// Package sessiond defines the session daemon control protocol.
package sessiond

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"time"
)

// Frame kinds tag each daemon socket frame. A frame is
// [4-byte BIG-ENDIAN length][1-byte kind][payload], where the length covers the
// kind byte plus the payload.
const (
	FrameControl  byte = 0x01 // payload is JSON of the Message envelope
	FramePaneData byte = 0x02 // payload is [4-byte LITTLE-ENDIAN paneId][raw bytes]
)

// Message Type strings name every frozen control envelope on the wire. No phase
// should hardcode a raw literal; reference these constants instead. The values
// are FROZEN per the v1 wire protocol contract (see
// docs/plans/2026-06-01-session-persistence-design.md) and must never change.
const (
	// Requests (client -> daemon).
	TypeCreateWorkspace = "create-workspace"
	TypeListWorkspaces  = "list-workspaces"
	TypeRenameWorkspace = "rename-workspace"
	TypeCloseWorkspace  = "close-workspace"
	TypeAttach          = "attach"
	TypeCreatePane      = "create-pane"
	TypeClosePane       = "close-pane"
	TypeResize          = "resize"
	TypePaneFocus       = "pane-focus"
	TypeRenamePane      = "rename-pane"
	TypeSaveLayout      = "save-layout"
	TypeScreenSnapshot  = "screen-snapshot" // request: MCP → daemon, VT grid for a pane
	TypeGetLayout       = "get-layout"      // request: MCP → daemon, ASCII layout diagram

	// Replies (daemon -> client, echo request cid).
	TypeWorkspaceCreated     = "workspace-created"
	TypeWorkspaceList        = "workspace-list"
	TypeComposition          = "composition"
	TypePaneCreated          = "pane-created"
	TypeOK                   = "ok"
	TypeScreenSnapshotResult = "screen-snapshot-result"
	TypeLayoutResult         = "layout-result"

	// Events (daemon -> all subscribers, cid=0).
	TypePaneAdded           = "pane-added"
	TypePaneClosed          = "pane-closed"
	TypeWorkspaceClosed     = "workspace-closed"
	TypeWorkspaceRenamed    = "workspace-renamed"
	TypePaneRenamed         = "pane-renamed"
	TypeBrowserAction       = "browser-action"        // relay browser DOM command to/from SW bridge
	TypeBrowserActionResult = "browser-action-result" // relay browser DOM command result back to MCP client
	TypeLayoutCommand       = "layout-command"        // relay layout mutation to browser clients
	TypeShellPrompt         = "shell-prompt"          // OSC 133 prompt/command lifecycle
	TypePaneResized         = "pane-resized"          // broadcast: canonical PTY size changed

	// Error envelope.
	TypeError = "error"

	// Client-driven browser pane messages (ride /ws; no server-side engine).
	// The daemon holds only a pane handle and RELAYS commands to the client that
	// owns the pane. See docs/muxterm-client-protocol.md.
	TypeCreateBrowserPane = "create-browser-pane" // client → daemon: allocate a browser pane handle
	TypeCloseBrowserPane  = "close-browser-pane"  // client → daemon: close a browser pane
	TypeBrowserCommand    = "browser-command"     // relayed to workspace subs: {paneId, cid, action, params}
	TypeBrowserResult     = "browser-result"      // relayed to workspace subs: {paneId, cid, result | error}
	TypeBrowserURL        = "browser-url"         // client -> server -> workspace subs: navigation committed
	TypeBrowserLoad       = "browser-load"        // client -> server -> workspace subs: page load complete
)

// Error codes are the frozen Message.Code values carried by a TypeError
// envelope. FROZEN per the v1 wire protocol contract.
const (
	CodeUnknownWorkspace = "unknown-workspace"
	CodePaneSpawnFailed  = "pane-spawn-failed"
	CodePaneNotFound     = "pane-not-found"
)

// Scrollback pagination message types (ADDITIVE, post-v1). These extend the
// frozen protocol above without altering any existing constant or field:
// TypeScrollbackPage is a client -> daemon request for one page of a pane's
// server-side scrollback history; TypeScrollbackPageResult is the daemon's
// reply, echoing the request cid. See
// docs/designs/2026-08-12-sessiond-cli-scrollback-design.md.
const (
	TypeScrollbackPage       = "scrollback-page"        // request:  client -> daemon
	TypeScrollbackPageResult = "scrollback-page-result" // reply:    daemon -> client
)

// Activity-aware close message types are additive. They preserve the legacy
// force-close messages while routing browser close intents through daemon-owned
// activity and ticket authority.
const (
	TypeCloseIntent  = "close-intent"  // request: browser relay -> daemon
	TypeCloseConfirm = "close-confirm" // request: browser relay -> daemon
	TypeCloseOutcome = "close-outcome" // reply: daemon -> browser relay
)

// Recovery message types are additive. Privileged envelopes travel only over
// the owner-local daemon boundary; browser-safe messages carry redacted
// projection types defined below.
const (
	TypeProtocolHello       = "protocol-hello"
	TypeProtocolHelloResult = "protocol-hello-result"

	TypePaneRecoveryChanged = "pane-recovery-changed"
	TypeRecoveryRetry       = "recovery-retry"
	TypeRecoveryRetryResult = "recovery-retry-result"

	TypeRecoverySelect       = "recovery-select"        // browser-safe opaque candidate selection
	TypeRecoverySelectResult = "recovery-select-result" // browser-safe selection result

	TypeLifecycleLeaseDelivery  = "lifecycle-lease-delivery"  // owner-local only
	TypeLifecycleCapture        = "lifecycle-capture"         // privileged request
	TypeLifecycleCaptureOutcome = "lifecycle-capture-outcome" // privileged result

	TypeReplacementPlan       = "replacement-plan"        // privileged request
	TypeReplacementPlanResult = "replacement-plan-result" // privileged result
	TypeReplacementCommit     = "replacement-commit"      // privileged request
	TypeReplacementOutcome    = "replacement-outcome"     // redacted event/result

	TypeSetActivePane       = "set-active-pane"
	TypeSetActivePaneResult = "set-active-pane-result"
)

// CloseRiskInfo is one user-safe activity warning in a close-outcome. It is
// deliberately a wire type rather than the daemon's internal CloseRisk so its
// JSON field names are fixed independently of internal transaction state.
type CloseRiskInfo struct {
	PaneID         int    `json:"paneId"`
	Title          string `json:"title"`
	Classification string `json:"classification"`
	Reason         string `json:"reason"`
}

// RecoveryProtocolCapability is a browser-safe capability advertised through
// protocol hello. Privileged recovery operations are intentionally absent.
type RecoveryProtocolCapability string

const (
	RecoveryProtocolCapabilityPaneProjection        RecoveryProtocolCapability = "pane-recovery-projection"
	RecoveryProtocolCapabilityRetry                 RecoveryProtocolCapability = "recovery-retry"
	RecoveryProtocolCapabilitySelection             RecoveryProtocolCapability = "recovery-select"
	RecoveryProtocolCapabilityActivePanePersistence RecoveryProtocolCapability = "active-pane-persistence"
)

// RecoveryProtocolCapabilities emits only populated values. len(Values) is
// authoritative and may not exceed RecoveryMaxProtocolCapabilities.
type RecoveryProtocolCapabilities struct {
	Values []RecoveryProtocolCapability `json:"values"`
}

func validRecoveryProtocolCapability(value RecoveryProtocolCapability) bool {
	switch value {
	case RecoveryProtocolCapabilityPaneProjection,
		RecoveryProtocolCapabilityRetry,
		RecoveryProtocolCapabilitySelection,
		RecoveryProtocolCapabilityActivePanePersistence:
		return true
	default:
		return false
	}
}

