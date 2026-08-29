package sessiond

import (
	"fmt"
	"time"
)

const (
	// RecoveryLifecycleCapabilityBytes is 256 bits of per-launch entropy.
	RecoveryLifecycleCapabilityBytes = 32
)

const RecoveryLifecycleCapabilityMaxTTL = 5 * time.Minute

// RecoveryLifecycleCapability is an opaque 256-bit owner-local token. It is
// never browser-visible or persisted as a reusable credential.
type RecoveryLifecycleCapability [RecoveryLifecycleCapabilityBytes]byte

func (capability RecoveryLifecycleCapability) validateRecoveryContract() error {
	var zero RecoveryLifecycleCapability
	if capability == zero {
		return fmt.Errorf("recovery: lifecycle capability is zero")
	}
	return nil
}

// RecoveryIntegrationNamespace is bounded by
// RecoveryMaxLifecycleNamespaceBytes and identifies only muxterm-owned
// namespaced integration state.
type RecoveryIntegrationNamespace string

func (namespace RecoveryIntegrationNamespace) validateRecoveryContract() error {
	return validateOpaqueIdentifier(
		string(namespace),
		RecoveryMaxLifecycleNamespaceBytes,
		"lifecycle namespace",
	)
}

// RecoveryIntegrationID is bounded by RecoveryMaxLifecycleIntegrationIDBytes.
// It identifies a configured integration without exposing its user config.
type RecoveryIntegrationID string

func (integrationID RecoveryIntegrationID) validateRecoveryContract() error {
	return validateOpaqueIdentifier(
		string(integrationID),
		RecoveryMaxLifecycleIntegrationIDBytes,
		"lifecycle integration ID",
	)
}

// RecoveryLifecycleLeaseRequest is daemon-owned issuance input. It deliberately
// has no callback capability and no caller-provided issuance or expiry time.
type RecoveryLifecycleLeaseRequest struct {
	Pane                  RecoveryPaneRef               `json:"pane"`
	RootProcessGeneration RecoveryRootProcessGeneration `json:"rootProcessGeneration"`
	StrategyID            RecoveryStrategyID            `json:"strategyId"`
	IntegrationID         RecoveryIntegrationID         `json:"integrationId"`
	CaptureEpoch          RecoveryCaptureEpoch          `json:"captureEpoch"`
}

func (request RecoveryLifecycleLeaseRequest) validateRecoveryContract() error {
	if err := request.Pane.validateRecoveryContract(); err != nil {
		return err
	}
	if request.RootProcessGeneration == 0 || request.CaptureEpoch == 0 {
		return fmt.Errorf("recovery: lifecycle lease request has zero generation or capture epoch")
	}
	if err := request.StrategyID.validateRecoveryContract(); err != nil {
		return err
	}
	return request.IntegrationID.validateRecoveryContract()
}

// RecoveryLifecycleBinding is the complete daemon-held binding for one tool
// launch. It is constructed by sessiond from RecoveryLifecycleLeaseRequest;
// callback payloads cannot provide or override any of these fields.
type RecoveryLifecycleBinding struct {
	Pane                  RecoveryPaneRef               `json:"-"`
	RootProcessGeneration RecoveryRootProcessGeneration `json:"-"`
	StrategyID            RecoveryStrategyID            `json:"-"`
	IntegrationID         RecoveryIntegrationID         `json:"-"`
	CaptureEpoch          RecoveryCaptureEpoch          `json:"-"`
	IssuedAt              time.Time                     `json:"-"`
	ExpiresAt             time.Time                     `json:"-"`
}

func (binding RecoveryLifecycleBinding) validateRecoveryContract() error {
	request := RecoveryLifecycleLeaseRequest{
		Pane:                  binding.Pane,
		RootProcessGeneration: binding.RootProcessGeneration,
		StrategyID:            binding.StrategyID,
		IntegrationID:         binding.IntegrationID,
		CaptureEpoch:          binding.CaptureEpoch,
	}
	if err := request.validateRecoveryContract(); err != nil {
		return err
	}
	return validateTimeRange(
		binding.IssuedAt,
		binding.ExpiresAt,
		RecoveryLifecycleCapabilityMaxTTL,
		"lifecycle capability",
	)
}

