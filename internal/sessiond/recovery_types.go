package sessiond

import "time"

// Recovery contract limits bound all variable-length recovery values before
// they can cross a persistence or launch boundary.
const (
	RecoveryCaptureSchemaVersion uint16 = 1

	RecoveryMaxWorkspaceIDBytes            = 128
	RecoveryMaxOpaqueSessionIDBytes        = 1024
	RecoveryMaxWorkingDirectoryBytes       = 4096
	RecoveryMaxExecutableBytes             = 4096
	RecoveryMaxArgumentBytes               = 4096
	RecoveryMaxLaunchArguments             = 32
	RecoveryMaxEnvironmentValueBytes       = 256
	RecoveryMaxEnvironmentEntries          = 3
	RecoveryMaxReplacementPanes            = 256
	RecoveryMaxReplacementPlanIDBytes      = 64
	RecoveryMaxProtocolCapabilities        = 8
	RecoveryMaxLifecycleNamespaceBytes     = 64
	RecoveryMaxLifecycleIntegrationIDBytes = 128
)

// RecoveryWorkspaceID and RecoveryPaneID form an identity that is always
// workspace-qualified. RecoveryWorkspaceID is bounded by
// RecoveryMaxWorkspaceIDBytes.
type RecoveryWorkspaceID string

type RecoveryPaneID uint32

// RecoveryPaneRef is the only pane identity accepted by recovery contracts.
// A bare pane ID is intentionally insufficient because pane IDs are local to a
// workspace.
type RecoveryPaneRef struct {
	WorkspaceID RecoveryWorkspaceID `json:"workspaceId"`
	PaneID      RecoveryPaneID      `json:"paneId"`
}

// RecoveryStrategyID is a closed built-in roster. There is deliberately no
// generic strategy-name or dynamically-loaded strategy contract.
type RecoveryStrategyID string

const (
	RecoveryStrategyAmplifier  RecoveryStrategyID = "amplifier-app-cli"
	RecoveryStrategyClaudeCode RecoveryStrategyID = "claude-code"
	RecoveryStrategyOpenCode   RecoveryStrategyID = "opencode"
	RecoveryStrategyCodex      RecoveryStrategyID = "codex"
)

// RecoveryStrategyLabel is the stable browser-safe label for one built-in
// strategy.
type RecoveryStrategyLabel string

const (
	RecoveryStrategyLabelAmplifier  RecoveryStrategyLabel = "Amplifier"
	RecoveryStrategyLabelClaudeCode RecoveryStrategyLabel = "Claude Code"
	RecoveryStrategyLabelOpenCode   RecoveryStrategyLabel = "OpenCode"
	RecoveryStrategyLabelCodex      RecoveryStrategyLabel = "Codex"
)

// RecoveryStatus is the complete daemon-authoritative browser status
// vocabulary. It is intentionally limited to the six values below.
type RecoveryStatus string

const (
	RecoveryStatusRestoring       RecoveryStatus = "restoring"
	RecoveryStatusRecovered       RecoveryStatus = "recovered"
	RecoveryStatusShellRestored   RecoveryStatus = "shell-restored"
	RecoveryStatusSelectionNeeded RecoveryStatus = "selection-needed"
	RecoveryStatusProvisional     RecoveryStatus = "provisional"
	RecoveryStatusStrategyFailed  RecoveryStatus = "strategy-failed"
)

// RecoveryGeneration identifies one reconstruction run. Root-process and
// capture generations prevent an event from authorizing a different launch.
type RecoveryGeneration uint64

type RecoveryRootProcessGeneration uint64

type RecoveryCaptureEpoch uint64

// RecoveryFence binds every claim, attempt, and outcome to exactly one pane,
// recovery generation, root process generation, selected strategy, and capture
// epoch.
type RecoveryFence struct {
	Pane                  RecoveryPaneRef               `json:"pane"`
	Generation            RecoveryGeneration            `json:"generation"`
	RootProcessGeneration RecoveryRootProcessGeneration `json:"rootProcessGeneration"`
	StrategyID            RecoveryStrategyID            `json:"strategyId"`
	CaptureEpoch          RecoveryCaptureEpoch          `json:"captureEpoch"`
}

