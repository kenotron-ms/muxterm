package sessiond

import (
	"fmt"
	"reflect"
	"time"
)

// RecoveryCaptureRequest contains only daemon-observed, bounded evidence. It
// has no terminal text, browser input, ambient credentials, or raw tool error.
type RecoveryCaptureRequest struct {
	Fence            RecoveryFence                   `json:"fence"`
	Source           RecoveryCaptureSource           `json:"source"`
	SessionID        RecoveryOpaqueSessionID         `json:"sessionId"`
	WorkingDirectory RecoveryWorkingDirectoryBinding `json:"workingDirectory"`
	ObservedAt       time.Time                       `json:"observedAt"`
}

func (request RecoveryCaptureRequest) validateRecoveryContract() error {
	if err := request.Fence.validateRecoveryContract(); err != nil {
		return err
	}
	if err := request.Source.validateRecoveryContract(); err != nil {
		return err
	}
	if err := request.SessionID.validateRecoveryContract(); err != nil {
		return err
	}
	if err := request.WorkingDirectory.validateRecoveryContract(); err != nil {
		return err
	}
	if request.WorkingDirectory.Validation != RecoveryValidationValid {
		return fmt.Errorf("recovery: capture request has invalid working directory")
	}
	if request.ObservedAt.IsZero() {
		return fmt.Errorf("recovery: capture request has no observation timestamp")
	}
	return nil
}

// RecoveryCaptureResult reports capture validation using stable detail codes.
// Capture is absent unless Validation is RecoveryValidationValid, so rejected
// results cannot be accidentally consumed as an exact-session authority.
type RecoveryCaptureResult struct {
	Validation RecoveryValidationState `json:"validation"`
	Capture    *ExactSessionCapture    `json:"capture,omitempty"`
	DetailCode RecoveryDetailCode      `json:"detailCode"`
}

func (result RecoveryCaptureResult) validateRecoveryContract() error {
	if err := result.Validation.validateRecoveryContract(); err != nil {
		return err
	}
	if err := result.DetailCode.validateRecoveryContract(); err != nil {
		return err
	}
	expectedDetail, ok := recoveryDetailForValidationState(result.Validation)
	if !ok || result.DetailCode != expectedDetail {
		return fmt.Errorf("recovery: invalid capture validation/detail pairing")
	}
	if result.Validation == RecoveryValidationValid {
		if result.Capture == nil {
			return fmt.Errorf("recovery: valid capture result has no capture")
		}
		return result.Capture.validateRecoveryContract()
	}
	if result.Capture != nil {
		return fmt.Errorf("recovery: rejected capture result exposes capture")
	}
	return nil
}

// RecoveryCaptureValidationRequest validates an existing capture against the
// current generation-fenced authority.
type RecoveryCaptureValidationRequest struct {
	ExpectedFence RecoveryFence       `json:"expectedFence"`
	Capture       ExactSessionCapture `json:"capture"`
}

func capturesMatchFence(fence RecoveryFence, capture ExactSessionCapture) bool {
	return fence.Pane == capture.Pane &&
		fence.StrategyID == capture.StrategyID &&
		fence.RootProcessGeneration == capture.RootGeneration &&
		fence.CaptureEpoch == capture.CaptureEpoch
}

func (request RecoveryCaptureValidationRequest) validateRecoveryContract() error {
	if err := request.ExpectedFence.validateRecoveryContract(); err != nil {
		return err
	}
	if err := request.Capture.validateRecoveryContract(); err != nil {
		return err
	}
	if !capturesMatchFence(request.ExpectedFence, request.Capture) {
		return fmt.Errorf("recovery: capture does not match expected fence")
	}
	return nil
}

type RecoveryCaptureValidationResult struct {
	Validation RecoveryValidationState `json:"validation"`
	DetailCode RecoveryDetailCode      `json:"detailCode"`
}

func (result RecoveryCaptureValidationResult) validateRecoveryContract() error {
	if err := result.Validation.validateRecoveryContract(); err != nil {
		return err
	}
	if err := result.DetailCode.validateRecoveryContract(); err != nil {
		return err
	}
	expectedDetail, ok := recoveryDetailForValidationState(result.Validation)
	if !ok || result.DetailCode != expectedDetail {
		return fmt.Errorf("recovery: invalid capture validation/detail pairing")
	}
	return nil
}