// MarshalJSON prevents authoritative lease bindings from entering durable or
// browser-visible JSON. They remain in the daemon lease registry only.
func (RecoveryLifecycleBinding) MarshalJSON() ([]byte, error) {
	return nil, fmt.Errorf("recovery: lifecycle binding must not be serialized")
}

// UnmarshalJSON prevents callback JSON from asserting an authoritative binding.
func (*RecoveryLifecycleBinding) UnmarshalJSON([]byte) error {
	return fmt.Errorf("recovery: lifecycle binding is daemon-issued only")
}

// RecoveryLifecycleLease is the ephemeral daemon registry value for one
// capability. The single-use state is daemon-held and must be transitioned only
// by RecoveryLifecycleLeaseResolver's atomic resolve-and-consume operation.
type RecoveryLifecycleLease struct {
	Capability RecoveryLifecycleCapability `json:"-"`
	Binding    RecoveryLifecycleBinding    `json:"-"`
	Consumed   bool                        `json:"-"`
}

func (lease RecoveryLifecycleLease) validateRecoveryContract() error {
	if err := lease.Capability.validateRecoveryContract(); err != nil {
		return err
	}
	return lease.Binding.validateRecoveryContract()
}

// MarshalJSON prevents ephemeral leases from being persisted or delivered to a
// browser. Only RecoveryLifecycleLeaseDelivery may leave the issuer.
func (RecoveryLifecycleLease) MarshalJSON() ([]byte, error) {
	return nil, fmt.Errorf("recovery: lifecycle lease must not be serialized")
}

// UnmarshalJSON prevents a caller from minting a daemon lease through JSON.
func (*RecoveryLifecycleLease) UnmarshalJSON([]byte) error {
	return fmt.Errorf("recovery: lifecycle lease must be issued by sessiond")
}

// NewRecoveryLifecycleLease constructs a daemon-held lease after sessiond has
// drawn the capability with cryptographic randomness and chosen server times.
// It returns a delivery object which carries only the capability.
func NewRecoveryLifecycleLease(
	capability RecoveryLifecycleCapability,
	request RecoveryLifecycleLeaseRequest,
	issuedAt, expiresAt time.Time,
) (RecoveryLifecycleLease, RecoveryLifecycleLeaseDelivery, error) {
	lease := RecoveryLifecycleLease{
		Capability: capability,
		Binding: RecoveryLifecycleBinding{
			Pane:                  request.Pane,
			RootProcessGeneration: request.RootProcessGeneration,
			StrategyID:            request.StrategyID,
			IntegrationID:         request.IntegrationID,
			CaptureEpoch:          request.CaptureEpoch,
			IssuedAt:              issuedAt,
			ExpiresAt:             expiresAt,
		},
	}
	if err := lease.validateRecoveryContract(); err != nil {
		return RecoveryLifecycleLease{}, RecoveryLifecycleLeaseDelivery{}, err
	}
	return lease, RecoveryLifecycleLeaseDelivery{Capability: capability}, nil
}

// RecoveryLifecycleLeaseDelivery is the explicit owner-local delivery shape
// emitted by sessiond. It contains the capability and no binding, identity,
// timestamps, path, session, or launch data.
type RecoveryLifecycleLeaseDelivery struct {
	Capability RecoveryLifecycleCapability `json:"capability"`
}

func (delivery RecoveryLifecycleLeaseDelivery) validateRecoveryContract() error {
	return delivery.Capability.validateRecoveryContract()
}

// RecoveryObservedToolEvidence is the complete bounded callback evidence.
// Timestamps, integration identity, pane identity, generation, strategy, and
// directory validation are daemon authority and do not appear here.
type RecoveryObservedToolEvidence struct {
	SessionID        RecoveryOpaqueSessionID  `json:"sessionId"`
	WorkingDirectory RecoveryWorkingDirectory `json:"workingDirectory"`
}

