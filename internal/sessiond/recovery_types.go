package sessiond

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"reflect"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Recovery contract limits bound all variable-length recovery values before
// they can cross a persistence, protocol, or launch boundary.
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
	RecoveryMaxFailureCodeBytes            = 64
	RecoveryMaxDetailCodeBytes             = 64
	RecoveryMaxCandidateHandleBytes        = 64
	RecoveryMaxBrowserSelectionCandidates  = 4
	RecoveryMaxContractBytes               = 256 * 1024
	RecoveryMaxBrowserRecoveryMessageBytes = 32 * 1024

	// RecoveryCandidateHandleBytes is 256 bits of entropy after raw URL-base64
	// decoding. The textual bound above permits that canonical representation.
	RecoveryCandidateHandleBytes = 32
)

const RecoveryCandidateHandleMaxTTL = 5 * time.Minute

// recoveryContractValue seals the canonical recovery validation boundary to
// contract values declared in this package. Every recovery ingress, durable
// record, and launch construction must use ValidateRecoveryContract, or the
// encode/decode helpers below, before it is acted on.
type recoveryContractValue interface {
	validateRecoveryContract() error
}

// ValidateRecoveryContract is the one canonical validation boundary for
// recovery contracts. It rejects values that are not a known recovery contract,
// including nil pointers, rather than accepting an unchecked duck-typed value.
func ValidateRecoveryContract(value any) error {
	if value == nil {
		return fmt.Errorf("recovery: nil contract")
	}
	rv := reflect.ValueOf(value)
	if rv.Kind() == reflect.Pointer && rv.IsNil() {
		return fmt.Errorf("recovery: nil contract")
	}
	contract, ok := value.(recoveryContractValue)
	if !ok {
		return fmt.Errorf("recovery: unsupported contract %T", value)
	}
	return contract.validateRecoveryContract()
}

