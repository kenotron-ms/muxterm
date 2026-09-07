package server

// Chief-of-staff WebSocket relay.
//
// The CoS conversation is SERVER-OWNED: one amplifier session per muxterm
// install, shared by every browser tab. That is why this follows the
// server-owned broadcast precedent next door (Hub.BroadcastConfig,
// Hub.BroadcastAIStatus) rather than the per-browser sessiond relay -- there is
// no per-daemon state here, nothing is forwarded to sessiond, and a turn
// started in one tab must stream to all of them.
//
// The browser vocabulary is the additive subscribe trio documented in
// sessiond/protocol.go:106-142 (X-subscribe -> X-subscribe-result -> X), so an
// old browser against a new server simply never subscribes, and an old server
// ignores a new browser's cos-subscribe instead of hanging it:
//
//	browser -> server   {"type":"cos-subscribe","on":true}
//	                    {"type":"cos-turn","prompt":"...","client_ref":"..."}
//	                    {"type":"cos-approval","request_id":"a-1","approved":true}
//	                    {"type":"cos-cancel","turn_id":"t-1"}
//	                    {"type":"cos-clear","older_than_days":7}
//	server -> browser   {"type":"cos-subscribe-result","ok":true,"session_id":"...","ready":true}
//	                    {"type":"cos-history","turns":[...]}
//	                    {"type":"cos-event","event":{...verbatim sidecar event...}}
//	                    {"type":"cos-clear-result","ok":true,"removed":12,"kept":3}
//
// cos-history is what makes a reloaded tab show the conversation it was in the
// middle of. The amplifier session remembers every turn; without a replay the
// browser did not, so a refresh looked like the chief of staff had forgotten
// everything -- and a "clear" that only emptied browser memory came back on
// the next reload. It is ADDITIVE: an old browser ignores the frame, and a new
// browser against an old server simply never receives one.
//
// Four properties are load-bearing:
//
//   - Subscribers are PER CONNECTION and opt-in. A connection that never sends
//     cos-subscribe receives no cos-event and costs nothing.
//   - Every subscribed connection holds its own subscription on the ONE shared
//     broker, so a turn submitted in any tab streams to all of them without
//     this layer fanning anything out by hand.
//   - The sidecar starts LAZILY, on the first cos-subscribe or cos-turn (the
//     internal/mcp lazyClient pattern). Booting an amplifier session on every
//     muxterm start would be a ~2s tax for a feature nobody opened.
//   - Events are DROPPABLE per subscriber. cos.Broker already implements
//     drop-on-slow; a browser that cannot keep up loses events and never blocks
//     the sidecar reader, which would otherwise stall the amplifier session
//     itself. This mirrors sessiond.subscriber.enqueuePreview.
//
// Events are forwarded VERBATIM (cos.Event.Raw), never re-encoded from the
// decoded struct: the sidecar emits fields this build does not know about
// (session_cost_usd, muxterm_tools, turn_end.error) and cost_usd may be a
// number or a numeric string. Re-typing either would corrupt them. The one
// exception is turn_start, which is decorated (see decorateTurnStart) with
// fields the sidecar cannot know.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/kenotron-ms/muxterm/internal/cos"
)

// Message types on the browser <-> serve wire. These are SERVE-LOCAL, not
// sessiond messages: nothing here is ever relayed to the daemon.
const (
	cosTypePrefix          = "cos-"
	cosTypeSubscribe       = "cos-subscribe"
	cosTypeSubscribeResult = "cos-subscribe-result"
	cosTypeTurn            = "cos-turn"
	cosTypeApproval        = "cos-approval"
	cosTypeCancel          = "cos-cancel"
	cosTypeClear           = "cos-clear"
	cosTypeClearResult     = "cos-clear-result"
	cosTypeHistory         = "cos-history"
	cosTypeEvent           = "cos-event"
)

// Why a cos-history frame was sent. An ADDITIVE field on an existing frame
// (2.4 law 5), and the browser needs it because the two replays mean opposite
// things about a turn the replay does NOT contain:
//
//	subscribe  the transcript as it stood a moment ago. A live turn missing
//	           from it may simply have finished after the snapshot was taken,
//	           somewhere in the gap between WaitReady and the frame landing.
//	clear      the transcript AFTER a prune the user asked for. A turn missing
//	           from it was deleted, and must not come back.
//
// An older browser ignores the field and keeps today's behaviour, which is the
// "clear" one.
const (
	cosHistoryReasonSubscribe = "subscribe"
	cosHistoryReasonClear     = "clear"
)

