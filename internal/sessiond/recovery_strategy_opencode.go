package sessiond

import (
	"fmt"
	"path/filepath"
)

// openCodeRecoveryStrategy constructs only exact, managed OpenCode recovery
// launches. It keeps no state besides the executable selected at construction.
type openCodeRecoveryStrategy struct {
	executable RecoveryExecutable
}

var _ RecoveryStrategy = openCodeRecoveryStrategy{}

// NewOpenCodeRecoveryStrategy constructs the pure OpenCode recovery adapter.
// Executable existence and launchability are intentionally not checked here.
func NewOpenCodeRecoveryStrategy(executable RecoveryExecutable) (RecoveryStrategy, error) {
	if !validOpenCodeExecutable(executable) {
		return nil, fmt.Errorf("recovery: OpenCode executable is invalid")
	}
	return openCodeRecoveryStrategy{executable: executable}, nil
}

func validOpenCodeExecutable(executable RecoveryExecutable) bool {
	return executable.validateRecoveryContract() == nil &&
		filepath.Base(string(executable)) == "opencode"
}

func validOpenCodeSessionID(sessionID RecoveryOpaqueSessionID) bool {
	value := string(sessionID)
	if len(value) < len("ses_")+1 || len(value) > RecoveryMaxOpaqueSessionIDBytes ||
		value[:len("ses_")] != "ses_" {
		return false
	}
	for _, value := range []byte(value[len("ses_"):]) {
		if !(value >= 'A' && value <= 'Z') &&
			!(value >= 'a' && value <= 'z') &&
			!(value >= '0' && value <= '9') &&
			value != '_' &&
			value != '-' {
			return false
		}
	}
	return true
}

func acceptedOpenCodeCaptureSource(source RecoveryCaptureSource) bool {
	return source == RecoveryCaptureSourceManagedSession ||
		source == RecoveryCaptureSourceExplicitSelection
}

func validateOpenCodeFence(fence RecoveryFence) RecoveryValidationState {
	if err := fence.validateRecoveryContract(); err != nil {
		return RecoveryValidationMalformed
	}
	if fence.StrategyID != RecoveryStrategyOpenCode {
		return RecoveryValidationUnsupported
	}
	return RecoveryValidationValid
}

func validateOpenCodeCaptureSource(source RecoveryCaptureSource) RecoveryValidationState {
	if err := source.validateRecoveryContract(); err != nil {
		return RecoveryValidationMalformed
	}
	if !acceptedOpenCodeCaptureSource(source) {
		return RecoveryValidationUnsupported
	}
	return RecoveryValidationValid
}

func validateOpenCodeCapture(capture ExactSessionCapture) RecoveryValidationState {
	if err := capture.validateRecoveryContract(); err != nil {
		return RecoveryValidationMalformed
	}
	if capture.StrategyID != RecoveryStrategyOpenCode {
		return RecoveryValidationUnsupported
	}
	if validation := validateOpenCodeCaptureSource(capture.Source); validation != RecoveryValidationValid {
		return validation
	}
	if !validOpenCodeSessionID(capture.SessionID) ||
		!capture.WorkingDirectory.ObservedAt.Equal(capture.ObservedAt) {
		return RecoveryValidationMalformed
	}
	return RecoveryValidationValid
}

func rejectedOpenCodeCapture(validation RecoveryValidationState) RecoveryCaptureResult {
	if validation == RecoveryValidationUnsupported {
		return RecoveryCaptureResult{
			Validation: RecoveryValidationUnsupported,
			DetailCode: RecoveryDetailStrategyUnsupported,
		}
	}
	return RecoveryCaptureResult{
		Validation: RecoveryValidationMalformed,
		DetailCode: RecoveryDetailCaptureInvalid,
	}
}

func openCodeCaptureValidationResult(validation RecoveryValidationState) RecoveryCaptureValidationResult {
	if validation == RecoveryValidationUnsupported {
		return RecoveryCaptureValidationResult{
			Validation: RecoveryValidationUnsupported,
			DetailCode: RecoveryDetailStrategyUnsupported,
		}
	}
	return RecoveryCaptureValidationResult{
		Validation: RecoveryValidationMalformed,
		DetailCode: RecoveryDetailCaptureInvalid,
	}
}

