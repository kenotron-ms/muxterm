package sessiond

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"hash"
	"sort"
	"time"
	"unicode/utf8"
)

// Close-ticket policy is deliberately small and daemon-local: two minutes is
// long enough to act on a modal without granting long-lived authority, 256
// entries put a hard ceiling on abandoned confirmations, and eight risks are
// one modal-worth of detail. Counts still cover the complete assessment.
const (
	CloseTicketTTL      = 2 * time.Minute
	CloseTicketCapacity = 256
	CloseRiskLimit      = 8

	closeTicketBytes              = 32
	closeTicketTextLength         = 43 // base64.RawURLEncoding of 32 bytes
	closeTicketGenerationAttempts = 4
	closeActivitySnapshotAttempts = 3
	closeIdleAssessmentAttempts   = 3
	closeRiskTitleBytes           = 256
)

// CloseTargetKind identifies the daemon-owned destructive transaction.
type CloseTargetKind string

const (
	CloseTargetPane      CloseTargetKind = "pane"
	CloseTargetWorkspace CloseTargetKind = "workspace"
)

// CloseStatus is the internal outcome B3 maps onto the additive wire contract.
type CloseStatus string

const (
	CloseStatusClosed               CloseStatus = "closed"
	CloseStatusConfirmationRequired CloseStatus = "confirmation-required"
	CloseStatusFailed               CloseStatus = "failed"
)

// Close failure codes are stable, user-safe categories for B3's failureCode.
const (
	CloseFailureInvalidTarget     = "invalid-close-target"
	CloseFailureInvalidTicket     = "invalid-close-ticket"
	CloseFailureTicketUnavailable = "close-ticket-unavailable"
)

// CloseTarget is the stable daemon identity named by a close intent.
type CloseTarget struct {
	Kind        CloseTargetKind
	WorkspaceID string
	PaneID      int
}

// CloseRisk is one bounded, user-safe warning entry. Idle panes never appear.
type CloseRisk struct {
	PaneID         int
	Title          string
	Classification ActivityClassification
	Reason         ActivityReason
}

// CloseOutcome is the daemon-internal result B3 maps to close-outcome.
//
// ClosedNow is internal lifecycle metadata, not part of the fixed wire shape.
// It tells server dispatch whether this transaction actually mutated the
// registry and therefore owes authoritative closure broadcasts. In particular,
// absent targets and invalidated tickets can reconcile as closed without a new
// registry mutation.
type CloseOutcome struct {
	Status           CloseStatus
	TargetKind       CloseTargetKind
	WorkspaceID      string
	PaneID           int
	Ticket           string
	BusyCount        int
	UnknownCount     int
	Risks            []CloseRisk
	OmittedRiskCount int
	FailureCode      string
	Error            string
	ClosedNow        bool
}

type closeActivityAssessment struct {
	assessment ActivityAssessment
	revision   uint64
}

type closePaneAssessment struct {
	pane             *Pane
	paneID           int
	targetGeneration uint64
	title            string
	activity         closeActivityAssessment
}

type closeAssessment struct {
	target               CloseTarget
	exists               bool
	workspace            *Workspace
	workspaceGeneration  uint64
	targetGeneration     uint64
	membershipGeneration uint64
	panes                []closePaneAssessment
}

// closeTicketBinding is fixed-size. The SHA-256 digest binds the complete,
// deterministic assessment and workspace membership without retaining an
// unbounded pane slice per abandoned ticket.
type closeTicketBinding struct {
	target               CloseTarget
	workspaceGeneration  uint64
	targetGeneration     uint64
	membershipGeneration uint64
	assessmentDigest     [sha256.Size]byte
}

type closeTicket struct {
	binding   closeTicketBinding
	expiresAt time.Time
	sequence  uint64
}

// CloseIntent performs the sole assess-and-close transaction for a pane or
// workspace. Registry identity and membership remain serialized from assessment
// through an idle-path removal. Pane teardown occurs only after r.mu is
// released, preserving the existing process-exit duplicate-event guard without
// introducing registry/pane lock inversion.
func (r *Registry) CloseIntent(target CloseTarget) CloseOutcome {
	if !target.valid() {
		return failedCloseOutcome(target, CloseFailureInvalidTarget, "invalid close target")
	}

	r.mu.Lock()
	now := time.Now()
	r.purgeExpiredCloseTicketsLocked(now)
	outcome, panes := r.resolveCloseIntentLocked(target, now)
	r.mu.Unlock()

	closeDetachedPanes(panes)
	return outcome
}

