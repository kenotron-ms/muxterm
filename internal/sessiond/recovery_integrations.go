package sessiond

import "time"

const (
	// RecoveryLifecycleCapabilityBytes is 256 bits of per-launch entropy.
	RecoveryLifecycleCapabilityBytes = 32
	// RecoveryLifecycleCapabilityMaxTTL bounds a capability's validity window.
	RecoveryLifecycleCapabilityMaxTTL = 5 * time.Minute
)

// RecoveryLifecycleCapability is an opaque 256-bit owner-local token. It is
// never browser-visible or persisted as a reusable credential.
type RecoveryLifecycleCapability [RecoveryLifecycleCapabilityBytes]byte

// RecoveryIntegrationNamespace is bounded by
// RecoveryMaxLifecycleNamespaceBytes and identifies only muxterm-owned
// namespaced integration state.
type RecoveryIntegrationNamespace string

// RecoveryIntegrationID is bounded by RecoveryMaxLifecycleIntegrationIDBytes.
// It identifies a configured integration without exposing its user config.
type RecoveryIntegrationID string

// RecoveryLifecycleBinding is the complete capability binding for one tool
// launch. IssuedAt and ExpiresAt must be within
// RecoveryLifecycleCapabilityMaxTTL.
type RecoveryLifecycleBinding struct {
	Pane                  RecoveryPaneRef               `json:"pane"`
	RootProcessGeneration RecoveryRootProcessGeneration `json:"rootProcessGeneration"`
	StrategyID            RecoveryStrategyID            `json:"strategyId"`
	CaptureEpoch          RecoveryCaptureEpoch          `json:"captureEpoch"`
	IssuedAt              time.Time                     `json:"issuedAt"`
	ExpiresAt             time.Time                     `json:"expiresAt"`
}

// RecoveryLifecycleCapture is the owner-local lifecycle callback payload. The
// capability and binding prevent stale, cross-pane, and wrong-strategy events
// from becoming recovery authority.
type RecoveryLifecycleCapture struct {
	Capability       RecoveryLifecycleCapability     `json:"capability"`
	Binding          RecoveryLifecycleBinding        `json:"binding"`
	IntegrationID    RecoveryIntegrationID           `json:"integrationId"`
	SessionID        RecoveryOpaqueSessionID         `json:"sessionId"`
	WorkingDirectory RecoveryWorkingDirectoryBinding `json:"workingDirectory"`
	ObservedAt       time.Time                       `json:"observedAt"`
}

// RecoveryLifecycleCaptureDisposition distinguishes acceptance from a
// fail-closed rejection without exposing raw callback failures.
type RecoveryLifecycleCaptureDisposition string

const (
	RecoveryLifecycleCaptureAccepted RecoveryLifecycleCaptureDisposition = "accepted"
	RecoveryLifecycleCaptureRejected RecoveryLifecycleCaptureDisposition = "rejected"
)

// RecoveryLifecycleRejectionCode is the closed set of lifecycle rejection
// categories. Each category is safe to project as a stable detail code.
type RecoveryLifecycleRejectionCode string

const (
	RecoveryLifecycleRejectionNone          RecoveryLifecycleRejectionCode = "none"
	RecoveryLifecycleRejectionStale         RecoveryLifecycleRejectionCode = "stale"
	RecoveryLifecycleRejectionDuplicate     RecoveryLifecycleRejectionCode = "duplicate"
	RecoveryLifecycleRejectionCrossPane     RecoveryLifecycleRejectionCode = "cross-pane"
	RecoveryLifecycleRejectionWrongStrategy RecoveryLifecycleRejectionCode = "wrong-strategy"
	RecoveryLifecycleRejectionExpired       RecoveryLifecycleRejectionCode = "expired"
	RecoveryLifecycleRejectionMalformed     RecoveryLifecycleRejectionCode = "malformed"
	RecoveryLifecycleRejectionConflicting   RecoveryLifecycleRejectionCode = "conflicting"
)

// RecoveryLifecycleCaptureOutcome is the result of validating one owner-local
// lifecycle capture. It intentionally carries no raw error or capability.
type RecoveryLifecycleCaptureOutcome struct {
	Disposition   RecoveryLifecycleCaptureDisposition `json:"disposition"`
	RejectionCode RecoveryLifecycleRejectionCode      `json:"rejectionCode"`
	DetailCode    RecoveryDetailCode                  `json:"detailCode"`
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

// RecoveryUserConfigPreservation is explicit so every integration plan and
// result records that existing user configuration is preserved.
type RecoveryUserConfigPreservation string

const (
	RecoveryUserConfigPreserved RecoveryUserConfigPreservation = "preserved"
	RecoveryUserConfigConflict  RecoveryUserConfigPreservation = "conflict"
	RecoveryUserConfigUnknown   RecoveryUserConfigPreservation = "unknown"
)

// RecoveryIntegrationOwnership says whether the integration is muxterm-owned
// and namespaced. It never models replacing or taking over user configuration.
type RecoveryIntegrationOwnership string

const (
	RecoveryIntegrationOwnershipNamespaced RecoveryIntegrationOwnership = "namespaced-owned"
	RecoveryIntegrationOwnershipNone       RecoveryIntegrationOwnership = "none"
)

type RecoveryIntegrationPlanRequest struct {
	StrategyID RecoveryStrategyID `json:"strategyId"`
}

// RecoveryIntegrationPlan is declarative only. No command, callback text, or
// user configuration payload appears in the Wave 0 contract.
type RecoveryIntegrationPlan struct {
	StrategyID             RecoveryStrategyID             `json:"strategyId"`
	Namespace              RecoveryIntegrationNamespace   `json:"namespace"`
	Ownership              RecoveryIntegrationOwnership   `json:"ownership"`
	UserConfigPreservation RecoveryUserConfigPreservation `json:"userConfigPreservation"`
}

type RecoveryIntegrationHealthRequest struct {
	StrategyID RecoveryStrategyID `json:"strategyId"`
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

// RecoveryIntegrationManager is the contract-only non-destructive integration
// seam. Implementations may plan, inspect, and validate captures; they do not
// receive a generic callback command, terminal text, or browser authority.
type RecoveryIntegrationManager interface {
	Plan(RecoveryIntegrationPlanRequest) RecoveryIntegrationPlan
	Health(RecoveryIntegrationHealthRequest) RecoveryIntegrationResult
	Capture(RecoveryLifecycleCapture) RecoveryLifecycleCaptureOutcome
}
