// Package cos supervises muxterm's "chief of staff" sidecar: a long-lived
// Python process that owns ONE amplifier session across many turns and speaks
// NDJSON over its stdin/stdout.
//
// The contract is docs/designs/2026-09-06-cos-sidecar-spec.md. Three of its
// laws shape every type in this package:
//
//   - One turn at a time. The sidecar refuses a concurrent turn with
//     {"ev":"error","code":"busy"} and never queues; Go queues (queue.go).
//     This is the structural fix for the proven silent-turn-loss defect where
//     two concurrent turns against one amplifier session erase one of them.
//   - Every turn_start resolves to exactly one terminal event. Silence is
//     never terminal, so a sidecar that dies mid-turn must still produce a
//     terminal event for whoever is waiting (supervisor.go synthesizes one).
//   - Unknown ops, events, and fields are ignored, never fatal. Evolution is
//     additive only, so a newer sidecar must never break an older muxterm.
//
// Nothing here knows about HTTP, WebSockets, or terminals. The CLI verb
// (cmd/muxterm/cos_cmd.go) is one subscriber; a WebSocket relay will be
// another, using the same API.
package cos

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
)

// Event names carried in the "ev" field (spec 2.3).
//
// EvCancelled and EvTurnCancelled are NOT in the spec's event table: 2.4 law 2
// names "a cancel acknowledgement" as one of the three terminal events but
// never gives it a wire name. Both plausible spellings are accepted as
// terminal, and an error carrying code "cancelled" is treated the same way, so
// whichever form the sidecar picks, a cancelled turn terminates rather than
// hanging its caller.
const (
	EvReady           = "ready"
	EvTurnStart       = "turn_start"
	EvDelta           = "delta"
	EvThinking        = "thinking"
	EvToolStart       = "tool_start"
	EvToolEnd         = "tool_end"
	EvApprovalRequest = "approval_request"
	EvTurnEnd         = "turn_end"
	EvError           = "error"
	EvPong            = "pong"
	EvCancelled       = "cancelled"
	EvTurnCancelled   = "turn_cancelled"
	// EvCleared and EvHistory are REPLIES, not broadcasts: each carries the
	// req_id of the op that asked for it, and supervisor.go routes them to
	// that one caller instead of the broker. They are listed here because a
	// reply whose caller has already given up still has to decode cleanly.
	EvCleared = "cleared"
	EvHistory = "history"
)

// Error codes carried in an EvError's "code" field.
//
// CodeBusy is the sidecar's refusal of a concurrent turn; reaching it means
// the Go queue failed at its one job. The remaining codes are synthesized by
// this package (never sent by the sidecar) so a caller waiting on a turn
// always gets a terminal event, even when the sidecar is the thing that died.
const (
	CodeBusy               = "busy"
	CodeCancelled          = "cancelled"
	CodeSidecarExit        = "sidecar_exit"
	CodeSidecarUnavailable = "sidecar_unavailable"
	CodeShutdown           = "shutdown"
	CodeDispatchFailed     = "dispatch_failed"
	// CodeUnknownOp is an OLDER sidecar refusing an op this build knows how to
	// send (2.4 law 5). It arrives with no req_id, because a sidecar that does
	// not understand the op does not understand its correlation field either -
	// which is exactly why supervisor.go treats it as an answer to whatever is
	// outstanding rather than letting the caller sit out the full timeout.
	CodeUnknownOp = "unknown_op"
	// CodeClearPartial and CodeClearUnsupported are the sidecar refusing to
	// call a prune a success. A clear has to land in TWO places - the
	// transcript on disk and the session's live memory - and landing in only
	// the first is not a clear: the next turn saves memory back over the file
	// and everything returns. clear_unsupported is that refusal made BEFORE
	// anything is touched; clear_partial is the report that the two halves
	// disagree, and it carries the split (removed/kept) so the message can say
	// what actually happened.
	CodeClearPartial     = "clear_partial"
	CodeClearUnsupported = "clear_unsupported"
)

