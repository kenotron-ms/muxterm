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