const (
	// cosSubscriberDepth is how far one browser may fall behind before its
	// events start being dropped. Sized for a full token-stream burst.
	cosSubscriberDepth = 512
	// cosPromptMaxBytes bounds one prompt. The connection read limit is 1MB
	// (ws.go), so this is the smaller, friendlier bound.
	cosPromptMaxBytes = 128 << 10
	// cosMaxTrackedTurns bounds the submission table below. Only turn_start
	// consults it, and only for the turn that just started, so a few hundred
	// entries is generous.
	cosMaxTrackedTurns = 256
	// cosHistoryTurns is how much conversation a reloaded tab gets back. The
	// sidecar summarizes each turn (prompt, reply, thinking, one line per
	// tool call), so fifty of them is tens of kilobytes -- not the megabytes
	// the raw session log would be.
	cosHistoryTurns = 50
	// cosBootWait bounds how long a background helper waits for the ~2s
	// amplifier boot before giving up. Generous, because the first subscribe
	// of a cold server is what pays for a bundle resolve.
	cosBootWait = 2 * time.Minute
)

// cosClientMessage is one browser -> serve frame.
//
// Approved is a POINTER for exactly the reason the Go -> sidecar op is
// (supervisor.go): a denial is approved=false, and a missing field must not be
// mistaken for one. An absent Approved is treated as a DENIAL and logged --
// never as an approval -- because this is the one message where guessing wrong
// runs the command the user just refused.
//
// Unknown fields are dropped by encoding/json for free, which is the additive
// half of the compatibility contract.
type cosClientMessage struct {
	Type          string `json:"type"`
	On            bool   `json:"on"`
	Prompt        string `json:"prompt"`
	ClientRef     string `json:"client_ref"`
	RequestID     string `json:"request_id"`
	Approved      *bool  `json:"approved"`
	Reason        string `json:"reason"`
	TurnID        string `json:"turn_id"`
	OlderThanDays int    `json:"older_than_days"`
}

// --- relay -----------------------------------------------------------------

// cosSubmission is what the browser told us about a turn that the sidecar
// itself never learns: which tab asked, and what it asked. turn_start carries
// only a turn id (internal/cos/sidecar/main.py:752).
type cosSubmission struct {
	clientRef string
	prompt    string
}

// cosRelay owns the single, lazily-started supervisor. One per Hub, i.e. one
// per muxterm server.
type cosRelay struct {
	cfg cos.Config

	once sync.Once
	mu   sync.Mutex
	sup  *cos.Supervisor
	err  error

	// subMu guards the submission table AND is held across cos.Supervisor.Submit.
	//
	// Holding it across Submit is what removes a real race: the sidecar emits
	// turn_start the instant it reads the turn op, and queue.submit dispatches
	// synchronously, so turn_start can reach a pump goroutine before Submit has
	// even returned the turn id to us. A pump must therefore take this same
	// lock to look a turn up, which makes it wait for the submitter to finish
	// recording rather than race it. Submit never blocks (sendOp is a
	// non-blocking channel send), so the critical section cannot stall.
	subMu    sync.Mutex
	subs     map[string]cosSubmission
	subOrder []string
}

func newCosRelay() *cosRelay {
	return &cosRelay{
		cfg: cos.Config{
			Logf:            log.Printf,
			SubscriberDepth: cosSubscriberDepth,
		},
		subs: make(map[string]cosSubmission),
	}
}

// get starts the sidecar on first use and returns the same result forever
// after, mirroring internal/mcp's lazyClient.
//
// A Start error is CACHED deliberately: Start only fails on interpreter or
// script resolution, which will not fix itself while this process runs, and
// retrying on every keystroke would bury the real error under a restart loop.
// Everything after a successful spawn is the supervisor's problem and surfaces
// as events -- including a mid-turn death, which internal/cos answers with a
// synthesized fatal error carrying the dead turn's id, so no browser waits on a
// process that no longer exists.
func (r *cosRelay) get() (*cos.Supervisor, error) {
	r.once.Do(func() {
		sup := cos.New(r.cfg)
		if err := sup.Start(context.Background()); err != nil {
			r.mu.Lock()
			r.err = err
			r.mu.Unlock()
			return
		}
		r.mu.Lock()
		r.sup = sup
		r.mu.Unlock()
	})
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sup, r.err
}