func (evidence RecoveryObservedToolEvidence) validateRecoveryContract() error {
	if err := evidence.SessionID.validateRecoveryContract(); err != nil {
		return err
	}
	return evidence.WorkingDirectory.validateRecoveryContract()
}

// RecoveryLifecycleCapture is the owner-local lifecycle callback payload. It
// contains only the previously delivered capability and bounded observed tool
// evidence. It cannot assert its own binding, integration identity, or time.
type RecoveryLifecycleCapture struct {
	Capability RecoveryLifecycleCapability  `json:"capability"`
	Evidence   RecoveryObservedToolEvidence `json:"evidence"`
}

func (capture RecoveryLifecycleCapture) validateRecoveryContract() error {
	if err := capture.Capability.validateRecoveryContract(); err != nil {
		return err
	}
	return capture.Evidence.validateRecoveryContract()
}

// RecoveryLifecycleResolvedCapture exists only after the daemon has atomically
// resolved a callback against its lease registry. It is not serializable and
// contains the authoritative binding used to construct a durable capture.
type RecoveryLifecycleResolvedCapture struct {
	Binding  RecoveryLifecycleBinding     `json:"-"`
	Evidence RecoveryObservedToolEvidence `json:"-"`
}

func (capture RecoveryLifecycleResolvedCapture) validateRecoveryContract() error {
	if err := capture.Binding.validateRecoveryContract(); err != nil {
		return err
	}
	return capture.Evidence.validateRecoveryContract()
}

func (RecoveryLifecycleResolvedCapture) MarshalJSON() ([]byte, error) {
	return nil, fmt.Errorf("recovery: resolved lifecycle capture must not be serialized")
}

func (*RecoveryLifecycleResolvedCapture) UnmarshalJSON([]byte) error {
	return fmt.Errorf("recovery: resolved lifecycle capture is daemon-local")
}

// RecoveryLifecycleCaptureDisposition distinguishes acceptance from a
// fail-closed rejection without exposing raw callback failures.
type RecoveryLifecycleCaptureDisposition string

const (
	RecoveryLifecycleCaptureAccepted RecoveryLifecycleCaptureDisposition = "accepted"
	RecoveryLifecycleCaptureRejected RecoveryLifecycleCaptureDisposition = "rejected"
)

func validRecoveryLifecycleCaptureDisposition(value RecoveryLifecycleCaptureDisposition) bool {
	return value == RecoveryLifecycleCaptureAccepted || value == RecoveryLifecycleCaptureRejected
}

// RecoveryLifecycleRejectionCode is the closed set of lifecycle rejection
// categories. Replayed is intentionally distinct from unknown so a consumed
// known lease cannot be treated as a fresh unrecognized one.
type RecoveryLifecycleRejectionCode string

const (
	RecoveryLifecycleRejectionNone          RecoveryLifecycleRejectionCode = "none"
	RecoveryLifecycleRejectionZero          RecoveryLifecycleRejectionCode = "zero"
	RecoveryLifecycleRejectionUnknown       RecoveryLifecycleRejectionCode = "unknown"
	RecoveryLifecycleRejectionExpired       RecoveryLifecycleRejectionCode = "expired"
	RecoveryLifecycleRejectionReplayed      RecoveryLifecycleRejectionCode = "replayed"
	RecoveryLifecycleRejectionStale         RecoveryLifecycleRejectionCode = "stale"
	RecoveryLifecycleRejectionCrossPane     RecoveryLifecycleRejectionCode = "cross-pane"
	RecoveryLifecycleRejectionCrossStrategy RecoveryLifecycleRejectionCode = "cross-strategy"
	RecoveryLifecycleRejectionConflicting   RecoveryLifecycleRejectionCode = "conflicting"
	RecoveryLifecycleRejectionMalformed     RecoveryLifecycleRejectionCode = "malformed"
)