// RecoveryResumeConstructionState describes whether an adapter constructed a
// bounded structured resume specification, not whether a process was launched.
type RecoveryResumeConstructionState string

const (
	RecoveryResumeConstructionReady    RecoveryResumeConstructionState = "ready"
	RecoveryResumeConstructionRejected RecoveryResumeConstructionState = "rejected"
)

func validRecoveryResumeConstructionState(value RecoveryResumeConstructionState) bool {
	return value == RecoveryResumeConstructionReady || value == RecoveryResumeConstructionRejected
}

func validRecoveryResumeRejectionDetail(value RecoveryDetailCode) bool {
	switch value {
	case RecoveryDetailCaptureInvalid,
		RecoveryDetailWorkingDirectoryInvalid,
		RecoveryDetailStrategyUnsupported,
		RecoveryDetailSchemaIncompatible,
		RecoveryDetailLaunchRejected:
		return true
	default:
		return false
	}
}

// RecoveryResumeRequest is daemon-owned launch construction input. Browsers
// never provide a capture, executable, argv, working directory, or environment
// delta through this contract.
type RecoveryResumeRequest struct {
	Claim   RecoveryClaim       `json:"claim"`
	Capture ExactSessionCapture `json:"capture"`
}

func (request RecoveryResumeRequest) validateRecoveryContract() error {
	if err := request.Claim.validateRecoveryContract(); err != nil {
		return err
	}
	if request.Claim.State != RecoveryClaimStateClaimed {
		return fmt.Errorf("recovery: resume request requires a claimed recovery authorization")
	}
	if err := request.Capture.validateRecoveryContract(); err != nil {
		return err
	}
	if !capturesMatchFence(request.Claim.Fence, request.Capture) {
		return fmt.Errorf("recovery: resume capture does not match claim fence")
	}
	return nil
}

// RecoveryResumeResult keeps Launch absent unless construction is ready. A
// rejected adapter result is therefore incapable of carrying launch authority.
type RecoveryResumeResult struct {
	State      RecoveryResumeConstructionState `json:"state"`
	Launch     *RecoveryLaunchSpec             `json:"launch,omitempty"`
	DetailCode RecoveryDetailCode              `json:"detailCode"`
}

func (result RecoveryResumeResult) validateRecoveryContract() error {
	if !validRecoveryResumeConstructionState(result.State) {
		return fmt.Errorf("recovery: unknown resume construction state %q", result.State)
	}
	if err := result.DetailCode.validateRecoveryContract(); err != nil {
		return err
	}
	if result.State == RecoveryResumeConstructionReady {
		if result.Launch == nil {
			return fmt.Errorf("recovery: ready resume result has no launch specification")
		}
		if result.DetailCode != RecoveryDetailNone {
			return fmt.Errorf("recovery: ready resume result has rejection detail")
		}
		return result.Launch.validateRecoveryContract()
	}
	if result.Launch != nil || !validRecoveryResumeRejectionDetail(result.DetailCode) {
		return fmt.Errorf("recovery: rejected resume result exposes launch or has invalid detail")
	}
	return nil
}

// RecoveryObservedIdentity is authoritative post-launch evidence. Its exact
// opaque identity is daemon-local and must never be sent to a browser.
type RecoveryObservedIdentity struct {
	SessionID        RecoveryOpaqueSessionID  `json:"sessionId"`
	WorkingDirectory RecoveryWorkingDirectory `json:"workingDirectory"`
	ObservedAt       time.Time                `json:"observedAt"`
}

func (identity RecoveryObservedIdentity) validateRecoveryContract() error {
	if err := identity.SessionID.validateRecoveryContract(); err != nil {
		return err
	}
	if err := identity.WorkingDirectory.validateRecoveryContract(); err != nil {
		return err
	}
	if identity.ObservedAt.IsZero() {
		return fmt.Errorf("recovery: observed identity has no observation timestamp")
	}
	return nil
}