// RecoveryClaimState is the durable state of a generation-fenced recovery
// claim. A consumed claim must not automatically launch again.
type RecoveryClaimState string

const (
	RecoveryClaimStatePending  RecoveryClaimState = "pending"
	RecoveryClaimStateClaimed  RecoveryClaimState = "claimed"
	RecoveryClaimStateConsumed RecoveryClaimState = "consumed"
)

// RecoveryAttemptState is the bounded state machine for the single automatic
// attempt allowed by one claim.
type RecoveryAttemptState string

const (
	RecoveryAttemptStatePending    RecoveryAttemptState = "pending"
	RecoveryAttemptStateLaunching  RecoveryAttemptState = "launching"
	RecoveryAttemptStateValidating RecoveryAttemptState = "validating"
	RecoveryAttemptStateFinished   RecoveryAttemptState = "finished"
)

const RecoveryMaxAutomaticAttempts uint8 = 1

// RecoveryOutcomeState records a redaction-safe terminal or provisional
// result. It is distinct from RecoveryStatus so durable coordination can
// represent an outcome without accepting arbitrary presentation strings.
type RecoveryOutcomeState string

const (
	RecoveryOutcomeStateRecovered       RecoveryOutcomeState = "recovered"
	RecoveryOutcomeStateShellRestored   RecoveryOutcomeState = "shell-restored"
	RecoveryOutcomeStateSelectionNeeded RecoveryOutcomeState = "selection-needed"
	RecoveryOutcomeStateProvisional     RecoveryOutcomeState = "provisional"
	RecoveryOutcomeStateStrategyFailed  RecoveryOutcomeState = "strategy-failed"
)

// RecoveryDetailCode is a closed, stable, redaction-safe explanation. It must
// never contain a session ID, path, command, environment value, or tool error.
type RecoveryDetailCode string

const (
	RecoveryDetailNone                     RecoveryDetailCode = "none"
	RecoveryDetailCaptureMissing           RecoveryDetailCode = "capture-missing"
	RecoveryDetailCaptureInvalid           RecoveryDetailCode = "capture-invalid"
	RecoveryDetailCaptureStale             RecoveryDetailCode = "capture-stale"
	RecoveryDetailCaptureConflicting       RecoveryDetailCode = "capture-conflicting"
	RecoveryDetailCaptureAmbiguous         RecoveryDetailCode = "capture-ambiguous"
	RecoveryDetailWorkingDirectoryInvalid  RecoveryDetailCode = "working-directory-invalid"
	RecoveryDetailStrategyUnsupported      RecoveryDetailCode = "strategy-unsupported"
	RecoveryDetailSchemaIncompatible       RecoveryDetailCode = "schema-incompatible"
	RecoveryDetailLifecycleUnavailable     RecoveryDetailCode = "lifecycle-unavailable"
	RecoveryDetailLifecycleExpired         RecoveryDetailCode = "lifecycle-expired"
	RecoveryDetailLifecycleMalformed       RecoveryDetailCode = "lifecycle-malformed"
	RecoveryDetailLaunchRejected           RecoveryDetailCode = "launch-rejected"
	RecoveryDetailLaunchFailed             RecoveryDetailCode = "launch-failed"
	RecoveryDetailObservedIdentityMismatch RecoveryDetailCode = "observed-identity-mismatch"
	RecoveryDetailReadinessTimeout         RecoveryDetailCode = "readiness-timeout"
	RecoveryDetailReplacementDeferred      RecoveryDetailCode = "replacement-deferred"
	RecoveryDetailReplacementFailed        RecoveryDetailCode = "replacement-failed"
	RecoveryDetailActivePaneInvalid        RecoveryDetailCode = "active-pane-invalid"
)

// RecoveryFailureCode is the daemon-local failure category stored alongside an
// outcome. Like RecoveryDetailCode, it excludes raw tool errors.
type RecoveryFailureCode string