func validRecoveryLifecycleRejectionCode(value RecoveryLifecycleRejectionCode) bool {
	switch value {
	case RecoveryLifecycleRejectionNone, RecoveryLifecycleRejectionZero,
		RecoveryLifecycleRejectionUnknown, RecoveryLifecycleRejectionExpired,
		RecoveryLifecycleRejectionReplayed, RecoveryLifecycleRejectionStale,
		RecoveryLifecycleRejectionCrossPane, RecoveryLifecycleRejectionCrossStrategy,
		RecoveryLifecycleRejectionConflicting, RecoveryLifecycleRejectionMalformed:
		return true
	default:
		return false
	}
}

func lifecycleDetailCodeForRejection(value RecoveryLifecycleRejectionCode) (RecoveryDetailCode, bool) {
	switch value {
	case RecoveryLifecycleRejectionNone:
		return RecoveryDetailNone, true
	case RecoveryLifecycleRejectionZero:
		return RecoveryDetailLifecycleZero, true
	case RecoveryLifecycleRejectionUnknown:
		return RecoveryDetailLifecycleUnknown, true
	case RecoveryLifecycleRejectionExpired:
		return RecoveryDetailLifecycleExpired, true
	case RecoveryLifecycleRejectionReplayed:
		return RecoveryDetailLifecycleReplayed, true
	case RecoveryLifecycleRejectionStale:
		return RecoveryDetailLifecycleStale, true
	case RecoveryLifecycleRejectionCrossPane:
		return RecoveryDetailLifecycleCrossPane, true
	case RecoveryLifecycleRejectionCrossStrategy:
		return RecoveryDetailLifecycleCrossStrategy, true
	case RecoveryLifecycleRejectionConflicting:
		return RecoveryDetailLifecycleConflicting, true
	case RecoveryLifecycleRejectionMalformed:
		return RecoveryDetailLifecycleMalformed, true
	default:
		return "", false
	}
}

// RecoveryLifecycleCaptureOutcome is the result of validating one owner-local
// lifecycle callback. It intentionally carries no raw error, capability, or
// callback evidence.
type RecoveryLifecycleCaptureOutcome struct {
	Disposition   RecoveryLifecycleCaptureDisposition `json:"disposition"`
	RejectionCode RecoveryLifecycleRejectionCode      `json:"rejectionCode"`
	DetailCode    RecoveryDetailCode                  `json:"detailCode"`
}

func (outcome RecoveryLifecycleCaptureOutcome) validateRecoveryContract() error {
	if !validRecoveryLifecycleCaptureDisposition(outcome.Disposition) {
		return fmt.Errorf("recovery: unknown lifecycle capture disposition %q", outcome.Disposition)
	}
	expectedDetail, ok := lifecycleDetailCodeForRejection(outcome.RejectionCode)
	if !ok || outcome.DetailCode != expectedDetail {
		return fmt.Errorf("recovery: invalid lifecycle rejection/detail pairing")
	}
	if outcome.Disposition == RecoveryLifecycleCaptureAccepted &&
		outcome.RejectionCode != RecoveryLifecycleRejectionNone {
		return fmt.Errorf("recovery: accepted lifecycle capture has a rejection")
	}
	if outcome.Disposition == RecoveryLifecycleCaptureRejected &&
		outcome.RejectionCode == RecoveryLifecycleRejectionNone {
		return fmt.Errorf("recovery: rejected lifecycle capture has no rejection")
	}
	return nil
}

// RecoveryLifecycleLeaseIssuer is the daemon-only issuance boundary. The
// implementation derives current authoritative bindings, chooses daemon time
// and expiry, draws a high-entropy capability, retains the resulting lease,
// and delivers only RecoveryLifecycleLeaseDelivery to the integration.
type RecoveryLifecycleLeaseIssuer interface {
	IssueLifecycleLease(RecoveryLifecycleLeaseRequest) (RecoveryLifecycleLeaseDelivery, error)
}