// started reports whether a sidecar was ever launched, WITHOUT launching one.
// Asking "is it running" must never be the thing that starts it.
func (r *cosRelay) started() *cos.Supervisor {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sup
}

// submit puts one prompt THROUGH THE QUEUE and records who asked.
//
// Never bypass cos.Supervisor.Submit. The queue is the structural fix for the
// proven silent-turn-loss defect: two concurrent turns against one amplifier
// session erase one of them, and the sidecar refuses the second rather than
// queueing it (spec 2.4 law 1).
func (r *cosRelay) submit(sup *cos.Supervisor, prompt, clientRef string) *cos.Turn {
	r.subMu.Lock()
	defer r.subMu.Unlock()

	turn := sup.Submit(prompt)
	r.subs[turn.ID] = cosSubmission{clientRef: clientRef, prompt: prompt}
	r.subOrder = append(r.subOrder, turn.ID)
	for len(r.subOrder) > cosMaxTrackedTurns {
		delete(r.subs, r.subOrder[0])
		r.subOrder = r.subOrder[1:]
	}
	return turn
}

// submission returns what the browser told us about a turn.
func (r *cosRelay) submission(turnID string) (cosSubmission, bool) {
	r.subMu.Lock()
	defer r.subMu.Unlock()
	s, ok := r.subs[turnID]
	return s, ok
}

// clear prunes the chief-of-staff conversation.
//
// The prune happens INSIDE THE SIDECAR, not here, and that is structural: the
// authoritative transcript is the amplifier session the sidecar owns, and
// rewriting the session store from Go behind a live sidecar would race the
// process that is actively appending to it. This function's whole job is to
// wait for a session to exist and ask it.
//
// Two guarantees are the sidecar's to keep and come back as errors when they
// cannot be: it refuses while a turn is in flight, and it never drops a
// message that references a lane that is still alive.
//
// It uses get() rather than started(), so a clear works on a server whose
// sidecar has not been asked for yet. Booting one to carry out an explicit
// destructive request the user just confirmed is not a surprise; silently
// answering "there was nothing to clear" while a transcript sits on disk
// would be.
func (r *cosRelay) clear(ctx context.Context, olderThanDays int) (removed, kept int, err error) {
	sup, err := r.get()
	if err != nil {
		return 0, 0, err
	}
	if _, err := sup.WaitReady(ctx); err != nil {
		return 0, 0, err
	}
	return sup.Clear(olderThanDays)
}

// history fetches the newest turns as the sidecar summarized them.
//
// Unlike clear this NEVER starts a sidecar: history is asked for on every
// subscribe, and "what was I saying?" must not be the thing that boots an
// amplifier session. The caller already holds a supervisor by the time it
// gets here (cos-subscribe started it), so the nil case is a real "nothing
// running", not a missed opportunity.
func (r *cosRelay) history(ctx context.Context, limit int) (json.RawMessage, error) {
	sup := r.started()
	if sup == nil {
		return nil, cos.ErrNotRunning
	}
	if _, err := sup.WaitReady(ctx); err != nil {
		return nil, err
	}
	return sup.History(limit)
}

// close shuts the sidecar down if one was ever started, so muxterm does not
// orphan a python process on exit.
func (r *cosRelay) close() {
	if r == nil {
		return
	}
	if sup := r.started(); sup != nil {
		_ = sup.Close()
	}
}

// --- framing ---------------------------------------------------------------

// cosEventFrame wraps one verbatim sidecar event in the serve envelope.
func cosEventFrame(event json.RawMessage) []byte {
	frame := struct {
		Type  string          `json:"type"`
		Event json.RawMessage `json:"event"`
	}{Type: cosTypeEvent, Event: event}
	data, err := json.Marshal(frame)
	if err != nil {
		// Cannot happen for a RawMessage that came off the wire, but a relay
		// that panicked here would take a browser's terminals down with it.
		log.Printf("cos: encode event frame: %v", err)
		return nil
	}
	return data
}

