package sessiond

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"unicode"
	"unicode/utf8"
)

// RecoveryStoreGeneration is the optimistic-concurrency generation of durable
// recovery state. It is intentionally distinct from RecoveryGeneration, which
// identifies a reconstruction run in the recovery strategy contract.
type RecoveryStoreGeneration uint64

// RecoveryHistorySegmentID is the immutable store-issued identity of one
// durable recovered-history segment. Generation identifies the structural
// snapshot that authorized the flush; Sequence is the global filename/frame
// sequence. Both values are encoded as canonical decimal strings so browser
// peers never need to round-trip uint64 values through a JavaScript number.
type RecoveryHistorySegmentID struct {
	Generation RecoveryStoreGeneration `json:"generation"`
	Sequence   uint64                  `json:"sequence"`
}

func validateRecoveryHistorySegmentID(id RecoveryHistorySegmentID) error {
	if id.Generation == 0 || id.Sequence == 0 {
		return fmt.Errorf("%w: history segment ID has a zero field", ErrRecoveryStoreInvalid)
	}
	return nil
}

func parseCanonicalRecoveryHistoryIDUint64(value string) (uint64, error) {
	if len(value) == 0 || len(value) > 20 || value[0] == '0' {
		return 0, fmt.Errorf("%w: history segment ID is not a canonical nonzero decimal", ErrRecoveryStoreInvalid)
	}
	for index := 0; index < len(value); index++ {
		if value[index] < '0' || value[index] > '9' {
			return 0, fmt.Errorf("%w: history segment ID is not a canonical nonzero decimal", ErrRecoveryStoreInvalid)
		}
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil || parsed == 0 {
		return 0, fmt.Errorf("%w: history segment ID is not a canonical nonzero uint64", ErrRecoveryStoreInvalid)
	}
	return parsed, nil
}

// MarshalJSON emits the sole identity wire representation. It deliberately
// does not delegate to a struct encoder: byte order and decimal-string form are
// part of the recovery replay contract.
func (id RecoveryHistorySegmentID) MarshalJSON() ([]byte, error) {
	if err := validateRecoveryHistorySegmentID(id); err != nil {
		return nil, err
	}
	return []byte(
		`{"generation":"` + strconv.FormatUint(uint64(id.Generation), 10) +
			`","sequence":"` + strconv.FormatUint(id.Sequence, 10) + `"}`,
	), nil
}

// UnmarshalJSON accepts only the byte-for-byte canonical identity encoding.
// The exact re-encode comparison rejects duplicate/unknown/reordered keys,
// whitespace, numbers, leading zeros, and trailing JSON values together.
func (id *RecoveryHistorySegmentID) UnmarshalJSON(data []byte) error {
	if id == nil {
		return fmt.Errorf("%w: nil history segment ID destination", ErrRecoveryStoreInvalid)
	}
	var wire struct {
		Generation string `json:"generation"`
		Sequence   string `json:"sequence"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return fmt.Errorf("%w: decode history segment ID", ErrRecoveryStoreInvalid)
	}
	generation, err := parseCanonicalRecoveryHistoryIDUint64(wire.Generation)
	if err != nil {
		return err
	}
	sequence, err := parseCanonicalRecoveryHistoryIDUint64(wire.Sequence)
	if err != nil {
		return err
	}
	decoded := RecoveryHistorySegmentID{
		Generation: RecoveryStoreGeneration(generation),
		Sequence:   sequence,
	}
	canonical, err := decoded.MarshalJSON()
	if err != nil || !bytes.Equal(data, canonical) {
		return fmt.Errorf("%w: noncanonical history segment ID", ErrRecoveryStoreInvalid)
	}
	*id = decoded
	return nil
}

func recoveryHistorySegmentIDLess(left, right RecoveryHistorySegmentID) bool {
	if left.Generation != right.Generation {
		return left.Generation < right.Generation
	}
	return left.Sequence < right.Sequence
}

const (
	// RecoveryStoreSchemaVersion versions the private durable store framing.
	// It does not version any browser or recovery-strategy contract.
	RecoveryStoreSchemaVersion uint16 = 1

	RecoveryStoreMaxWorkspaces = 64
	RecoveryStoreMaxPanes      = 256
	RecoveryStoreMaxLayouts    = 256
	RecoveryStoreMaxCaptures   = 256
	RecoveryStoreMaxClaims     = 256
	RecoveryStoreMaxAttempts   = 256
	RecoveryStoreMaxOutcomes   = 256

	RecoveryStoreMaxNameBytes        = 1024
	RecoveryStoreMaxTitleBytes       = 1024
	RecoveryStoreMaxBreakpointBytes  = 64
	RecoveryStoreMaxLayoutBytes      = 96 * 1024
	RecoveryStoreMaxLayoutGroupBytes = 128
	RecoveryStoreMaxLayoutExtent     = 1 << 24
	RecoveryStoreLayoutRatioScale    = 1_000_000
	RecoveryStoreMaxMutationBytes    = 256 * 1024

	recoveryStoreMaxLayoutDepth = 32
	recoveryStoreMaxLayoutNodes = RecoveryStoreMaxPanes*2 - 1

	RecoveryStoreMaxJournalRecords = 4096
	RecoveryStoreMaxJournalBytes   = 64 * 1024 * 1024

	RecoveryStoreMaxHistoryLineBytes       = 16 * 1024
	RecoveryStoreMaxHistoryScanBytes       = 64 * 1024
	RecoveryStoreMaxHistoryLinesPerSegment = 1024
	RecoveryStoreMaxHistorySegmentBytes    = 1024 * 1024
	RecoveryStoreMaxHistorySegments        = 1024
	RecoveryStoreMaxHistoryTotalBytes      = 64 * 1024 * 1024
)

var (
	// ErrRecoveryStoreClosed means the handle has released its lock and file
	// descriptors. Open a new store instead of reusing the closed handle.
	ErrRecoveryStoreClosed = errors.New("recovery store is closed")
	// ErrRecoveryStorePoisoned means an uncertain write or publication failed.
	// Reopen so the durable files, rather than stale memory, become authority.
	ErrRecoveryStorePoisoned = errors.New("recovery store requires reopen")
	// ErrRecoveryStoreGenerationConflict means another committed mutation
	// advanced the store after the caller read its expected generation.
	ErrRecoveryStoreGenerationConflict = errors.New("recovery store generation conflict")
	// ErrRecoveryStoreAlreadyOpen means another handle holds the exclusive
	// writer lock for this root.
	ErrRecoveryStoreAlreadyOpen = errors.New("recovery store already has a writer")
	// ErrRecoveryStoreUnsafePath means an owner, mode, type, link, symlink, or
	// root-path check failed. Callers must fix the on-disk state explicitly.
	ErrRecoveryStoreUnsafePath = errors.New("recovery store filesystem state is unsafe")
	// ErrRecoveryStoreCorrupt means a complete durable frame or its ordering
	// failed validation. It deliberately never falls back to an invented state.
	ErrRecoveryStoreCorrupt = errors.New("recovery store data is corrupt")
	// ErrRecoveryStoreInvalid means a caller supplied a model, mutation, option,
	// or history value outside the bounded recovery-store contract.
	ErrRecoveryStoreInvalid = errors.New("recovery store input is invalid")
)

// RecoverySurfaceKind is the intentionally small set of persisted pane
// surfaces. A recovery record contains no browser URL, client reference, or
// terminal replay bytes.
type RecoverySurfaceKind string

const (
	RecoverySurfaceTerminal RecoverySurfaceKind = "terminal"
	RecoverySurfaceBrowser  RecoverySurfaceKind = "browser"
)

// RecoveryWorkspace is a durable workspace identity and presentation name.
// ActivePane, when present, is always qualified by the same workspace.
type RecoveryWorkspace struct {
	ID         RecoveryWorkspaceID `json:"id"`
	Name       string              `json:"name"`
	ActivePane *RecoveryPaneRef    `json:"activePane,omitempty"`
}

// RecoveryPane is the structural, shell-safe part of one pane. Its working
// directory is optional for browser surfaces and is never used as a filename.
// Root and capture generations deliberately live only in their frozen
// recovery-contract records; duplicating them here would create two sources of
// truth.
type RecoveryPane struct {
	Ref              RecoveryPaneRef          `json:"ref"`
	Surface          RecoverySurfaceKind      `json:"surface"`
	Columns          uint32                   `json:"columns"`
	Rows             uint32                   `json:"rows"`
	Title            string                   `json:"title"`
	WorkingDirectory RecoveryWorkingDirectory `json:"workingDirectory,omitempty"`
}

// RecoveryLayoutNodeKind closes the durable layout tree to split and pane-group
// nodes. Browser component state and arbitrary metadata have no representation.
type RecoveryLayoutNodeKind string

const (
	RecoveryLayoutNodeSplit RecoveryLayoutNodeKind = "split"
	RecoveryLayoutNodeGroup RecoveryLayoutNodeKind = "group"
)

// RecoveryLayoutOrientation is meaningful only for split nodes.
type RecoveryLayoutOrientation string

const (
	RecoveryLayoutHorizontal RecoveryLayoutOrientation = "horizontal"
	RecoveryLayoutVertical   RecoveryLayoutOrientation = "vertical"
)

// RecoveryLayoutGeometry is bounded viewport-relative geometry. Width and
// Height are nonzero, and the complete rectangle must fit within the hard
// layout extent.
type RecoveryLayoutGeometry struct {
	X      uint32 `json:"x"`
	Y      uint32 `json:"y"`
	Width  uint32 `json:"width"`
	Height uint32 `json:"height"`
}

// RecoveryLayoutNode is a closed recursive layout shape. Ratio is an integer
// fraction of RecoveryStoreLayoutRatioScale, avoiding non-finite or unstable
// floating-point durable values. Split children sum exactly to that scale.
// Group Views contain only stable, workspace-qualified pane references.
type RecoveryLayoutNode struct {
	Kind     RecoveryLayoutNodeKind `json:"kind"`
	Geometry RecoveryLayoutGeometry `json:"geometry"`
	Ratio    uint32                 `json:"ratio"`

	Orientation RecoveryLayoutOrientation `json:"orientation,omitempty"`
	Children    []RecoveryLayoutNode      `json:"children,omitempty"`

	GroupID    string            `json:"groupId,omitempty"`
	Views      []RecoveryPaneRef `json:"views,omitempty"`
	ActiveView *RecoveryPaneRef  `json:"activeView,omitempty"`
}

// RecoveryLayout is a store-owned, closed representation scoped to one
// workspace and breakpoint. ActiveGroup identifies a group in Root. Unknown
// fields, browser metadata, credentials, runtime state, and tool errors cannot
// be represented.
type RecoveryLayout struct {
	WorkspaceID RecoveryWorkspaceID `json:"workspaceId"`
	Breakpoint  string              `json:"breakpoint"`
	ActiveGroup string              `json:"activeGroup,omitempty"`
	Root        RecoveryLayoutNode  `json:"root"`
}

// RecoveryLayoutRef identifies a layout for idempotent deletion.
type RecoveryLayoutRef struct {
	WorkspaceID RecoveryWorkspaceID `json:"workspaceId"`
	Breakpoint  string              `json:"breakpoint"`
}

// RecoveryActivePane assigns one workspace's optional active pane. Clearing
// the assignment uses RecoveryMutationClearActivePane instead of a nil payload.
type RecoveryActivePane struct {
	WorkspaceID RecoveryWorkspaceID `json:"workspaceId"`
	Pane        RecoveryPaneRef     `json:"pane"`
}

// RecoveryCaptureKey is the stable identity of an ExactSessionCapture. The
// opaque external SessionID remains payload data and never participates in a
// durable filename.
type RecoveryCaptureKey struct {
	Pane           RecoveryPaneRef               `json:"pane"`
	StrategyID     RecoveryStrategyID            `json:"strategyId"`
	RootGeneration RecoveryRootProcessGeneration `json:"rootGeneration"`
	CaptureEpoch   RecoveryCaptureEpoch          `json:"captureEpoch"`
}

// RecoveryAttemptKey is the stable identity of one frozen RecoveryAttempt.
type RecoveryAttemptKey struct {
	Fence   RecoveryFence `json:"fence"`
	Ordinal uint8         `json:"ordinal"`
}

// RecoverySnapshot is the complete structural recovery state at one durable
// store generation. All slices are canonicalized by identity before they are
// persisted or returned.
type RecoverySnapshot struct {
	Generation RecoveryStoreGeneration `json:"generation"`
	Workspaces []RecoveryWorkspace     `json:"workspaces"`
	Panes      []RecoveryPane          `json:"panes"`
	Layouts    []RecoveryLayout        `json:"layouts"`
	Captures   []ExactSessionCapture   `json:"captures"`
	Claims     []RecoveryClaim         `json:"claims"`
	Attempts   []RecoveryAttempt       `json:"attempts"`
	Outcomes   []RecoveryOutcome       `json:"outcomes"`
}

// RecoveryMutationKind is a direct state assignment, deletion, or active-pane
// clear. It intentionally contains no lifecycle-transition policy.
type RecoveryMutationKind string

const (
	RecoveryMutationSetWorkspace    RecoveryMutationKind = "set-workspace"
	RecoveryMutationDeleteWorkspace RecoveryMutationKind = "delete-workspace"
	RecoveryMutationSetPane         RecoveryMutationKind = "set-pane"
	RecoveryMutationDeletePane      RecoveryMutationKind = "delete-pane"
	RecoveryMutationSetLayout       RecoveryMutationKind = "set-layout"
	RecoveryMutationDeleteLayout    RecoveryMutationKind = "delete-layout"
	RecoveryMutationSetActivePane   RecoveryMutationKind = "set-active-pane"
	RecoveryMutationClearActivePane RecoveryMutationKind = "clear-active-pane"
	RecoveryMutationSetCapture      RecoveryMutationKind = "set-capture"
	RecoveryMutationDeleteCapture   RecoveryMutationKind = "delete-capture"
	RecoveryMutationSetClaim        RecoveryMutationKind = "set-claim"
	RecoveryMutationDeleteClaim     RecoveryMutationKind = "delete-claim"
	RecoveryMutationSetAttempt      RecoveryMutationKind = "set-attempt"
	RecoveryMutationDeleteAttempt   RecoveryMutationKind = "delete-attempt"
	RecoveryMutationSetOutcome      RecoveryMutationKind = "set-outcome"
	RecoveryMutationDeleteOutcome   RecoveryMutationKind = "delete-outcome"
)

// RecoveryMutation has exactly one payload for its Kind. Pointer payloads make
// the encoded form unambiguous and avoid sentinel values that could accidentally
// become recovery authority.
type RecoveryMutation struct {
	Kind RecoveryMutationKind `json:"kind"`

	Workspace   *RecoveryWorkspace   `json:"workspace,omitempty"`
	WorkspaceID *RecoveryWorkspaceID `json:"workspaceId,omitempty"`

	Pane    *RecoveryPane    `json:"pane,omitempty"`
	PaneRef *RecoveryPaneRef `json:"paneRef,omitempty"`

	Layout    *RecoveryLayout    `json:"layout,omitempty"`
	LayoutRef *RecoveryLayoutRef `json:"layoutRef,omitempty"`

	ActivePane *RecoveryActivePane `json:"activePane,omitempty"`

	Capture    *ExactSessionCapture `json:"capture,omitempty"`
	CaptureKey *RecoveryCaptureKey  `json:"captureKey,omitempty"`

	Claim *RecoveryClaim `json:"claim,omitempty"`
	Fence *RecoveryFence `json:"fence,omitempty"`

	Attempt    *RecoveryAttempt    `json:"attempt,omitempty"`
	AttemptKey *RecoveryAttemptKey `json:"attemptKey,omitempty"`

	Outcome *RecoveryOutcome `json:"outcome,omitempty"`
}

// RecoveryHistorySegment carries literal display lines for a pane. ID is zero
// until the file store accepts a nonempty caller candidate and issues one.
// Callers render Lines as text and must never send them to an ANSI or VT
// parser.
type RecoveryHistorySegment struct {
	ID    RecoveryHistorySegmentID `json:"id"`
	Pane  RecoveryPaneRef          `json:"pane"`
	Lines []string                 `json:"lines"`
}

// RecoveryLoadResult is a deep-copied view of the durable structural state and
// inert history ordered by immutable store-issued segment sequence.
type RecoveryLoadResult struct {
	Snapshot RecoverySnapshot         `json:"snapshot"`
	History  []RecoveryHistorySegment `json:"history"`
}

// RecoveryCommitResult reports only the new optimistic store generation.
type RecoveryCommitResult struct {
	Generation RecoveryStoreGeneration `json:"generation"`
}

// RecoveryStoreOptions bounds journal and history retention. A zero value for
// each field inherits the corresponding conservative default. Nonzero values
// outside the public hard ceilings are rejected by OpenFileRecoveryStore.
type RecoveryStoreOptions struct {
	MaxJournalRecords int
	MaxJournalBytes   int

	MaxHistoryLineBytes       int
	MaxHistoryLinesPerSegment int
	MaxHistorySegmentBytes    int
	MaxHistorySegments        int
	MaxHistoryTotalBytes      int
}

// DefaultRecoveryStoreOptions returns the bounded default policy for one local
// owner-only store.
func DefaultRecoveryStoreOptions() RecoveryStoreOptions {
	return RecoveryStoreOptions{
		MaxJournalRecords:         128,
		MaxJournalBytes:           4 * 1024 * 1024,
		MaxHistoryLineBytes:       4096,
		MaxHistoryLinesPerSegment: 256,
		MaxHistorySegmentBytes:    256 * 1024,
		MaxHistorySegments:        128,
		MaxHistoryTotalBytes:      4 * 1024 * 1024,
	}
}

// RecoveryStore is the standalone durable boundary. It does not launch
// processes, inspect terminals, read ambient environment, or wire runtime
// behavior. Commit and FlushHistory serialize against one exclusive writer.
type RecoveryStore interface {
	Load() (RecoveryLoadResult, error)
	Commit(RecoveryStoreGeneration, RecoveryMutation) (RecoveryCommitResult, error)
	PublishSnapshot() error
	FlushHistory(RecoveryPaneRef, []string) (RecoveryHistorySegment, error)
	Close() error
}

// NewRecoverySnapshot returns the canonical empty recovery state. Generation
// zero is the only state before the first durable mutation.
func NewRecoverySnapshot() RecoverySnapshot {
	return RecoverySnapshot{
		Workspaces: make([]RecoveryWorkspace, 0),
		Panes:      make([]RecoveryPane, 0),
		Layouts:    make([]RecoveryLayout, 0),
		Captures:   make([]ExactSessionCapture, 0),
		Claims:     make([]RecoveryClaim, 0),
		Attempts:   make([]RecoveryAttempt, 0),
		Outcomes:   make([]RecoveryOutcome, 0),
	}
}

// ApplyRecoveryMutation validates, canonicalizes, and deterministically applies
// one direct assignment/deletion to a snapshot. Every accepted mutation advances
// the store generation exactly once, including an idempotent assignment or
// deletion whose visible state is already equal.
func ApplyRecoveryMutation(snapshot RecoverySnapshot, mutation RecoveryMutation) (RecoverySnapshot, error) {
	current, err := canonicalRecoverySnapshot(snapshot)
	if err != nil {
		return RecoverySnapshot{}, err
	}
	if current.Generation == RecoveryStoreGeneration(math.MaxUint64) {
		return RecoverySnapshot{}, fmt.Errorf("%w: generation overflow", ErrRecoveryStoreInvalid)
	}
	mutation, err = canonicalRecoveryMutation(mutation)
	if err != nil {
		return RecoverySnapshot{}, err
	}

	next := cloneRecoverySnapshot(current)
	switch mutation.Kind {
	case RecoveryMutationSetWorkspace:
		next.Workspaces = replaceWorkspace(next.Workspaces, *mutation.Workspace)
	case RecoveryMutationDeleteWorkspace:
		deleteWorkspace(&next, *mutation.WorkspaceID)
	case RecoveryMutationSetPane:
		next.Panes = replacePane(next.Panes, *mutation.Pane)
	case RecoveryMutationDeletePane:
		deletePane(&next, *mutation.PaneRef)
	case RecoveryMutationSetLayout:
		next.Layouts = replaceLayout(next.Layouts, *mutation.Layout)
	case RecoveryMutationDeleteLayout:
		next.Layouts = removeLayout(next.Layouts, *mutation.LayoutRef)
	case RecoveryMutationSetActivePane:
		if !recoverySnapshotHasWorkspace(next, mutation.ActivePane.WorkspaceID) ||
			!recoverySnapshotHasPane(next, mutation.ActivePane.Pane) {
			return RecoverySnapshot{}, fmt.Errorf("%w: active pane references missing structure", ErrRecoveryStoreInvalid)
		}
		assignActivePane(&next, *mutation.ActivePane)
	case RecoveryMutationClearActivePane:
		clearActivePane(&next, *mutation.WorkspaceID)
	case RecoveryMutationSetCapture:
		next.Captures = replaceCapture(next.Captures, *mutation.Capture)
	case RecoveryMutationDeleteCapture:
		deleteCapture(&next, *mutation.CaptureKey)
	case RecoveryMutationSetClaim:
		next.Claims = replaceClaim(next.Claims, *mutation.Claim)
	case RecoveryMutationDeleteClaim:
		deleteClaim(&next, *mutation.Fence)
	case RecoveryMutationSetAttempt:
		next.Attempts = replaceAttempt(next.Attempts, *mutation.Attempt)
	case RecoveryMutationDeleteAttempt:
		next.Attempts = removeAttempt(next.Attempts, *mutation.AttemptKey)
	case RecoveryMutationSetOutcome:
		next.Outcomes = replaceOutcome(next.Outcomes, *mutation.Outcome)
	case RecoveryMutationDeleteOutcome:
		next.Outcomes = removeOutcome(next.Outcomes, *mutation.Fence)
	default:
		return RecoverySnapshot{}, fmt.Errorf("%w: unknown mutation kind %q", ErrRecoveryStoreInvalid, mutation.Kind)
	}
	next.Generation++
	return canonicalRecoverySnapshot(next)
}

func normalizedRecoveryStoreOptions(options RecoveryStoreOptions) (RecoveryStoreOptions, error) {
	defaults := DefaultRecoveryStoreOptions()
	if options.MaxJournalRecords == 0 {
		options.MaxJournalRecords = defaults.MaxJournalRecords
	}
	if options.MaxJournalBytes == 0 {
		options.MaxJournalBytes = defaults.MaxJournalBytes
	}
	if options.MaxHistoryLineBytes == 0 {
		options.MaxHistoryLineBytes = defaults.MaxHistoryLineBytes
	}
	if options.MaxHistoryLinesPerSegment == 0 {
		options.MaxHistoryLinesPerSegment = defaults.MaxHistoryLinesPerSegment
	}
	if options.MaxHistorySegmentBytes == 0 {
		options.MaxHistorySegmentBytes = defaults.MaxHistorySegmentBytes
	}
	if options.MaxHistorySegments == 0 {
		options.MaxHistorySegments = defaults.MaxHistorySegments
	}
	if options.MaxHistoryTotalBytes == 0 {
		options.MaxHistoryTotalBytes = defaults.MaxHistoryTotalBytes
	}

	if options.MaxJournalRecords < 1 || options.MaxJournalRecords > RecoveryStoreMaxJournalRecords ||
		options.MaxJournalBytes < recoveryMinimumJournalBytes || options.MaxJournalBytes > RecoveryStoreMaxJournalBytes ||
		options.MaxHistoryLineBytes < 1 || options.MaxHistoryLineBytes > RecoveryStoreMaxHistoryLineBytes ||
		options.MaxHistoryLinesPerSegment < 1 || options.MaxHistoryLinesPerSegment > RecoveryStoreMaxHistoryLinesPerSegment ||
		options.MaxHistorySegmentBytes < 1 || options.MaxHistorySegmentBytes > RecoveryStoreMaxHistorySegmentBytes ||
		options.MaxHistorySegments < 1 || options.MaxHistorySegments > RecoveryStoreMaxHistorySegments ||
		options.MaxHistoryTotalBytes < 1 || options.MaxHistoryTotalBytes > RecoveryStoreMaxHistoryTotalBytes {
		return RecoveryStoreOptions{}, fmt.Errorf("%w: option exceeds a bounded store limit", ErrRecoveryStoreInvalid)
	}
	// Retention accounts for complete on-disk frames, not just history JSON
	// payloads. Requiring room for one frame prevents a valid staged segment
	// from being selected for pruning before it can be published.
	if options.MaxHistorySegmentBytes < options.MaxHistoryLineBytes ||
		options.MaxHistoryTotalBytes < options.MaxHistorySegmentBytes+recoveryFrameHeaderBytes {
		return RecoveryStoreOptions{}, fmt.Errorf("%w: history byte limits are inconsistent", ErrRecoveryStoreInvalid)
	}
	return options, nil
}

func canonicalRecoverySnapshot(snapshot RecoverySnapshot) (RecoverySnapshot, error) {
	out := NewRecoverySnapshot()
	out.Generation = snapshot.Generation

	if len(snapshot.Workspaces) > RecoveryStoreMaxWorkspaces ||
		len(snapshot.Panes) > RecoveryStoreMaxPanes ||
		len(snapshot.Layouts) > RecoveryStoreMaxLayouts ||
		len(snapshot.Captures) > RecoveryStoreMaxCaptures ||
		len(snapshot.Claims) > RecoveryStoreMaxClaims ||
		len(snapshot.Attempts) > RecoveryStoreMaxAttempts ||
		len(snapshot.Outcomes) > RecoveryStoreMaxOutcomes {
		return RecoverySnapshot{}, fmt.Errorf("%w: snapshot collection exceeds a store limit", ErrRecoveryStoreInvalid)
	}

	out.Workspaces = make([]RecoveryWorkspace, len(snapshot.Workspaces))
	for index, workspace := range snapshot.Workspaces {
		copied, err := canonicalRecoveryWorkspace(workspace)
		if err != nil {
			return RecoverySnapshot{}, err
		}
		out.Workspaces[index] = copied
	}
	out.Panes = make([]RecoveryPane, len(snapshot.Panes))
	for index, pane := range snapshot.Panes {
		copied, err := canonicalRecoveryPane(pane)
		if err != nil {
			return RecoverySnapshot{}, err
		}
		out.Panes[index] = copied
	}
	out.Layouts = make([]RecoveryLayout, len(snapshot.Layouts))
	for index, layout := range snapshot.Layouts {
		copied, err := canonicalRecoveryLayout(layout)
		if err != nil {
			return RecoverySnapshot{}, err
		}
		out.Layouts[index] = copied
	}
	out.Captures = make([]ExactSessionCapture, len(snapshot.Captures))
	for index, capture := range snapshot.Captures {
		capture = canonicalExactSessionCapture(capture)
		if err := capture.validateRecoveryContract(); err != nil {
			return RecoverySnapshot{}, invalidRecoveryStoreValue("capture", err)
		}
		out.Captures[index] = capture
	}
	out.Claims = make([]RecoveryClaim, len(snapshot.Claims))
	for index, claim := range snapshot.Claims {
		claim = canonicalRecoveryClaim(claim)
		if err := claim.validateRecoveryContract(); err != nil {
			return RecoverySnapshot{}, invalidRecoveryStoreValue("claim", err)
		}
		out.Claims[index] = claim
	}
	out.Attempts = make([]RecoveryAttempt, len(snapshot.Attempts))
	for index, attempt := range snapshot.Attempts {
		attempt = canonicalRecoveryAttempt(attempt)
		if err := attempt.validateRecoveryContract(); err != nil {
			return RecoverySnapshot{}, invalidRecoveryStoreValue("attempt", err)
		}
		out.Attempts[index] = attempt
	}
	out.Outcomes = make([]RecoveryOutcome, len(snapshot.Outcomes))
	for index, outcome := range snapshot.Outcomes {
		outcome = canonicalRecoveryOutcome(outcome)
		if err := outcome.validateRecoveryContract(); err != nil {
			return RecoverySnapshot{}, invalidRecoveryStoreValue("outcome", err)
		}
		out.Outcomes[index] = outcome
	}

	sort.Slice(out.Workspaces, func(left, right int) bool {
		return out.Workspaces[left].ID < out.Workspaces[right].ID
	})
	sort.Slice(out.Panes, func(left, right int) bool {
		return recoveryPaneRefLess(out.Panes[left].Ref, out.Panes[right].Ref)
	})
	sort.Slice(out.Layouts, func(left, right int) bool {
		if out.Layouts[left].WorkspaceID != out.Layouts[right].WorkspaceID {
			return out.Layouts[left].WorkspaceID < out.Layouts[right].WorkspaceID
		}
		return out.Layouts[left].Breakpoint < out.Layouts[right].Breakpoint
	})
	sort.Slice(out.Captures, func(left, right int) bool {
		return recoveryCaptureKeyLess(recoveryCaptureKeyForCapture(out.Captures[left]), recoveryCaptureKeyForCapture(out.Captures[right]))
	})
	sort.Slice(out.Claims, func(left, right int) bool {
		return recoveryFenceLess(out.Claims[left].Fence, out.Claims[right].Fence)
	})
	sort.Slice(out.Attempts, func(left, right int) bool {
		if recoveryFenceEqual(out.Attempts[left].Fence, out.Attempts[right].Fence) {
			return out.Attempts[left].Ordinal < out.Attempts[right].Ordinal
		}
		return recoveryFenceLess(out.Attempts[left].Fence, out.Attempts[right].Fence)
	})
	sort.Slice(out.Outcomes, func(left, right int) bool {
		return recoveryFenceLess(out.Outcomes[left].Fence, out.Outcomes[right].Fence)
	})

	if err := validateCanonicalRecoverySnapshot(out); err != nil {
		return RecoverySnapshot{}, err
	}
	return out, nil
}

func canonicalRecoveryWorkspace(workspace RecoveryWorkspace) (RecoveryWorkspace, error) {
	if err := validateRecoveryWorkspaceID(workspace.ID); err != nil {
		return RecoveryWorkspace{}, err
	}
	if err := validateRecoveryStoreText(workspace.Name, RecoveryStoreMaxNameBytes, "workspace name", false); err != nil {
		return RecoveryWorkspace{}, err
	}
	out := workspace
	if workspace.ActivePane != nil {
		pane := *workspace.ActivePane
		if err := pane.validateRecoveryContract(); err != nil {
			return RecoveryWorkspace{}, invalidRecoveryStoreValue("active pane", err)
		}
		out.ActivePane = &pane
	}
	return out, nil
}

func canonicalRecoveryPane(pane RecoveryPane) (RecoveryPane, error) {
	if err := pane.Ref.validateRecoveryContract(); err != nil {
		return RecoveryPane{}, invalidRecoveryStoreValue("pane", err)
	}
	if pane.Surface != RecoverySurfaceTerminal && pane.Surface != RecoverySurfaceBrowser {
		return RecoveryPane{}, fmt.Errorf("%w: pane surface is not terminal or browser", ErrRecoveryStoreInvalid)
	}
	if pane.Columns == 0 || pane.Rows == 0 {
		return RecoveryPane{}, fmt.Errorf("%w: pane dimensions must be nonzero", ErrRecoveryStoreInvalid)
	}
	if err := validateRecoveryStoreText(pane.Title, RecoveryStoreMaxTitleBytes, "pane title", false); err != nil {
		return RecoveryPane{}, err
	}
	if pane.WorkingDirectory != "" {
		if err := pane.WorkingDirectory.validateRecoveryContract(); err != nil {
			return RecoveryPane{}, invalidRecoveryStoreValue("pane working directory", err)
		}
	}
	return pane, nil
}

func canonicalRecoveryLayout(layout RecoveryLayout) (RecoveryLayout, error) {
	if err := validateRecoveryWorkspaceID(layout.WorkspaceID); err != nil {
		return RecoveryLayout{}, err
	}
	if err := validateRecoveryStoreText(layout.Breakpoint, RecoveryStoreMaxBreakpointBytes, "layout breakpoint", true); err != nil {
		return RecoveryLayout{}, err
	}
	if err := validateRecoveryStoreText(layout.ActiveGroup, RecoveryStoreMaxLayoutGroupBytes, "active layout group", false); err != nil {
		return RecoveryLayout{}, err
	}
	state := recoveryLayoutValidation{
		workspaceID: layout.WorkspaceID,
		groups:      make(map[string]struct{}),
		panes:       make(map[RecoveryPaneRef]struct{}),
	}
	root, err := canonicalRecoveryLayoutNode(layout.Root, 1, &state)
	if err != nil {
		return RecoveryLayout{}, err
	}
	if root.Ratio != RecoveryStoreLayoutRatioScale {
		return RecoveryLayout{}, fmt.Errorf("%w: layout root ratio must equal its scale", ErrRecoveryStoreInvalid)
	}
	if layout.ActiveGroup != "" {
		if _, ok := state.groups[layout.ActiveGroup]; !ok {
			return RecoveryLayout{}, fmt.Errorf("%w: active layout group is missing", ErrRecoveryStoreInvalid)
		}
	}
	out := RecoveryLayout{
		WorkspaceID: layout.WorkspaceID,
		Breakpoint:  layout.Breakpoint,
		ActiveGroup: layout.ActiveGroup,
		Root:        root,
	}
	encoded, err := json.Marshal(out)
	if err != nil || len(encoded) > RecoveryStoreMaxLayoutBytes {
		return RecoveryLayout{}, fmt.Errorf("%w: layout cannot be encoded within its bound", ErrRecoveryStoreInvalid)
	}
	return out, nil
}

// DecodeRecoveryLayout validates a serialized layout at the store boundary.
// Strict decoding rejects unknown fields recursively before a value can enter a
// mutation. Callers that already hold typed values receive the same validation
// from ApplyRecoveryMutation and Commit.
func DecodeRecoveryLayout(data []byte) (RecoveryLayout, error) {
	if len(data) == 0 || len(data) > RecoveryStoreMaxLayoutBytes || !utf8.Valid(data) {
		return RecoveryLayout{}, fmt.Errorf("%w: layout is not bounded UTF-8 JSON", ErrRecoveryStoreInvalid)
	}
	var layout RecoveryLayout
	if err := decodeRecoveryJSON(data, &layout); err != nil {
		return RecoveryLayout{}, fmt.Errorf("%w: layout does not match the closed schema: %v", ErrRecoveryStoreInvalid, err)
	}
	return canonicalRecoveryLayout(layout)
}

func canonicalRecoveryLayoutRef(reference RecoveryLayoutRef) (RecoveryLayoutRef, error) {
	if err := validateRecoveryWorkspaceID(reference.WorkspaceID); err != nil {
		return RecoveryLayoutRef{}, err
	}
	if err := validateRecoveryStoreText(reference.Breakpoint, RecoveryStoreMaxBreakpointBytes, "layout breakpoint", true); err != nil {
		return RecoveryLayoutRef{}, err
	}
	return reference, nil
}

func canonicalRecoveryActivePane(active RecoveryActivePane) (RecoveryActivePane, error) {
	if err := validateRecoveryWorkspaceID(active.WorkspaceID); err != nil {
		return RecoveryActivePane{}, err
	}
	if err := active.Pane.validateRecoveryContract(); err != nil {
		return RecoveryActivePane{}, invalidRecoveryStoreValue("active pane", err)
	}
	if active.Pane.WorkspaceID != active.WorkspaceID {
		return RecoveryActivePane{}, fmt.Errorf("%w: active pane is outside its workspace", ErrRecoveryStoreInvalid)
	}
	return active, nil
}

func canonicalRecoveryCaptureKey(key RecoveryCaptureKey) (RecoveryCaptureKey, error) {
	if err := key.Pane.validateRecoveryContract(); err != nil {
		return RecoveryCaptureKey{}, invalidRecoveryStoreValue("capture key", err)
	}
	if err := key.StrategyID.validateRecoveryContract(); err != nil {
		return RecoveryCaptureKey{}, invalidRecoveryStoreValue("capture key", err)
	}
	if key.RootGeneration == 0 || key.CaptureEpoch == 0 {
		return RecoveryCaptureKey{}, fmt.Errorf("%w: capture key has a zero generation or epoch", ErrRecoveryStoreInvalid)
	}
	return key, nil
}

func canonicalRecoveryAttemptKey(key RecoveryAttemptKey) (RecoveryAttemptKey, error) {
	if err := key.Fence.validateRecoveryContract(); err != nil {
		return RecoveryAttemptKey{}, invalidRecoveryStoreValue("attempt key", err)
	}
	if key.Ordinal >= RecoveryMaxAutomaticAttempts {
		return RecoveryAttemptKey{}, fmt.Errorf("%w: attempt key has an invalid ordinal", ErrRecoveryStoreInvalid)
	}
	return key, nil
}

func canonicalRecoveryMutation(mutation RecoveryMutation) (RecoveryMutation, error) {
	out := RecoveryMutation{Kind: mutation.Kind}
	if mutationPayloadCount(mutation) != 1 {
		return RecoveryMutation{}, fmt.Errorf("%w: mutation must contain exactly one payload", ErrRecoveryStoreInvalid)
	}

	switch mutation.Kind {
	case RecoveryMutationSetWorkspace:
		if mutation.Workspace == nil {
			break
		}
		workspace, err := canonicalRecoveryWorkspace(*mutation.Workspace)
		if err != nil {
			return RecoveryMutation{}, err
		}
		out.Workspace = &workspace
	case RecoveryMutationDeleteWorkspace, RecoveryMutationClearActivePane:
		if mutation.WorkspaceID == nil {
			break
		}
		id := *mutation.WorkspaceID
		if err := validateRecoveryWorkspaceID(id); err != nil {
			return RecoveryMutation{}, err
		}
		out.WorkspaceID = &id
	case RecoveryMutationSetPane:
		if mutation.Pane == nil {
			break
		}
		pane, err := canonicalRecoveryPane(*mutation.Pane)
		if err != nil {
			return RecoveryMutation{}, err
		}
		out.Pane = &pane
	case RecoveryMutationDeletePane:
		if mutation.PaneRef == nil {
			break
		}
		reference := *mutation.PaneRef
		if err := reference.validateRecoveryContract(); err != nil {
			return RecoveryMutation{}, invalidRecoveryStoreValue("pane reference", err)
		}
		out.PaneRef = &reference
	case RecoveryMutationSetLayout:
		if mutation.Layout == nil {
			break
		}
		layout, err := canonicalRecoveryLayout(*mutation.Layout)
		if err != nil {
			return RecoveryMutation{}, err
		}
		out.Layout = &layout
	case RecoveryMutationDeleteLayout:
		if mutation.LayoutRef == nil {
			break
		}
		reference, err := canonicalRecoveryLayoutRef(*mutation.LayoutRef)
		if err != nil {
			return RecoveryMutation{}, err
		}
		out.LayoutRef = &reference
	case RecoveryMutationSetActivePane:
		if mutation.ActivePane == nil {
			break
		}
		active, err := canonicalRecoveryActivePane(*mutation.ActivePane)
		if err != nil {
			return RecoveryMutation{}, err
		}
		out.ActivePane = &active
	case RecoveryMutationSetCapture:
		if mutation.Capture == nil {
			break
		}
		capture := canonicalExactSessionCapture(*mutation.Capture)
		if err := capture.validateRecoveryContract(); err != nil {
			return RecoveryMutation{}, invalidRecoveryStoreValue("capture", err)
		}
		out.Capture = &capture
	case RecoveryMutationDeleteCapture:
		if mutation.CaptureKey == nil {
			break
		}
		key, err := canonicalRecoveryCaptureKey(*mutation.CaptureKey)
		if err != nil {
			return RecoveryMutation{}, err
		}
		out.CaptureKey = &key
	case RecoveryMutationSetClaim:
		if mutation.Claim == nil {
			break
		}
		claim := canonicalRecoveryClaim(*mutation.Claim)
		if err := claim.validateRecoveryContract(); err != nil {
			return RecoveryMutation{}, invalidRecoveryStoreValue("claim", err)
		}
		out.Claim = &claim
	case RecoveryMutationDeleteClaim, RecoveryMutationDeleteOutcome:
		if mutation.Fence == nil {
			break
		}
		fence := *mutation.Fence
		if err := fence.validateRecoveryContract(); err != nil {
			return RecoveryMutation{}, invalidRecoveryStoreValue("fence", err)
		}
		out.Fence = &fence
	case RecoveryMutationSetAttempt:
		if mutation.Attempt == nil {
			break
		}
		attempt := canonicalRecoveryAttempt(*mutation.Attempt)
		if err := attempt.validateRecoveryContract(); err != nil {
			return RecoveryMutation{}, invalidRecoveryStoreValue("attempt", err)
		}
		out.Attempt = &attempt
	case RecoveryMutationDeleteAttempt:
		if mutation.AttemptKey == nil {
			break
		}
		key, err := canonicalRecoveryAttemptKey(*mutation.AttemptKey)
		if err != nil {
			return RecoveryMutation{}, err
		}
		out.AttemptKey = &key
	case RecoveryMutationSetOutcome:
		if mutation.Outcome == nil {
			break
		}
		outcome := canonicalRecoveryOutcome(*mutation.Outcome)
		if err := outcome.validateRecoveryContract(); err != nil {
			return RecoveryMutation{}, invalidRecoveryStoreValue("outcome", err)
		}
		out.Outcome = &outcome
	default:
		return RecoveryMutation{}, fmt.Errorf("%w: unknown mutation kind %q", ErrRecoveryStoreInvalid, mutation.Kind)
	}
	if mutationPayloadCount(out) != 1 {
		return RecoveryMutation{}, fmt.Errorf("%w: mutation payload does not match kind %q", ErrRecoveryStoreInvalid, mutation.Kind)
	}
	return out, nil
}

func validateCanonicalRecoverySnapshot(snapshot RecoverySnapshot) error {
	workspaceIDs := make(map[RecoveryWorkspaceID]struct{}, len(snapshot.Workspaces))
	for index, workspace := range snapshot.Workspaces {
		if index > 0 && snapshot.Workspaces[index-1].ID == workspace.ID {
			return fmt.Errorf("%w: duplicate workspace", ErrRecoveryStoreInvalid)
		}
		workspaceIDs[workspace.ID] = struct{}{}
	}

	panes := make(map[RecoveryPaneRef]struct{}, len(snapshot.Panes))
	for index, pane := range snapshot.Panes {
		if _, ok := workspaceIDs[pane.Ref.WorkspaceID]; !ok {
			return fmt.Errorf("%w: pane references a missing workspace", ErrRecoveryStoreInvalid)
		}
		if index > 0 && pane.Ref == snapshot.Panes[index-1].Ref {
			return fmt.Errorf("%w: duplicate pane", ErrRecoveryStoreInvalid)
		}
		panes[pane.Ref] = struct{}{}
	}
	for _, workspace := range snapshot.Workspaces {
		if workspace.ActivePane == nil {
			continue
		}
		if workspace.ActivePane.WorkspaceID != workspace.ID {
			return fmt.Errorf("%w: active pane is outside workspace", ErrRecoveryStoreInvalid)
		}
		if _, ok := panes[*workspace.ActivePane]; !ok {
			return fmt.Errorf("%w: workspace active pane is missing", ErrRecoveryStoreInvalid)
		}
	}

	for index, layout := range snapshot.Layouts {
		if _, ok := workspaceIDs[layout.WorkspaceID]; !ok {
			return fmt.Errorf("%w: layout references a missing workspace", ErrRecoveryStoreInvalid)
		}
		if err := validateRecoveryLayoutPaneMembership(layout.Root, panes); err != nil {
			return err
		}
		if index > 0 && layout.WorkspaceID == snapshot.Layouts[index-1].WorkspaceID &&
			layout.Breakpoint == snapshot.Layouts[index-1].Breakpoint {
			return fmt.Errorf("%w: duplicate layout", ErrRecoveryStoreInvalid)
		}
	}

	captures := make(map[RecoveryCaptureKey]struct{}, len(snapshot.Captures))
	for index, capture := range snapshot.Captures {
		if _, ok := panes[capture.Pane]; !ok {
			return fmt.Errorf("%w: capture references a missing pane", ErrRecoveryStoreInvalid)
		}
		key := recoveryCaptureKeyForCapture(capture)
		if index > 0 && recoveryCaptureKeyEqual(key, recoveryCaptureKeyForCapture(snapshot.Captures[index-1])) {
			return fmt.Errorf("%w: duplicate capture", ErrRecoveryStoreInvalid)
		}
		captures[key] = struct{}{}
	}
	for index, claim := range snapshot.Claims {
		if !recoveryFenceHasCapture(claim.Fence, captures) {
			return fmt.Errorf("%w: claim references a missing capture", ErrRecoveryStoreInvalid)
		}
		if index > 0 && recoveryFenceEqual(claim.Fence, snapshot.Claims[index-1].Fence) {
			return fmt.Errorf("%w: duplicate claim", ErrRecoveryStoreInvalid)
		}
	}
	for index, attempt := range snapshot.Attempts {
		if !recoveryFenceHasCapture(attempt.Fence, captures) {
			return fmt.Errorf("%w: attempt references a missing capture", ErrRecoveryStoreInvalid)
		}
		if index > 0 && recoveryFenceEqual(attempt.Fence, snapshot.Attempts[index-1].Fence) &&
			attempt.Ordinal == snapshot.Attempts[index-1].Ordinal {
			return fmt.Errorf("%w: duplicate attempt", ErrRecoveryStoreInvalid)
		}
	}
	for index, outcome := range snapshot.Outcomes {
		if !recoveryFenceHasCapture(outcome.Fence, captures) {
			return fmt.Errorf("%w: outcome references a missing capture", ErrRecoveryStoreInvalid)
		}
		if index > 0 && recoveryFenceEqual(outcome.Fence, snapshot.Outcomes[index-1].Fence) {
			return fmt.Errorf("%w: duplicate outcome", ErrRecoveryStoreInvalid)
		}
	}
	return nil
}

type recoveryLayoutValidation struct {
	workspaceID RecoveryWorkspaceID
	nodes       int
	groups      map[string]struct{}
	panes       map[RecoveryPaneRef]struct{}
}

func canonicalRecoveryLayoutNode(
	node RecoveryLayoutNode,
	depth int,
	state *recoveryLayoutValidation,
) (RecoveryLayoutNode, error) {
	if depth > recoveryStoreMaxLayoutDepth {
		return RecoveryLayoutNode{}, fmt.Errorf("%w: layout exceeds its nesting bound", ErrRecoveryStoreInvalid)
	}
	state.nodes++
	if state.nodes > recoveryStoreMaxLayoutNodes {
		return RecoveryLayoutNode{}, fmt.Errorf("%w: layout exceeds its node bound", ErrRecoveryStoreInvalid)
	}
	if err := validateRecoveryLayoutGeometry(node.Geometry); err != nil {
		return RecoveryLayoutNode{}, err
	}
	if node.Ratio == 0 || node.Ratio > RecoveryStoreLayoutRatioScale {
		return RecoveryLayoutNode{}, fmt.Errorf("%w: layout ratio is outside its bounded scale", ErrRecoveryStoreInvalid)
	}

	out := RecoveryLayoutNode{
		Kind:     node.Kind,
		Geometry: node.Geometry,
		Ratio:    node.Ratio,
	}
	switch node.Kind {
	case RecoveryLayoutNodeSplit:
		if node.Orientation != RecoveryLayoutHorizontal && node.Orientation != RecoveryLayoutVertical {
			return RecoveryLayoutNode{}, fmt.Errorf("%w: split layout orientation is invalid", ErrRecoveryStoreInvalid)
		}
		if len(node.Children) < 2 || len(node.Children) > RecoveryStoreMaxPanes {
			return RecoveryLayoutNode{}, fmt.Errorf("%w: split layout child count is invalid", ErrRecoveryStoreInvalid)
		}
		if node.GroupID != "" || len(node.Views) != 0 || node.ActiveView != nil {
			return RecoveryLayoutNode{}, fmt.Errorf("%w: split layout contains group fields", ErrRecoveryStoreInvalid)
		}
		out.Orientation = node.Orientation
		out.Children = make([]RecoveryLayoutNode, len(node.Children))
		var ratioTotal uint64
		for index, child := range node.Children {
			if !recoveryLayoutGeometryContains(node.Geometry, child.Geometry) {
				return RecoveryLayoutNode{}, fmt.Errorf("%w: split child geometry is outside its parent", ErrRecoveryStoreInvalid)
			}
			canonical, err := canonicalRecoveryLayoutNode(child, depth+1, state)
			if err != nil {
				return RecoveryLayoutNode{}, err
			}
			out.Children[index] = canonical
			ratioTotal += uint64(canonical.Ratio)
		}
		if ratioTotal != RecoveryStoreLayoutRatioScale {
			return RecoveryLayoutNode{}, fmt.Errorf("%w: split child ratios do not sum to their scale", ErrRecoveryStoreInvalid)
		}
	case RecoveryLayoutNodeGroup:
		if node.Orientation != "" || len(node.Children) != 0 {
			return RecoveryLayoutNode{}, fmt.Errorf("%w: group layout contains split fields", ErrRecoveryStoreInvalid)
		}
		if err := validateRecoveryStoreText(node.GroupID, RecoveryStoreMaxLayoutGroupBytes, "layout group ID", true); err != nil {
			return RecoveryLayoutNode{}, err
		}
		if _, exists := state.groups[node.GroupID]; exists {
			return RecoveryLayoutNode{}, fmt.Errorf("%w: duplicate layout group ID", ErrRecoveryStoreInvalid)
		}
		state.groups[node.GroupID] = struct{}{}
		if len(node.Views) == 0 || len(node.Views) > RecoveryStoreMaxPanes {
			return RecoveryLayoutNode{}, fmt.Errorf("%w: layout group view count is invalid", ErrRecoveryStoreInvalid)
		}
		out.GroupID = node.GroupID
		out.Views = make([]RecoveryPaneRef, len(node.Views))
		activeFound := node.ActiveView == nil
		for index, pane := range node.Views {
			if err := pane.validateRecoveryContract(); err != nil {
				return RecoveryLayoutNode{}, invalidRecoveryStoreValue("layout view", err)
			}
			if pane.WorkspaceID != state.workspaceID {
				return RecoveryLayoutNode{}, fmt.Errorf("%w: layout view is outside its workspace", ErrRecoveryStoreInvalid)
			}
			if _, exists := state.panes[pane]; exists {
				return RecoveryLayoutNode{}, fmt.Errorf("%w: duplicate pane view in layout", ErrRecoveryStoreInvalid)
			}
			state.panes[pane] = struct{}{}
			out.Views[index] = pane
			if node.ActiveView != nil && pane == *node.ActiveView {
				activeFound = true
			}
		}
		if node.ActiveView != nil {
			active := *node.ActiveView
			if err := active.validateRecoveryContract(); err != nil {
				return RecoveryLayoutNode{}, invalidRecoveryStoreValue("active layout view", err)
			}
			if !activeFound {
				return RecoveryLayoutNode{}, fmt.Errorf("%w: active layout view is not in its group", ErrRecoveryStoreInvalid)
			}
			out.ActiveView = &active
		}
	default:
		return RecoveryLayoutNode{}, fmt.Errorf("%w: layout node kind is invalid", ErrRecoveryStoreInvalid)
	}
	return out, nil
}

func validateRecoveryLayoutGeometry(geometry RecoveryLayoutGeometry) error {
	if geometry.Width == 0 || geometry.Height == 0 ||
		geometry.X > RecoveryStoreMaxLayoutExtent ||
		geometry.Y > RecoveryStoreMaxLayoutExtent ||
		geometry.Width > RecoveryStoreMaxLayoutExtent ||
		geometry.Height > RecoveryStoreMaxLayoutExtent ||
		uint64(geometry.X)+uint64(geometry.Width) > RecoveryStoreMaxLayoutExtent ||
		uint64(geometry.Y)+uint64(geometry.Height) > RecoveryStoreMaxLayoutExtent {
		return fmt.Errorf("%w: layout geometry is outside its hard extent", ErrRecoveryStoreInvalid)
	}
	return nil
}

func recoveryLayoutGeometryContains(parent, child RecoveryLayoutGeometry) bool {
	return child.X >= parent.X &&
		child.Y >= parent.Y &&
		uint64(child.X)+uint64(child.Width) <= uint64(parent.X)+uint64(parent.Width) &&
		uint64(child.Y)+uint64(child.Height) <= uint64(parent.Y)+uint64(parent.Height)
}

func validateRecoveryLayoutPaneMembership(
	node RecoveryLayoutNode,
	panes map[RecoveryPaneRef]struct{},
) error {
	for _, pane := range node.Views {
		if _, ok := panes[pane]; !ok {
			return fmt.Errorf("%w: layout references a missing pane", ErrRecoveryStoreInvalid)
		}
	}
	for _, child := range node.Children {
		if err := validateRecoveryLayoutPaneMembership(child, panes); err != nil {
			return err
		}
	}
	return nil
}

func validateRecoveryWorkspaceID(id RecoveryWorkspaceID) error {
	if err := validateOpaqueIdentifier(string(id), RecoveryMaxWorkspaceIDBytes, "workspace ID"); err != nil {
		return invalidRecoveryStoreValue("workspace ID", err)
	}
	return nil
}

func validateRecoveryStoreText(value string, maximum int, field string, required bool) error {
	if required && value == "" {
		return fmt.Errorf("%w: %s is empty", ErrRecoveryStoreInvalid, field)
	}
	if len(value) > maximum || !utf8.ValidString(value) {
		return fmt.Errorf("%w: %s exceeds its UTF-8 bound", ErrRecoveryStoreInvalid, field)
	}
	for _, runeValue := range value {
		if unicode.IsControl(runeValue) {
			return fmt.Errorf("%w: %s contains a control character", ErrRecoveryStoreInvalid, field)
		}
	}
	return nil
}

func invalidRecoveryStoreValue(field string, err error) error {
	return fmt.Errorf("%w: %s: %v", ErrRecoveryStoreInvalid, field, err)
}

func mutationPayloadCount(mutation RecoveryMutation) int {
	count := 0
	for _, present := range []bool{
		mutation.Workspace != nil,
		mutation.WorkspaceID != nil,
		mutation.Pane != nil,
		mutation.PaneRef != nil,
		mutation.Layout != nil,
		mutation.LayoutRef != nil,
		mutation.ActivePane != nil,
		mutation.Capture != nil,
		mutation.CaptureKey != nil,
		mutation.Claim != nil,
		mutation.Fence != nil,
		mutation.Attempt != nil,
		mutation.AttemptKey != nil,
		mutation.Outcome != nil,
	} {
		if present {
			count++
		}
	}
	return count
}

func cloneRecoverySnapshot(snapshot RecoverySnapshot) RecoverySnapshot {
	out := snapshot
	out.Workspaces = make([]RecoveryWorkspace, len(snapshot.Workspaces))
	for index, workspace := range snapshot.Workspaces {
		out.Workspaces[index] = workspace
		if workspace.ActivePane != nil {
			pane := *workspace.ActivePane
			out.Workspaces[index].ActivePane = &pane
		}
	}
	out.Panes = append(make([]RecoveryPane, 0, len(snapshot.Panes)), snapshot.Panes...)
	out.Layouts = make([]RecoveryLayout, len(snapshot.Layouts))
	for index, layout := range snapshot.Layouts {
		out.Layouts[index] = layout
		out.Layouts[index].Root = cloneRecoveryLayoutNode(layout.Root)
	}
	out.Captures = append(make([]ExactSessionCapture, 0, len(snapshot.Captures)), snapshot.Captures...)
	out.Claims = append(make([]RecoveryClaim, 0, len(snapshot.Claims)), snapshot.Claims...)
	out.Attempts = append(make([]RecoveryAttempt, 0, len(snapshot.Attempts)), snapshot.Attempts...)
	out.Outcomes = append(make([]RecoveryOutcome, 0, len(snapshot.Outcomes)), snapshot.Outcomes...)
	return out
}

func cloneRecoveryLayoutNode(node RecoveryLayoutNode) RecoveryLayoutNode {
	out := node
	if node.ActiveView != nil {
		active := *node.ActiveView
		out.ActiveView = &active
	}
	out.Views = append([]RecoveryPaneRef(nil), node.Views...)
	if node.Children != nil {
		out.Children = make([]RecoveryLayoutNode, len(node.Children))
		for index, child := range node.Children {
			out.Children[index] = cloneRecoveryLayoutNode(child)
		}
	}
	return out
}

func canonicalExactSessionCapture(capture ExactSessionCapture) ExactSessionCapture {
	capture.WorkingDirectory.ObservedAt = capture.WorkingDirectory.ObservedAt.UTC()
	capture.ObservedAt = capture.ObservedAt.UTC()
	capture.CapturedAt = capture.CapturedAt.UTC()
	return capture
}

func canonicalRecoveryClaim(claim RecoveryClaim) RecoveryClaim {
	claim.ClaimedAt = claim.ClaimedAt.UTC()
	return claim
}

func canonicalRecoveryAttempt(attempt RecoveryAttempt) RecoveryAttempt {
	attempt.StartedAt = attempt.StartedAt.UTC()
	attempt.UpdatedAt = attempt.UpdatedAt.UTC()
	return attempt
}

func canonicalRecoveryOutcome(outcome RecoveryOutcome) RecoveryOutcome {
	outcome.CompletedAt = outcome.CompletedAt.UTC()
	return outcome
}

func recoveryPaneRefLess(left, right RecoveryPaneRef) bool {
	if left.WorkspaceID != right.WorkspaceID {
		return left.WorkspaceID < right.WorkspaceID
	}
	return left.PaneID < right.PaneID
}

func recoveryCaptureKeyForCapture(capture ExactSessionCapture) RecoveryCaptureKey {
	return RecoveryCaptureKey{
		Pane:           capture.Pane,
		StrategyID:     capture.StrategyID,
		RootGeneration: capture.RootGeneration,
		CaptureEpoch:   capture.CaptureEpoch,
	}
}

func recoveryCaptureKeyLess(left, right RecoveryCaptureKey) bool {
	if !recoveryPaneRefEqual(left.Pane, right.Pane) {
		return recoveryPaneRefLess(left.Pane, right.Pane)
	}
	if left.StrategyID != right.StrategyID {
		return left.StrategyID < right.StrategyID
	}
	if left.RootGeneration != right.RootGeneration {
		return left.RootGeneration < right.RootGeneration
	}
	return left.CaptureEpoch < right.CaptureEpoch
}

func recoveryCaptureKeyEqual(left, right RecoveryCaptureKey) bool {
	return left == right
}

func recoveryPaneRefEqual(left, right RecoveryPaneRef) bool {
	return left == right
}

func recoveryFenceLess(left, right RecoveryFence) bool {
	if !recoveryPaneRefEqual(left.Pane, right.Pane) {
		return recoveryPaneRefLess(left.Pane, right.Pane)
	}
	if left.Generation != right.Generation {
		return left.Generation < right.Generation
	}
	if left.RootProcessGeneration != right.RootProcessGeneration {
		return left.RootProcessGeneration < right.RootProcessGeneration
	}
	if left.StrategyID != right.StrategyID {
		return left.StrategyID < right.StrategyID
	}
	return left.CaptureEpoch < right.CaptureEpoch
}

func recoveryFenceEqual(left, right RecoveryFence) bool {
	return left == right
}

func recoveryFenceHasCapture(fence RecoveryFence, captures map[RecoveryCaptureKey]struct{}) bool {
	_, ok := captures[RecoveryCaptureKey{
		Pane:           fence.Pane,
		StrategyID:     fence.StrategyID,
		RootGeneration: fence.RootProcessGeneration,
		CaptureEpoch:   fence.CaptureEpoch,
	}]
	return ok
}

func replaceWorkspace(values []RecoveryWorkspace, value RecoveryWorkspace) []RecoveryWorkspace {
	for index := range values {
		if values[index].ID == value.ID {
			values[index] = value
			return values
		}
	}
	return append(values, value)
}

func replacePane(values []RecoveryPane, value RecoveryPane) []RecoveryPane {
	for index := range values {
		if values[index].Ref == value.Ref {
			values[index] = value
			return values
		}
	}
	return append(values, value)
}

func replaceLayout(values []RecoveryLayout, value RecoveryLayout) []RecoveryLayout {
	for index := range values {
		if values[index].WorkspaceID == value.WorkspaceID && values[index].Breakpoint == value.Breakpoint {
			values[index] = value
			return values
		}
	}
	return append(values, value)
}

func replaceCapture(values []ExactSessionCapture, value ExactSessionCapture) []ExactSessionCapture {
	key := recoveryCaptureKeyForCapture(value)
	for index := range values {
		if recoveryCaptureKeyEqual(recoveryCaptureKeyForCapture(values[index]), key) {
			values[index] = value
			return values
		}
	}
	return append(values, value)
}

func replaceClaim(values []RecoveryClaim, value RecoveryClaim) []RecoveryClaim {
	for index := range values {
		if recoveryFenceEqual(values[index].Fence, value.Fence) {
			values[index] = value
			return values
		}
	}
	return append(values, value)
}

func replaceAttempt(values []RecoveryAttempt, value RecoveryAttempt) []RecoveryAttempt {
	for index := range values {
		if recoveryFenceEqual(values[index].Fence, value.Fence) && values[index].Ordinal == value.Ordinal {
			values[index] = value
			return values
		}
	}
	return append(values, value)
}

func replaceOutcome(values []RecoveryOutcome, value RecoveryOutcome) []RecoveryOutcome {
	for index := range values {
		if recoveryFenceEqual(values[index].Fence, value.Fence) {
			values[index] = value
			return values
		}
	}
	return append(values, value)
}

func removeLayout(values []RecoveryLayout, reference RecoveryLayoutRef) []RecoveryLayout {
	out := values[:0]
	for _, value := range values {
		if value.WorkspaceID != reference.WorkspaceID || value.Breakpoint != reference.Breakpoint {
			out = append(out, value)
		}
	}
	return out
}

func removeAttempt(values []RecoveryAttempt, key RecoveryAttemptKey) []RecoveryAttempt {
	out := values[:0]
	for _, value := range values {
		if !recoveryFenceEqual(value.Fence, key.Fence) || value.Ordinal != key.Ordinal {
			out = append(out, value)
		}
	}
	return out
}

func removeOutcome(values []RecoveryOutcome, fence RecoveryFence) []RecoveryOutcome {
	out := values[:0]
	for _, value := range values {
		if !recoveryFenceEqual(value.Fence, fence) {
			out = append(out, value)
		}
	}
	return out
}

func deleteWorkspace(snapshot *RecoverySnapshot, workspaceID RecoveryWorkspaceID) {
	workspaces := snapshot.Workspaces[:0]
	for _, workspace := range snapshot.Workspaces {
		if workspace.ID != workspaceID {
			workspaces = append(workspaces, workspace)
		}
	}
	snapshot.Workspaces = workspaces

	panes := snapshot.Panes[:0]
	for _, pane := range snapshot.Panes {
		if pane.Ref.WorkspaceID != workspaceID {
			panes = append(panes, pane)
		}
	}
	snapshot.Panes = panes
	snapshot.Layouts = removeLayoutsForWorkspace(snapshot.Layouts, workspaceID)
	removeCaptureDependentsForWorkspace(snapshot, workspaceID)
}

func deletePane(snapshot *RecoverySnapshot, pane RecoveryPaneRef) {
	panes := snapshot.Panes[:0]
	for _, value := range snapshot.Panes {
		if value.Ref != pane {
			panes = append(panes, value)
		}
	}
	snapshot.Panes = panes
	for index := range snapshot.Workspaces {
		if snapshot.Workspaces[index].ActivePane != nil && *snapshot.Workspaces[index].ActivePane == pane {
			snapshot.Workspaces[index].ActivePane = nil
		}
	}
	removeCaptureDependentsForPane(snapshot, pane)
}

func removeLayoutsForWorkspace(values []RecoveryLayout, workspaceID RecoveryWorkspaceID) []RecoveryLayout {
	out := values[:0]
	for _, value := range values {
		if value.WorkspaceID != workspaceID {
			out = append(out, value)
		}
	}
	return out
}

func assignActivePane(snapshot *RecoverySnapshot, active RecoveryActivePane) {
	for index := range snapshot.Workspaces {
		if snapshot.Workspaces[index].ID == active.WorkspaceID {
			pane := active.Pane
			snapshot.Workspaces[index].ActivePane = &pane
			return
		}
	}
}

func clearActivePane(snapshot *RecoverySnapshot, workspaceID RecoveryWorkspaceID) {
	for index := range snapshot.Workspaces {
		if snapshot.Workspaces[index].ID == workspaceID {
			snapshot.Workspaces[index].ActivePane = nil
			return
		}
	}
}

func deleteCapture(snapshot *RecoverySnapshot, key RecoveryCaptureKey) {
	captures := snapshot.Captures[:0]
	for _, capture := range snapshot.Captures {
		if !recoveryCaptureKeyEqual(recoveryCaptureKeyForCapture(capture), key) {
			captures = append(captures, capture)
		}
	}
	snapshot.Captures = captures
	removeFenceDependentsForCapture(snapshot, key)
}

func deleteClaim(snapshot *RecoverySnapshot, fence RecoveryFence) {
	claims := snapshot.Claims[:0]
	for _, claim := range snapshot.Claims {
		if !recoveryFenceEqual(claim.Fence, fence) {
			claims = append(claims, claim)
		}
	}
	snapshot.Claims = claims
}

func removeCaptureDependentsForPane(snapshot *RecoverySnapshot, pane RecoveryPaneRef) {
	captures := snapshot.Captures[:0]
	for _, capture := range snapshot.Captures {
		if capture.Pane != pane {
			captures = append(captures, capture)
		}
	}
	snapshot.Captures = captures
	snapshot.Claims = removeClaimsForPane(snapshot.Claims, pane)
	snapshot.Attempts = removeAttemptsForPane(snapshot.Attempts, pane)
	snapshot.Outcomes = removeOutcomesForPane(snapshot.Outcomes, pane)
}

func removeCaptureDependentsForWorkspace(snapshot *RecoverySnapshot, workspaceID RecoveryWorkspaceID) {
	captures := snapshot.Captures[:0]
	for _, capture := range snapshot.Captures {
		if capture.Pane.WorkspaceID != workspaceID {
			captures = append(captures, capture)
		}
	}
	snapshot.Captures = captures
	snapshot.Claims = removeClaimsForWorkspace(snapshot.Claims, workspaceID)
	snapshot.Attempts = removeAttemptsForWorkspace(snapshot.Attempts, workspaceID)
	snapshot.Outcomes = removeOutcomesForWorkspace(snapshot.Outcomes, workspaceID)
}

func removeFenceDependentsForCapture(snapshot *RecoverySnapshot, key RecoveryCaptureKey) {
	snapshot.Claims = removeClaimsForCapture(snapshot.Claims, key)
	snapshot.Attempts = removeAttemptsForCapture(snapshot.Attempts, key)
	snapshot.Outcomes = removeOutcomesForCapture(snapshot.Outcomes, key)
}

func removeClaimsForPane(values []RecoveryClaim, pane RecoveryPaneRef) []RecoveryClaim {
	out := values[:0]
	for _, value := range values {
		if value.Fence.Pane != pane {
			out = append(out, value)
		}
	}
	return out
}

func removeClaimsForWorkspace(values []RecoveryClaim, workspaceID RecoveryWorkspaceID) []RecoveryClaim {
	out := values[:0]
	for _, value := range values {
		if value.Fence.Pane.WorkspaceID != workspaceID {
			out = append(out, value)
		}
	}
	return out
}

func removeAttemptsForPane(values []RecoveryAttempt, pane RecoveryPaneRef) []RecoveryAttempt {
	out := values[:0]
	for _, value := range values {
		if value.Fence.Pane != pane {
			out = append(out, value)
		}
	}
	return out
}

func removeAttemptsForWorkspace(values []RecoveryAttempt, workspaceID RecoveryWorkspaceID) []RecoveryAttempt {
	out := values[:0]
	for _, value := range values {
		if value.Fence.Pane.WorkspaceID != workspaceID {
			out = append(out, value)
		}
	}
	return out
}

func removeOutcomesForPane(values []RecoveryOutcome, pane RecoveryPaneRef) []RecoveryOutcome {
	out := values[:0]
	for _, value := range values {
		if value.Fence.Pane != pane {
			out = append(out, value)
		}
	}
	return out
}

func removeOutcomesForWorkspace(values []RecoveryOutcome, workspaceID RecoveryWorkspaceID) []RecoveryOutcome {
	out := values[:0]
	for _, value := range values {
		if value.Fence.Pane.WorkspaceID != workspaceID {
			out = append(out, value)
		}
	}
	return out
}

func removeClaimsForCapture(values []RecoveryClaim, key RecoveryCaptureKey) []RecoveryClaim {
	out := values[:0]
	for _, value := range values {
		if !recoveryFenceMatchesCaptureKey(value.Fence, key) {
			out = append(out, value)
		}
	}
	return out
}

func removeAttemptsForCapture(values []RecoveryAttempt, key RecoveryCaptureKey) []RecoveryAttempt {
	out := values[:0]
	for _, value := range values {
		if !recoveryFenceMatchesCaptureKey(value.Fence, key) {
			out = append(out, value)
		}
	}
	return out
}

func removeOutcomesForCapture(values []RecoveryOutcome, key RecoveryCaptureKey) []RecoveryOutcome {
	out := values[:0]
	for _, value := range values {
		if !recoveryFenceMatchesCaptureKey(value.Fence, key) {
			out = append(out, value)
		}
	}
	return out
}

func recoveryFenceMatchesCaptureKey(fence RecoveryFence, key RecoveryCaptureKey) bool {
	return fence.Pane == key.Pane &&
		fence.StrategyID == key.StrategyID &&
		fence.RootProcessGeneration == key.RootGeneration &&
		fence.CaptureEpoch == key.CaptureEpoch
}

func recoverySnapshotHasPane(snapshot RecoverySnapshot, pane RecoveryPaneRef) bool {
	for _, candidate := range snapshot.Panes {
		if candidate.Ref == pane {
			return true
		}
	}
	return false
}

func recoverySnapshotHasWorkspace(snapshot RecoverySnapshot, workspaceID RecoveryWorkspaceID) bool {
	for _, candidate := range snapshot.Workspaces {
		if candidate.ID == workspaceID {
			return true
		}
	}
	return false
}

func stableRecoverySnapshotJSON(snapshot RecoverySnapshot) ([]byte, error) {
	canonical, err := canonicalRecoverySnapshot(snapshot)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(canonical)
	if err != nil {
		return nil, fmt.Errorf("%w: encode snapshot", ErrRecoveryStoreInvalid)
	}
	return encoded, nil
}

func stableRecoveryMutationJSON(mutation RecoveryMutation) ([]byte, RecoveryMutation, error) {
	canonical, err := canonicalRecoveryMutation(mutation)
	if err != nil {
		return nil, RecoveryMutation{}, err
	}
	encoded, err := json.Marshal(canonical)
	if err != nil || len(encoded) > RecoveryStoreMaxMutationBytes {
		return nil, RecoveryMutation{}, fmt.Errorf("%w: mutation cannot be encoded within its bound", ErrRecoveryStoreInvalid)
	}
	return encoded, canonical, nil
}