// MarshalRecoveryContract validates a recovery value immediately before it
// crosses a durable or owner-local protocol boundary. Callers must not use an
// unchecked generic JSON marshal for recovery state.
func MarshalRecoveryContract(value any) ([]byte, error) {
	if err := ValidateRecoveryContract(value); err != nil {
		return nil, err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if len(data) > RecoveryMaxContractBytes {
		return nil, fmt.Errorf("recovery: encoded contract exceeds %d bytes", RecoveryMaxContractBytes)
	}
	return data, nil
}

// DecodeRecoveryContract bounds bytes before decoding, rejects unknown JSON
// fields, rejects trailing values, and validates before publishing the decoded
// value to its caller. The destination must be a non-nil pointer to a known
// recovery contract.
func DecodeRecoveryContract(data []byte, destination any) error {
	if len(data) == 0 || len(data) > RecoveryMaxContractBytes {
		return fmt.Errorf("recovery: contract input must be 1..%d bytes", RecoveryMaxContractBytes)
	}
	rv := reflect.ValueOf(destination)
	if rv.Kind() != reflect.Pointer || rv.IsNil() {
		return fmt.Errorf("recovery: decode destination must be a non-nil pointer")
	}
	if _, ok := destination.(recoveryContractValue); !ok {
		return fmt.Errorf("recovery: unsupported decode destination %T", destination)
	}

	decoded := reflect.New(rv.Elem().Type())
	if _, ok := decoded.Interface().(recoveryContractValue); !ok {
		return fmt.Errorf("recovery: unsupported decode destination %T", destination)
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(decoded.Interface()); err != nil {
		return fmt.Errorf("recovery: decode contract: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("recovery: contract has trailing JSON value")
		}
		return fmt.Errorf("recovery: decode trailing contract value: %w", err)
	}
	if err := ValidateRecoveryContract(decoded.Interface()); err != nil {
		return err
	}
	rv.Elem().Set(decoded.Elem())
	return nil
}

func validateBoundedText(value string, maximum int, field string, allowEmpty bool) error {
	if value == "" && !allowEmpty {
		return fmt.Errorf("recovery: %s is empty", field)
	}
	if len(value) > maximum {
		return fmt.Errorf("recovery: %s exceeds %d bytes", field, maximum)
	}
	if !utf8.ValidString(value) {
		return fmt.Errorf("recovery: %s is not valid UTF-8", field)
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return fmt.Errorf("recovery: %s contains a control character", field)
		}
	}
	return nil
}

func validateOpaqueIdentifier(value string, maximum int, field string) error {
	if err := validateBoundedText(value, maximum, field, false); err != nil {
		return err
	}
	if strings.ContainsAny(value, `/\:`) || strings.Contains(value, "..") {
		return fmt.Errorf("recovery: %s contains path syntax", field)
	}
	return nil
}

func validateAbsoluteCleanPath(value string, maximum int, field string) error {
	if err := validateBoundedText(value, maximum, field, false); err != nil {
		return err
	}
	if strings.ContainsRune(value, '\\') || !filepath.IsAbs(value) || filepath.Clean(value) != value {
		return fmt.Errorf("recovery: %s is not a clean absolute path", field)
	}
	return nil
}

func validateOpaqueHandle(value string, maximum, decodedBytes int, field string) error {
	if err := validateBoundedText(value, maximum, field, false); err != nil {
		return err
	}
	if strings.ContainsAny(value, `/\=`) {
		return fmt.Errorf("recovery: %s contains path or non-canonical base64 syntax", field)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != decodedBytes || base64.RawURLEncoding.EncodeToString(decoded) != value {
		return fmt.Errorf("recovery: %s is not a canonical %d-byte opaque handle", field, decodedBytes)
	}
	if bytes.Equal(decoded, make([]byte, decodedBytes)) {
		return fmt.Errorf("recovery: %s is zero", field)
	}
	return nil
}

func validateTimeRange(issuedAt, expiresAt time.Time, maximum time.Duration, field string) error {
	if issuedAt.IsZero() || expiresAt.IsZero() || !expiresAt.After(issuedAt) {
		return fmt.Errorf("recovery: %s has invalid issuance or expiry", field)
	}
	if expiresAt.Sub(issuedAt) > maximum {
		return fmt.Errorf("recovery: %s exceeds maximum TTL", field)
	}
	return nil
}

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

func (ref RecoveryPaneRef) validateRecoveryContract() error {
	if err := validateOpaqueIdentifier(string(ref.WorkspaceID), RecoveryMaxWorkspaceIDBytes, "workspace ID"); err != nil {
		return err
	}
	if ref.PaneID == 0 {
		return fmt.Errorf("recovery: pane ID is zero")
	}
	return nil
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

func validRecoveryStrategyID(value RecoveryStrategyID) bool {
	switch value {
	case RecoveryStrategyAmplifier, RecoveryStrategyClaudeCode, RecoveryStrategyOpenCode, RecoveryStrategyCodex:
		return true
	default:
		return false
	}
}

func (value RecoveryStrategyID) validateRecoveryContract() error {
	if !validRecoveryStrategyID(value) {
		return fmt.Errorf("recovery: unknown strategy %q", value)
	}
	return nil
}

// RecoveryStrategyLabel is the stable browser-safe label for one built-in
// strategy.
type RecoveryStrategyLabel string

const (
	RecoveryStrategyLabelAmplifier  RecoveryStrategyLabel = "Amplifier"
	RecoveryStrategyLabelClaudeCode RecoveryStrategyLabel = "Claude Code"
	RecoveryStrategyLabelOpenCode   RecoveryStrategyLabel = "OpenCode"
	RecoveryStrategyLabelCodex      RecoveryStrategyLabel = "Codex"
)

func validRecoveryStrategyLabel(value RecoveryStrategyLabel) bool {
	switch value {
	case RecoveryStrategyLabelAmplifier, RecoveryStrategyLabelClaudeCode, RecoveryStrategyLabelOpenCode, RecoveryStrategyLabelCodex:
		return true
	default:
		return false
	}
}

func (value RecoveryStrategyLabel) validateRecoveryContract() error {
	if !validRecoveryStrategyLabel(value) {
		return fmt.Errorf("recovery: unknown strategy label %q", value)
	}
	return nil
}

// RecoveryStrategyLabelForID is the only internal ID-to-label projection.
// Browser-safe contracts receive the resulting label, never the ID.
func RecoveryStrategyLabelForID(strategy RecoveryStrategyID) (RecoveryStrategyLabel, bool) {
	switch strategy {
	case RecoveryStrategyAmplifier:
		return RecoveryStrategyLabelAmplifier, true
	case RecoveryStrategyClaudeCode:
		return RecoveryStrategyLabelClaudeCode, true
	case RecoveryStrategyOpenCode:
		return RecoveryStrategyLabelOpenCode, true
	case RecoveryStrategyCodex:
		return RecoveryStrategyLabelCodex, true
	default:
		return "", false
	}
}

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

func validRecoveryStatus(value RecoveryStatus) bool {
	switch value {
	case RecoveryStatusRestoring, RecoveryStatusRecovered, RecoveryStatusShellRestored,
		RecoveryStatusSelectionNeeded, RecoveryStatusProvisional, RecoveryStatusStrategyFailed:
		return true
	default:
		return false
	}
}

func (value RecoveryStatus) validateRecoveryContract() error {
	if !validRecoveryStatus(value) {
		return fmt.Errorf("recovery: unknown status %q", value)
	}
	return nil
}

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

func (fence RecoveryFence) validateRecoveryContract() error {
	if err := fence.Pane.validateRecoveryContract(); err != nil {
		return err
	}
	if fence.Generation == 0 || fence.RootProcessGeneration == 0 || fence.CaptureEpoch == 0 {
		return fmt.Errorf("recovery: fence has a zero generation or capture epoch")
	}
	return fence.StrategyID.validateRecoveryContract()
}

// RecoveryClaimState is the durable state of a generation-fenced recovery
// claim. A consumed claim must not automatically launch again.
type RecoveryClaimState string

const (
	RecoveryClaimStatePending  RecoveryClaimState = "pending"
	RecoveryClaimStateClaimed  RecoveryClaimState = "claimed"
	RecoveryClaimStateConsumed RecoveryClaimState = "consumed"
)

func validRecoveryClaimState(value RecoveryClaimState) bool {
	switch value {
	case RecoveryClaimStatePending, RecoveryClaimStateClaimed, RecoveryClaimStateConsumed:
		return true
	default:
		return false
	}
}

// RecoveryAttemptState is the bounded state machine for the single automatic
// attempt allowed by one claim.
type RecoveryAttemptState string

const (
	RecoveryAttemptStatePending    RecoveryAttemptState = "pending"
	RecoveryAttemptStateLaunching  RecoveryAttemptState = "launching"
	RecoveryAttemptStateValidating RecoveryAttemptState = "validating"
	RecoveryAttemptStateFinished   RecoveryAttemptState = "finished"
)

func validRecoveryAttemptState(value RecoveryAttemptState) bool {
	switch value {
	case RecoveryAttemptStatePending, RecoveryAttemptStateLaunching, RecoveryAttemptStateValidating, RecoveryAttemptStateFinished:
		return true
	default:
		return false
	}
}

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

func validRecoveryOutcomeState(value RecoveryOutcomeState) bool {
	switch value {
	case RecoveryOutcomeStateRecovered, RecoveryOutcomeStateShellRestored,
		RecoveryOutcomeStateSelectionNeeded, RecoveryOutcomeStateProvisional, RecoveryOutcomeStateStrategyFailed:
		return true
	default:
		return false
	}
}

func statusForRecoveryOutcome(value RecoveryOutcomeState) (RecoveryStatus, bool) {
	switch value {
	case RecoveryOutcomeStateRecovered:
		return RecoveryStatusRecovered, true
	case RecoveryOutcomeStateShellRestored:
		return RecoveryStatusShellRestored, true
	case RecoveryOutcomeStateSelectionNeeded:
		return RecoveryStatusSelectionNeeded, true
	case RecoveryOutcomeStateProvisional:
		return RecoveryStatusProvisional, true
	case RecoveryOutcomeStateStrategyFailed:
		return RecoveryStatusStrategyFailed, true
	default:
		return "", false
	}
}

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
	RecoveryDetailLifecycleZero            RecoveryDetailCode = "lifecycle-zero"
	RecoveryDetailLifecycleUnknown         RecoveryDetailCode = "lifecycle-unknown"
	RecoveryDetailLifecycleReplayed        RecoveryDetailCode = "lifecycle-replayed"
	RecoveryDetailLifecycleStale           RecoveryDetailCode = "lifecycle-stale"
	RecoveryDetailLifecycleCrossPane       RecoveryDetailCode = "lifecycle-cross-pane"
	RecoveryDetailLifecycleCrossStrategy   RecoveryDetailCode = "lifecycle-cross-strategy"
	RecoveryDetailLifecycleConflicting     RecoveryDetailCode = "lifecycle-conflicting"
	RecoveryDetailLaunchRejected           RecoveryDetailCode = "launch-rejected"
	RecoveryDetailLaunchFailed             RecoveryDetailCode = "launch-failed"
	RecoveryDetailObservedIdentityMismatch RecoveryDetailCode = "observed-identity-mismatch"
	RecoveryDetailReadinessTimeout         RecoveryDetailCode = "readiness-timeout"
	RecoveryDetailReplacementDeferred      RecoveryDetailCode = "replacement-deferred"
	RecoveryDetailReplacementFailed        RecoveryDetailCode = "replacement-failed"
	RecoveryDetailReplacementPlanInvalid   RecoveryDetailCode = "replacement-plan-invalid"
	RecoveryDetailActivePaneInvalid        RecoveryDetailCode = "active-pane-invalid"
	RecoveryDetailCandidateInvalid         RecoveryDetailCode = "candidate-invalid"
)

func validRecoveryDetailCode(value RecoveryDetailCode) bool {
	switch value {
	case RecoveryDetailNone, RecoveryDetailCaptureMissing, RecoveryDetailCaptureInvalid,
		RecoveryDetailCaptureStale, RecoveryDetailCaptureConflicting, RecoveryDetailCaptureAmbiguous,
		RecoveryDetailWorkingDirectoryInvalid, RecoveryDetailStrategyUnsupported,
		RecoveryDetailSchemaIncompatible, RecoveryDetailLifecycleUnavailable,
		RecoveryDetailLifecycleExpired, RecoveryDetailLifecycleMalformed, RecoveryDetailLifecycleZero,
		RecoveryDetailLifecycleUnknown, RecoveryDetailLifecycleReplayed, RecoveryDetailLifecycleStale,
		RecoveryDetailLifecycleCrossPane, RecoveryDetailLifecycleCrossStrategy,
		RecoveryDetailLifecycleConflicting, RecoveryDetailLaunchRejected, RecoveryDetailLaunchFailed,
		RecoveryDetailObservedIdentityMismatch, RecoveryDetailReadinessTimeout,
		RecoveryDetailReplacementDeferred, RecoveryDetailReplacementFailed,
		RecoveryDetailReplacementPlanInvalid, RecoveryDetailActivePaneInvalid, RecoveryDetailCandidateInvalid:
		return true
	default:
		return false
	}
}

func (value RecoveryDetailCode) validateRecoveryContract() error {
	if len(value) > RecoveryMaxDetailCodeBytes || !validRecoveryDetailCode(value) {
		return fmt.Errorf("recovery: unknown detail code %q", value)
	}
	return nil
}

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

func validRecoveryFailureCode(value RecoveryFailureCode) bool {
	switch value {
	case RecoveryFailureNone, RecoveryFailureCaptureInvalid, RecoveryFailureWorkingDirectoryInvalid,
		RecoveryFailureStrategyUnsupported, RecoveryFailureSchemaIncompatible,
		RecoveryFailureLaunchRejected, RecoveryFailureLaunchFailed,
		RecoveryFailureObservedIdentityMismatch, RecoveryFailureReadinessTimeout:
		return true
	default:
		return false
	}
}

func (value RecoveryFailureCode) validateRecoveryContract() error {
	if len(value) > RecoveryMaxFailureCodeBytes || !validRecoveryFailureCode(value) {
		return fmt.Errorf("recovery: unknown failure code %q", value)
	}
	return nil
}

func recoveryDetailForFailureCode(value RecoveryFailureCode) (RecoveryDetailCode, bool) {
	switch value {
	case RecoveryFailureNone:
		return RecoveryDetailNone, true
	case RecoveryFailureCaptureInvalid:
		return RecoveryDetailCaptureInvalid, true
	case RecoveryFailureWorkingDirectoryInvalid:
		return RecoveryDetailWorkingDirectoryInvalid, true
	case RecoveryFailureStrategyUnsupported:
		return RecoveryDetailStrategyUnsupported, true
	case RecoveryFailureSchemaIncompatible:
		return RecoveryDetailSchemaIncompatible, true
	case RecoveryFailureLaunchRejected:
		return RecoveryDetailLaunchRejected, true
	case RecoveryFailureLaunchFailed:
		return RecoveryDetailLaunchFailed, true
	case RecoveryFailureObservedIdentityMismatch:
		return RecoveryDetailObservedIdentityMismatch, true
	case RecoveryFailureReadinessTimeout:
		return RecoveryDetailReadinessTimeout, true
	default:
		return "", false
	}
}

// RecoveryClaim is the persisted authorization to make one recovery attempt.
type RecoveryClaim struct {
	Fence     RecoveryFence      `json:"fence"`
	State     RecoveryClaimState `json:"state"`
	ClaimedAt time.Time          `json:"claimedAt"`
}

func (claim RecoveryClaim) validateRecoveryContract() error {
	if err := claim.Fence.validateRecoveryContract(); err != nil {
		return err
	}
	if !validRecoveryClaimState(claim.State) {
		return fmt.Errorf("recovery: unknown claim state %q", claim.State)
	}
	if claim.State == RecoveryClaimStatePending {
		if !claim.ClaimedAt.IsZero() {
			return fmt.Errorf("recovery: pending claim has claimed timestamp")
		}
		return nil
	}
	if claim.ClaimedAt.IsZero() {
		return fmt.Errorf("recovery: non-pending claim has no claimed timestamp")
	}
	return nil
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

func (attempt RecoveryAttempt) validateRecoveryContract() error {
	if err := attempt.Fence.validateRecoveryContract(); err != nil {
		return err
	}
	if attempt.Ordinal >= RecoveryMaxAutomaticAttempts {
		return fmt.Errorf("recovery: attempt ordinal %d exceeds automatic attempt limit", attempt.Ordinal)
	}
	if !validRecoveryAttemptState(attempt.State) {
		return fmt.Errorf("recovery: unknown attempt state %q", attempt.State)
	}
	if attempt.State == RecoveryAttemptStatePending {
		if !attempt.StartedAt.IsZero() || !attempt.UpdatedAt.IsZero() {
			return fmt.Errorf("recovery: pending attempt has timestamps")
		}
		return nil
	}
	if attempt.StartedAt.IsZero() || attempt.UpdatedAt.IsZero() || attempt.UpdatedAt.Before(attempt.StartedAt) {
		return fmt.Errorf("recovery: active attempt has invalid timestamps")
	}
	return nil
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

func (outcome RecoveryOutcome) validateRecoveryContract() error {
	if err := outcome.Fence.validateRecoveryContract(); err != nil {
		return err
	}
	expectedStatus, ok := statusForRecoveryOutcome(outcome.State)
	if !ok || outcome.Status != expectedStatus {
		return fmt.Errorf("recovery: invalid outcome state/status pairing")
	}
	if err := outcome.DetailCode.validateRecoveryContract(); err != nil {
		return err
	}
	if err := outcome.FailureCode.validateRecoveryContract(); err != nil {
		return err
	}
	if outcome.CompletedAt.IsZero() {
		return fmt.Errorf("recovery: outcome has no completion timestamp")
	}
	if outcome.CanRetry != (outcome.Status == RecoveryStatusStrategyFailed) {
		return fmt.Errorf("recovery: invalid retry/status pairing")
	}
	if outcome.CanSelect != (outcome.Status == RecoveryStatusSelectionNeeded) {
		return fmt.Errorf("recovery: invalid selection/status pairing")
	}
	switch outcome.Status {
	case RecoveryStatusRecovered, RecoveryStatusShellRestored:
		if outcome.DetailCode != RecoveryDetailNone || outcome.FailureCode != RecoveryFailureNone {
			return fmt.Errorf("recovery: successful outcome has failure detail")
		}
	case RecoveryStatusStrategyFailed:
		expectedDetail, ok := recoveryDetailForFailureCode(outcome.FailureCode)
		if !ok || outcome.FailureCode == RecoveryFailureNone || outcome.DetailCode != expectedDetail {
			return fmt.Errorf("recovery: failed outcome has invalid detail/failure pairing")
		}
	default:
		if outcome.DetailCode == RecoveryDetailNone || outcome.FailureCode != RecoveryFailureNone {
			return fmt.Errorf("recovery: provisional outcome has invalid detail/failure pairing")
		}
	}
	return nil
}

// RecoveryCaptureSchema identifies the record schema; future schemas are
// explicit additions rather than reinterpretations of this capture.
type RecoveryCaptureSchema string

const RecoveryCaptureSchemaV1 RecoveryCaptureSchema = "muxterm.recovery.capture"

func (value RecoveryCaptureSchema) validateRecoveryContract() error {
	if value != RecoveryCaptureSchemaV1 {
		return fmt.Errorf("recovery: unknown capture schema %q", value)
	}
	return nil
}

// RecoveryCaptureSource is closed to evidence paths that do not inspect
// terminal text or select a guessed latest session.
type RecoveryCaptureSource string

const (
	RecoveryCaptureSourceLifecycle           RecoveryCaptureSource = "lifecycle"
	RecoveryCaptureSourceManagedSession      RecoveryCaptureSource = "managed-session"
	RecoveryCaptureSourceVerifiedCorrelation RecoveryCaptureSource = "verified-correlation"
	RecoveryCaptureSourceExplicitSelection   RecoveryCaptureSource = "explicit-selection"
)

func validRecoveryCaptureSource(value RecoveryCaptureSource) bool {
	switch value {
	case RecoveryCaptureSourceLifecycle, RecoveryCaptureSourceManagedSession,
		RecoveryCaptureSourceVerifiedCorrelation, RecoveryCaptureSourceExplicitSelection:
		return true
	default:
		return false
	}
}

func (value RecoveryCaptureSource) validateRecoveryContract() error {
	if !validRecoveryCaptureSource(value) {
		return fmt.Errorf("recovery: unknown capture source %q", value)
	}
	return nil
}

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

func validRecoveryValidationState(value RecoveryValidationState) bool {
	switch value {
	case RecoveryValidationValid, RecoveryValidationMissing, RecoveryValidationMalformed,
		RecoveryValidationStale, RecoveryValidationConflicting, RecoveryValidationAmbiguous,
		RecoveryValidationMismatched, RecoveryValidationUnsupported:
		return true
	default:
		return false
	}
}

func (value RecoveryValidationState) validateRecoveryContract() error {
	if !validRecoveryValidationState(value) {
		return fmt.Errorf("recovery: unknown validation state %q", value)
	}
	return nil
}

func recoveryDetailForValidationState(value RecoveryValidationState) (RecoveryDetailCode, bool) {
	switch value {
	case RecoveryValidationValid:
		return RecoveryDetailNone, true
	case RecoveryValidationMissing:
		return RecoveryDetailCaptureMissing, true
	case RecoveryValidationMalformed:
		return RecoveryDetailCaptureInvalid, true
	case RecoveryValidationStale:
		return RecoveryDetailCaptureStale, true
	case RecoveryValidationConflicting:
		return RecoveryDetailCaptureConflicting, true
	case RecoveryValidationAmbiguous:
		return RecoveryDetailCaptureAmbiguous, true
	case RecoveryValidationMismatched:
		return RecoveryDetailObservedIdentityMismatch, true
	case RecoveryValidationUnsupported:
		return RecoveryDetailStrategyUnsupported, true
	default:
		return "", false
	}
}

// RecoveryOpaqueSessionID is an exact daemon-local external session identity.
// Its byte length is bounded by RecoveryMaxOpaqueSessionIDBytes and it must
// never be projected to browsers.
type RecoveryOpaqueSessionID string

func (value RecoveryOpaqueSessionID) validateRecoveryContract() error {
	return validateOpaqueIdentifier(string(value), RecoveryMaxOpaqueSessionIDBytes, "session ID")
}

// RecoveryWorkingDirectory is a daemon-local path bounded by
// RecoveryMaxWorkingDirectoryBytes. It must never be projected to browsers.
type RecoveryWorkingDirectory string

func (value RecoveryWorkingDirectory) validateRecoveryContract() error {
	return validateAbsoluteCleanPath(string(value), RecoveryMaxWorkingDirectoryBytes, "working directory")
}

// RecoveryWorkingDirectoryBinding records the validated directory evidence
// required to resume an exact external session.
type RecoveryWorkingDirectoryBinding struct {
	Directory  RecoveryWorkingDirectory `json:"directory"`
	Validation RecoveryValidationState  `json:"validation"`
	ObservedAt time.Time                `json:"observedAt"`
}

func (binding RecoveryWorkingDirectoryBinding) validateRecoveryContract() error {
	if err := binding.Validation.validateRecoveryContract(); err != nil {
		return err
	}
	if binding.Validation != RecoveryValidationValid {
		if binding.Directory != "" || !binding.ObservedAt.IsZero() {
			return fmt.Errorf("recovery: invalid directory binding retains directory evidence")
		}
		return nil
	}
	if err := binding.Directory.validateRecoveryContract(); err != nil {
		return err
	}
	if binding.ObservedAt.IsZero() {
		return fmt.Errorf("recovery: valid directory binding has no observation timestamp")
	}
	return nil
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

func (capture ExactSessionCapture) validateRecoveryContract() error {
	if err := capture.Schema.validateRecoveryContract(); err != nil {
		return err
	}
	if capture.Version != RecoveryCaptureSchemaVersion {
		return fmt.Errorf("recovery: unsupported capture schema version %d", capture.Version)
	}
	if err := capture.Pane.validateRecoveryContract(); err != nil {
		return err
	}
	if err := capture.StrategyID.validateRecoveryContract(); err != nil {
		return err
	}
	if err := capture.Source.validateRecoveryContract(); err != nil {
		return err
	}
	if err := capture.SessionID.validateRecoveryContract(); err != nil {
		return err
	}
	if err := capture.WorkingDirectory.validateRecoveryContract(); err != nil {
		return err
	}
	if capture.WorkingDirectory.Validation != RecoveryValidationValid {
		return fmt.Errorf("recovery: exact capture has invalid working directory")
	}
	if capture.RootGeneration == 0 || capture.CaptureEpoch == 0 {
		return fmt.Errorf("recovery: capture has a zero root generation or capture epoch")
	}
	if capture.ObservedAt.IsZero() || capture.CapturedAt.IsZero() || capture.CapturedAt.Before(capture.ObservedAt) {
		return fmt.Errorf("recovery: capture has invalid timestamps")
	}
	return nil
}

// RecoveryExecutable and RecoveryArgument are bounded daemon-local launch
// values. They are passed as executable plus argv, never evaluated by a shell.
type RecoveryExecutable string

func (value RecoveryExecutable) validateRecoveryContract() error {
	return validateAbsoluteCleanPath(string(value), RecoveryMaxExecutableBytes, "executable")
}

type RecoveryArgument string

func (value RecoveryArgument) validateRecoveryContract() error {
	if err := validateBoundedText(string(value), RecoveryMaxArgumentBytes, "argument", false); err != nil {
		return err
	}
	if strings.ContainsAny(string(value), `/\`) || strings.Contains(string(value), "..") {
		return fmt.Errorf("recovery: argument contains prohibited path syntax")
	}
	return nil
}

// RecoveryArgv uses fixed storage and an explicit count to bound argument
// cardinality. Every populated value is bounded by RecoveryMaxArgumentBytes.
type RecoveryArgv struct {
	Count  uint8                                        `json:"count"`
	Values [RecoveryMaxLaunchArguments]RecoveryArgument `json:"values"`
}

func (argv RecoveryArgv) validateRecoveryContract() error {
	if int(argv.Count) > len(argv.Values) {
		return fmt.Errorf("recovery: argument count exceeds capacity")
	}
	for index, argument := range argv.Values {
		if index >= int(argv.Count) {
			if argument != "" {
				return fmt.Errorf("recovery: unused argument slot %d is nonzero", index)
			}
			continue
		}
		if err := argument.validateRecoveryContract(); err != nil {
			return err
		}
	}
	return nil
}

// NewRecoveryArgv constructs the fixed argv representation only after bounding
// cardinality; it never allocates or copies an unbounded caller slice.
func NewRecoveryArgv(arguments []RecoveryArgument) (RecoveryArgv, error) {
	if len(arguments) > RecoveryMaxLaunchArguments {
		return RecoveryArgv{}, fmt.Errorf("recovery: argument count exceeds capacity")
	}
	var argv RecoveryArgv
	argv.Count = uint8(len(arguments))
	for index, argument := range arguments {
		argv.Values[index] = argument
	}
	if err := argv.validateRecoveryContract(); err != nil {
		return RecoveryArgv{}, err
	}
	return argv, nil
}

// RecoveryEnvironmentName is the complete allowlist for persisted recovery
// launch context. It excludes credentials, PATH, HOME, and ambient variables.
type RecoveryEnvironmentName string

const (
	RecoveryEnvironmentTERM      RecoveryEnvironmentName = "TERM"
	RecoveryEnvironmentCOLORTERM RecoveryEnvironmentName = "COLORTERM"
	RecoveryEnvironmentLANG      RecoveryEnvironmentName = "LANG"
)

func validRecoveryEnvironmentName(value RecoveryEnvironmentName) bool {
	switch value {
	case RecoveryEnvironmentTERM, RecoveryEnvironmentCOLORTERM, RecoveryEnvironmentLANG:
		return true
	default:
		return false
	}
}

// RecoveryEnvironmentValue is bounded by RecoveryMaxEnvironmentValueBytes.
type RecoveryEnvironmentValue string

func (value RecoveryEnvironmentValue) validateRecoveryContract() error {
	if err := validateBoundedText(string(value), RecoveryMaxEnvironmentValueBytes, "environment value", true); err != nil {
		return err
	}
	if strings.ContainsAny(string(value), `/\`) || strings.Contains(string(value), "..") {
		return fmt.Errorf("recovery: environment value contains prohibited path syntax")
	}
	return nil
}

type RecoveryEnvironmentEntry struct {
	Name  RecoveryEnvironmentName  `json:"name"`
	Value RecoveryEnvironmentValue `json:"value"`
}

func (entry RecoveryEnvironmentEntry) validateRecoveryContract() error {
	if !validRecoveryEnvironmentName(entry.Name) {
		return fmt.Errorf("recovery: disallowed environment key %q", entry.Name)
	}
	return entry.Value.validateRecoveryContract()
}

// RecoveryEnvironmentDelta uses fixed storage and an explicit count. It may
// contain only allowlisted names and at most RecoveryMaxEnvironmentEntries.
type RecoveryEnvironmentDelta struct {
	Count   uint8                                                   `json:"count"`
	Entries [RecoveryMaxEnvironmentEntries]RecoveryEnvironmentEntry `json:"entries"`
}

func (delta RecoveryEnvironmentDelta) validateRecoveryContract() error {
	if int(delta.Count) > len(delta.Entries) {
		return fmt.Errorf("recovery: environment count exceeds capacity")
	}
	seen := make(map[RecoveryEnvironmentName]struct{}, delta.Count)
	for index, entry := range delta.Entries {
		if index >= int(delta.Count) {
			if entry.Name != "" || entry.Value != "" {
				return fmt.Errorf("recovery: unused environment slot %d is nonzero", index)
			}
			continue
		}
		if err := entry.validateRecoveryContract(); err != nil {
			return err
		}
		if _, duplicate := seen[entry.Name]; duplicate {
			return fmt.Errorf("recovery: duplicate environment key %q", entry.Name)
		}
		seen[entry.Name] = struct{}{}
	}
	return nil
}

// NewRecoveryEnvironmentDelta constructs fixed environment storage after
// checking a caller slice's capacity and every allowlisted entry.
func NewRecoveryEnvironmentDelta(entries []RecoveryEnvironmentEntry) (RecoveryEnvironmentDelta, error) {
	if len(entries) > RecoveryMaxEnvironmentEntries {
		return RecoveryEnvironmentDelta{}, fmt.Errorf("recovery: environment count exceeds capacity")
	}
	var delta RecoveryEnvironmentDelta
	delta.Count = uint8(len(entries))
	for index, entry := range entries {
		delta.Entries[index] = entry
	}
	if err := delta.validateRecoveryContract(); err != nil {
		return RecoveryEnvironmentDelta{}, err
	}
	return delta, nil
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

func (spec RecoveryLaunchSpec) validateRecoveryContract() error {
	if err := spec.Executable.validateRecoveryContract(); err != nil {
		return err
	}
	if err := spec.Argv.validateRecoveryContract(); err != nil {
		return err
	}
	if err := spec.CWD.validateRecoveryContract(); err != nil {
		return err
	}
	return spec.EnvironmentDelta.validateRecoveryContract()
}

// RecoveryCandidateHandle is an opaque daemon-issued 256-bit selection handle.
// It is not an external session ID and is the only candidate value a browser
// may return to sessiond.
type RecoveryCandidateHandle string

func (handle RecoveryCandidateHandle) validateRecoveryContract() error {
	return validateOpaqueHandle(
		string(handle),
		RecoveryMaxCandidateHandleBytes,
		RecoveryCandidateHandleBytes,
		"candidate handle",
	)
}

// RecoveryCandidateGeneration distinguishes candidate issuance within a
// recovery fence. It is authoritative daemon state, not browser input.
type RecoveryCandidateGeneration uint64

// RecoverySelectionCandidate is the browser-safe projection of one daemon-held
// candidate lease. It contains only a handle and a fixed human-safe label.
type RecoverySelectionCandidate struct {
	CandidateHandle RecoveryCandidateHandle `json:"candidateHandle"`
	StrategyLabel   RecoveryStrategyLabel   `json:"strategyLabel"`
}

func (candidate RecoverySelectionCandidate) validateRecoveryContract() error {
	if err := candidate.CandidateHandle.validateRecoveryContract(); err != nil {
		return err
	}
	return candidate.StrategyLabel.validateRecoveryContract()
}

// RecoveryCandidateLease is daemon-held ephemeral state. It binds a browser
// handle to one exact external session identity and one current recovery fence.
// It is intentionally not JSON-serializable or durable, so the exact identity
// cannot enter the browser projection.
type RecoveryCandidateLease struct {
	Handle              RecoveryCandidateHandle     `json:"-"`
	SessionID           RecoveryOpaqueSessionID     `json:"-"`
	Pane                RecoveryPaneRef             `json:"-"`
	Fence               RecoveryFence               `json:"-"`
	StrategyID          RecoveryStrategyID          `json:"-"`
	CandidateGeneration RecoveryCandidateGeneration `json:"-"`
	IssuedAt            time.Time                   `json:"-"`
	ExpiresAt           time.Time                   `json:"-"`
	Consumed            bool                        `json:"-"`
}

func (lease RecoveryCandidateLease) validateRecoveryContract() error {
	if err := lease.Handle.validateRecoveryContract(); err != nil {
		return err
	}
	if err := lease.SessionID.validateRecoveryContract(); err != nil {
		return err
	}
	if err := lease.Pane.validateRecoveryContract(); err != nil {
		return err
	}
	if err := lease.Fence.validateRecoveryContract(); err != nil {
		return err
	}
	if err := lease.StrategyID.validateRecoveryContract(); err != nil {
		return err
	}
	if lease.CandidateGeneration == 0 {
		return fmt.Errorf("recovery: candidate lease has zero candidate generation")
	}
	if lease.Pane != lease.Fence.Pane || lease.StrategyID != lease.Fence.StrategyID {
		return fmt.Errorf("recovery: candidate lease does not match its recovery fence")
	}
	return validateTimeRange(lease.IssuedAt, lease.ExpiresAt, RecoveryCandidateHandleMaxTTL, "candidate lease")
}

// MarshalJSON prevents an ephemeral candidate binding from becoming durable or
// browser-visible through an accidental generic JSON path.
func (RecoveryCandidateLease) MarshalJSON() ([]byte, error) {
	return nil, fmt.Errorf("recovery: candidate lease must not be serialized")
}

// UnmarshalJSON prevents an untrusted caller from minting an in-memory lease.
func (*RecoveryCandidateLease) UnmarshalJSON([]byte) error {
	return fmt.Errorf("recovery: candidate lease must be issued by sessiond")
}

// NewRecoveryCandidateLease constructs the daemon-held candidate binding. The
// pane and strategy are derived from the current fence, not accepted separately.
func NewRecoveryCandidateLease(
	handle RecoveryCandidateHandle,
	sessionID RecoveryOpaqueSessionID,
	fence RecoveryFence,
	candidateGeneration RecoveryCandidateGeneration,
	issuedAt, expiresAt time.Time,
) (RecoveryCandidateLease, error) {
	lease := RecoveryCandidateLease{
		Handle:              handle,
		SessionID:           sessionID,
		Pane:                fence.Pane,
		Fence:               fence,
		StrategyID:          fence.StrategyID,
		CandidateGeneration: candidateGeneration,
		IssuedAt:            issuedAt,
		ExpiresAt:           expiresAt,
	}
	if err := lease.validateRecoveryContract(); err != nil {
		return RecoveryCandidateLease{}, err
	}
	return lease, nil
}

// BrowserCandidate returns the only candidate projection permitted to cross the
// browser boundary after the daemon has issued and validated the lease.
func (lease RecoveryCandidateLease) BrowserCandidate() (RecoverySelectionCandidate, error) {
	if err := lease.validateRecoveryContract(); err != nil {
		return RecoverySelectionCandidate{}, err
	}
	label, ok := RecoveryStrategyLabelForID(lease.StrategyID)
	if !ok {
		return RecoverySelectionCandidate{}, fmt.Errorf("recovery: candidate lease has unknown strategy")
	}
	return RecoverySelectionCandidate{CandidateHandle: lease.Handle, StrategyLabel: label}, nil
}

// RecoveryCandidateResolution is daemon-local output after a browser handle is
// resolved. It preserves the exact external session identity, current fence,
// and candidate generation. The type is deliberately non-serializable so none
// of that authority can be projected back to the browser.
type RecoveryCandidateResolution struct {
	Fence               RecoveryFence               `json:"-"`
	SessionID           RecoveryOpaqueSessionID     `json:"-"`
	CandidateGeneration RecoveryCandidateGeneration `json:"-"`
}

func (resolution RecoveryCandidateResolution) validateRecoveryContract() error {
	if err := resolution.Fence.validateRecoveryContract(); err != nil {
		return err
	}
	if err := resolution.SessionID.validateRecoveryContract(); err != nil {
		return err
	}
	if resolution.CandidateGeneration == 0 {
		return fmt.Errorf("recovery: candidate resolution has zero candidate generation")
	}
	return nil
}

func (RecoveryCandidateResolution) MarshalJSON() ([]byte, error) {
	return nil, fmt.Errorf("recovery: candidate resolution must not be serialized")
}

func (*RecoveryCandidateResolution) UnmarshalJSON([]byte) error {
	return fmt.Errorf("recovery: candidate resolution is daemon-local")
}

// RecoveryCandidateLeaseResolver is the daemon-held candidate registry
// boundary. It must atomically resolve the handle, validate the daemon-held
// exact session identity, verify that its workspace-qualified pane, recovery
// fence, fixed strategy, and candidate generation are still current, reject
// expired or consumed state, and consume the single-use lease before returning
// a successful resolution.
type RecoveryCandidateLeaseResolver interface {
	ResolveAndConsumeRecoveryCandidate(RecoverySelectRequest) (RecoveryCandidateResolution, RecoveryDetailCode)
}

// RecoveryReplacementPlanID is an opaque daemon-local 256-bit plan handle
// bounded by RecoveryMaxReplacementPlanIDBytes.
type RecoveryReplacementPlanID string

func (value RecoveryReplacementPlanID) validateRecoveryContract() error {
	return validateOpaqueHandle(
		string(value),
		RecoveryMaxReplacementPlanIDBytes,
		RecoveryCandidateHandleBytes,
		"replacement plan handle",
	)
}

// RecoveryReplacementPaneSet uses fixed storage and a count to keep a
// controlled replacement plan bounded.
type RecoveryReplacementPaneSet struct {
	Count uint16                                       `json:"count"`
	Panes [RecoveryMaxReplacementPanes]RecoveryPaneRef `json:"panes"`
}

func (set RecoveryReplacementPaneSet) validateRecoveryContract() error {
	if int(set.Count) > len(set.Panes) {
		return fmt.Errorf("recovery: replacement pane count exceeds capacity")
	}
	seen := make(map[RecoveryPaneRef]struct{}, set.Count)
	for index, pane := range set.Panes {
		if index >= int(set.Count) {
			if pane != (RecoveryPaneRef{}) {
				return fmt.Errorf("recovery: unused replacement pane slot %d is nonzero", index)
			}
			continue
		}
		if err := pane.validateRecoveryContract(); err != nil {
			return err
		}
		if _, duplicate := seen[pane]; duplicate {
			return fmt.Errorf("recovery: duplicate replacement pane")
		}
		seen[pane] = struct{}{}
	}
	return nil
}

// NewRecoveryReplacementPaneSet bounds a registry-derived pane census before
// copying it into fixed storage. Browser and owner-local callers must never
// submit this value; only sessiond's registry may construct it.
func NewRecoveryReplacementPaneSet(panes []RecoveryPaneRef) (RecoveryReplacementPaneSet, error) {
	if len(panes) > RecoveryMaxReplacementPanes {
		return RecoveryReplacementPaneSet{}, fmt.Errorf("recovery: replacement pane count exceeds capacity")
	}
	var set RecoveryReplacementPaneSet
	set.Count = uint16(len(panes))
	for index, pane := range panes {
		set.Panes[index] = pane
	}
	if err := set.validateRecoveryContract(); err != nil {
		return RecoveryReplacementPaneSet{}, err
	}
	return set, nil
}