// cosSynthEvent builds an event this layer invents rather than receives.
func cosSynthEvent(fields map[string]any) json.RawMessage {
	data, err := json.Marshal(fields)
	if err != nil {
		return nil
	}
	return data
}

// decorateTurn adds client_ref (and the prompt) to an event that names a turn.
//
// The sidecar's turn_start carries only a turn id, so without this a tab cannot
// tell which of its own submissions just started, and a SECOND tab would watch
// a reply stream in with no question above it. Both are additive FIELDS on an
// existing event, which spec 2.4 law 5 requires every consumer to ignore if it
// does not know them.
//
// It is applied to a turn's ERROR event as well, and for a sharper reason: a
// turn that fails at dispatch (queue.fail) never produced a turn_start at all,
// so the error is the ONLY frame the browser will ever see for it. Undecorated,
// it renders as a failure with no question above it -- the user watches their
// prompt vanish and gets an error that does not say what it was about.
//
// The decode is into map[string]json.RawMessage on purpose: every value the
// sidecar sent survives as the exact bytes it sent, so nothing is re-typed.
// Any failure returns the original line unmodified -- a turn_start missing its
// client_ref is a cosmetic loss, a dropped turn_start is not.
func (r *cosRelay) decorateTurn(raw json.RawMessage, turnID string) json.RawMessage {
	sub, ok := r.submission(turnID)
	if !ok {
		return raw
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return raw
	}
	if sub.clientRef != "" {
		if b, err := json.Marshal(sub.clientRef); err == nil {
			fields["client_ref"] = b
		}
	}
	if sub.prompt != "" {
		if b, err := json.Marshal(sub.prompt); err == nil {
			fields["prompt"] = b
		}
	}
	out, err := json.Marshal(fields)
	if err != nil {
		return raw
	}
	return out
}

// --- per-connection subscription -------------------------------------------

// isCosMessage reports whether a control frame belongs to this relay.
func isCosMessage(msgType string) bool {
	return strings.HasPrefix(msgType, cosTypePrefix)
}

// handleCosMessage routes one browser frame. It runs on the client's readPump
// goroutine and must not block: everything it calls is either a lock-protected
// state change or a bounded write.
//
// It deliberately does NOT require a daemon connection. The chief of staff is
// server-owned and reaches muxterm through the MCP server, not through this
// client's sessiond socket.
func (c *Client) handleCosMessage(data []byte) {
	var msg cosClientMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		log.Printf("cos: ignoring malformed frame: %v", err)
		return
	}

	switch msg.Type {
	case cosTypeSubscribe:
		c.cosSubscribe(msg.On)
	case cosTypeTurn:
		c.cosTurn(msg)
	case cosTypeApproval:
		c.cosApproval(msg)
	case cosTypeCancel:
		c.cosCancel(msg)
	case cosTypeClear:
		c.cosClear(msg)
	default:
		// Additive evolution only: an unknown cos-* type from a newer browser
		// is ignored, never an error (2.4 law 5, applied to this hop).
		log.Printf("cos: ignoring unknown message type %q", msg.Type)
	}
}

// cosSubscribe turns the event stream on or off for THIS connection.
func (c *Client) cosSubscribe(on bool) {
	if !on {
		c.stopCos()
		c.sendCosSubscribeResult(true, "", "", false)
		return
	}

	relay := c.hub.cos
	if relay == nil {
		c.sendCosSubscribeResult(false, "muxterm is not available on this server", "", false)
		return
	}
	sup, err := relay.get()
	if err != nil {
		c.sendCosSubscribeResult(false, err.Error(), "", false)
		return
	}

	// A repeat subscribe replaces the old subscription rather than stacking a
	// second pump onto the same socket.
	c.stopCos()

	sub := sup.Subscribe(cosSubscriberDepth)
	st := sup.Status()

	c.cosMu.Lock()
	c.cosSub = sub
	c.cosMu.Unlock()

	// ready is reported here, not only as an event: the sidecar publishes its
	// ready event exactly once, so a tab that subscribes after boot would
	// otherwise never learn the session is live.
	c.sendCosSubscribeResult(true, "", st.SessionID, st.Ready)

	go c.cosPump(sub, relay)
	// History is fetched on its own goroutine because the sidecar may still
	// be booting: blocking the read pump on a ~2s amplifier start would stall
	// every terminal keystroke on this socket behind a chat replay.
	go c.cosSendHistory(sup, sub)
}