// ConfirmClose consumes an opaque ticket before validation or mutation.
// Unchanged, unexpired snapshots close exactly their warned registry members.
// Expired or changed snapshots are reassessed without mutation: risky targets
// receive a fresh ticket, while idle or absent targets reconcile as closed.
func (r *Registry) ConfirmClose(ticket string) CloseOutcome {
	if !validCloseTicketText(ticket) {
		return failedCloseOutcome(CloseTarget{}, CloseFailureInvalidTicket, "close confirmation is no longer valid; try closing again")
	}

	r.mu.Lock()
	now := time.Now()
	entry, ok := r.closeTickets[ticket]
	if ok {
		// Single-use is enforced before any classification or destructive action.
		delete(r.closeTickets, ticket)
	}
	r.purgeExpiredCloseTicketsLocked(now)
	if !ok {
		r.mu.Unlock()
		return failedCloseOutcome(CloseTarget{}, CloseFailureInvalidTicket, "close confirmation is no longer valid; try closing again")
	}

	current := r.captureStableCloseAssessmentLocked(entry.binding.target)
	if !now.Before(entry.expiresAt) || !current.exists || current.binding() != entry.binding {
		outcome := r.reassessInvalidatedCloseLocked(current, now)
		r.mu.Unlock()
		return outcome
	}

	panes, ok := r.detachCloseAssessmentLocked(current)
	if !ok {
		// The registry is serialized, so this is defensive fail-closed handling
		// for activity that changed after validation, not a membership race.
		outcome := r.reassessInvalidatedCloseLocked(r.captureStableCloseAssessmentLocked(entry.binding.target), now)
		r.mu.Unlock()
		return outcome
	}
	outcome := closedCloseOutcome(entry.binding.target, true)
	r.mu.Unlock()

	closeDetachedPanes(panes)
	return outcome
}

func (t CloseTarget) valid() bool {
	if t.WorkspaceID == "" {
		return false
	}
	switch t.Kind {
	case CloseTargetPane:
		return t.PaneID > 0
	case CloseTargetWorkspace:
		return t.PaneID == 0
	default:
		return false
	}
}

func (r *Registry) resolveCloseIntentLocked(target CloseTarget, now time.Time) (CloseOutcome, []*Pane) {
	assessment := r.captureStableCloseAssessmentLocked(target)
	if !assessment.exists {
		return closedCloseOutcome(target, false), nil
	}
	if assessment.hasRisks() {
		return r.confirmationRequiredLocked(assessment, now), nil
	}
	panes, ok := r.detachCloseAssessmentLocked(assessment)
	if !ok {
		// Activity changed in the narrow interval after the stable capture.
		// Reassess once more, but do not force a stale idle result through.
		assessment = r.captureStableCloseAssessmentLocked(target)
		if !assessment.exists {
			return closedCloseOutcome(target, false), nil
		}
		if assessment.hasRisks() {
			return r.confirmationRequiredLocked(assessment, now), nil
		}
		panes, ok = r.detachCloseAssessmentLocked(assessment)
		if !ok {
			assessment.forceConflicting()
			return r.confirmationRequiredLocked(assessment, now), nil
		}
	}
	return closedCloseOutcome(target, true), panes
}

// reassessInvalidatedCloseLocked never mutates. This is the design's stale
// confirmation rule: changed membership or activity refreshes the warning, and
// a now-idle/absent warned snapshot dismisses as closed while authoritative
// broadcasts remain the only source of structural removal.
func (r *Registry) reassessInvalidatedCloseLocked(assessment closeAssessment, now time.Time) CloseOutcome {
	if !assessment.exists || !assessment.hasRisks() {
		return closedCloseOutcome(assessment.target, false)
	}
	return r.confirmationRequiredLocked(assessment, now)
}

func (r *Registry) captureCloseAssessmentLocked(target CloseTarget) closeAssessment {
	assessment := closeAssessment{target: target}
	ws, ok := r.workspaces[target.WorkspaceID]
	if !ok {
		return assessment
	}

	assessment.workspace = ws
	assessment.workspaceGeneration = ws.generation
	switch target.Kind {
	case CloseTargetPane:
		pane, exists := ws.Panes[target.PaneID]
		if !exists || pane == nil {
			return assessment
		}
		assessment.exists = true
		assessment.targetGeneration = pane.targetGeneration
		assessment.panes = []closePaneAssessment{captureClosePaneAssessment(pane)}
	case CloseTargetWorkspace:
		assessment.exists = true
		assessment.targetGeneration = ws.generation
		assessment.membershipGeneration = ws.membershipGeneration
		ids := make([]int, 0, len(ws.Panes))
		for paneID := range ws.Panes {
			ids = append(ids, paneID)
		}
		sort.Ints(ids)
		assessment.panes = make([]closePaneAssessment, 0, len(ids))
		for _, paneID := range ids {
			pane := ws.Panes[paneID]
			if pane == nil {
				// Registry.PutPane rejects nil. Treat legacy/corrupt state as
				// absent from automatic authority rather than dereferencing it.
				assessment.panes = append(assessment.panes, closePaneAssessment{
					paneID: paneID,
					activity: closeActivityAssessment{assessment: ActivityAssessment{
						Classification: ActivityUnknown,
						Reason:         ActivityReasonConflictingEvidence,
					}},
				})
				continue
			}
			assessment.panes = append(assessment.panes, captureClosePaneAssessment(pane))
		}
	}
	return assessment
}