const (
	RecoveryFailureNone                     RecoveryFailureCode = "none"
	RecoveryFailureCaptureInvalid           RecoveryFailureCode = "capture-invalid"
	RecoveryFailureWorkingDirectoryInvalid  RecoveryFailureCode = "working-directory-invalid"
	RecoveryFailureStrategyUnsupported      RecoveryFailureCode = "strategy-unsupported"
	RecoveryFailureSchemaIncompatible       RecoveryFailureCode = "schema-incompatible"
	RecoveryFailureLaunchRejected           RecoveryFailureCode = "launch-rejected"
	RecoveryFailureLaunchFailed             RecoveryFailureCode = "launch-failed"
	RecoveryFailureObservedIdentityMismatch RecoveryFailureCode = "observed-identity-mismatch"
	RecoveryFailureReadinessTimeout         RecoveryFailureCode = "readiness-timeout"
)

// RecoveryClaim is the persisted authorization to make one recovery attempt.
type RecoveryClaim struct {
	Fence     RecoveryFence      `json:"fence"`
	State     RecoveryClaimState `json:"state"`
	ClaimedAt time.Time          `json:"claimedAt"`
}

// RecoveryAttempt is the persisted execution state for a generation-fenced
// claim. Ordinal is bounded by RecoveryMaxAutomaticAttempts.
type RecoveryAttempt struct {
	Fence     RecoveryFence        `json:"fence"`
	Ordinal   uint8                `json:"ordinal"`
	State     RecoveryAttemptState `json:"state"`
	StartedAt time.Time            `json:"startedAt"`
	UpdatedAt time.Time            `json:"updatedAt"`
}

// RecoveryOutcome is the durable result for one recovery fence. It contains
// only redaction-safe explanation data; exact session identities remain in
// ExactSessionCapture.
type RecoveryOutcome struct {
	Fence           RecoveryFence        `json:"fence"`
	State           RecoveryOutcomeState `json:"state"`
	Status          RecoveryStatus       `json:"status"`
	DetailCode      RecoveryDetailCode   `json:"detailCode"`
	FailureCode     RecoveryFailureCode  `json:"failureCode"`
	HistoryBoundary bool                 `json:"historyBoundary"`
	CanRetry        bool                 `json:"canRetry"`
	CanSelect       bool                 `json:"canSelect"`
	CompletedAt     time.Time            `json:"completedAt"`
}

// RecoveryCaptureSchema identifies the record schema; future schemas are
// explicit additions rather than reinterpretations of this capture.
type RecoveryCaptureSchema string

const RecoveryCaptureSchemaV1 RecoveryCaptureSchema = "muxterm.recovery.capture"

// RecoveryCaptureSource is closed to evidence paths that do not inspect
// terminal text or select a guessed latest session.
type RecoveryCaptureSource string

const (
	RecoveryCaptureSourceLifecycle           RecoveryCaptureSource = "lifecycle"
	RecoveryCaptureSourceManagedSession      RecoveryCaptureSource = "managed-session"
	RecoveryCaptureSourceVerifiedCorrelation RecoveryCaptureSource = "verified-correlation"
	RecoveryCaptureSourceExplicitSelection   RecoveryCaptureSource = "explicit-selection"
)

// RecoveryValidationState describes validation without carrying a raw error.
type RecoveryValidationState string

const (
	RecoveryValidationValid       RecoveryValidationState = "valid"
	RecoveryValidationMissing     RecoveryValidationState = "missing"
	RecoveryValidationMalformed   RecoveryValidationState = "malformed"
	RecoveryValidationStale       RecoveryValidationState = "stale"
	RecoveryValidationConflicting RecoveryValidationState = "conflicting"
	RecoveryValidationAmbiguous   RecoveryValidationState = "ambiguous"
	RecoveryValidationMismatched  RecoveryValidationState = "mismatched"
	RecoveryValidationUnsupported RecoveryValidationState = "unsupported"
)

// RecoveryOpaqueSessionID is an exact daemon-local external session identity.
// Its byte length is bounded by RecoveryMaxOpaqueSessionIDBytes and it must
// never be projected to browsers.
type RecoveryOpaqueSessionID string

// RecoveryOpaqueSessionCandidate is one privileged exact-selection candidate,
// bounded by RecoveryMaxOpaqueSessionIDBytes. It has no browser-safe form.
type RecoveryOpaqueSessionCandidate string