// cosSendHistory replays the conversation to ONE freshly-subscribed tab.
//
// The subscription it was started for is passed in and re-checked before the
// write: a tab that unsubscribed and re-subscribed while the boot was in
// flight would otherwise receive a stale replay AFTER its fresh one, and the
// store would render the older transcript over the newer.
//
// Failure is quiet by design. A missing replay costs a reloaded tab its
// scrollback until the next turn; an error dialog for it would be louder than
// the problem.
func (c *Client) cosSendHistory(sup *cos.Supervisor, sub *cos.Subscription) {
	ctx, cancel := context.WithTimeout(context.Background(), cosBootWait)
	defer cancel()
	if _, err := sup.WaitReady(ctx); err != nil {
		log.Printf("cos: no history replay (sidecar never became ready): %v", err)
		return
	}
	turns, err := sup.History(cosHistoryTurns)
	if err != nil {
		log.Printf("cos: no history replay: %v", err)
		return
	}
	if !c.cosHolds(sub) {
		return
	}
	c.sendCosHistory(turns, cosHistoryReasonSubscribe)
}

// cosHolds reports whether sub is still THIS connection's live subscription.
func (c *Client) cosHolds(sub *cos.Subscription) bool {
	c.cosMu.Lock()
	defer c.cosMu.Unlock()
	return c.cosSub != nil && c.cosSub == sub
}

// cosSubscribed reports whether this connection is watching the conversation
// at all, without starting anything.
func (c *Client) cosSubscribed() bool {
	c.cosMu.Lock()
	defer c.cosMu.Unlock()
	return c.cosSub != nil
}

