package sessiond

import "time"

// RecoveryCaptureRequest contains only daemon-observed, bounded evidence. It
// has no terminal text, browser input, ambient credentials, or raw tool error.
type RecoveryCaptureRequest struct {
	Fence            RecoveryFence                   `json:"fence"`
	Source           RecoveryCaptureSource           `json:"source"`
	SessionID        RecoveryOpaqueSessionID         `json:"sessionId"`
	WorkingDirectory RecoveryWorkingDirectoryBinding `json:"workingDirectory"`
	ObservedAt       time.Time                       `json:"observedAt"`
}

// RecoveryCaptureResult reports capture validation using stable detail codes.
// Capture is meaningful only when Validation is RecoveryValidationValid.
type RecoveryCaptureResult struct {
	Validation RecoveryValidationState `json:"validation"`
	Capture    ExactSessionCapture     `json:"capture"`
	DetailCode RecoveryDetailCode      `json:"detailCode"`
}

// RecoveryCaptureValidationRequest validates an existing capture against the
// current generation-fenced authority.
type RecoveryCaptureValidationRequest struct {
	ExpectedFence RecoveryFence       `json:"expectedFence"`
	Capture       ExactSessionCapture `json:"capture"`
}

type RecoveryCaptureValidationResult struct {
	Validation RecoveryValidationState `json:"validation"`
	DetailCode RecoveryDetailCode      `json:"detailCode"`
}

// RecoveryResumeConstructionState describes whether an adapter constructed a
// bounded structured resume specification, not whether a process was launched.
type RecoveryResumeConstructionState string

const (
	RecoveryResumeConstructionReady    RecoveryResumeConstructionState = "ready"
	RecoveryResumeConstructionRejected RecoveryResumeConstructionState = "rejected"
)

// RecoveryResumeRequest is daemon-owned launch construction input. Browsers
// never provide a capture, executable, argv, working directory, or environment
// delta through this contract.
type RecoveryResumeRequest struct {
	Claim   RecoveryClaim       `json:"claim"`
	Capture ExactSessionCapture `json:"capture"`
}

type RecoveryResumeResult struct {
	State      RecoveryResumeConstructionState `json:"state"`
	Launch     RecoveryLaunchSpec              `json:"launch"`
	DetailCode RecoveryDetailCode              `json:"detailCode"`
}

// RecoveryObservedIdentity is authoritative post-launch evidence. Its exact
// opaque identity is daemon-local and must never be sent to a browser.
type RecoveryObservedIdentity struct {
	SessionID        RecoveryOpaqueSessionID         `json:"sessionId"`
	WorkingDirectory RecoveryWorkingDirectoryBinding `json:"workingDirectory"`
	ObservedAt       time.Time                       `json:"observedAt"`
}

type RecoveryObservedIdentityRequest struct {
	ExpectedFence RecoveryFence            `json:"expectedFence"`
	Capture       ExactSessionCapture      `json:"capture"`
	Observed      RecoveryObservedIdentity `json:"observed"`
}

type RecoveryObservedIdentityResult struct {
	Validation RecoveryValidationState `json:"validation"`
	DetailCode RecoveryDetailCode      `json:"detailCode"`
}

// RecoveryStrategy is the fixed-roster adapter seam. Strategy selection occurs
// outside this interface against the four RecoveryStrategyID constants; this
// seam intentionally offers no dynamic strategy loading, shell evaluation, or
// raw-error escape hatch.
type RecoveryStrategy interface {
	Capture(RecoveryCaptureRequest) RecoveryCaptureResult
	ValidateCapture(RecoveryCaptureValidationRequest) RecoveryCaptureValidationResult
	BuildResume(RecoveryResumeRequest) RecoveryResumeResult
	ValidateObservedIdentity(RecoveryObservedIdentityRequest) RecoveryObservedIdentityResult
}

// BuiltInRecoveryStrategies is the complete fixed adapter roster. It has no
// map, registration hook, or plugin loader through which an arbitrary strategy
// could become recovery authority.
type BuiltInRecoveryStrategies struct {
	Amplifier  RecoveryStrategy
	ClaudeCode RecoveryStrategy
	OpenCode   RecoveryStrategy
	Codex      RecoveryStrategy
}