type RecoveryObservedIdentityRequest struct {
	ExpectedFence RecoveryFence            `json:"expectedFence"`
	Capture       ExactSessionCapture      `json:"capture"`
	Observed      RecoveryObservedIdentity `json:"observed"`
}

func (request RecoveryObservedIdentityRequest) validateRecoveryContract() error {
	if err := request.ExpectedFence.validateRecoveryContract(); err != nil {
		return err
	}
	if err := request.Capture.validateRecoveryContract(); err != nil {
		return err
	}
	if !capturesMatchFence(request.ExpectedFence, request.Capture) {
		return fmt.Errorf("recovery: observed identity capture does not match fence")
	}
	return request.Observed.validateRecoveryContract()
}

type RecoveryObservedIdentityResult struct {
	Validation RecoveryValidationState `json:"validation"`
	DetailCode RecoveryDetailCode      `json:"detailCode"`
}

func (result RecoveryObservedIdentityResult) validateRecoveryContract() error {
	if err := result.Validation.validateRecoveryContract(); err != nil {
		return err
	}
	if err := result.DetailCode.validateRecoveryContract(); err != nil {
		return err
	}
	expectedDetail, ok := recoveryDetailForValidationState(result.Validation)
	if !ok || result.DetailCode != expectedDetail {
		return fmt.Errorf("recovery: invalid observed identity/detail pairing")
	}
	return nil
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

func recoveryStrategyIsNil(strategy RecoveryStrategy) bool {
	if strategy == nil {
		return true
	}
	value := reflect.ValueOf(strategy)
	return (value.Kind() == reflect.Chan ||
		value.Kind() == reflect.Func ||
		value.Kind() == reflect.Interface ||
		value.Kind() == reflect.Map ||
		value.Kind() == reflect.Pointer ||
		value.Kind() == reflect.Slice) && value.IsNil()
}

// BuiltInRecoveryStrategies is the complete fixed adapter roster. It has no
// map, registration hook, or plugin loader through which an arbitrary strategy
// could become recovery authority. NewBuiltInRecoveryStrategies is the runtime
// construction boundary and requires every product adapter.
type BuiltInRecoveryStrategies struct {
	Amplifier  RecoveryStrategy
	ClaudeCode RecoveryStrategy
	OpenCode   RecoveryStrategy
	Codex      RecoveryStrategy
}

func (strategies BuiltInRecoveryStrategies) validateRecoveryContract() error {
	if recoveryStrategyIsNil(strategies.Amplifier) ||
		recoveryStrategyIsNil(strategies.ClaudeCode) ||
		recoveryStrategyIsNil(strategies.OpenCode) ||
		recoveryStrategyIsNil(strategies.Codex) {
		return fmt.Errorf("recovery: built-in strategy roster is incomplete")
	}
	return nil
}

// NewBuiltInRecoveryStrategies constructs the closed four-product roster. It
// intentionally accepts four explicit arguments instead of a map or registry.
func NewBuiltInRecoveryStrategies(
	amplifier, claudeCode, openCode, codex RecoveryStrategy,
) (BuiltInRecoveryStrategies, error) {
	strategies := BuiltInRecoveryStrategies{
		Amplifier:  amplifier,
		ClaudeCode: claudeCode,
		OpenCode:   openCode,
		Codex:      codex,
	}
	if err := strategies.validateRecoveryContract(); err != nil {
		return BuiltInRecoveryStrategies{}, err
	}
	return strategies, nil
}

// Strategy resolves only a fixed built-in ID after the roster is complete.
func (strategies BuiltInRecoveryStrategies) Strategy(id RecoveryStrategyID) (RecoveryStrategy, error) {
	if err := strategies.validateRecoveryContract(); err != nil {
		return nil, err
	}
	switch id {
	case RecoveryStrategyAmplifier:
		return strategies.Amplifier, nil
	case RecoveryStrategyClaudeCode:
		return strategies.ClaudeCode, nil
	case RecoveryStrategyOpenCode:
		return strategies.OpenCode, nil
	case RecoveryStrategyCodex:
		return strategies.Codex, nil
	default:
		return nil, fmt.Errorf("recovery: unknown strategy %q", id)
	}
}