func (capabilities RecoveryProtocolCapabilities) validateRecoveryContract() error {
	if len(capabilities.Values) > RecoveryMaxProtocolCapabilities {
		return fmt.Errorf("recovery: protocol capability count exceeds capacity")
	}
	seen := make(map[RecoveryProtocolCapability]struct{}, len(capabilities.Values))
	for _, capability := range capabilities.Values {
		if !validRecoveryProtocolCapability(capability) {
			return fmt.Errorf("recovery: unknown protocol capability %q", capability)
		}
		if _, duplicate := seen[capability]; duplicate {
			return fmt.Errorf("recovery: duplicate protocol capability %q", capability)
		}
		seen[capability] = struct{}{}
	}
	return nil
}

// UnmarshalJSON bounds the only browser-safe recovery slice before it becomes
// a typed allocation. A count above the fixed storage limit is rejected before
// publishing any value to the receiver.
func (capabilities *RecoveryProtocolCapabilities) UnmarshalJSON(data []byte) error {
	if len(data) == 0 || len(data) > RecoveryMaxBrowserRecoveryMessageBytes {
		return fmt.Errorf("recovery: protocol capabilities exceed input limit")
	}
	var raw struct {
		Values json.RawMessage `json:"values"`
	}
	if err := decodeRecoveryJSON(data, &raw); err != nil {
		return err
	}
	if len(raw.Values) == 0 || len(raw.Values) > RecoveryMaxBrowserRecoveryMessageBytes {
		return fmt.Errorf("recovery: protocol capabilities omit or exceed values")
	}
	if bytes.Equal(bytes.TrimSpace(raw.Values), []byte("null")) {
		return fmt.Errorf("recovery: protocol capability values must be an array")
	}
	var encodedValues []json.RawMessage
	if err := json.Unmarshal(raw.Values, &encodedValues); err != nil {
		return fmt.Errorf("recovery: decode protocol capability values: %w", err)
	}
	if len(encodedValues) > RecoveryMaxProtocolCapabilities {
		return fmt.Errorf("recovery: protocol capability count exceeds capacity")
	}
	values := make([]RecoveryProtocolCapability, len(encodedValues))
	for index, encodedValue := range encodedValues {
		if len(encodedValue) > RecoveryMaxDetailCodeBytes {
			return fmt.Errorf("recovery: protocol capability exceeds input limit")
		}
		if err := json.Unmarshal(encodedValue, &values[index]); err != nil {
			return fmt.Errorf("recovery: decode protocol capability: %w", err)
		}
	}
	decoded := RecoveryProtocolCapabilities{Values: values}
	if err := decoded.validateRecoveryContract(); err != nil {
		return err
	}
	*capabilities = decoded
	return nil
}

func (capabilities RecoveryProtocolCapabilities) MarshalJSON() ([]byte, error) {
	if err := capabilities.validateRecoveryContract(); err != nil {
		return nil, err
	}
	type wire RecoveryProtocolCapabilities
	return json.Marshal(wire(capabilities))
}

// ProtocolHelloRequest and ProtocolHelloResult negotiate only browser-safe
// schema/capability support. They cannot grant launch or strategy authority.
type ProtocolHelloRequest struct {
	RecoverySchemaVersion uint16                       `json:"recoverySchemaVersion"`
	Capabilities          RecoveryProtocolCapabilities `json:"capabilities"`
}

func (request ProtocolHelloRequest) validateRecoveryContract() error {
	if request.RecoverySchemaVersion != RecoveryCaptureSchemaVersion {
		return fmt.Errorf("recovery: unsupported protocol schema version %d", request.RecoverySchemaVersion)
	}
	return request.Capabilities.validateRecoveryContract()
}

type ProtocolHelloResult struct {
	RecoverySchemaVersion uint16                       `json:"recoverySchemaVersion"`
	Capabilities          RecoveryProtocolCapabilities `json:"capabilities"`
	Compatible            bool                         `json:"compatible"`
	DetailCode            RecoveryDetailCode           `json:"detailCode"`
}

func (result ProtocolHelloResult) validateRecoveryContract() error {
	if result.RecoverySchemaVersion != RecoveryCaptureSchemaVersion {
		return fmt.Errorf("recovery: unsupported protocol schema version %d", result.RecoverySchemaVersion)
	}
	if err := result.Capabilities.validateRecoveryContract(); err != nil {
		return err
	}
	if err := result.DetailCode.validateRecoveryContract(); err != nil {
		return err
	}
	if result.Compatible && result.DetailCode != RecoveryDetailNone {
		return fmt.Errorf("recovery: invalid protocol compatibility/detail pairing")
	}
	if !result.Compatible && result.DetailCode != RecoveryDetailSchemaIncompatible {
		return fmt.Errorf("recovery: incompatible protocol result has invalid detail")
	}
	return nil
}

// PaneRecoveryInfo is the complete browser-safe recovery projection. Exact
// session identities, paths, launch data, capabilities, generations, internal
// strategy IDs, and raw tool errors must never be added here. A selection-needed
// projection may contain only daemon-issued opaque candidate handles paired
// with fixed human-safe strategy labels.
type PaneRecoveryInfo struct {
	Status              RecoveryStatus               `json:"status"`
	StrategyLabel       RecoveryStrategyLabel        `json:"strategyLabel,omitempty"`
	DetailCode          RecoveryDetailCode           `json:"detailCode"`
	HistoryBoundary     bool                         `json:"historyBoundary"`
	CanRetry            bool                         `json:"canRetry"`
	CanSelect           bool                         `json:"canSelect"`
	SelectionCandidates []RecoverySelectionCandidate `json:"selectionCandidates,omitempty"`
}

func (info PaneRecoveryInfo) validateRecoveryContract() error {
	if err := info.Status.validateRecoveryContract(); err != nil {
		return err
	}
	if err := info.DetailCode.validateRecoveryContract(); err != nil {
		return err
	}
	if len(info.SelectionCandidates) > RecoveryMaxBrowserSelectionCandidates {
		return fmt.Errorf("recovery: selection candidate count exceeds capacity")
	}
	seen := make(map[RecoveryCandidateHandle]struct{}, len(info.SelectionCandidates))
	for _, candidate := range info.SelectionCandidates {
		if err := candidate.validateRecoveryContract(); err != nil {
			return err
		}
		if _, duplicate := seen[candidate.CandidateHandle]; duplicate {
			return fmt.Errorf("recovery: duplicate selection candidate")
		}
		seen[candidate.CandidateHandle] = struct{}{}
	}

	switch info.Status {
	case RecoveryStatusRestoring, RecoveryStatusRecovered:
		if info.StrategyLabel == "" || info.DetailCode != RecoveryDetailNone ||
			info.CanRetry || info.CanSelect || len(info.SelectionCandidates) != 0 {
			return fmt.Errorf("recovery: invalid restoring/recovered projection")
		}
	case RecoveryStatusShellRestored:
		if info.StrategyLabel != "" || info.DetailCode != RecoveryDetailNone ||
			info.CanRetry || info.CanSelect || len(info.SelectionCandidates) != 0 {
			return fmt.Errorf("recovery: invalid shell-restored projection")
		}
	case RecoveryStatusSelectionNeeded:
		if info.StrategyLabel != "" || info.DetailCode == RecoveryDetailNone ||
			info.CanRetry || !info.CanSelect || len(info.SelectionCandidates) == 0 {
			return fmt.Errorf("recovery: invalid selection-needed projection")
		}
	case RecoveryStatusProvisional:
		if info.StrategyLabel == "" || info.DetailCode == RecoveryDetailNone ||
			info.CanRetry || info.CanSelect || len(info.SelectionCandidates) != 0 {
			return fmt.Errorf("recovery: invalid provisional projection")
		}
	case RecoveryStatusStrategyFailed:
		if info.StrategyLabel == "" || info.DetailCode == RecoveryDetailNone ||
			!info.CanRetry || info.CanSelect || len(info.SelectionCandidates) != 0 {
			return fmt.Errorf("recovery: invalid strategy-failed projection")
		}
	}
	if info.StrategyLabel != "" {
		return info.StrategyLabel.validateRecoveryContract()
	}
	return nil
}