func (strategy openCodeRecoveryStrategy) Capture(request RecoveryCaptureRequest) RecoveryCaptureResult {
	if validation := validateOpenCodeFence(request.Fence); validation != RecoveryValidationValid {
		return rejectedOpenCodeCapture(validation)
	}
	if validation := validateOpenCodeCaptureSource(request.Source); validation != RecoveryValidationValid {
		return rejectedOpenCodeCapture(validation)
	}
	if err := request.validateRecoveryContract(); err != nil ||
		!validOpenCodeSessionID(request.SessionID) ||
		!request.WorkingDirectory.ObservedAt.Equal(request.ObservedAt) {
		return rejectedOpenCodeCapture(RecoveryValidationMalformed)
	}

	capture := ExactSessionCapture{
		Schema:           RecoveryCaptureSchemaV1,
		Version:          RecoveryCaptureSchemaVersion,
		Pane:             request.Fence.Pane,
		StrategyID:       request.Fence.StrategyID,
		Source:           request.Source,
		SessionID:        request.SessionID,
		WorkingDirectory: request.WorkingDirectory,
		RootGeneration:   request.Fence.RootProcessGeneration,
		CaptureEpoch:     request.Fence.CaptureEpoch,
		ObservedAt:       request.ObservedAt,
		CapturedAt:       request.ObservedAt,
	}
	if validation := validateOpenCodeCapture(capture); validation != RecoveryValidationValid {
		return rejectedOpenCodeCapture(validation)
	}
	return RecoveryCaptureResult{
		Validation: RecoveryValidationValid,
		Capture:    &capture,
		DetailCode: RecoveryDetailNone,
	}
}

func (strategy openCodeRecoveryStrategy) ValidateCapture(
	request RecoveryCaptureValidationRequest,
) RecoveryCaptureValidationResult {
	if validation := validateOpenCodeFence(request.ExpectedFence); validation != RecoveryValidationValid {
		return openCodeCaptureValidationResult(validation)
	}
	if validation := validateOpenCodeCapture(request.Capture); validation != RecoveryValidationValid {
		return openCodeCaptureValidationResult(validation)
	}
	if err := request.validateRecoveryContract(); err != nil {
		return openCodeCaptureValidationResult(RecoveryValidationMalformed)
	}
	return RecoveryCaptureValidationResult{
		Validation: RecoveryValidationValid,
		DetailCode: RecoveryDetailNone,
	}
}

func openCodeResumeCaptureDetail(capture ExactSessionCapture) RecoveryDetailCode {
	if capture.Schema != RecoveryCaptureSchemaV1 ||
		capture.Version != RecoveryCaptureSchemaVersion {
		return RecoveryDetailSchemaIncompatible
	}
	if err := capture.WorkingDirectory.validateRecoveryContract(); err != nil ||
		capture.WorkingDirectory.Validation != RecoveryValidationValid {
		return RecoveryDetailWorkingDirectoryInvalid
	}
	switch validateOpenCodeCapture(capture) {
	case RecoveryValidationValid:
		return RecoveryDetailNone
	case RecoveryValidationUnsupported:
		return RecoveryDetailStrategyUnsupported
	default:
		return RecoveryDetailCaptureInvalid
	}
}

func openCodeResumeFenceDetail(fence RecoveryFence) RecoveryDetailCode {
	switch validateOpenCodeFence(fence) {
	case RecoveryValidationValid:
		return RecoveryDetailNone
	case RecoveryValidationUnsupported:
		return RecoveryDetailStrategyUnsupported
	default:
		return RecoveryDetailCaptureInvalid
	}
}

