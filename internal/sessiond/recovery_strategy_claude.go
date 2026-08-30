package sessiond

import (
	"fmt"
	"path/filepath"
	"time"
)

const claudeCodeExecutableBasename = "claude"

// ClaudeCodeRecoveryStrategy captures and resumes only exact Claude Code
// session identities.
type ClaudeCodeRecoveryStrategy struct {
	executable RecoveryExecutable
}

var _ RecoveryStrategy = (*ClaudeCodeRecoveryStrategy)(nil)

// NewClaudeCodeRecoveryStrategy creates the pure Claude Code adapter for one
// syntactically valid, absolute executable path named claude.
func NewClaudeCodeRecoveryStrategy(
	executable RecoveryExecutable,
) (*ClaudeCodeRecoveryStrategy, error) {
	strategy := &ClaudeCodeRecoveryStrategy{executable: executable}
	if !strategy.hasValidExecutable() {
		return nil, fmt.Errorf(
			"recovery: Claude Code executable must be a clean absolute path named %q",
			claudeCodeExecutableBasename,
		)
	}
	return strategy, nil
}

func (strategy *ClaudeCodeRecoveryStrategy) Capture(
	request RecoveryCaptureRequest,
) RecoveryCaptureResult {
	if !strategy.hasValidExecutable() {
		return claudeCodeCaptureResult(RecoveryValidationUnsupported)
	}
	if err := request.Fence.validateRecoveryContract(); err != nil {
		return claudeCodeCaptureResult(RecoveryValidationMalformed)
	}
	if request.Fence.StrategyID != RecoveryStrategyClaudeCode {
		return claudeCodeCaptureResult(RecoveryValidationUnsupported)
	}
	if err := request.Source.validateRecoveryContract(); err != nil {
		return claudeCodeCaptureResult(RecoveryValidationMalformed)
	}
	if !claudeCodeCaptureSourceAllowed(request.Source) {
		return claudeCodeCaptureResult(RecoveryValidationUnsupported)
	}
	if !claudeCodeSessionIDValid(request.SessionID) {
		return claudeCodeCaptureResult(RecoveryValidationMalformed)
	}
	if err := request.WorkingDirectory.validateRecoveryContract(); err != nil ||
		request.WorkingDirectory.Validation != RecoveryValidationValid {
		return claudeCodeCaptureResult(RecoveryValidationMalformed)
	}
	if !claudeCodeTimeUTC(request.ObservedAt) ||
		!claudeCodeTimeUTC(request.WorkingDirectory.ObservedAt) ||
		request.WorkingDirectory.ObservedAt != request.ObservedAt {
		return claudeCodeCaptureResult(RecoveryValidationMalformed)
	}

	capture := ExactSessionCapture{
		Schema:           RecoveryCaptureSchemaV1,
		Version:          RecoveryCaptureSchemaVersion,
		Pane:             request.Fence.Pane,
		StrategyID:       RecoveryStrategyClaudeCode,
		Source:           request.Source,
		SessionID:        request.SessionID,
		WorkingDirectory: request.WorkingDirectory,
		RootGeneration:   request.Fence.RootProcessGeneration,
		CaptureEpoch:     request.Fence.CaptureEpoch,
		ObservedAt:       request.ObservedAt,
		CapturedAt:       request.ObservedAt,
	}
	return RecoveryCaptureResult{
		Validation: RecoveryValidationValid,
		Capture:    &capture,
		DetailCode: RecoveryDetailNone,
	}
}

func (strategy *ClaudeCodeRecoveryStrategy) ValidateCapture(
	request RecoveryCaptureValidationRequest,
) RecoveryCaptureValidationResult {
	if !strategy.hasValidExecutable() {
		return claudeCodeCaptureValidationResult(RecoveryValidationUnsupported)
	}
	if err := request.ExpectedFence.validateRecoveryContract(); err != nil {
		return claudeCodeCaptureValidationResult(RecoveryValidationMalformed)
	}
	if request.ExpectedFence.StrategyID != RecoveryStrategyClaudeCode {
		return claudeCodeCaptureValidationResult(RecoveryValidationUnsupported)
	}
	switch claudeCodeCaptureValidity(request.Capture) {
	case claudeCodeCaptureMalformed, claudeCodeCaptureWorkingDirectoryInvalid,
		claudeCodeCaptureSchemaIncompatible:
		return claudeCodeCaptureValidationResult(RecoveryValidationMalformed)
	case claudeCodeCaptureUnsupported:
		return claudeCodeCaptureValidationResult(RecoveryValidationUnsupported)
	}
	if !capturesMatchFence(request.ExpectedFence, request.Capture) {
		return claudeCodeCaptureValidationResult(RecoveryValidationConflicting)
	}
	return claudeCodeCaptureValidationResult(RecoveryValidationValid)
}