// UnmarshalJSON bounds candidate bytes and count before assigning a
// browser-provided or browser-received projection.
func (info *PaneRecoveryInfo) UnmarshalJSON(data []byte) error {
	if len(data) == 0 || len(data) > RecoveryMaxBrowserRecoveryMessageBytes {
		return fmt.Errorf("recovery: pane recovery projection exceeds input limit")
	}
	var raw struct {
		SelectionCandidates json.RawMessage `json:"selectionCandidates"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return fmt.Errorf("recovery: decode pane recovery projection: %w", err)
	}
	if len(raw.SelectionCandidates) > RecoveryMaxBrowserRecoveryMessageBytes {
		return fmt.Errorf("recovery: selection candidates exceed input limit")
	}
	if len(raw.SelectionCandidates) != 0 {
		var candidates []json.RawMessage
		if err := json.Unmarshal(raw.SelectionCandidates, &candidates); err != nil {
			return fmt.Errorf("recovery: decode selection candidates: %w", err)
		}
		if len(candidates) > RecoveryMaxBrowserSelectionCandidates {
			return fmt.Errorf("recovery: selection candidate count exceeds capacity")
		}
	}
	type wire PaneRecoveryInfo
	var decoded wire
	if err := decodeRecoveryJSON(data, &decoded); err != nil {
		return err
	}
	result := PaneRecoveryInfo(decoded)
	if err := result.validateRecoveryContract(); err != nil {
		return err
	}
	*info = result
	return nil
}

func (info PaneRecoveryInfo) MarshalJSON() ([]byte, error) {
	if err := info.validateRecoveryContract(); err != nil {
		return nil, err
	}
	type wire PaneRecoveryInfo
	return json.Marshal(wire(info))
}

// PaneRecoveryTransition is the browser-safe live state update for one
// workspace-qualified pane.
type PaneRecoveryTransition struct {
	Pane     RecoveryPaneRef  `json:"pane"`
	Recovery PaneRecoveryInfo `json:"recovery"`
}

func (transition PaneRecoveryTransition) validateRecoveryContract() error {
	if err := transition.Pane.validateRecoveryContract(); err != nil {
		return err
	}
	return transition.Recovery.validateRecoveryContract()
}

// RecoveryRetryRequest identifies only the workspace-qualified pane. Sessiond
// resolves its current failed generation and capture fence internally.
type RecoveryRetryRequest struct {
	Pane RecoveryPaneRef `json:"pane"`
}

func (request RecoveryRetryRequest) validateRecoveryContract() error {
	return request.Pane.validateRecoveryContract()
}

type RecoveryRetryResult struct {
	Pane     RecoveryPaneRef  `json:"pane"`
	Recovery PaneRecoveryInfo `json:"recovery"`
}

func (result RecoveryRetryResult) validateRecoveryContract() error {
	if err := result.Pane.validateRecoveryContract(); err != nil {
		return err
	}
	return result.Recovery.validateRecoveryContract()
}

// RecoverySelectRequest is browser-safe: a caller returns only a daemon-issued
// opaque candidate handle. Sessiond resolves and revalidates its
// workspace-qualified pane binding against the candidate lease registry.
type RecoverySelectRequest struct {
	CandidateHandle RecoveryCandidateHandle `json:"candidateHandle"`
}

func (request RecoverySelectRequest) validateRecoveryContract() error {
	return request.CandidateHandle.validateRecoveryContract()
}

// RecoverySelectResult is a redacted post-resolution browser result. It does
// not reveal the selected external session identity or recovery fence.
type RecoverySelectResult struct {
	Pane     RecoveryPaneRef  `json:"pane"`
	Recovery PaneRecoveryInfo `json:"recovery"`
}

func (result RecoverySelectResult) validateRecoveryContract() error {
	if err := result.Pane.validateRecoveryContract(); err != nil {
		return err
	}
	return result.Recovery.validateRecoveryContract()
}

// PrivilegedLifecycleCaptureRequest and
// PrivilegedLifecycleCaptureOutcome are owner-local only. They keep callback
// capability and exact session values outside browser projection types.
type PrivilegedLifecycleCaptureRequest struct {
	Callback RecoveryLifecycleCapture `json:"callback"`
}

type PrivilegedLifecycleCaptureOutcome struct {
	Outcome RecoveryLifecycleCaptureOutcome `json:"outcome"`
}

// RecoveryReplacementPlanState is a closed coordination result for controlled
// daemon replacement.
type RecoveryReplacementPlanState string

const (
	RecoveryReplacementPlanReady    RecoveryReplacementPlanState = "ready"
	RecoveryReplacementPlanDeferred RecoveryReplacementPlanState = "deferred"
)

func validRecoveryReplacementPlanState(value RecoveryReplacementPlanState) bool {
	return value == RecoveryReplacementPlanReady || value == RecoveryReplacementPlanDeferred
}

// RecoveryReplacementPlanIntent is all a plan requester may send. Sessiond
// derives the current recovery generation and complete active-pane census from
// its authoritative registry rather than accepting them from any caller.
type RecoveryReplacementPlanIntent string

const RecoveryReplacementPlanIntentRequest RecoveryReplacementPlanIntent = "request"

type PrivilegedReplacementPlanRequest struct {
	Intent RecoveryReplacementPlanIntent `json:"intent"`
}

func (request PrivilegedReplacementPlanRequest) validateRecoveryContract() error {
	if request.Intent != RecoveryReplacementPlanIntentRequest {
		return fmt.Errorf("recovery: unknown replacement plan intent %q", request.Intent)
	}
	return nil
}

type PrivilegedReplacementPlanResult struct {
	PlanID     RecoveryReplacementPlanID    `json:"planId,omitempty"`
	State      RecoveryReplacementPlanState `json:"state"`
	DetailCode RecoveryDetailCode           `json:"detailCode"`
	ExpiresAt  *time.Time                   `json:"expiresAt,omitempty"`
}

func (result PrivilegedReplacementPlanResult) validateRecoveryContract() error {
	if !validRecoveryReplacementPlanState(result.State) {
		return fmt.Errorf("recovery: unknown replacement plan state %q", result.State)
	}
	if err := result.DetailCode.validateRecoveryContract(); err != nil {
		return err
	}
	switch result.State {
	case RecoveryReplacementPlanReady:
		if err := result.PlanID.validateRecoveryContract(); err != nil {
			return err
		}
		if result.ExpiresAt == nil || result.ExpiresAt.IsZero() || result.DetailCode != RecoveryDetailNone {
			return fmt.Errorf("recovery: ready replacement plan lacks a valid lease result")
		}
	case RecoveryReplacementPlanDeferred:
		if result.PlanID != "" || result.ExpiresAt != nil ||
			(result.DetailCode != RecoveryDetailReplacementDeferred &&
				result.DetailCode != RecoveryDetailReplacementPlanInvalid) {
			return fmt.Errorf("recovery: invalid deferred replacement plan result")
		}
	}
	return nil
}

// RecoveryReplacementPlanLease is the daemon-held, short-lived single-use
// binding for a replacement commit. The registry generation and complete
// census are derived only by sessiond. This value never crosses a JSON boundary.
type RecoveryReplacementPlanLease struct {
	PlanID     RecoveryReplacementPlanID  `json:"-"`
	Generation RecoveryGeneration         `json:"-"`
	Census     RecoveryReplacementPaneSet `json:"-"`
	IssuedAt   time.Time                  `json:"-"`
	ExpiresAt  time.Time                  `json:"-"`
	Consumed   bool                       `json:"-"`
}

const RecoveryReplacementPlanMaxTTL = 30 * time.Second

func (lease RecoveryReplacementPlanLease) validateRecoveryContract() error {
	if err := lease.PlanID.validateRecoveryContract(); err != nil {
		return err
	}
	if lease.Generation == 0 {
		return fmt.Errorf("recovery: replacement plan lease has zero generation")
	}
	if err := lease.Census.validateRecoveryContract(); err != nil {
		return err
	}
	return validateTimeRange(lease.IssuedAt, lease.ExpiresAt, RecoveryReplacementPlanMaxTTL, "replacement plan")
}

func (RecoveryReplacementPlanLease) MarshalJSON() ([]byte, error) {
	return nil, fmt.Errorf("recovery: replacement plan lease must not be serialized")
}

func (*RecoveryReplacementPlanLease) UnmarshalJSON([]byte) error {
	return fmt.Errorf("recovery: replacement plan lease must be minted by sessiond")
}

// NewRecoveryReplacementPlanLease constructs the daemon-held plan lease after
// sessiond has captured the authoritative registry generation and full census.
func NewRecoveryReplacementPlanLease(
	planID RecoveryReplacementPlanID,
	generation RecoveryGeneration,
	census RecoveryReplacementPaneSet,
	issuedAt, expiresAt time.Time,
) (RecoveryReplacementPlanLease, error) {
	lease := RecoveryReplacementPlanLease{
		PlanID:     planID,
		Generation: generation,
		Census:     census,
		IssuedAt:   issuedAt,
		ExpiresAt:  expiresAt,
	}
	if err := lease.validateRecoveryContract(); err != nil {
		return RecoveryReplacementPlanLease{}, err
	}
	return lease, nil
}

// RecoveryReplacementShellOnlyAcceptance accepts only the shell-only fallback
// already identified by a particular daemon-issued plan. Its sole field binds
// the acceptance to that plan; it cannot submit a generation or a pane census.
type RecoveryReplacementShellOnlyAcceptance struct {
	PlanID RecoveryReplacementPlanID `json:"planId"`
}

func (acceptance RecoveryReplacementShellOnlyAcceptance) validateRecoveryContract() error {
	return acceptance.PlanID.validateRecoveryContract()
}

type PrivilegedReplacementCommitRequest struct {
	PlanID              RecoveryReplacementPlanID               `json:"planId"`
	ShellOnlyAcceptance *RecoveryReplacementShellOnlyAcceptance `json:"shellOnlyAcceptance,omitempty"`
}

func (request PrivilegedReplacementCommitRequest) validateRecoveryContract() error {
	if err := request.PlanID.validateRecoveryContract(); err != nil {
		return err
	}
	if request.ShellOnlyAcceptance != nil {
		if err := request.ShellOnlyAcceptance.validateRecoveryContract(); err != nil {
			return err
		}
		if request.ShellOnlyAcceptance.PlanID != request.PlanID {
			return fmt.Errorf("recovery: shell-only acceptance is not bound to replacement plan")
		}
	}
	return nil
}

// RecoveryReplacementPlanResolver is the daemon-owned plan registry boundary.
// It must atomically mint a lease after deriving the authoritative generation
// and complete census, and atomically resolve/consume a commit only while the
// plan remains unexpired, unused, and equal to current registry structure and
// generation. Any structure or generation change invalidates the plan.
type RecoveryReplacementPlanResolver interface {
	CreateReplacementPlan(PrivilegedReplacementPlanRequest) PrivilegedReplacementPlanResult
	ResolveAndConsumeReplacementPlan(PrivilegedReplacementCommitRequest) RecoveryReplacementOutcome
}

// RecoveryReplacementOutcomeState is the redacted terminal disposition of a
// controlled replacement after a commit is attempted.
type RecoveryReplacementOutcomeState string

const (
	RecoveryReplacementOutcomeCommitted RecoveryReplacementOutcomeState = "committed"
	RecoveryReplacementOutcomeDeferred  RecoveryReplacementOutcomeState = "deferred"
	RecoveryReplacementOutcomeFailed    RecoveryReplacementOutcomeState = "failed"
)

// RecoveryReplacementOutcome is safe for browser projection: it deliberately
// excludes the plan handle, pane list, generation, and raw failure detail.
type RecoveryReplacementOutcome struct {
	State      RecoveryReplacementOutcomeState `json:"state"`
	DetailCode RecoveryDetailCode              `json:"detailCode"`
}

func (outcome RecoveryReplacementOutcome) validateRecoveryContract() error {
	if err := outcome.DetailCode.validateRecoveryContract(); err != nil {
		return err
	}
	switch outcome.State {
	case RecoveryReplacementOutcomeCommitted:
		if outcome.DetailCode != RecoveryDetailNone {
			return fmt.Errorf("recovery: committed replacement has failure detail")
		}
	case RecoveryReplacementOutcomeDeferred:
		if outcome.DetailCode != RecoveryDetailReplacementDeferred {
			return fmt.Errorf("recovery: deferred replacement has invalid detail")
		}
	case RecoveryReplacementOutcomeFailed:
		if outcome.DetailCode != RecoveryDetailReplacementFailed &&
			outcome.DetailCode != RecoveryDetailReplacementPlanInvalid {
			return fmt.Errorf("recovery: failed replacement has invalid detail")
		}
	default:
		return fmt.Errorf("recovery: unknown replacement outcome state %q", outcome.State)
	}
	return nil
}

// ActivePanePersistenceRequest is distinct from connection-scoped pane-focus:
// sessiond validates and persists the workspace-qualified active selection.
type ActivePanePersistenceRequest struct {
	Pane RecoveryPaneRef `json:"pane"`
}

func (request ActivePanePersistenceRequest) validateRecoveryContract() error {
	return request.Pane.validateRecoveryContract()
}

type ActivePanePersistenceResult struct {
	Pane       RecoveryPaneRef    `json:"pane"`
	DetailCode RecoveryDetailCode `json:"detailCode"`
}

func (result ActivePanePersistenceResult) validateRecoveryContract() error {
	if err := result.Pane.validateRecoveryContract(); err != nil {
		return err
	}
	if err := result.DetailCode.validateRecoveryContract(); err != nil {
		return err
	}
	if result.DetailCode != RecoveryDetailNone && result.DetailCode != RecoveryDetailActivePaneInvalid {
		return fmt.Errorf("recovery: invalid active-pane persistence detail")
	}
	return nil
}

func (request PrivilegedLifecycleCaptureRequest) validateRecoveryContract() error {
	return request.Callback.validateRecoveryContract()
}

func (outcome PrivilegedLifecycleCaptureOutcome) validateRecoveryContract() error {
	return outcome.Outcome.validateRecoveryContract()
}

// OwnerLocalRecoveryMessage is structurally separate from Message. It is the
// only privileged recovery envelope and its decoder is intended exclusively for
// the authenticated Unix daemon transport, never the browser /ws relay.
type OwnerLocalRecoveryMessage struct {
	Type                   string                              `json:"type"`
	CID                    uint64                              `json:"cid,omitempty"`
	LifecycleLeaseDelivery *RecoveryLifecycleLeaseDelivery     `json:"lifecycleLeaseDelivery,omitempty"`
	LifecycleCapture       *PrivilegedLifecycleCaptureRequest  `json:"lifecycleCapture,omitempty"`
	LifecycleOutcome       *PrivilegedLifecycleCaptureOutcome  `json:"lifecycleOutcome,omitempty"`
	ReplacementPlan        *PrivilegedReplacementPlanRequest   `json:"replacementPlan,omitempty"`
	ReplacementResult      *PrivilegedReplacementPlanResult    `json:"replacementResult,omitempty"`
	ReplacementCommit      *PrivilegedReplacementCommitRequest `json:"replacementCommit,omitempty"`
}

func (message OwnerLocalRecoveryMessage) validateRecoveryContract() error {
	payloads := 0
	for _, present := range []bool{
		message.LifecycleLeaseDelivery != nil,
		message.LifecycleCapture != nil,
		message.LifecycleOutcome != nil,
		message.ReplacementPlan != nil,
		message.ReplacementResult != nil,
		message.ReplacementCommit != nil,
	} {
		if present {
			payloads++
		}
	}
	if payloads != 1 {
		return fmt.Errorf("recovery: owner-local envelope must contain exactly one payload")
	}
	switch message.Type {
	case TypeLifecycleLeaseDelivery:
		if message.LifecycleLeaseDelivery == nil {
			return fmt.Errorf("recovery: lifecycle lease delivery payload is missing")
		}
		return message.LifecycleLeaseDelivery.validateRecoveryContract()
	case TypeLifecycleCapture:
		if message.LifecycleCapture == nil {
			return fmt.Errorf("recovery: lifecycle capture payload is missing")
		}
		return message.LifecycleCapture.validateRecoveryContract()
	case TypeLifecycleCaptureOutcome:
		if message.LifecycleOutcome == nil {
			return fmt.Errorf("recovery: lifecycle outcome payload is missing")
		}
		return message.LifecycleOutcome.validateRecoveryContract()
	case TypeReplacementPlan:
		if message.ReplacementPlan == nil {
			return fmt.Errorf("recovery: replacement plan payload is missing")
		}
		return message.ReplacementPlan.validateRecoveryContract()
	case TypeReplacementPlanResult:
		if message.ReplacementResult == nil {
			return fmt.Errorf("recovery: replacement plan result payload is missing")
		}
		return message.ReplacementResult.validateRecoveryContract()
	case TypeReplacementCommit:
		if message.ReplacementCommit == nil {
			return fmt.Errorf("recovery: replacement commit payload is missing")
		}
		return message.ReplacementCommit.validateRecoveryContract()
	default:
		return fmt.Errorf("recovery: unknown owner-local message type %q", message.Type)
	}
}

func (message OwnerLocalRecoveryMessage) MarshalJSON() ([]byte, error) {
	if err := message.validateRecoveryContract(); err != nil {
		return nil, err
	}
	type wire OwnerLocalRecoveryMessage
	return json.Marshal(wire(message))
}

func (message *OwnerLocalRecoveryMessage) UnmarshalJSON(data []byte) error {
	if len(data) == 0 || len(data) > RecoveryMaxContractBytes {
		return fmt.Errorf("recovery: owner-local recovery message exceeds input limit")
	}
	type wire OwnerLocalRecoveryMessage
	var decoded wire
	if err := decodeRecoveryJSON(data, &decoded); err != nil {
		return err
	}
	result := OwnerLocalRecoveryMessage(decoded)
	if err := result.validateRecoveryContract(); err != nil {
		return err
	}
	*message = result
	return nil
}

// writeFrame writes a single framed message: a 5-byte header consisting of a
// big-endian uint32 length (kind byte + payload) followed by the kind byte,
// then the payload (if any).
func writeFrame(w io.Writer, kind byte, payload []byte) error {
	var hdr [5]byte
	binary.BigEndian.PutUint32(hdr[0:4], uint32(1+len(payload)))
	hdr[4] = kind
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if len(payload) > 0 {
		if _, err := w.Write(payload); err != nil {
			return err
		}
	}
	return nil
}

// WriteControl marshals msg to JSON and writes it as a FrameControl frame.
func WriteControl(w io.Writer, msg *Message) error {
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return writeFrame(w, FrameControl, payload)
}

// WriteOwnerLocalRecoveryControl writes a privileged recovery envelope only to
// the authenticated Unix daemon transport. It deliberately accepts a distinct
// type from Message, so browser /ws code cannot accidentally serialize this
// payload through its generic control path.
func WriteOwnerLocalRecoveryControl(w io.Writer, msg *OwnerLocalRecoveryMessage) error {
	payload, err := MarshalRecoveryContract(msg)
	if err != nil {
		return err
	}
	return writeFrame(w, FrameControl, payload)
}

// DecodeOwnerLocalRecoveryControl decodes an owner-local recovery envelope.
// Callers must use it only after authenticating the Unix daemon transport; the
// browser relay MUST call DecodeBrowserRecoveryMessage for recovery traffic and
// reject owner-local kinds and fields before forwarding anything over /ws.
func DecodeOwnerLocalRecoveryControl(payload []byte) (*OwnerLocalRecoveryMessage, error) {
	var message OwnerLocalRecoveryMessage
	if err := DecodeRecoveryContract(payload, &message); err != nil {
		return nil, err
	}
	return &message, nil
}

// WritePaneData writes a FramePaneData frame whose payload is
// [4-byte LITTLE-ENDIAN paneId][raw bytes]. Little-endian matches the existing
// browser framing so serve can bridge the body without rewriting it. The body
// is binary-safe (may contain newlines and NUL bytes).
func WritePaneData(w io.Writer, paneID uint32, data []byte) error {
	payload := make([]byte, 4+len(data))
	binary.LittleEndian.PutUint32(payload[0:4], paneID)
	copy(payload[4:], data)
	return writeFrame(w, FramePaneData, payload)
}

// DecodePaneData splits a FramePaneData payload into its little-endian paneID
// and raw body. A payload shorter than the 4-byte paneId header is malformed
// and yields (0, nil) defensively rather than panicking.
func DecodePaneData(payload []byte) (paneID uint32, data []byte) {
	if len(payload) < 4 {
		return 0, nil
	}
	return binary.LittleEndian.Uint32(payload[0:4]), payload[4:]
}

// ReadFrame reads one frame and returns its kind and payload. This is the
// frozen 3-value signature (kind, payload, err) and must not change shape.
func ReadFrame(r io.Reader) (kind byte, payload []byte, err error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	total := binary.BigEndian.Uint32(hdr[:])
	if total < 1 {
		return 0, nil, fmt.Errorf("sessiond: frame length %d too short (need >=1 for kind byte)", total)
	}
	buf := make([]byte, total)
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0, nil, err
	}
	return buf[0], buf[1:], nil
}

// Message is the generic browser-capable control envelope. Every v1 request,
// reply, event, and error is this struct with a different Type. Privileged
// recovery traffic is structurally excluded and uses OwnerLocalRecoveryMessage.
// Generic JSON decoding intentionally retains the frozen additive behavior.
// The later /ws relay lane MUST use DecodeBrowserRecoveryMessage for recovery
// traffic before forwarding it across the browser boundary.
// The JSON tags are FROZEN per the v1 wire protocol contract (see
// docs/plans/2026-06-01-session-persistence-design.md) and must never change.
type Message struct {
	Type        string          `json:"type"`
	CID         uint64          `json:"cid,omitempty"`         // request/reply correlation, 0 = unsolicited event
	ClientRef   string          `json:"clientRef,omitempty"`   // client-minted optimistic-create correlation id
	WorkspaceID string          `json:"workspaceId,omitempty"` //
	Name        string          `json:"name,omitempty"`        //
	PaneID      int             `json:"paneId,omitempty"`      // workspace-local
	Cols        int             `json:"cols,omitempty"`        //
	Rows        int             `json:"rows,omitempty"`        //
	Cmd         []string        `json:"cmd,omitempty"`         // argv, empty => default $SHELL
	Title       string          `json:"title,omitempty"`       //
	Breakpoint  string          `json:"breakpoint,omitempty"`  // responsive layout key (opaque to daemon)
	ClientKind  string          `json:"clientKind,omitempty"`  // "interactive" (browser/human) | "agent" (MCP/automation)
	Layout      string          `json:"layout,omitempty"`      // opaque dockview layout JSON blob
	Workspaces  []WorkspaceInfo `json:"workspaces,omitempty"`  //
	Panes       []PaneInfo      `json:"panes,omitempty"`       //
	Code        string          `json:"code,omitempty"`        // error code
	Error       string          `json:"error,omitempty"`       // human-readable error text

	// Activity-aware close fields (ADDITIVE). The pointer counts and risks
	// preserve required zero and empty values on confirmation-required outcomes
	// without adding these fields to unrelated messages.
	TargetKind       string           `json:"targetKind,omitempty"`       // "pane" | "workspace"
	CloseStatus      string           `json:"closeStatus,omitempty"`      // "closed" | "confirmation-required" | "failed"
	Ticket           string           `json:"ticket,omitempty"`           // opaque daemon-issued confirmation ticket
	BusyCount        *int             `json:"busyCount,omitempty"`        // present for confirmation-required, including zero
	UnknownCount     *int             `json:"unknownCount,omitempty"`     // present for confirmation-required, including zero
	Risks            *[]CloseRiskInfo `json:"risks,omitempty"`            // present for confirmation-required, including []
	OmittedRiskCount *int             `json:"omittedRiskCount,omitempty"` // present for confirmation-required, including zero
	FailureCode      string           `json:"failureCode,omitempty"`      // stable close failure category

	// Browser pane fields (used in create-pane and pane-added for browser surface kinds)
	SurfaceKind string `json:"surfaceKind,omitempty"`

	// Layout placement fields (create-pane request → pane-added broadcast → browser dockview)
	Placement       string `json:"placement,omitempty"`       // tab|split-right|split-left|split-above|split-below
	ReferencePaneID int    `json:"referencePaneId,omitempty"` // pane to split relative to; 0 = active pane

	// MCP relay fields (browser-action, screen-snapshot-result, shell-prompt, get-layout).
	Action     string     `json:"action,omitempty"`   // browser-action verb: click/fill/...
	Ref        string     `json:"ref,omitempty"`      // element ref e1,e2 from snapshot
	Selector   string     `json:"selector,omitempty"` // CSS selector
	Value      string     `json:"value,omitempty"`    // input value for fill/type
	Key        string     `json:"key,omitempty"`      // keyboard key for press
	Expression string     `json:"expr,omitempty"`     // JS expression for eval
	Text       string     `json:"text,omitempty"`     // plain-text result: screen snapshot, eval
	ExitCode   int        `json:"exitCode,omitempty"` // OSC 133 command exit code
	Cursor     *CursorPos `json:"cursor,omitempty"`   // cursor {row,col} for screen snapshot
	ASCII      string     `json:"ascii,omitempty"`    // ASCII layout diagram, get-layout result

	// Real process exit fields (pane-closed only, process-exit-driven close).
	// ProcessExitCode is a pointer so 0 (a normal successful exit) is
	// distinguishable from "field absent" (e.g. a client-requested close,
	// which has no real process exit code).
	ProcessExitCode *int  `json:"processExitCode,omitempty"` // real shell process exit code, set on pane-closed only
	RuntimeMs       int64 `json:"runtimeMs,omitempty"`       // real shell process wall-clock runtime, set on pane-closed only

	// Params carries the browser-command parameters as raw JSON for passthrough
	// relay (TypeBrowserCommand). Schema (see docs/muxterm-client-protocol.md):
	//   { "action": "navigate|click|scroll|evaluate|back|forward|reload",
	//     "selector"?: string,        // CSS selector — element targeting
	//     "x"?: number, "y"?: number, // CSS px — coordinate targeting
	//     "url"?: string,             // for navigate
	//     "script"?: string,          // for evaluate
	//     "timeoutMs"?: number }      // evaluate timeout; default 30000, bounded
	// An action carries EXACTLY ONE of {selector} or {x,y}. evaluate is governed
	// by a bounded timeout (default 30s) so an injected script cannot hang the pane.
	Params json.RawMessage `json:"params,omitempty"`

	// Browser action result fields (browser-action-result event, shim → MCP round-trip).
	Snapshot string          `json:"snapshot,omitempty"` // accessibility tree YAML from browser_snapshot
	Result   json.RawMessage `json:"result,omitempty"`   // JS eval result (any JSON value)
	OK       bool            `json:"ok,omitempty"`       // true when action succeeded without error

	// URL carries the committed/loaded URL for TypeBrowserURL and TypeBrowserLoad
	// client-to-server browser pane navigation notifications.
	URL string `json:"url,omitempty"`

	// Scrollback pagination fields (ADDITIVE, post-v1; see TypeScrollbackPage).
	// LineCursor is deliberately NOT named "Cursor": Message.Cursor is the
	// frozen *CursorPos screen-snapshot field above and cannot be reused.
	//
	//   Request  (TypeScrollbackPage):       PaneID, LineCursor, Limit
	//   Reply    (TypeScrollbackPageResult): PaneID, Lines, NextCursor, StartLine
	//
	// LineCursor is an EXCLUSIVE upper bound expressed as an absolute
	// line-sequence number: the page returned is the (up to) Limit lines
	// immediately BEFORE it. Nil/omitted means "start just before the current
	// live viewport", i.e. the most recent page of history. NextCursor is the
	// value to send as the next request's LineCursor to page further back; nil
	// means no more retained history in that direction (the normal termination
	// condition for a paging loop). StartLine is the absolute sequence of the
	// first returned line, which reveals when a request was clamped to the
	// oldest retained line.
	LineCursor *uint64  `json:"lineCursor,omitempty"`
	Limit      int      `json:"limit,omitempty"`
	Lines      []string `json:"lines,omitempty"`
	NextCursor *uint64  `json:"nextCursor,omitempty"`
	StartLine  uint64   `json:"startLine,omitempty"`

	// Recovery browser-safe projection (ADDITIVE). Recovery is present only
	// when the pane has daemon-authoritative recovery state.
	Recovery             *PaneRecoveryInfo           `json:"recovery,omitempty"`
	RecoveryTransition   *PaneRecoveryTransition     `json:"recoveryTransition,omitempty"`
	RecoveryRetry        *RecoveryRetryRequest       `json:"recoveryRetry,omitempty"`
	RecoveryRetryResult  *RecoveryRetryResult        `json:"recoveryRetryResult,omitempty"`
	RecoverySelect       *RecoverySelectRequest      `json:"recoverySelect,omitempty"`
	RecoverySelectResult *RecoverySelectResult       `json:"recoverySelectResult,omitempty"`
	ProtocolHello        *ProtocolHelloRequest       `json:"protocolHello,omitempty"`
	ProtocolHelloResult  *ProtocolHelloResult        `json:"protocolHelloResult,omitempty"`
	ReplacementOutcome   *RecoveryReplacementOutcome `json:"replacementOutcome,omitempty"`

	// Active-pane persistence has only a workspace-qualified pane reference
	// and a stable result code. It remains distinct from connection-scoped
	// pane-focus authority.
	ActivePanePersistence       *ActivePanePersistenceRequest `json:"activePanePersistence,omitempty"`
	ActivePanePersistenceResult *ActivePanePersistenceResult  `json:"activePanePersistenceResult,omitempty"`
}

// decodeRecoveryJSON applies strict object-field and trailing-value validation
// for recovery-only protocol shapes. Generic Message keeps its frozen additive
// behavior, but its recovery fields are always decoded through these bounded,
// validated subcontracts.
func decodeRecoveryJSON(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("recovery: decode protocol contract: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("recovery: protocol contract has trailing JSON value")
		}
		return fmt.Errorf("recovery: decode trailing protocol value: %w", err)
	}
	return nil
}

func isOwnerLocalRecoveryType(messageType string) bool {
	switch messageType {
	case TypeLifecycleLeaseDelivery,
		TypeLifecycleCapture,
		TypeLifecycleCaptureOutcome,
		TypeReplacementPlan,
		TypeReplacementPlanResult,
		TypeReplacementCommit:
		return true
	default:
		return false
	}
}

type browserPrivilegeProbe struct {
	Type                   string          `json:"type"`
	PrivilegedRecovery     json.RawMessage `json:"privilegedRecovery"`
	LifecycleLeaseDelivery json.RawMessage `json:"lifecycleLeaseDelivery"`
	LifecycleCapture       json.RawMessage `json:"lifecycleCapture"`
	LifecycleOutcome       json.RawMessage `json:"lifecycleOutcome"`
	ReplacementPlan        json.RawMessage `json:"replacementPlan"`
	ReplacementResult      json.RawMessage `json:"replacementResult"`
	ReplacementCommit      json.RawMessage `json:"replacementCommit"`
	Binding                json.RawMessage `json:"binding"`
}

func (probe browserPrivilegeProbe) hasOwnerLocalPayload() bool {
	return probe.PrivilegedRecovery != nil ||
		probe.LifecycleLeaseDelivery != nil ||
		probe.LifecycleCapture != nil ||
		probe.LifecycleOutcome != nil ||
		probe.ReplacementPlan != nil ||
		probe.ReplacementResult != nil ||
		probe.ReplacementCommit != nil ||
		probe.Binding != nil
}

func browserRecoveryPayloadField(messageType string) (string, bool) {
	switch messageType {
	case TypeProtocolHello:
		return "protocolHello", true
	case TypeProtocolHelloResult:
		return "protocolHelloResult", true
	case TypePaneRecoveryChanged:
		return "recoveryTransition", true
	case TypeRecoveryRetry:
		return "recoveryRetry", true
	case TypeRecoveryRetryResult:
		return "recoveryRetryResult", true
	case TypeRecoverySelect:
		return "recoverySelect", true
	case TypeRecoverySelectResult:
		return "recoverySelectResult", true
	case TypeReplacementOutcome:
		return "replacementOutcome", true
	case TypeSetActivePane:
		return "activePanePersistence", true
	case TypeSetActivePaneResult:
		return "activePanePersistenceResult", true
	default:
		return "", false
	}
}

func validateBrowserRecoveryFieldAllowlist(data []byte, messageType string) error {
	payloadField, recoveryType := browserRecoveryPayloadField(messageType)
	if !recoveryType {
		return nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return fmt.Errorf("recovery: decode browser field allowlist: %w", err)
	}
	for field := range fields {
		if field != "type" && field != "cid" && field != payloadField {
			return fmt.Errorf("recovery: field %q is forbidden for browser recovery type %q", field, messageType)
		}
	}
	return nil
}

// ValidateBrowserRecoveryMessage allowlists recovery type/payload pairings in a
// decoded generic envelope. The later /ws relay MUST pair this validation with
// DecodeBrowserRecoveryMessage so raw owner-local or unknown fields are rejected
// before generic decoding can discard them.
func ValidateBrowserRecoveryMessage(message *Message) error {
	if message == nil {
		return fmt.Errorf("recovery: nil browser message")
	}
	if isOwnerLocalRecoveryType(message.Type) {
		return fmt.Errorf("recovery: owner-local message type %q is forbidden on browser transport", message.Type)
	}

	payloads := 0
	for _, present := range []bool{
		message.Recovery != nil,
		message.RecoveryTransition != nil,
		message.RecoveryRetry != nil,
		message.RecoveryRetryResult != nil,
		message.RecoverySelect != nil,
		message.RecoverySelectResult != nil,
		message.ProtocolHello != nil,
		message.ProtocolHelloResult != nil,
		message.ReplacementOutcome != nil,
		message.ActivePanePersistence != nil,
		message.ActivePanePersistenceResult != nil,
	} {
		if present {
			payloads++
		}
	}

	switch message.Type {
	case TypeProtocolHello:
		if payloads != 1 || message.ProtocolHello == nil {
			return fmt.Errorf("recovery: protocol hello has invalid payload")
		}
		return message.ProtocolHello.validateRecoveryContract()
	case TypeProtocolHelloResult:
		if payloads != 1 || message.ProtocolHelloResult == nil {
			return fmt.Errorf("recovery: protocol hello result has invalid payload")
		}
		return message.ProtocolHelloResult.validateRecoveryContract()
	case TypePaneRecoveryChanged:
		if payloads != 1 || message.RecoveryTransition == nil {
			return fmt.Errorf("recovery: recovery transition has invalid payload")
		}
		return message.RecoveryTransition.validateRecoveryContract()
	case TypeRecoveryRetry:
		if payloads != 1 || message.RecoveryRetry == nil {
			return fmt.Errorf("recovery: recovery retry has invalid payload")
		}
		return message.RecoveryRetry.validateRecoveryContract()
	case TypeRecoveryRetryResult:
		if payloads != 1 || message.RecoveryRetryResult == nil {
			return fmt.Errorf("recovery: recovery retry result has invalid payload")
		}
		return message.RecoveryRetryResult.validateRecoveryContract()
	case TypeRecoverySelect:
		if payloads != 1 || message.RecoverySelect == nil {
			return fmt.Errorf("recovery: recovery selection has invalid payload")
		}
		return message.RecoverySelect.validateRecoveryContract()
	case TypeRecoverySelectResult:
		if payloads != 1 || message.RecoverySelectResult == nil {
			return fmt.Errorf("recovery: recovery selection result has invalid payload")
		}
		return message.RecoverySelectResult.validateRecoveryContract()
	case TypeReplacementOutcome:
		if payloads != 1 || message.ReplacementOutcome == nil {
			return fmt.Errorf("recovery: replacement outcome has invalid payload")
		}
		return message.ReplacementOutcome.validateRecoveryContract()
	case TypeSetActivePane:
		if payloads != 1 || message.ActivePanePersistence == nil {
			return fmt.Errorf("recovery: active-pane persistence request has invalid payload")
		}
		return message.ActivePanePersistence.validateRecoveryContract()
	case TypeSetActivePaneResult:
		if payloads != 1 || message.ActivePanePersistenceResult == nil {
			return fmt.Errorf("recovery: active-pane persistence result has invalid payload")
		}
		return message.ActivePanePersistenceResult.validateRecoveryContract()
	case TypePaneAdded, TypePaneCreated, TypeComposition:
		if payloads == 0 {
			return nil
		}
		if payloads == 1 && message.Recovery != nil {
			return message.Recovery.validateRecoveryContract()
		}
		return fmt.Errorf("recovery: pane projection has invalid recovery payload")
	default:
		if payloads != 0 {
			return fmt.Errorf("recovery: non-recovery message has a recovery payload")
		}
		return nil
	}
}

// DecodeBrowserRecoveryMessage is the explicit browser /ws recovery decoder and
// allowlist. The later relay lane MUST call it for recovery traffic. It bounds
// recovery-specific input, rejects owner-local type names and payload field
// names before generic Message decoding, and validates the resulting
// browser-safe recovery shape.
func DecodeBrowserRecoveryMessage(data []byte) (*Message, error) {
	if len(data) == 0 || len(data) > RecoveryMaxBrowserRecoveryMessageBytes {
		return nil, fmt.Errorf("recovery: browser control message exceeds input limit")
	}
	var probe browserPrivilegeProbe
	if err := json.Unmarshal(data, &probe); err != nil {
		return nil, fmt.Errorf("recovery: decode browser control message: %w", err)
	}
	if isOwnerLocalRecoveryType(probe.Type) || probe.hasOwnerLocalPayload() {
		return nil, fmt.Errorf("recovery: owner-local recovery payload is forbidden on browser transport")
	}
	if err := validateBrowserRecoveryFieldAllowlist(data, probe.Type); err != nil {
		return nil, err
	}
	type wire Message
	var decoded wire
	if err := decodeRecoveryJSON(data, &decoded); err != nil {
		return nil, err
	}
	message := Message(decoded)
	if err := ValidateBrowserRecoveryMessage(&message); err != nil {
		return nil, err
	}
	return &message, nil
}

// CloseOutcomeMessage maps a daemon close transaction result onto the additive
// wire envelope. cid belongs to the caller's current transport domain: the
// daemon server uses its socket cid, while the browser relay supplies the
// initiating browser cid after its independent daemon request completes.
func CloseOutcomeMessage(cid uint64, outcome CloseOutcome) *Message {
	msg := &Message{
		Type:        TypeCloseOutcome,
		CID:         cid,
		TargetKind:  string(outcome.TargetKind),
		WorkspaceID: outcome.WorkspaceID,
		PaneID:      outcome.PaneID,
		CloseStatus: string(outcome.Status),
	}

	switch outcome.Status {
	case CloseStatusConfirmationRequired:
		busyCount := outcome.BusyCount
		unknownCount := outcome.UnknownCount
		omittedRiskCount := outcome.OmittedRiskCount
		risks := make([]CloseRiskInfo, len(outcome.Risks))
		for i, risk := range outcome.Risks {
			risks[i] = CloseRiskInfo{
				PaneID:         risk.PaneID,
				Title:          risk.Title,
				Classification: string(risk.Classification),
				Reason:         string(risk.Reason),
			}
		}
		msg.Ticket = outcome.Ticket
		msg.BusyCount = &busyCount
		msg.UnknownCount = &unknownCount
		msg.Risks = &risks
		msg.OmittedRiskCount = &omittedRiskCount
	case CloseStatusFailed:
		msg.FailureCode = outcome.FailureCode
		msg.Error = outcome.Error
	}

	return msg
}

// ParseCloseOutcomeMessage decodes the additive close-outcome envelope into the
// daemon transaction shape. It rejects malformed outcomes so a relay never
// grants destructive authority based on an incomplete daemon reply.
func ParseCloseOutcomeMessage(msg *Message) (CloseOutcome, error) {
	if msg == nil || msg.Type != TypeCloseOutcome {
		return CloseOutcome{}, fmt.Errorf("sessiond: expected %q reply", TypeCloseOutcome)
	}

	target := CloseTarget{
		Kind:        CloseTargetKind(msg.TargetKind),
		WorkspaceID: msg.WorkspaceID,
		PaneID:      msg.PaneID,
	}
	outcome := CloseOutcome{
		Status:      CloseStatus(msg.CloseStatus),
		TargetKind:  target.Kind,
		WorkspaceID: target.WorkspaceID,
		PaneID:      target.PaneID,
		Ticket:      msg.Ticket,
		FailureCode: msg.FailureCode,
		Error:       msg.Error,
	}

	switch outcome.Status {
	case CloseStatusClosed:
		if !target.valid() {
			return CloseOutcome{}, fmt.Errorf("sessiond: closed close outcome has invalid target")
		}
	case CloseStatusConfirmationRequired:
		if !target.valid() || outcome.Ticket == "" ||
			msg.BusyCount == nil || msg.UnknownCount == nil ||
			msg.Risks == nil || msg.OmittedRiskCount == nil {
			return CloseOutcome{}, fmt.Errorf("sessiond: confirmation-required close outcome is incomplete")
		}
		outcome.BusyCount = *msg.BusyCount
		outcome.UnknownCount = *msg.UnknownCount
		outcome.OmittedRiskCount = *msg.OmittedRiskCount
		outcome.Risks = make([]CloseRisk, len(*msg.Risks))
		for i, risk := range *msg.Risks {
			classification := ActivityClassification(risk.Classification)
			reason := ActivityReason(risk.Reason)
			if (classification != ActivityBusy && classification != ActivityUnknown) ||
				!validCloseActivityReason(reason) {
				return CloseOutcome{}, fmt.Errorf("sessiond: close outcome contains invalid risk")
			}
			outcome.Risks[i] = CloseRisk{
				PaneID:         risk.PaneID,
				Title:          risk.Title,
				Classification: classification,
				Reason:         reason,
			}
		}
	case CloseStatusFailed:
		// A malformed or expired opaque ticket has no recoverable target identity
		// at daemon scope. The browser relay overlays its locally-correlated
		// target before forwarding such a failure to the browser.
	default:
		return CloseOutcome{}, fmt.Errorf("sessiond: invalid close outcome status %q", msg.CloseStatus)
	}

	return outcome, nil
}

// CursorPos is a 0-indexed terminal cursor position carried by screen-snapshot-result.
type CursorPos struct {
	Row int `json:"row"`
	Col int `json:"col"`
}

// WorkspaceInfo is one entry in a workspace-list reply.
type WorkspaceInfo struct {
	WorkspaceID string `json:"workspaceId"`
	Name        string `json:"name,omitempty"`
	ClientRef   string `json:"clientRef,omitempty"`
	PaneCount   int    `json:"paneCount"`
}

// PaneInfo is one entry in a composition reply or pane-added event.
type PaneInfo struct {
	PaneID      int    `json:"paneId"`
	SurfaceKind string `json:"surfaceKind,omitempty"` // "terminal" | "browser"; absent = "terminal"
	Cols        int    `json:"cols,omitempty"`
	Rows        int    `json:"rows,omitempty"`
	Title       string `json:"title,omitempty"`
	TotalSeq    uint64 `json:"totalSeq,omitempty"` // exact byte length of the replay data for this pane

	// Layout placement (only present on pane-added events from create-pane requests
	// that carried an explicit placement token; absent means default/tab placement).
	Placement       string `json:"placement,omitempty"`       // tab|split-right|split-left|split-above|split-below
	ReferencePaneID int    `json:"referencePaneId,omitempty"` // pane to split relative to; 0 = active pane

	// Recovery is an optional browser-safe projection. It intentionally omits
	// every daemon-local capture, launch, capability, and generation field.
	Recovery *PaneRecoveryInfo `json:"recovery,omitempty"`
}
