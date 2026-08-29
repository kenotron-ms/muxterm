package sessiond

import (
	"fmt"
	"path/filepath"
	"time"
)

const (
	codexExecutableBasename = "codex"
	codexThreadUUIDLength   = 36
	codexNilThreadUUID      = "00000000-0000-0000-0000-000000000000"
)

type codexRecoveryStrategy struct {
	executable RecoveryExecutable
}

var _ RecoveryStrategy = (*codexRecoveryStrategy)(nil)

// NewCodexRecoveryStrategy constructs the exact-session Codex adapter.
func NewCodexRecoveryStrategy(executable RecoveryExecutable) (RecoveryStrategy, error) {
	if !validCodexRecoveryExecutable(executable) {
		return nil, fmt.Errorf("recovery: codex executable must be a clean absolute path named %q", codexExecutableBasename)
	}
	return &codexRecoveryStrategy{executable: executable}, nil
}

func (strategy *codexRecoveryStrategy) Capture(request RecoveryCaptureRequest) RecoveryCaptureResult {
	if request.validateRecoveryContract() != nil {
		return rejectedCodexCapture(RecoveryValidationMalformed)
	}
	if !strategy.valid() ||
		request.Fence.StrategyID != RecoveryStrategyCodex ||
		!validCodexCaptureSource(request.Source) {
		return rejectedCodexCapture(RecoveryValidationUnsupported)
	}
	if !validCodexThreadUUID(request.SessionID) ||
		!validCodexCaptureEvidence(
			request.WorkingDirectory.ObservedAt,
			request.ObservedAt,
			request.ObservedAt,
		) {
		return rejectedCodexCapture(RecoveryValidationMalformed)
	}

	capture := ExactSessionCapture{
		Schema:           RecoveryCaptureSchemaV1,
		Version:          RecoveryCaptureSchemaVersion,
		Pane:             request.Fence.Pane,
		StrategyID:       RecoveryStrategyCodex,
		Source:           request.Source,
		SessionID:        request.SessionID,
		WorkingDirectory: request.WorkingDirectory,
		RootGeneration:   request.Fence.RootProcessGeneration,
		CaptureEpoch:     request.Fence.CaptureEpoch,
		ObservedAt:       request.ObservedAt,
		CapturedAt:       request.ObservedAt,
	}
	if capture.validateRecoveryContract() != nil || !validCodexCapture(capture) {
		return rejectedCodexCapture(RecoveryValidationMalformed)
	}
	return RecoveryCaptureResult{
		Validation: RecoveryValidationValid,
		Capture:    &capture,
		DetailCode: RecoveryDetailNone,
	}
}

func (strategy *codexRecoveryStrategy) ValidateCapture(
	request RecoveryCaptureValidationRequest,
) RecoveryCaptureValidationResult {
	if request.ExpectedFence.validateRecoveryContract() != nil ||
		request.Capture.validateRecoveryContract() != nil {
		return rejectedCodexCaptureValidation(RecoveryValidationMalformed)
	}
	if !strategy.valid() ||
		request.ExpectedFence.StrategyID != RecoveryStrategyCodex ||
		request.Capture.StrategyID != RecoveryStrategyCodex ||
		!validCodexCaptureSource(request.Capture.Source) {
		return rejectedCodexCaptureValidation(RecoveryValidationUnsupported)
	}
	if !capturesMatchFence(request.ExpectedFence, request.Capture) {
		return rejectedCodexCaptureValidation(RecoveryValidationMismatched)
	}
	if !validCodexCapture(request.Capture) {
		return rejectedCodexCaptureValidation(RecoveryValidationMalformed)
	}
	return RecoveryCaptureValidationResult{
		Validation: RecoveryValidationValid,
		DetailCode: RecoveryDetailNone,
	}
}

func (strategy *codexRecoveryStrategy) BuildResume(request RecoveryResumeRequest) RecoveryResumeResult {
	if !strategy.valid() {
		return rejectedCodexResume(RecoveryDetailStrategyUnsupported)
	}
	if request.Claim.validateRecoveryContract() != nil {
		return rejectedCodexResume(RecoveryDetailLaunchRejected)
	}
	if request.Capture.validateRecoveryContract() != nil {
		return rejectedCodexResume(codexResumeDetailForCapture(request.Capture))
	}
	if request.Claim.Fence.StrategyID != RecoveryStrategyCodex ||
		request.Capture.StrategyID != RecoveryStrategyCodex ||
		!validCodexCaptureSource(request.Capture.Source) {
		return rejectedCodexResume(RecoveryDetailStrategyUnsupported)
	}
	if !validCodexCapture(request.Capture) {
		return rejectedCodexResume(RecoveryDetailCaptureInvalid)
	}
	if request.Claim.State != RecoveryClaimStateClaimed ||
		!validCodexUTCTime(request.Claim.ClaimedAt) ||
		request.Claim.ClaimedAt.Before(request.Capture.CapturedAt) ||
		!capturesMatchFence(request.Claim.Fence, request.Capture) {
		return rejectedCodexResume(RecoveryDetailLaunchRejected)
	}

	argv, err := NewRecoveryArgv([]RecoveryArgument{
		"resume",
		RecoveryArgument(request.Capture.SessionID),
	})
	if err != nil {
		return rejectedCodexResume(RecoveryDetailLaunchRejected)
	}
	launch := RecoveryLaunchSpec{
		Executable:       strategy.executable,
		Argv:             argv,
		CWD:              request.Capture.WorkingDirectory.Directory,
		EnvironmentDelta: RecoveryEnvironmentDelta{},
	}
	if launch.validateRecoveryContract() != nil {
		return rejectedCodexResume(RecoveryDetailLaunchRejected)
	}
	return RecoveryResumeResult{
		State:      RecoveryResumeConstructionReady,
		Launch:     &launch,
		DetailCode: RecoveryDetailNone,
	}
}