func (strategy *ClaudeCodeRecoveryStrategy) BuildResume(
	request RecoveryResumeRequest,
) RecoveryResumeResult {
	if !strategy.hasValidExecutable() {
		return claudeCodeResumeRejected(RecoveryDetailStrategyUnsupported)
	}
	if err := request.Claim.Fence.validateRecoveryContract(); err != nil {
		return claudeCodeResumeRejected(RecoveryDetailCaptureInvalid)
	}
	if request.Claim.Fence.StrategyID != RecoveryStrategyClaudeCode {
		return claudeCodeResumeRejected(RecoveryDetailStrategyUnsupported)
	}
	if err := request.Claim.validateRecoveryContract(); err != nil ||
		request.Claim.State != RecoveryClaimStateClaimed ||
		!claudeCodeTimeUTC(request.Claim.ClaimedAt) {
		return claudeCodeResumeRejected(RecoveryDetailCaptureInvalid)
	}
	switch claudeCodeCaptureValidity(request.Capture) {
	case claudeCodeCaptureSchemaIncompatible:
		return claudeCodeResumeRejected(RecoveryDetailSchemaIncompatible)
	case claudeCodeCaptureWorkingDirectoryInvalid:
		return claudeCodeResumeRejected(RecoveryDetailWorkingDirectoryInvalid)
	case claudeCodeCaptureUnsupported:
		return claudeCodeResumeRejected(RecoveryDetailStrategyUnsupported)
	case claudeCodeCaptureMalformed:
		return claudeCodeResumeRejected(RecoveryDetailCaptureInvalid)
	}
	if !capturesMatchFence(request.Claim.Fence, request.Capture) {
		return claudeCodeResumeRejected(RecoveryDetailCaptureInvalid)
	}

	argv, err := NewRecoveryArgv([]RecoveryArgument{
		"--resume",
		RecoveryArgument(request.Capture.SessionID),
	})
	if err != nil {
		return claudeCodeResumeRejected(RecoveryDetailLaunchRejected)
	}
	launch := RecoveryLaunchSpec{
		Executable: strategy.executable,
		Argv:       argv,
		CWD:        request.Capture.WorkingDirectory.Directory,
	}
	if err := launch.validateRecoveryContract(); err != nil {
		return claudeCodeResumeRejected(RecoveryDetailLaunchRejected)
	}
	return RecoveryResumeResult{
		State:      RecoveryResumeConstructionReady,
		Launch:     &launch,
		DetailCode: RecoveryDetailNone,
	}
}

func (strategy *ClaudeCodeRecoveryStrategy) ValidateObservedIdentity(
	request RecoveryObservedIdentityRequest,
) RecoveryObservedIdentityResult {
	if !strategy.hasValidExecutable() {
		return claudeCodeObservedIdentityResult(RecoveryValidationUnsupported)
	}
	if err := request.ExpectedFence.validateRecoveryContract(); err != nil {
		return claudeCodeObservedIdentityResult(RecoveryValidationMalformed)
	}
	if request.ExpectedFence.StrategyID != RecoveryStrategyClaudeCode {
		return claudeCodeObservedIdentityResult(RecoveryValidationUnsupported)
	}
	switch claudeCodeCaptureValidity(request.Capture) {
	case claudeCodeCaptureMalformed, claudeCodeCaptureWorkingDirectoryInvalid,
		claudeCodeCaptureSchemaIncompatible:
		return claudeCodeObservedIdentityResult(RecoveryValidationMalformed)
	case claudeCodeCaptureUnsupported:
		return claudeCodeObservedIdentityResult(RecoveryValidationUnsupported)
	}
	if !capturesMatchFence(request.ExpectedFence, request.Capture) {
		return claudeCodeObservedIdentityResult(RecoveryValidationConflicting)
	}
	if err := request.Observed.validateRecoveryContract(); err != nil ||
		!claudeCodeSessionIDValid(request.Observed.SessionID) ||
		!claudeCodeTimeUTC(request.Observed.ObservedAt) ||
		request.Observed.ObservedAt.Before(request.Capture.CapturedAt) {
		return claudeCodeObservedIdentityResult(RecoveryValidationMalformed)
	}
	if request.Observed.SessionID != request.Capture.SessionID ||
		request.Observed.WorkingDirectory != request.Capture.WorkingDirectory.Directory {
		return claudeCodeObservedIdentityResult(RecoveryValidationMismatched)
	}
	return claudeCodeObservedIdentityResult(RecoveryValidationValid)
}

type claudeCodeCaptureValidityState uint8