// RecoveryLifecycleLeaseResolver is the daemon-owned, serialized lease
// registry boundary. ResolveAndConsumeLifecycleCapture must atomically:
//
//   - reject a zero capability before lookup;
//   - distinguish an unknown capability, expiry, and previously consumed lease;
//   - compare the daemon-held binding to current registry state and reject
//     stale, cross-pane, or cross-strategy state;
//   - detect evidence that conflicts with a prior authoritative capture; and
//   - transition a valid, current lease to consumed before returning accepted.
//
// A known, current callback is consumed as part of this transaction even when
// its evidence is malformed or conflicting; a later callback is replayed. The
// resolver alone chooses the daemon's current time and authoritative bindings.
type RecoveryLifecycleLeaseResolver interface {
	ResolveAndConsumeLifecycleCapture(
		RecoveryLifecycleCapture,
	) (RecoveryLifecycleResolvedCapture, RecoveryLifecycleCaptureOutcome)
}

// RecoveryIntegrationHealth is the observed state of a namespaced recovery
// integration, not a claim that a user configuration was modified.
type RecoveryIntegrationHealth string

const (
	RecoveryIntegrationHealthHealthy     RecoveryIntegrationHealth = "healthy"
	RecoveryIntegrationHealthUnavailable RecoveryIntegrationHealth = "unavailable"
	RecoveryIntegrationHealthConflict    RecoveryIntegrationHealth = "conflict"
	RecoveryIntegrationHealthUnsupported RecoveryIntegrationHealth = "unsupported"
	RecoveryIntegrationHealthStale       RecoveryIntegrationHealth = "stale"
	RecoveryIntegrationHealthMalformed   RecoveryIntegrationHealth = "malformed"
)

func validRecoveryIntegrationHealth(value RecoveryIntegrationHealth) bool {
	switch value {
	case RecoveryIntegrationHealthHealthy, RecoveryIntegrationHealthUnavailable,
		RecoveryIntegrationHealthConflict, RecoveryIntegrationHealthUnsupported,
		RecoveryIntegrationHealthStale, RecoveryIntegrationHealthMalformed:
		return true
	default:
		return false
	}
}

func recoveryDetailForIntegrationHealth(value RecoveryIntegrationHealth) (RecoveryDetailCode, bool) {
	switch value {
	case RecoveryIntegrationHealthHealthy:
		return RecoveryDetailNone, true
	case RecoveryIntegrationHealthUnavailable:
		return RecoveryDetailLifecycleUnavailable, true
	case RecoveryIntegrationHealthConflict:
		return RecoveryDetailLifecycleConflicting, true
	case RecoveryIntegrationHealthUnsupported:
		return RecoveryDetailStrategyUnsupported, true
	case RecoveryIntegrationHealthStale:
		return RecoveryDetailLifecycleStale, true
	case RecoveryIntegrationHealthMalformed:
		return RecoveryDetailLifecycleMalformed, true
	default:
		return "", false
	}
}

// RecoveryUserConfigPreservation is explicit so every integration plan and
// result records that existing user configuration is preserved.
type RecoveryUserConfigPreservation string

const (
	RecoveryUserConfigPreserved RecoveryUserConfigPreservation = "preserved"
	RecoveryUserConfigConflict  RecoveryUserConfigPreservation = "conflict"
	RecoveryUserConfigUnknown   RecoveryUserConfigPreservation = "unknown"
)

func validRecoveryUserConfigPreservation(value RecoveryUserConfigPreservation) bool {
	switch value {
	case RecoveryUserConfigPreserved, RecoveryUserConfigConflict, RecoveryUserConfigUnknown:
		return true
	default:
		return false
	}
}

// RecoveryIntegrationOwnership says whether the integration is muxterm-owned
// and namespaced. It never models replacing or taking over user configuration.
type RecoveryIntegrationOwnership string

const (
	RecoveryIntegrationOwnershipNamespaced RecoveryIntegrationOwnership = "namespaced-owned"
	RecoveryIntegrationOwnershipNone       RecoveryIntegrationOwnership = "none"
)