// Event is one decoded NDJSON line from the sidecar.
//
// Every field is optional: the sidecar sends only what an event kind needs,
// and a field this struct does not know about is DISCARDED BY DESIGN rather
// than rejected (2.4 law 5). Raw keeps the original line so a relay can
// forward an event verbatim, including fields added after this struct was
// written.
//
// CostUSD is a json.Number because the spec prints it quoted
// ({"cost_usd":"0.04"}) while the obvious Python implementation emits a bare
// float; json.Number accepts both and neither is a decode error.
type Event struct {
	Ev string `json:"ev"`

	// Identity
	TurnID    string `json:"turn_id,omitempty"`
	RequestID string `json:"request_id,omitempty"`
	CallID    string `json:"call_id,omitempty"`

	// ready
	SessionID string `json:"session_id,omitempty"`
	Bundle    string `json:"bundle,omitempty"`
	Tools     int    `json:"tools,omitempty"`
	BootMS    int64  `json:"boot_ms,omitempty"`
	Resumed   bool   `json:"resumed,omitempty"`

	// delta / thinking
	Text string `json:"text,omitempty"`

	// tool_start / tool_end
	Name    string          `json:"name,omitempty"`
	Args    json.RawMessage `json:"args,omitempty"`
	OK      bool            `json:"ok,omitempty"`
	Summary string          `json:"summary,omitempty"`
	MS      int64           `json:"ms,omitempty"`

	// approval_request
	Tool   string `json:"tool,omitempty"`
	Detail string `json:"detail,omitempty"`

	// turn_end
	Response string      `json:"response,omitempty"`
	CostUSD  json.Number `json:"cost_usd,omitempty"`

	// error
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
	Fatal   bool   `json:"fatal,omitempty"`

	// Request/response correlation. ReqID is echoed by the sidecar on the
	// reply to a clear or history op (and on an error answering one), which
	// is what lets Supervisor hand the reply to the single caller waiting for
	// it rather than broadcasting it at every browser.
	ReqID string `json:"req_id,omitempty"`

	// cleared
	Removed int `json:"removed,omitempty"`
	Kept    int `json:"kept,omitempty"`

	// history. Kept RAW on purpose: this package has no opinion about what a
	// replayed turn looks like, and re-typing it here would mean a sidecar
	// that adds a field to a turn silently loses it on the way to the browser.
	Turns json.RawMessage `json:"turns,omitempty"`

	// Raw is the exact line the sidecar wrote, minus the newline. It is not
	// part of the wire format; it exists so unknown fields survive a round
	// trip through this struct.
	Raw json.RawMessage `json:"-"`
}

// IsTerminal reports whether this event ENDS the turn it names, per 2.4 law 2.
//
// A non-fatal error is deliberately not terminal: the sidecar may report a
// failed tool call mid-turn and keep going. The one exception is CodeBusy,
// which the spec marks fatal:false but which means "your turn was refused and
// will never run" - treating that as advisory would hang the caller forever.
func (e Event) IsTerminal() bool {
	switch e.Ev {
	case EvTurnEnd, EvCancelled, EvTurnCancelled:
		return true
	case EvError:
		return e.Fatal || e.Code == CodeBusy || e.Code == CodeCancelled
	}
	return false
}

// String renders an event for logs. It deliberately omits text-bearing fields:
// logging a delta stream would otherwise reproduce the whole model reply in
// the daemon log.
func (e Event) String() string {
	switch e.Ev {
	case EvError:
		return fmt.Sprintf("error code=%s fatal=%v turn=%s: %s", e.Code, e.Fatal, e.TurnID, e.Message)
	case EvReady:
		return fmt.Sprintf("ready session=%s bundle=%s tools=%d boot_ms=%d resumed=%v",
			e.SessionID, e.Bundle, e.Tools, e.BootMS, e.Resumed)
	case EvToolStart:
		return fmt.Sprintf("tool_start turn=%s call=%s %s", e.TurnID, e.CallID, e.Name)
	case EvToolEnd:
		return fmt.Sprintf("tool_end turn=%s call=%s ok=%v ms=%d", e.TurnID, e.CallID, e.OK, e.MS)
	case EvTurnEnd:
		return fmt.Sprintf("turn_end turn=%s ms=%d bytes=%d", e.TurnID, e.MS, len(e.Response))
	default:
		return fmt.Sprintf("%s turn=%s", e.Ev, e.TurnID)
	}
}

// errNoEventName marks a well-formed JSON object carrying no "ev" field. Such
// a line is not an event and is dropped rather than dispatched.
var errNoEventName = errors.New("cos: line has no \"ev\" field")

// ParseEvent decodes one NDJSON line.
//
// Tolerance is the point (2.4 law 5). Unknown FIELDS are dropped by
// encoding/json for free; a known field arriving with the wrong TYPE (a number
// where a string was promised) yields a json.UnmarshalTypeError, which
// encoding/json records while still decoding every other field - so the event
// is kept, not discarded. Only a line that is not a JSON object at all, or one
// with no event name, is rejected.
func ParseEvent(line []byte) (Event, error) {
	var ev Event
	if err := json.Unmarshal(line, &ev); err != nil {
		var typeErr *json.UnmarshalTypeError
		if !errors.As(err, &typeErr) {
			return Event{}, err
		}
		// Partial decode: keep whatever came through.
	}
	if ev.Ev == "" {
		return Event{}, errNoEventName
	}
	ev.Raw = append(json.RawMessage(nil), line...)
	return ev, nil
}