const (
	claudeCodeCaptureValid claudeCodeCaptureValidityState = iota
	claudeCodeCaptureMalformed
	claudeCodeCaptureWorkingDirectoryInvalid
	claudeCodeCaptureSchemaIncompatible
	claudeCodeCaptureUnsupported
)

func claudeCodeCaptureValidity(
	capture ExactSessionCapture,
) claudeCodeCaptureValidityState {
	if err := capture.Schema.validateRecoveryContract(); err != nil ||
		capture.Version != RecoveryCaptureSchemaVersion {
		return claudeCodeCaptureSchemaIncompatible
	}
	if err := capture.Pane.validateRecoveryContract(); err != nil {
		return claudeCodeCaptureMalformed
	}
	if err := capture.StrategyID.validateRecoveryContract(); err != nil {
		return claudeCodeCaptureMalformed
	}
	if capture.StrategyID != RecoveryStrategyClaudeCode {
		return claudeCodeCaptureUnsupported
	}
	if err := capture.Source.validateRecoveryContract(); err != nil {
		return claudeCodeCaptureMalformed
	}
	if !claudeCodeCaptureSourceAllowed(capture.Source) {
		return claudeCodeCaptureUnsupported
	}
	if !claudeCodeSessionIDValid(capture.SessionID) {
		return claudeCodeCaptureMalformed
	}
	if err := capture.WorkingDirectory.validateRecoveryContract(); err != nil ||
		capture.WorkingDirectory.Validation != RecoveryValidationValid {
		return claudeCodeCaptureWorkingDirectoryInvalid
	}
	if capture.RootGeneration == 0 || capture.CaptureEpoch == 0 ||
		!claudeCodeTimeUTC(capture.ObservedAt) ||
		!claudeCodeTimeUTC(capture.CapturedAt) ||
		!claudeCodeTimeUTC(capture.WorkingDirectory.ObservedAt) ||
		capture.CapturedAt.Before(capture.ObservedAt) ||
		capture.WorkingDirectory.ObservedAt != capture.ObservedAt {
		return claudeCodeCaptureMalformed
	}
	if err := capture.validateRecoveryContract(); err != nil {
		return claudeCodeCaptureMalformed
	}
	return claudeCodeCaptureValid
}

func (strategy *ClaudeCodeRecoveryStrategy) hasValidExecutable() bool {
	return strategy != nil &&
		strategy.executable.validateRecoveryContract() == nil &&
		filepath.Base(string(strategy.executable)) == claudeCodeExecutableBasename
}

func claudeCodeCaptureSourceAllowed(source RecoveryCaptureSource) bool {
	return source == RecoveryCaptureSourceLifecycle ||
		source == RecoveryCaptureSourceExplicitSelection
}

func claudeCodeSessionIDValid(sessionID RecoveryOpaqueSessionID) bool {
	if err := sessionID.validateRecoveryContract(); err != nil {
		return false
	}
	value := string(sessionID)
	if len(value) != 36 {
		return false
	}
	allZero := true
	for index := range value {
		switch index {
		case 8, 13, 18, 23:
			if value[index] != '-' {
				return false
			}
		case 0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 17,
			19, 20, 21, 22, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35:
			if value[index] >= '1' && value[index] <= '9' {
				allZero = false
				continue
			}
			if value[index] >= 'a' && value[index] <= 'f' {
				allZero = false
				continue
			}
			if value[index] != '0' {
				return false
			}
		}
	}
	return !allZero
}

func claudeCodeTimeUTC(observedAt time.Time) bool {
	return !observedAt.IsZero() && observedAt.Location() == time.UTC
}

func claudeCodeCaptureResult(
	validation RecoveryValidationState,
) RecoveryCaptureResult {
	detailCode, _ := recoveryDetailForValidationState(validation)
	return RecoveryCaptureResult{
		Validation: validation,
		DetailCode: detailCode,
	}
}

func claudeCodeCaptureValidationResult(
	validation RecoveryValidationState,
) RecoveryCaptureValidationResult {
	detailCode, _ := recoveryDetailForValidationState(validation)
	return RecoveryCaptureValidationResult{
		Validation: validation,
		DetailCode: detailCode,
	}
}

func claudeCodeObservedIdentityResult(
	validation RecoveryValidationState,
) RecoveryObservedIdentityResult {
	detailCode, _ := recoveryDetailForValidationState(validation)
	return RecoveryObservedIdentityResult{
		Validation: validation,
		DetailCode: detailCode,
	}
}

func claudeCodeResumeRejected(detailCode RecoveryDetailCode) RecoveryResumeResult {
	return RecoveryResumeResult{
		State:      RecoveryResumeConstructionRejected,
		DetailCode: detailCode,
	}
}