func (strategy openCodeRecoveryStrategy) resumeRejectionDetail(
	request RecoveryResumeRequest,
) RecoveryDetailCode {
	if detail := openCodeResumeCaptureDetail(request.Capture); detail != RecoveryDetailNone {
		return detail
	}
	if detail := openCodeResumeFenceDetail(request.Claim.Fence); detail != RecoveryDetailNone {
		return detail
	}
	if err := request.Claim.validateRecoveryContract(); err != nil ||
		request.Claim.State != RecoveryClaimStateClaimed ||
		!capturesMatchFence(request.Claim.Fence, request.Capture) ||
		request.validateRecoveryContract() != nil {
		return RecoveryDetailCaptureInvalid
	}
	if !validOpenCodeExecutable(strategy.executable) {
		return RecoveryDetailLaunchRejected
	}
	return RecoveryDetailNone
}

func rejectedOpenCodeResume(detail RecoveryDetailCode) RecoveryResumeResult {
	return RecoveryResumeResult{
		State:      RecoveryResumeConstructionRejected,
		DetailCode: detail,
	}
}

func (strategy openCodeRecoveryStrategy) BuildResume(request RecoveryResumeRequest) RecoveryResumeResult {
	if detail := strategy.resumeRejectionDetail(request); detail != RecoveryDetailNone {
		return rejectedOpenCodeResume(detail)
	}

	argv, err := NewRecoveryArgv([]RecoveryArgument{
		"--session",
		RecoveryArgument(request.Capture.SessionID),
	})
	if err != nil {
		return rejectedOpenCodeResume(RecoveryDetailLaunchRejected)
	}
	environment, err := NewRecoveryEnvironmentDelta(nil)
	if err != nil {
		return rejectedOpenCodeResume(RecoveryDetailLaunchRejected)
	}
	launch := RecoveryLaunchSpec{
		Executable:       strategy.executable,
		Argv:             argv,
		CWD:              request.Capture.WorkingDirectory.Directory,
		EnvironmentDelta: environment,
	}
	if err := launch.validateRecoveryContract(); err != nil {
		return rejectedOpenCodeResume(RecoveryDetailLaunchRejected)
	}
	return RecoveryResumeResult{
		State:      RecoveryResumeConstructionReady,
		Launch:     &launch,
		DetailCode: RecoveryDetailNone,
	}
}

func openCodeObservedIdentityResult(
	validation RecoveryValidationState,
) RecoveryObservedIdentityResult {
	switch validation {
	case RecoveryValidationValid:
		return RecoveryObservedIdentityResult{
			Validation: RecoveryValidationValid,
			DetailCode: RecoveryDetailNone,
		}
	case RecoveryValidationUnsupported:
		return RecoveryObservedIdentityResult{
			Validation: RecoveryValidationUnsupported,
			DetailCode: RecoveryDetailStrategyUnsupported,
		}
	case RecoveryValidationMismatched:
		return RecoveryObservedIdentityResult{
			Validation: RecoveryValidationMismatched,
			DetailCode: RecoveryDetailObservedIdentityMismatch,
		}
	default:
		return RecoveryObservedIdentityResult{
			Validation: RecoveryValidationMalformed,
			DetailCode: RecoveryDetailCaptureInvalid,
		}
	}
}

func (strategy openCodeRecoveryStrategy) ValidateObservedIdentity(
	request RecoveryObservedIdentityRequest,
) RecoveryObservedIdentityResult {
	if validation := validateOpenCodeFence(request.ExpectedFence); validation != RecoveryValidationValid {
		return openCodeObservedIdentityResult(validation)
	}
	if validation := validateOpenCodeCapture(request.Capture); validation != RecoveryValidationValid {
		return openCodeObservedIdentityResult(validation)
	}
	if err := request.Observed.SessionID.validateRecoveryContract(); err != nil ||
		!validOpenCodeSessionID(request.Observed.SessionID) ||
		request.Observed.WorkingDirectory.validateRecoveryContract() != nil ||
		request.Observed.ObservedAt.IsZero() ||
		request.Observed.ObservedAt.Before(request.Capture.CapturedAt) ||
		request.validateRecoveryContract() != nil {
		return openCodeObservedIdentityResult(RecoveryValidationMalformed)
	}
	if request.Observed.SessionID != request.Capture.SessionID ||
		request.Observed.WorkingDirectory != request.Capture.WorkingDirectory.Directory {
		return openCodeObservedIdentityResult(RecoveryValidationMismatched)
	}
	return openCodeObservedIdentityResult(RecoveryValidationValid)
}