func validRecoveryIntegrationOwnership(value RecoveryIntegrationOwnership) bool {
	return value == RecoveryIntegrationOwnershipNamespaced || value == RecoveryIntegrationOwnershipNone
}

type RecoveryIntegrationPlanRequest struct {
	StrategyID RecoveryStrategyID `json:"strategyId"`
}

func (request RecoveryIntegrationPlanRequest) validateRecoveryContract() error {
	return request.StrategyID.validateRecoveryContract()
}

// RecoveryIntegrationPlan is declarative only. No command, callback text, or
// user configuration payload appears in the Wave 0 contract.
type RecoveryIntegrationPlan struct {
	StrategyID             RecoveryStrategyID             `json:"strategyId"`
	Namespace              RecoveryIntegrationNamespace   `json:"namespace"`
	Ownership              RecoveryIntegrationOwnership   `json:"ownership"`
	UserConfigPreservation RecoveryUserConfigPreservation `json:"userConfigPreservation"`
}

func (plan RecoveryIntegrationPlan) validateRecoveryContract() error {
	if err := plan.StrategyID.validateRecoveryContract(); err != nil {
		return err
	}
	if !validRecoveryIntegrationOwnership(plan.Ownership) {
		return fmt.Errorf("recovery: unknown integration ownership %q", plan.Ownership)
	}
	if !validRecoveryUserConfigPreservation(plan.UserConfigPreservation) {
		return fmt.Errorf("recovery: unknown user-config preservation %q", plan.UserConfigPreservation)
	}
	if plan.Ownership == RecoveryIntegrationOwnershipNone {
		if plan.Namespace != "" {
			return fmt.Errorf("recovery: unowned integration has a namespace")
		}
		return nil
	}
	return plan.Namespace.validateRecoveryContract()
}

type RecoveryIntegrationHealthRequest struct {
	StrategyID RecoveryStrategyID `json:"strategyId"`
}

func (request RecoveryIntegrationHealthRequest) validateRecoveryContract() error {
	return request.StrategyID.validateRecoveryContract()
}

// RecoveryIntegrationResult reports health and confirms the non-destructive
// ownership/preservation contract using stable redacted detail codes.
type RecoveryIntegrationResult struct {
	StrategyID             RecoveryStrategyID             `json:"strategyId"`
	Health                 RecoveryIntegrationHealth      `json:"health"`
	Ownership              RecoveryIntegrationOwnership   `json:"ownership"`
	UserConfigPreservation RecoveryUserConfigPreservation `json:"userConfigPreservation"`
	DetailCode             RecoveryDetailCode             `json:"detailCode"`
}

func (result RecoveryIntegrationResult) validateRecoveryContract() error {
	if err := result.StrategyID.validateRecoveryContract(); err != nil {
		return err
	}
	if !validRecoveryIntegrationHealth(result.Health) ||
		!validRecoveryIntegrationOwnership(result.Ownership) ||
		!validRecoveryUserConfigPreservation(result.UserConfigPreservation) {
		return fmt.Errorf("recovery: integration result has an unknown enum")
	}
	if err := result.DetailCode.validateRecoveryContract(); err != nil {
		return err
	}
	expectedDetail, ok := recoveryDetailForIntegrationHealth(result.Health)
	if !ok || result.DetailCode != expectedDetail {
		return fmt.Errorf("recovery: invalid integration health/detail pairing")
	}
	return nil
}

// RecoveryIntegrationManager is the contract-only non-destructive integration
// seam. Implementations may plan, inspect, issue bounded leases, and resolve
// callbacks; they do not receive a generic callback command, terminal text, or
// browser authority.
type RecoveryIntegrationManager interface {
	Plan(RecoveryIntegrationPlanRequest) RecoveryIntegrationPlan
	Health(RecoveryIntegrationHealthRequest) RecoveryIntegrationResult
	RecoveryLifecycleLeaseIssuer
	RecoveryLifecycleLeaseResolver
}
