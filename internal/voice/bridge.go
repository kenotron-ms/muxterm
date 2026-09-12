package voice

import "context"

// Bridge is the chief of staff, as much of it as this package needs.
//
// Narrow on purpose. It exists so the sideband can be tested without an
// amplifier sidecar, and so this package cannot reach anything in
// internal/cos beyond submitting a turn, answering an approval, and
// cancelling. internal/server supplies the real implementation over the
// SAME supervisor the text chat uses -- one session, one transcript, one set
// of approvals.
type Bridge interface {
	// Submit queues a chief-of-staff turn. The returned handle resolves
	// exactly once, even if the sidecar dies mid-turn.
	Submit(prompt string) (TurnHandle, error)
	// Approve answers a pending approval request.
	Approve(requestID string, approved bool, reason string) error
	// Cancel stops a running turn. An empty turnID means "whatever is
	// running".
	Cancel(turnID string) error
}

// CorrelatedBridge is the only bridge shape a thread-scoped realtime
// attachment may use. The values are copied from provider events observed by
// the server; neither focus nor an HTTP client can choose a target for them.
// Legacy Bridge.Submit is deliberately unavailable on a ScopedBridge.
type CorrelatedBridge interface {
	Bridge
	SubmitCorrelated(Correlation, string) (TurnHandle, error)
}

// Correlation identifies the provider event that requested work, as observed
// on one immutable provider attachment.
type Correlation struct {
	ProviderCallID     string
	ProviderItemID     string
	ProviderResponseID string
	CaptureID          string
	AttachmentEpoch    uint64
}

// ProviderEvent is an event observed on one Sideband connection. CallID is
// always the sideband's server-observed call identity, never a client value.
type ProviderEvent struct {
	Type       string
	CallID     string
	ItemID     string
	ResponseID string
	OutputID   string
	CallRef    string
	Metadata   map[string]string
}

// ProviderEventBridge verifies provider event ordering before Sideband may
// dispatch a tool. ResolveToolCall returns the one immutable capture
// correlation for a final function-call event; it never has a "latest"
// fallback.
type ProviderEventBridge interface {
	ObserveProviderEvent(ProviderEvent) error
	ReserveToolCall(ProviderEvent) (Correlation, error)
	ResolveToolCall(ProviderEvent) (Correlation, error)
}

// ScopedReplyBridge owns every audible response for a scoped attachment.
// Sideband may deliver a function result into the provider conversation, but
// it must delegate response creation to this prefix-gated controller.
type ScopedReplyBridge interface {
	// terminal distinguishes the final turn result from a started/working
	// acknowledgement. Completing work alone does not complete its narration.
	QueueScopedReply(Correlation, string, string, bool) error
}

type SidebandTerminalBridge interface {
	SidebandTerminal(reason string)
}

// TurnHandle is one in-flight chief-of-staff turn.
type TurnHandle interface {
	// ID is the turn_id every event of this turn carries.
	ID() string
	// Wait blocks until the turn terminates or ctx is cancelled, and
	// returns the assistant's answer text. A cancelled ctx returns
	// ctx.Err() and does NOT cancel the turn: the turn keeps running and
	// its answer arrives on the asynchronous path.
	Wait(ctx context.Context) (string, error)
}