// synthEvent builds an event this package invents rather than receives, and
// fills Raw so a relay forwarding Raw sees the same thing a subscriber does.
func synthEvent(ev Event) Event {
	raw, err := json.Marshal(struct {
		Ev      string `json:"ev"`
		TurnID  string `json:"turn_id,omitempty"`
		Code    string `json:"code,omitempty"`
		Message string `json:"message,omitempty"`
		Fatal   bool   `json:"fatal"`
	}{ev.Ev, ev.TurnID, ev.Code, ev.Message, ev.Fatal})
	if err == nil {
		ev.Raw = raw
	}
	return ev
}

// DefaultSubscriberDepth bounds how far one subscriber may fall behind the
// sidecar reader before its events start being dropped. Sized for a full
// token-stream burst (a long reply is hundreds of deltas) so an ordinary
// consumer never drops anything.
const DefaultSubscriberDepth = 512

// Broker fans one sidecar event stream out to many subscribers.
//
// DROPPING IS THE POINT. A slow subscriber loses events; it never blocks the
// reader goroutine and it is never disconnected. This mirrors
// sessiond.subscriber.enqueuePreview, which drops advisory frames rather than
// killing a session - the same reasoning applies with more force here, since
// blocking this reader would stall the amplifier session itself.
//
// The control plane does NOT ride on this: queue.observe is called by the
// reader directly, before Publish, so a dropped delta can never cost a caller
// its turn_end. Deltas are advisory by 2.4 law 4 precisely so this is safe.
type Broker struct {
	mu     sync.Mutex
	subs   map[uint64]*Subscription
	nextID uint64
	closed bool
}

// NewBroker returns an empty broker.
func NewBroker() *Broker {
	return &Broker{subs: make(map[uint64]*Subscription)}
}

// Subscribe registers a new subscriber with a buffered channel of the given
// depth (<= 0 means DefaultSubscriberDepth). The caller MUST Close it when
// done, or the broker keeps filling and dropping into a channel nobody reads.
//
// Subscribing to a closed broker returns a subscription whose channel is
// already closed, so a caller ranging over it terminates immediately instead
// of blocking forever.
func (b *Broker) Subscribe(depth int) *Subscription {
	if depth <= 0 {
		depth = DefaultSubscriberDepth
	}
	s := &Subscription{ch: make(chan Event, depth), b: b}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		s.closeOnce.Do(func() { close(s.ch) })
		return s
	}
	b.nextID++
	s.id = b.nextID
	b.subs[s.id] = s
	return s
}

// Publish delivers ev to every live subscriber. It never blocks and never
// returns an error: a full subscriber queue drops the event and bumps that
// subscriber's drop counter.
func (b *Broker) Publish(ev Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	for _, s := range b.subs {
		select {
		case s.ch <- ev:
		default:
			s.dropped.Add(1)
		}
	}
}

// Close closes every subscriber channel and refuses further publishes.
// Subscribers see their channel close, which is how a consumer distinguishes
// "sidecar stream ended" from "no events right now".
func (b *Broker) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	for id, s := range b.subs {
		s.closeOnce.Do(func() { close(s.ch) })
		delete(b.subs, id)
	}
}

// Subscribers reports the number of live subscribers.
func (b *Broker) Subscribers() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subs)
}

// Subscription is one consumer's view of the sidecar event stream.
type Subscription struct {
	ch        chan Event
	b         *Broker
	id        uint64
	dropped   atomic.Int64
	closeOnce sync.Once
}

// C returns the receive channel. It is closed when the subscription or the
// broker is closed.
func (s *Subscription) C() <-chan Event { return s.ch }

// Dropped reports how many events were discarded because this subscriber was
// not draining fast enough. Non-zero means the consumer is slow, not that the
// sidecar misbehaved.
func (s *Subscription) Dropped() int64 { return s.dropped.Load() }

// Close unregisters the subscription and closes its channel. It is idempotent
// and safe to call concurrently with Publish.
func (s *Subscription) Close() {
	s.b.mu.Lock()
	defer s.b.mu.Unlock()
	delete(s.b.subs, s.id)
	s.closeOnce.Do(func() { close(s.ch) })
}