func (r *Registry) captureStableCloseAssessmentLocked(target CloseTarget) closeAssessment {
	for range closeIdleAssessmentAttempts {
		assessment := r.captureCloseAssessmentLocked(target)
		if !assessment.exists || assessment.bindingsCurrent() {
			return assessment
		}
	}

	// Repeated activity churn cannot enter a destructive path or issue a ticket
	// that was already stale when created.
	assessment := r.captureCloseAssessmentLocked(target)
	if assessment.exists {
		assessment.forceConflicting()
	}
	return assessment
}

func captureClosePaneAssessment(pane *Pane) closePaneAssessment {
	info := pane.Info()
	return closePaneAssessment{
		pane:             pane,
		paneID:           pane.LocalID,
		targetGeneration: pane.targetGeneration,
		title:            closeRiskPaneTitle(info),
		activity:         pane.closeActivityAssessment(),
	}
}

// closeActivityAssessment brackets B1 classification with activity revisions.
// The returned classification and private revision therefore describe the same
// root-process state, including error/unknown paths that B1 conservatively
// returns before its idle-only second inspection.
func (p *Pane) closeActivityAssessment() closeActivityAssessment {
	for range closeActivitySnapshotAttempts {
		before := p.activitySnapshot()
		assessment := normalizeCloseActivity(p.ClassifyActivity())
		after := p.activitySnapshot()
		if before.generation == after.generation &&
			before.revision == after.revision &&
			assessment.Generation == after.generation {
			return closeActivityAssessment{assessment: assessment, revision: after.revision}
		}
	}

	current := p.activitySnapshot()
	return closeActivityAssessment{
		assessment: ActivityAssessment{
			Classification: ActivityUnknown,
			Reason:         ActivityReasonConflictingEvidence,
			Generation:     current.generation,
		},
		revision: current.revision,
	}
}

func normalizeCloseActivity(assessment ActivityAssessment) ActivityAssessment {
	switch assessment.Classification {
	case ActivityIdle:
		if assessment.Reason == "" {
			return assessment
		}
	case ActivityBusy, ActivityUnknown:
		if validCloseActivityReason(assessment.Reason) {
			return assessment
		}
	}
	assessment.Classification = ActivityUnknown
	assessment.Reason = ActivityReasonConflictingEvidence
	return assessment
}

func validCloseActivityReason(reason ActivityReason) bool {
	switch reason {
	case ActivityReasonCommandActive,
		ActivityReasonForegroundProcess,
		ActivityReasonCustomCommand,
		ActivityReasonBrowserPane,
		ActivityReasonUnsupportedShell,
		ActivityReasonUnsupportedPlatform,
		ActivityReasonMissingLifecycle,
		ActivityReasonStaleLifecycle,
		ActivityReasonProcessInspectionFailed,
		ActivityReasonPTYInspectionFailed,
		ActivityReasonConflictingEvidence:
		return true
	default:
		return false
	}
}

func (a closeAssessment) hasRisks() bool {
	for _, pane := range a.panes {
		if pane.activity.assessment.Classification != ActivityIdle {
			return true
		}
	}
	return false
}

func (a closeAssessment) bindingsCurrent() bool {
	for _, pane := range a.panes {
		if pane.pane == nil ||
			pane.pane.targetGeneration != pane.targetGeneration ||
			closeRiskPaneTitle(pane.pane.Info()) != pane.title {
			return false
		}
		current := pane.pane.activitySnapshot()
		if current.generation != pane.activity.assessment.Generation ||
			current.revision != pane.activity.revision {
			return false
		}
	}
	return true
}