func (strategy *codexRecoveryStrategy) ValidateObservedIdentity(
	request RecoveryObservedIdentityRequest,
) RecoveryObservedIdentityResult {
	if request.ExpectedFence.validateRecoveryContract() != nil ||
		request.Capture.validateRecoveryContract() != nil ||
		request.Observed.validateRecoveryContract() != nil {
		return rejectedCodexObservedIdentity(RecoveryValidationMalformed)
	}
	if !strategy.valid() ||
		request.ExpectedFence.StrategyID != RecoveryStrategyCodex ||
		request.Capture.StrategyID != RecoveryStrategyCodex ||
		!validCodexCaptureSource(request.Capture.Source) {
		return rejectedCodexObservedIdentity(RecoveryValidationUnsupported)
	}
	if !capturesMatchFence(request.ExpectedFence, request.Capture) {
		return rejectedCodexObservedIdentity(RecoveryValidationMismatched)
	}
	if !validCodexCapture(request.Capture) ||
		!validCodexThreadUUID(request.Observed.SessionID) ||
		!validCodexUTCTime(request.Observed.ObservedAt) ||
		request.Observed.ObservedAt.Before(request.Capture.CapturedAt) {
		return rejectedCodexObservedIdentity(RecoveryValidationMalformed)
	}
	if request.Observed.SessionID != request.Capture.SessionID ||
		request.Observed.WorkingDirectory != request.Capture.WorkingDirectory.Directory {
		return rejectedCodexObservedIdentity(RecoveryValidationMismatched)
	}
	return RecoveryObservedIdentityResult{
		Validation: RecoveryValidationValid,
		DetailCode: RecoveryDetailNone,
	}
}

func (strategy *codexRecoveryStrategy) valid() bool {
	return strategy != nil && validCodexRecoveryExecutable(strategy.executable)
}

func validCodexRecoveryExecutable(executable RecoveryExecutable) bool {
	return executable.validateRecoveryContract() == nil &&
		filepath.Base(string(executable)) == codexExecutableBasename
}

func validCodexCaptureSource(source RecoveryCaptureSource) bool {
	return source == RecoveryCaptureSourceLifecycle ||
		source == RecoveryCaptureSourceExplicitSelection
}

func validCodexCapture(capture ExactSessionCapture) bool {
	return capture.Schema == RecoveryCaptureSchemaV1 &&
		capture.Version == RecoveryCaptureSchemaVersion &&
		capture.StrategyID == RecoveryStrategyCodex &&
		validCodexCaptureSource(capture.Source) &&
		validCodexThreadUUID(capture.SessionID) &&
		validCodexCaptureEvidence(
			capture.WorkingDirectory.ObservedAt,
			capture.ObservedAt,
			capture.CapturedAt,
		)
}

func validCodexCaptureEvidence(
	directoryObservedAt, observedAt, capturedAt time.Time,
) bool {
	return validCodexUTCTime(directoryObservedAt) &&
		validCodexUTCTime(observedAt) &&
		validCodexUTCTime(capturedAt) &&
		!directoryObservedAt.After(observedAt) &&
		!observedAt.After(capturedAt)
}

func validCodexUTCTime(value time.Time) bool {
	return !value.IsZero() && value.Location() == time.UTC
}

func validCodexThreadUUID(sessionID RecoveryOpaqueSessionID) bool {
	value := string(sessionID)
	if len(value) != codexThreadUUIDLength || value == codexNilThreadUUID {
		return false
	}
	for index := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if value[index] != '-' {
				return false
			}
			continue
		}
		if (value[index] < '0' || value[index] > '9') &&
			(value[index] < 'a' || value[index] > 'f') {
			return false
		}
	}
	return true
}

func rejectedCodexCapture(validation RecoveryValidationState) RecoveryCaptureResult {
	return RecoveryCaptureResult{
		Validation: validation,
		DetailCode: codexValidationDetail(validation),
	}
}

func rejectedCodexCaptureValidation(
	validation RecoveryValidationState,
) RecoveryCaptureValidationResult {
	return RecoveryCaptureValidationResult{
		Validation: validation,
		DetailCode: codexValidationDetail(validation),
	}
}

func rejectedCodexResume(detail RecoveryDetailCode) RecoveryResumeResult {
	return RecoveryResumeResult{
		State:      RecoveryResumeConstructionRejected,
		DetailCode: detail,
	}
}

func rejectedCodexObservedIdentity(
	validation RecoveryValidationState,
) RecoveryObservedIdentityResult {
	return RecoveryObservedIdentityResult{
		Validation: validation,
		DetailCode: codexValidationDetail(validation),
	}
}

func codexValidationDetail(validation RecoveryValidationState) RecoveryDetailCode {
	detail, ok := recoveryDetailForValidationState(validation)
	if !ok {
		return RecoveryDetailCaptureInvalid
	}
	return detail
}

func codexResumeDetailForCapture(capture ExactSessionCapture) RecoveryDetailCode {
	if capture.Schema != RecoveryCaptureSchemaV1 ||
		capture.Version != RecoveryCaptureSchemaVersion {
		return RecoveryDetailSchemaIncompatible
	}
	if capture.WorkingDirectory.Validation != RecoveryValidationValid ||
		capture.WorkingDirectory.validateRecoveryContract() != nil {
		return RecoveryDetailWorkingDirectoryInvalid
	}
	return RecoveryDetailCaptureInvalid
}