// RecoveryWorkingDirectory is a daemon-local path bounded by
// RecoveryMaxWorkingDirectoryBytes. It must never be projected to browsers.
type RecoveryWorkingDirectory string

// RecoveryWorkingDirectoryBinding records the validated directory evidence
// required to resume an exact external session.
type RecoveryWorkingDirectoryBinding struct {
	Directory  RecoveryWorkingDirectory `json:"directory"`
	Validation RecoveryValidationState  `json:"validation"`
	ObservedAt time.Time                `json:"observedAt"`
}

// ExactSessionCapture preserves one exact opaque session identity and its
// workspace-qualified execution binding. It has no latest-session field.
type ExactSessionCapture struct {
	Schema           RecoveryCaptureSchema           `json:"schema"`
	Version          uint16                          `json:"version"`
	Pane             RecoveryPaneRef                 `json:"pane"`
	StrategyID       RecoveryStrategyID              `json:"strategyId"`
	Source           RecoveryCaptureSource           `json:"source"`
	SessionID        RecoveryOpaqueSessionID         `json:"sessionId"`
	WorkingDirectory RecoveryWorkingDirectoryBinding `json:"workingDirectory"`
	RootGeneration   RecoveryRootProcessGeneration   `json:"rootGeneration"`
	CaptureEpoch     RecoveryCaptureEpoch            `json:"captureEpoch"`
	ObservedAt       time.Time                       `json:"observedAt"`
	CapturedAt       time.Time                       `json:"capturedAt"`
}

// RecoveryExecutable and RecoveryArgument are bounded daemon-local launch
// values. They are passed as executable plus argv, never evaluated by a shell.
type RecoveryExecutable string

type RecoveryArgument string

// RecoveryArgv uses fixed storage and an explicit count to bound argument
// cardinality. Every populated value is bounded by RecoveryMaxArgumentBytes.
type RecoveryArgv struct {
	Count  uint8                                        `json:"count"`
	Values [RecoveryMaxLaunchArguments]RecoveryArgument `json:"values"`
}

// RecoveryEnvironmentName is the complete allowlist for persisted recovery
// launch context. It excludes credentials, PATH, HOME, and ambient variables.
type RecoveryEnvironmentName string

const (
	RecoveryEnvironmentTERM      RecoveryEnvironmentName = "TERM"
	RecoveryEnvironmentCOLORTERM RecoveryEnvironmentName = "COLORTERM"
	RecoveryEnvironmentLANG      RecoveryEnvironmentName = "LANG"
)

// RecoveryEnvironmentValue is bounded by RecoveryMaxEnvironmentValueBytes.
type RecoveryEnvironmentValue string

type RecoveryEnvironmentEntry struct {
	Name  RecoveryEnvironmentName  `json:"name"`
	Value RecoveryEnvironmentValue `json:"value"`
}

// RecoveryEnvironmentDelta uses fixed storage and an explicit count. It may
// contain only allowlisted names and at most RecoveryMaxEnvironmentEntries.
type RecoveryEnvironmentDelta struct {
	Count   uint8                                                   `json:"count"`
	Entries [RecoveryMaxEnvironmentEntries]RecoveryEnvironmentEntry `json:"entries"`
}

// RecoveryLaunchSpec is daemon-generated structured launch data. Browsers
// cannot supply it; adapters can produce only its bounded argv and allowlisted
// environment form, never shell text or an ambient environment.
type RecoveryLaunchSpec struct {
	Executable       RecoveryExecutable       `json:"executable"`
	Argv             RecoveryArgv             `json:"argv"`
	CWD              RecoveryWorkingDirectory `json:"cwd"`
	EnvironmentDelta RecoveryEnvironmentDelta `json:"environmentDelta"`
}

// RecoveryReplacementPlanID is an opaque daemon-local plan handle bounded by
// RecoveryMaxReplacementPlanIDBytes.
type RecoveryReplacementPlanID string

// RecoveryReplacementPaneSet uses fixed storage and a count to keep a
// controlled replacement plan bounded.
type RecoveryReplacementPaneSet struct {
	Count uint16                                       `json:"count"`
	Panes [RecoveryMaxReplacementPanes]RecoveryPaneRef `json:"panes"`
}