// broadcastCosHistory pushes one replay to every subscribed tab.
//
// This is what makes a clear look like a clear everywhere instead of only in
// the tab that asked. The conversation is server-owned and shared, so a prune
// is not a private edit: the same reasoning that makes a turn stream to every
// tab makes the post-prune transcript belong to every tab. Follows the
// BroadcastConfig shape next door -- snapshot the client set under the lock,
// write outside it.
func (h *Hub) broadcastCosHistory(turns json.RawMessage, reason string) {
	h.mu.Lock()
	clients := make([]*Client, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.Unlock()

	for _, c := range clients {
		if c.cosSubscribed() {
			c.sendCosHistory(turns, reason)
		}
	}
}

// cosPump forwards this connection's slice of the event stream.
//
// It exits when the subscription closes (this connection unsubscribed or went
// away), when the broker closes (the supervisor shut down), or when the socket
// stops accepting writes. A browser that stops reading stalls only THIS
// goroutine: cos.Broker.Publish is non-blocking, so once the 512-deep channel
// fills, events for this subscriber are dropped and every other subscriber --
// and the sidecar reader itself -- keeps running at full speed.
func (c *Client) cosPump(sub *cos.Subscription, relay *cosRelay) {
	defer func() {
		if n := sub.Dropped(); n > 0 {
			log.Printf("cos: subscriber dropped %d event(s) while behind", n)
		}
	}()

	for ev := range sub.C() {
		raw := ev.Raw
		if len(raw) == 0 {
			// Every event from ParseEvent and synthEvent carries Raw; this is
			// belt and braces so an event can never be silently swallowed.
			encoded, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			raw = encoded
		}
		if (ev.Ev == cos.EvTurnStart || ev.Ev == cos.EvError) && ev.TurnID != "" {
			raw = relay.decorateTurn(raw, ev.TurnID)
		}
		frame := cosEventFrame(raw)
		if frame == nil {
			continue
		}
		if err := c.writeText(frame); err != nil {
			// The socket is going away (or wedged past the 5s write deadline);
			// readPump will remove the client.
			return
		}
	}
}

// stopCos ends this connection's subscription. Idempotent, and safe to call
// from the connection teardown path.
func (c *Client) stopCos() {
	c.cosMu.Lock()
	sub := c.cosSub
	c.cosSub = nil
	c.cosMu.Unlock()
	if sub != nil {
		sub.Close()
	}
}

// cosTurn submits one prompt through the queue, lazily starting the sidecar.
func (c *Client) cosTurn(msg cosClientMessage) {
	prompt := strings.TrimSpace(msg.Prompt)
	if prompt == "" {
		c.sendCosError("", "bad_request", "an empty prompt was ignored")
		return
	}
	if len(prompt) > cosPromptMaxBytes {
		c.sendCosError("", "bad_request",
			fmt.Sprintf("prompt is %d bytes; the limit is %d", len(prompt), cosPromptMaxBytes))
		return
	}
	relay := c.hub.cos
	if relay == nil {
		c.sendCosError("", cos.CodeSidecarUnavailable, "muxterm is not available on this server")
		return
	}
	sup, err := relay.get()
	if err != nil {
		c.sendCosError("", cos.CodeSidecarUnavailable, err.Error())
		return
	}

	// The turn's visible existence is its turn_start, which reaches EVERY
	// subscriber through the shared broker -- including tabs that did not ask
	// for it, because the conversation is shared. Nothing is fanned out here.
	relay.submit(sup, prompt, msg.ClientRef)
}

// cosApproval answers an approval_request.
//
// An approval_request BLOCKS the turn until it is answered (2.4 law 3), so
// every path here answers. A frame with no "approved" field is a DENIAL: the
// alternative is guessing, on the one message where guessing wrong runs the
// command the user just refused.
func (c *Client) cosApproval(msg cosClientMessage) {
	if msg.RequestID == "" {
		c.sendCosError("", "bad_request", "cos-approval carried no request_id")
		return
	}
	relay := c.hub.cos
	if relay == nil {
		return
	}
	sup := relay.started()
	if sup == nil {
		c.sendCosError("", cos.CodeSidecarUnavailable, "muxterm is not running here")
		return
	}

	approved := false
	reason := msg.Reason
	if msg.Approved != nil {
		approved = *msg.Approved
	} else {
		log.Printf("cos: approval %s arrived with no \"approved\" field; denying", msg.RequestID)
		reason = "denied: the browser sent no decision"
	}
	if reason == "" {
		if approved {
			reason = "approved in the muxterm web chat"
		} else {
			reason = "denied in the muxterm web chat"
		}
	}
	if err := sup.Approve(msg.RequestID, approved, reason); err != nil {
		c.sendCosError("", "approval_failed", err.Error())
	}
}

// cosCancel asks the sidecar to abandon a turn. The turn is not resolved here:
// it ends when its terminal event arrives, or when one is synthesized.
//
// It deliberately does not start a sidecar: cancelling a turn on a chief of
// staff that was never launched is a no-op, not a reason to boot one.
func (c *Client) cosCancel(msg cosClientMessage) {
	relay := c.hub.cos
	if relay == nil {
		return
	}
	sup := relay.started()
	if sup == nil {
		return
	}
	if err := sup.Cancel(msg.TurnID); err != nil {
		c.sendCosError(msg.TurnID, "cancel_failed", err.Error())
	}
}

// cosClear prunes the shared conversation.
//
// EVERY PATH ANSWERS. The browser puts a confirm dialog in front of this and
// waits on the result, so silence here is a dialog that never resolves.
//
// The work runs on its own goroutine because this function is called from the
// read pump: the prune is a round trip to a python process that may still be
// booting, and blocking the pump on it would stall every terminal keystroke
// arriving on the same socket.
func (c *Client) cosClear(msg cosClientMessage) {
	if msg.OlderThanDays < 0 {
		c.sendCosClearResult(false, 0, 0, "older_than_days cannot be negative")
		return
	}
	relay := c.hub.cos
	if relay == nil {
		c.sendCosClearResult(false, 0, 0, "muxterm is not available on this server")
		return
	}
	go c.cosRunClear(relay, msg.OlderThanDays)
}

// cosRunClear performs the prune and tells everyone what survived.
func (c *Client) cosRunClear(relay *cosRelay, olderThanDays int) {
	ctx, cancel := context.WithTimeout(context.Background(), cosBootWait)
	defer cancel()

	removed, kept, err := relay.clear(ctx, olderThanDays)
	if err != nil {
		// The counts travel even on failure: a clear_partial refusal means the
		// disk WAS pruned while the live session was not, and reporting 0/0
		// there would hide the very split the sidecar refused to lie about.
		c.sendCosClearResult(false, removed, kept, err.Error())
		return
	}
	c.sendCosClearResult(true, removed, kept, "")

	// The transcript changed underneath every tab, not just this one. A fresh
	// replay is the honest reconciliation: it says exactly what survived,
	// which matters because the prune deliberately KEEPS anything referencing
	// a still-live lane, and no browser can work out that set for itself.
	turns, herr := relay.history(ctx, cosHistoryTurns)
	if herr != nil {
		// SAY SO, rather than logging where no user will look. The browser
		// drops its transcript the moment it sees ok:true and waits for this
		// replay to say what survived, so a silent return leaves an EMPTY
		// conversation that reads exactly like a total wipe -- after a prune
		// that may have kept most of it. Nothing pushes another replay until
		// the next subscribe, so this is the only chance to say the surface
		// is not the truth.
		log.Printf("cos: cleared, but the post-clear replay failed: %v", herr)
		c.sendCosError("", "history_failed", fmt.Sprintf(
			"the conversation was cleared, but what survived could not be read back (%v); reload to see it",
			herr))
		return
	}
	c.hub.broadcastCosHistory(turns, cosHistoryReasonClear)
}

// --- outbound frames -------------------------------------------------------

func (c *Client) sendCosSubscribeResult(ok bool, errMsg, sessionID string, ready bool) {
	frame := struct {
		Type      string `json:"type"`
		OK        bool   `json:"ok"`
		SessionID string `json:"session_id,omitempty"`
		Ready     bool   `json:"ready"`
		Error     string `json:"error,omitempty"`
	}{Type: cosTypeSubscribeResult, OK: ok, SessionID: sessionID, Ready: ready, Error: errMsg}
	data, err := json.Marshal(frame)
	if err != nil {
		log.Printf("cos: encode subscribe result: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("cos: subscribe result write error: %v", err)
	}
}

func (c *Client) sendCosClearResult(ok bool, removed, kept int, errMsg string) {
	frame := struct {
		Type    string `json:"type"`
		OK      bool   `json:"ok"`
		Removed int    `json:"removed"`
		Kept    int    `json:"kept"`
		Error   string `json:"error,omitempty"`
	}{Type: cosTypeClearResult, OK: ok, Removed: removed, Kept: kept, Error: errMsg}
	data, err := json.Marshal(frame)
	if err != nil {
		log.Printf("cos: encode clear result: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("cos: clear result write error: %v", err)
	}
}

// sendCosHistory writes one replay frame.
//
// The turns array is forwarded VERBATIM, for the same reason cos-event is: it
// is the sidecar's shape, and a field added to a replayed turn must reach the
// browser rather than being filtered out by a Go struct written before it
// existed.
func (c *Client) sendCosHistory(turns json.RawMessage, reason string) {
	if len(turns) == 0 {
		turns = json.RawMessage("[]")
	}
	frame := struct {
		Type   string          `json:"type"`
		Turns  json.RawMessage `json:"turns"`
		Reason string          `json:"reason,omitempty"`
	}{Type: cosTypeHistory, Turns: turns, Reason: reason}
	data, err := json.Marshal(frame)
	if err != nil {
		log.Printf("cos: encode history frame: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("cos: history write error: %v", err)
	}
}

// sendCosError reports a serve-layer failure to ONE connection, in the same
// envelope and the same shape a sidecar error arrives in, so the browser needs
// exactly one error path.
func (c *Client) sendCosError(turnID, code, message string) {
	fields := map[string]any{"ev": cos.EvError, "code": code, "message": message, "fatal": false}
	if turnID != "" {
		fields["turn_id"] = turnID
	}
	frame := cosEventFrame(cosSynthEvent(fields))
	if frame == nil {
		return
	}
	if err := c.writeText(frame); err != nil {
		log.Printf("cos: error frame write error: %v", err)
	}
}
