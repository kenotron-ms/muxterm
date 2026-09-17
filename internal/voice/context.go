package voice

import "context"

// ConversationContextView is the deliberately closed read shape exposed to
// the realtime model. It has no conversation, workspace, browser, path, or
// range selector: a Voice sideband is permanently attached to one authenticated
// muxterm voice session and can inspect only that session's one Operator root.
type ConversationContextView string

const (
	// ConversationContextRecent returns the bounded recent conversational cut.
	ConversationContextRecent ConversationContextView = "recent"
	// ConversationContextContinuitySummary returns the smaller cut appropriate
	// for resumed, referential speech such as "continue" or "as we said".
	ConversationContextContinuitySummary ConversationContextView = "continuity_summary"
)

func (v ConversationContextView) Valid() bool {
	return v == ConversationContextRecent || v == ConversationContextContinuitySummary
}

// ConversationContextItem is a prior, user-visible conversational utterance.
// It deliberately has no IDs, timestamps, tool calls, thinking, errors, or
// transport metadata. Its Kind makes clear to the realtime model that this is
// historic context, never a new instruction from the user.
type ConversationContextItem struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}

// ConversationContextWork is the safe current queue projection. It contains
// only a sanitized user prompt and whether it is active or durably queued.
type ConversationContextWork struct {
	State string `json:"state"`
	Text  string `json:"text"`
}

// OperatorConversationContext is the bounded, read-only representation of the
// one persistent server-owned Operator conversation. It is serialized only as
// a function-call output in the current realtime session; it is never cached,
// logged, sent to a browser, or made available through an HTTP route.
type OperatorConversationContext struct {
	Kind        string                    `json:"kind"`
	Notice      string                    `json:"notice"`
	Items       []ConversationContextItem `json:"items"`
	CurrentWork []ConversationContextWork `json:"current_work"`
}

// ContextBridge is intentionally narrower than Bridge. Sideband callers can
// discover it only from the bridge installed for their own authenticated voice
// session; there is no caller-provided selector to resolve another conversation.
type ContextBridge interface {
	ReadOperatorConversationContext(context.Context, ConversationContextView) (OperatorConversationContext, error)
}