func (a *closeAssessment) forceConflicting() {
	for i := range a.panes {
		pane := &a.panes[i]
		if pane.pane == nil {
			continue
		}
		current := pane.pane.activitySnapshot()
		pane.title = closeRiskPaneTitle(pane.pane.Info())
		pane.activity = closeActivityAssessment{
			assessment: ActivityAssessment{
				Classification: ActivityUnknown,
				Reason:         ActivityReasonConflictingEvidence,
				Generation:     current.generation,
			},
			revision: current.revision,
		}
	}
}

func (a closeAssessment) binding() closeTicketBinding {
	if !a.exists {
		return closeTicketBinding{target: a.target}
	}
	return closeTicketBinding{
		target:               a.target,
		workspaceGeneration:  a.workspaceGeneration,
		targetGeneration:     a.targetGeneration,
		membershipGeneration: a.membershipGeneration,
		assessmentDigest:     a.digest(),
	}
}

func (a closeAssessment) digest() [sha256.Size]byte {
	h := sha256.New()
	writeCloseHashString(h, "muxterm-close-assessment-v1")
	writeCloseHashString(h, string(a.target.Kind))
	writeCloseHashString(h, a.target.WorkspaceID)
	writeCloseHashUint64(h, uint64(a.target.PaneID))
	writeCloseHashUint64(h, a.workspaceGeneration)
	writeCloseHashUint64(h, a.targetGeneration)
	writeCloseHashUint64(h, a.membershipGeneration)
	writeCloseHashUint64(h, uint64(len(a.panes)))
	for _, pane := range a.panes {
		writeCloseHashUint64(h, uint64(pane.paneID))
		writeCloseHashUint64(h, pane.targetGeneration)
		writeCloseHashString(h, pane.title)
		writeCloseHashString(h, string(pane.activity.assessment.Classification))
		writeCloseHashString(h, string(pane.activity.assessment.Reason))
		writeCloseHashUint64(h, pane.activity.assessment.Generation)
		writeCloseHashUint64(h, pane.activity.revision)
	}
	var digest [sha256.Size]byte
	copy(digest[:], h.Sum(nil))
	return digest
}

func writeCloseHashString(h hash.Hash, value string) {
	writeCloseHashUint64(h, uint64(len(value)))
	_, _ = h.Write([]byte(value))
}

func writeCloseHashUint64(h hash.Hash, value uint64) {
	var encoded [8]byte
	binary.BigEndian.PutUint64(encoded[:], value)
	_, _ = h.Write(encoded[:])
}

func (r *Registry) confirmationRequiredLocked(assessment closeAssessment, now time.Time) CloseOutcome {
	binding := assessment.binding()
	if existing := r.findCloseTicketLocked(binding, now); existing != "" {
		return confirmationCloseOutcome(assessment, existing)
	}

	ticket, err := r.newCloseTicketLocked()
	if err != nil {
		return failedCloseOutcome(assessment.target, CloseFailureTicketUnavailable, "close confirmation is temporarily unavailable; try again")
	}
	if len(r.closeTickets) >= CloseTicketCapacity {
		r.evictOldestCloseTicketLocked()
	}
	r.closeTicketSequence++
	r.closeTickets[ticket] = closeTicket{
		binding:   binding,
		expiresAt: now.Add(CloseTicketTTL),
		sequence:  r.closeTicketSequence,
	}
	return confirmationCloseOutcome(assessment, ticket)
}

func (r *Registry) findCloseTicketLocked(binding closeTicketBinding, now time.Time) string {
	var found string
	var sequence uint64
	for ticket, entry := range r.closeTickets {
		if !now.Before(entry.expiresAt) || entry.binding != binding {
			continue
		}
		if found == "" || entry.sequence < sequence || (entry.sequence == sequence && ticket < found) {
			found = ticket
			sequence = entry.sequence
		}
	}
	return found
}

func (r *Registry) newCloseTicketLocked() (string, error) {
	var raw [closeTicketBytes]byte
	for range closeTicketGenerationAttempts {
		if _, err := rand.Read(raw[:]); err != nil {
			return "", err
		}
		ticket := base64.RawURLEncoding.EncodeToString(raw[:])
		if _, exists := r.closeTickets[ticket]; !exists {
			return ticket, nil
		}
	}
	return "", errCloseTicketCollision{}
}

// errCloseTicketCollision avoids importing errors solely for a practically
// impossible collision path while still surfacing ticket issuance failure.
type errCloseTicketCollision struct{}

func (errCloseTicketCollision) Error() string { return "sessiond: repeated close ticket collision" }

