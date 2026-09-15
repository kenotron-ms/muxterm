package voice

import (
	"sync"
	"time"
)

// AppVoiceDelivery is the only policy vocabulary allowed to promote a
// server-side event into a new spoken provider response. Fleet state and the
// Mission Control transcript intentionally remain richer than this surface.
type AppVoiceDelivery string

const (
	// AppVoiceDirectReply answers the utterance that just completed.
	AppVoiceDirectReply AppVoiceDelivery = "direct_reply"
	// AppVoiceTaskResult is a final result for work the speaker asked Operator
	// to do. It is not a progress update.
	AppVoiceTaskResult AppVoiceDelivery = "task_result"
	// AppVoiceDecision is a material approval/blocker question requiring the
	// speaker to decide something.
	AppVoiceDecision AppVoiceDelivery = "decision"
	// AppVoiceBlocker is a non-recoverable or material failure on the direct
	// request path.
	AppVoiceBlocker AppVoiceDelivery = "blocker"
	// AppVoiceRoutine never creates speech. It covers tool/lane progress,
	// queue receipts, reconnects, preview reads, and similar operational noise.
	AppVoiceRoutine AppVoiceDelivery = "routine"
)

// appVoiceDeliveryPolicy is deliberately scoped to one Sideband lifetime.
// Provider call/capture IDs already fence replay; retaining keys for that
// lifetime additionally prevents a reattach or duplicate observer event from
// speaking the same semantic update twice. The expiry is a replay window, not
// a count limit: it preserves duplicate/reconnect suppression while retiring
// old fixed-size digests in a long-lived healthy session. Correlation and
// capture state independently reject stale deliveries after this window.
type appVoiceDeliveryPolicy struct {
	mu        sync.Mutex
	delivered map[string]time.Time
}

const appVoiceDeliveryReplayWindow = 10 * time.Minute

func newAppVoiceDeliveryPolicy() *appVoiceDeliveryPolicy {
	return &appVoiceDeliveryPolicy{delivered: make(map[string]time.Time)}
}

// allow reports whether a semantic update may create a spoken response. A
// missing/ambiguous classification is routine: silence is safer than an
// unsolicited interruption. Direct user input, final results, decisions, and
// material blockers must name a stable correlation key and are admitted once.
func (p *appVoiceDeliveryPolicy) allow(kind AppVoiceDelivery, key string) bool {
	if kind == AppVoiceRoutine || key == "" {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	for deliveredKey, deliveredAt := range p.delivered {
		if now.Sub(deliveredAt) >= appVoiceDeliveryReplayWindow {
			delete(p.delivered, deliveredKey)
		}
	}
	if _, seen := p.delivered[key]; seen {
		return false
	}
	p.delivered[key] = now
	return true
}