func validCloseTicketText(ticket string) bool {
	if len(ticket) != closeTicketTextLength {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(ticket)
	return err == nil && len(decoded) == closeTicketBytes
}

func (r *Registry) purgeExpiredCloseTicketsLocked(now time.Time) {
	for ticket, entry := range r.closeTickets {
		if !now.Before(entry.expiresAt) {
			delete(r.closeTickets, ticket)
		}
	}
}

func (r *Registry) evictOldestCloseTicketLocked() {
	var oldestTicket string
	var oldestSequence uint64
	for ticket, entry := range r.closeTickets {
		if oldestTicket == "" ||
			entry.sequence < oldestSequence ||
			(entry.sequence == oldestSequence && ticket < oldestTicket) {
			oldestTicket = ticket
			oldestSequence = entry.sequence
		}
	}
	if oldestTicket != "" {
		delete(r.closeTickets, oldestTicket)
	}
}

func (r *Registry) detachCloseAssessmentLocked(assessment closeAssessment) ([]*Pane, bool) {
	ws, ok := r.workspaces[assessment.target.WorkspaceID]
	if !ok || ws != assessment.workspace || ws.generation != assessment.workspaceGeneration {
		return nil, false
	}
	if !assessment.bindingsCurrent() {
		return nil, false
	}

	switch assessment.target.Kind {
	case CloseTargetPane:
		pane, exists := ws.Panes[assessment.target.PaneID]
		if !exists || pane == nil ||
			pane != assessment.panes[0].pane ||
			pane.targetGeneration != assessment.targetGeneration {
			return nil, false
		}
		removed, _, removedOK := r.removePaneLocked(assessment.target.WorkspaceID, assessment.target.PaneID)
		if !removedOK {
			return nil, false
		}
		return []*Pane{removed}, true
	case CloseTargetWorkspace:
		if ws.membershipGeneration != assessment.membershipGeneration ||
			len(ws.Panes) != len(assessment.panes) {
			return nil, false
		}
		for _, expected := range assessment.panes {
			pane, exists := ws.Panes[expected.paneID]
			if !exists || pane != expected.pane || pane == nil ||
				pane.targetGeneration != expected.targetGeneration {
				return nil, false
			}
		}
		panes, _, closed := r.closeWorkspaceLocked(assessment.target.WorkspaceID)
		return panes, closed
	default:
		return nil, false
	}
}

func closeDetachedPanes(panes []*Pane) {
	// Never hold Registry.mu while Close kills a process, closes a PTY, or lets
	// readLoop/onExit re-enter Registry.RemovePane.
	for _, pane := range panes {
		if pane != nil {
			pane.Close()
		}
	}
}

func confirmationCloseOutcome(assessment closeAssessment, ticket string) CloseOutcome {
	outcome := baseCloseOutcome(assessment.target)
	outcome.Status = CloseStatusConfirmationRequired
	outcome.Ticket = ticket
	for _, pane := range assessment.panes {
		classification := pane.activity.assessment.Classification
		switch classification {
		case ActivityBusy:
			outcome.BusyCount++
		case ActivityUnknown:
			outcome.UnknownCount++
		default:
			continue
		}
		if len(outcome.Risks) < CloseRiskLimit {
			outcome.Risks = append(outcome.Risks, CloseRisk{
				PaneID:         pane.paneID,
				Title:          boundedCloseRiskTitle(pane.title),
				Classification: classification,
				Reason:         pane.activity.assessment.Reason,
			})
		} else {
			outcome.OmittedRiskCount++
		}
	}
	return outcome
}

func boundedCloseRiskTitle(title string) string {
	if len(title) <= closeRiskTitleBytes {
		return title
	}
	end := closeRiskTitleBytes
	for end > 0 && !utf8.ValidString(title[:end]) {
		end--
	}
	return title[:end]
}

func closeRiskPaneTitle(info PaneInfo) string {
	if info.Title != "" {
		return info.Title
	}
	if info.SurfaceKind == "browser" {
		return "Browser"
	}
	return fmt.Sprintf("Pane %d", info.PaneID)
}

func closedCloseOutcome(target CloseTarget, closedNow bool) CloseOutcome {
	outcome := baseCloseOutcome(target)
	outcome.Status = CloseStatusClosed
	outcome.ClosedNow = closedNow
	return outcome
}

func failedCloseOutcome(target CloseTarget, code, userError string) CloseOutcome {
	outcome := baseCloseOutcome(target)
	outcome.Status = CloseStatusFailed
	outcome.FailureCode = code
	outcome.Error = userError
	return outcome
}

func baseCloseOutcome(target CloseTarget) CloseOutcome {
	return CloseOutcome{
		TargetKind:  target.Kind,
		WorkspaceID: target.WorkspaceID,
		PaneID:      target.PaneID,
	}
}
