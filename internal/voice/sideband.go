package voice

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Sideband is muxterm's second connection into the realtime session the
// browser is already holding over WebRTC.
//
// It attaches by call id -- {endpoint}/realtime?call_id=... -- which makes it
// an observer of the SAME session rather than a second conversation. Audio
// never touches it. What arrives here is function calls, and what leaves is
// their results.
//
// This is the piece that keeps tool authority out of the browser. muxterm's
// tools run shell commands; a design where the page executes them and posts
// back the answer would mean any script running in that tab inherits the
// user's terminal. So the browser is a microphone and a speaker, and every
// function call is executed here.
type Sideband struct {
	callID string
	url    string
	secret string
	bridge Bridge
	cfg    sidebandConfig

	// events is an optional observer for everything the sideband sees and
	// sends. The E2E harness subscribes to it; nothing in production
	// depends on it, and it is never a credential sink -- only event
	// types and tool names are published.
	events func(Trace)

	// endSession tears this voice session down through the manager, which
	// is the same path POST /api/cos/voice/end takes. Held as a callback
	// rather than a manager reference so the sideband stays testable and
	// knows nothing about HTTP -- see endsession.go.
	endSession func(reason string)

	conn *websocket.Conn

	mu      sync.Mutex
	closed  bool
	fenced  bool
	pending map[string]*approvalIntent

	// The spoken exit, guarded by mu. ending means a goodbye is on its way
	// out; farewellCh carries the read loop's view of that goodbye's audio
	// to the goroutine waiting to hang up.
	//
	// TWO fields, and there is deliberately no third holding a hangup that
	// has been asked about but not yet acted on. Ending is asked about once,
	// in the conversation, and the next thing that happens is this tool
	// being called -- so between the question and the answer there is no
	// pending-exit state to keep, and after a "no" there is none to leave
	// behind. See endsession.go.
	ending     bool
	farewellCh chan string

	// A realtime session runs ONE response at a time. Asking for another
	// while one is in flight is refused outright:
	//
	//   conversation_already_has_active_response: Conversation already has
	//   an active response in progress. Wait until the response is finished
	//   before creating a new one.
	//
	// That refusal is silent from the user's side and it eats the ANSWER --
	// the tool result is already in the conversation, but nothing ever asks
	// the model to speak it, so the chief of staff's reply is simply never
	// heard. It happens on the most ordinary timing there is: the model is
	// still saying "I'll go and ask" when the answer comes back.
	//
	// So a response request that arrives during an active response is HELD
	// and replayed on response.done rather than sent and lost.
	respActive  bool
	respQueued  []map[string]any
	respStarted time.Time
	// lastResponseReq is the most recent response.create, kept so it can
	// be re-sent if the vendor refuses it as concurrent.
	lastResponseReq     map[string]any
	lastResponseCreated time.Time
	retryCount          int
	eventKinds          map[string]int

	writeMu sync.Mutex
	done    chan struct{}
	wg      sync.WaitGroup
}

type sidebandConfig struct {
	syncTimeout time.Duration
}

// Trace is one observable moment in the sideband's life. Deliberately
// coarse: a type, a name, and a short detail. No arguments, no results, no
// credentials.
type Trace struct {
	At     time.Time `json:"at"`
	Kind   string    `json:"kind"`
	Name   string    `json:"name,omitempty"`
	Detail string    `json:"detail,omitempty"`
}

// Trace kinds.
const (
	TraceConnected  = "connected"
	TraceToolCall   = "tool_call"
	TraceToolResult = "tool_result"
	TraceInject     = "inject"
	TraceClosed     = "closed"
	TraceError      = "error"
	// TraceBusy is the vendor refusing a response because one is already
	// running. Recorded separately from TraceError because it is EXPECTED
	// and recovered from, not a fault.
	TraceBusy = "busy_retry"
	// TraceSaw is the first sighting of an event type on this connection.
	TraceSaw = "saw"
	// TraceReattached is a sideband that was dropped and came back.
	TraceReattached = "reattached"
	// TraceEnding is a step in the spoken exit that did NOT end the
	// session: an intent read back, a goodbye requested, an interrupted
	// goodbye abandoned.
	TraceEnding = "ending"
	// TraceEnded is the moment teardown is triggered by a spoken request.
	// It is emitted after the goodbye has been heard, so its position
	// relative to the audio events around it IS the ordering evidence.
	TraceEnded = "ended"
)

// Dial attaches a sideband to callID and starts listening.
//
// The ephemeral secret is the bearer here too, and it is the ONLY credential
// this connection ever sees: the long-lived one stays with the Client.
//
// endSession may be nil, and is the callback the spoken exit pulls to hang
// up. It is supplied HERE rather than assigned afterwards because a function
// call can arrive on the very first frame after the dial returns, and an
// end_voice_session that lands before the callback is installed would be a
// hangup with nowhere to go.
func Dial(ctx context.Context, c *Client, callID, ephemeral string, bridge Bridge, events func(Trace), endSession func(reason string)) (*Sideband, error) {
	if callID == "" {
		return nil, errors.New("voice: cannot attach a sideband without a call id")
	}
	u, err := c.WebSocketURL(callID)
	if err != nil {
		return nil, err
	}

	sb := &Sideband{
		callID:     callID,
		url:        u,
		secret:     ephemeral,
		bridge:     bridge,
		cfg:        sidebandConfig{syncTimeout: c.Config().SyncToolTimeout},
		events:     events,
		endSession: endSession,
		pending:    map[string]*approvalIntent{},
		done:       make(chan struct{}),
	}

	dialCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(dialCtx, u, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + ephemeral}},
	})
	if err != nil {
		return nil, fmt.Errorf("voice: attaching the tool sideband to call %s failed: %w", callID, err)
	}
	// A realtime event carrying a long tool result can be large; the
	// default read limit is 32 KiB and truncating an event is a silent
	// protocol break.
	conn.SetReadLimit(8 << 20)
	sb.conn = conn
	sb.emit(Trace{Kind: TraceConnected, Detail: callID})

	sb.wg.Add(1)
	go sb.listen()
	sb.wg.Add(1)
	go sb.sweep()
	return sb, nil
}

// CallID is the realtime call this sideband is attached to.
func (s *Sideband) CallID() string { return s.callID }

// Close tears the sideband down. Idempotent.
func (s *Sideband) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.mu.Unlock()

	close(s.done)
	s.writeMu.Lock()
	conn := s.conn
	s.writeMu.Unlock()
	_ = conn.Close(websocket.StatusNormalClosure, "")
	s.wg.Wait()
	s.emit(Trace{Kind: TraceClosed, Detail: s.callID})
}

func (s *Sideband) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

func (s *Sideband) emit(t Trace) {
	if s.events == nil {
		return
	}
	t.At = time.Now()
	s.events(t)
}

// listen is the read loop. It exits on Close, or on a read error -- and a
// read error is NOT the end of the sideband.
//
// The vendor hangs this connection up for reasons that have nothing to do
// with the conversation: an invalid client event, an idle observer, a
// routine restart. When that happens the browser is still talking to the
// model perfectly happily over WebRTC, and the only thing that has gone is
// muxterm's ability to run tools and speak answers -- silently. A voice
// assistant that quietly stops being able to act is worse than one that
// fails loudly, so the sideband re-attaches to the SAME call id rather than
// leaving the session half-alive.
func (s *Sideband) listen() {
	defer s.wg.Done()
	ctx := context.Background()
	for {
		typ, data, err := s.conn.Read(ctx)
		if err != nil {
			if s.isClosed() {
				return
			}
			s.emit(Trace{Kind: TraceClosed, Detail: "read: " + trimErr(err)})
			if s.reattach() {
				continue
			}
			s.mu.Lock()
			s.closed = true
			s.mu.Unlock()
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		s.handle(data)
	}
}

// reattach re-dials the same call, with a bounded backoff.
//
// Bounded because a call that has genuinely ended never comes back, and a
// sideband retrying forever against a dead call id is a background loop
// nobody asked for. Six attempts over roughly fifteen seconds covers a
// vendor blip and gives up on a real hangup.
func (s *Sideband) reattach() bool {
	for attempt := 0; attempt < 6; attempt++ {
		select {
		case <-s.done:
			return false
		case <-time.After(time.Duration(attempt+1) * 700 * time.Millisecond):
		}
		if s.isClosed() {
			return false
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		conn, _, err := websocket.Dial(ctx, s.url, &websocket.DialOptions{
			HTTPHeader: http.Header{"Authorization": []string{"Bearer " + s.secret}},
		})
		cancel()
		if err != nil {
			continue
		}
		conn.SetReadLimit(8 << 20)
		s.writeMu.Lock()
		s.conn = conn
		s.writeMu.Unlock()
		// A fresh connection is not mid-response, whatever the old one
		// believed. Leaving respActive set here would wedge every later
		// answer behind a response that no longer exists.
		s.mu.Lock()
		s.respActive = false
		s.respQueued = nil
		s.retryCount = 0
		s.mu.Unlock()
		s.emit(Trace{Kind: TraceReattached, Detail: s.callID})
		return true
	}
	return false
}

// realtimeEvent is the subset of the vendor's server events this bridge
// acts on. Everything else is ignored by design: the protocol evolves
// additively, and an unknown event must never be fatal.
type realtimeEvent struct {
	Type       string          `json:"type"`
	CallID     string          `json:"call_id"`
	ItemID     string          `json:"item_id"`
	ResponseID string          `json:"response_id"`
	Name       string          `json:"name"`
	Arguments  json.RawMessage `json:"arguments"`
	Error      json.RawMessage `json:"error"`
	Response   struct {
		ID       string            `json:"id"`
		Metadata map[string]string `json:"metadata"`
	} `json:"response"`
	Item struct {
		ID     string `json:"id"`
		Type   string `json:"type"`
		CallID string `json:"call_id"`
	} `json:"item"`
}

func (s *Sideband) handle(data []byte) {
	var ev realtimeEvent
	if err := json.Unmarshal(data, &ev); err != nil {
		return
	}
	s.seen(ev.Type)
	if scoped, ok := s.bridge.(ProviderEventBridge); ok {
		event := ProviderEvent{
			Type: ev.Type, CallID: s.callID, ItemID: ev.ItemID, ResponseID: ev.ResponseID,
			OutputID: ev.Item.ID, CallRef: ev.CallID, Metadata: ev.Response.Metadata,
		}
		if event.ResponseID == "" {
			event.ResponseID = ev.Response.ID
		}
		if event.ItemID == "" {
			event.ItemID = ev.Item.ID
		}
		if err := scoped.ObserveProviderEvent(event); err != nil {
			s.Fence("scoped provider event rejected")
			return
		}
	}
	switch {
	case ev.Type == "response.function_call_arguments.done":
		go s.dispatch(ev)
	case ev.Type == "response.created":
		s.mu.Lock()
		s.respActive = true
		s.respStarted = time.Now()
		s.lastResponseCreated = time.Now()
		s.mu.Unlock()
	case ev.Type == "output_audio_buffer.started":
		// The assistant is audibly speaking. Treated as busy even without
		// a response.created, because over-blocking costs a beat of delay
		// (the sweep and the queue recover it) while under-blocking costs
		// the whole sideband.
		s.mu.Lock()
		s.respActive = true
		s.respStarted = time.Now()
		s.lastResponseCreated = time.Now()
		s.mu.Unlock()
		s.signalFarewell(sigAudioStarted)
	case ev.Type == "output_audio_buffer.stopped":
		// The buffer drained: the user has HEARD what was in it. This is
		// the only event on this wire that describes delivery rather than
		// generation, which is why the spoken exit waits for it.
		s.signalFarewell(sigAudioStopped)
	case ev.Type == "output_audio_buffer.cleared":
		// Audio thrown away mid-play -- a barge-in, on a session whose
		// turn detection carries interrupt_response.
		s.signalFarewell(sigAudioCleared)
	case ev.Type == "response.done" || ev.Type == "response.cancelled":
		s.releaseResponse()
		s.signalFarewell(sigResponseDone)
	case strings.HasPrefix(ev.Type, "error"):
		// The one error worth acting on rather than reporting.
		//
		// The observer connection is NOT told when the browser's own audio
		// starts a response -- there is no response.created on this wire for
		// a turn the user began by speaking -- so the sideband cannot always
		// know a response is in flight. Optimism plus this retry is what
		// covers the gap: the conversation item is already in place, so a
		// later response.create still makes the model speak it.
		if bytes.Contains(ev.Error, []byte("conversation_already_has_active_response")) {
			s.emit(Trace{Kind: TraceBusy})
			s.retryLastResponse()
			return
		}
		s.emit(Trace{Kind: TraceError, Detail: snippet(ev.Error)})
		log.Printf("voice: sideband error event: %s", snippet(ev.Error))
	}
}

// seen records each event type once, so a run can be diagnosed without
// logging a conversation. Types only -- no content, ever.
func (s *Sideband) seen(t string) {
	if t == "" {
		return
	}
	s.mu.Lock()
	if s.eventKinds == nil {
		s.eventKinds = map[string]int{}
	}
	first := s.eventKinds[t] == 0
	s.eventKinds[t]++
	s.mu.Unlock()
	if first {
		s.emit(Trace{Kind: TraceSaw, Name: t})
	}
}

// retryLastResponse re-asks for a response after the active one should have
// finished.
//
// Backs off and gives up rather than looping: a response request that is
// still refused after several attempts means something else is wrong, and a
// tight retry against a vendor endpoint is worse than silence.
func (s *Sideband) retryLastResponse() {
	s.mu.Lock()
	last := s.lastResponseReq
	s.respActive = false
	attempt := s.retryCount
	s.retryCount++
	s.mu.Unlock()
	if last == nil || attempt >= 6 {
		return
	}
	go func() {
		select {
		case <-time.After(time.Duration(attempt+1) * 2 * time.Second):
		case <-s.done:
			return
		}
		s.send(last)
	}()
}

// sweep releases a response that has gone stale.
//
// A response.done that never arrives -- a dropped event, a response the
// vendor declined to start -- would otherwise leave every queued answer
// undeliverable. The read loop cannot notice that on its own because
// nothing arrives to notice.
func (s *Sideband) sweep() {
	defer s.wg.Done()
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-tick.C:
			s.mu.Lock()
			stale := s.respActive && time.Since(s.respStarted) > responseStalePeriod
			queued := len(s.respQueued) > 0
			s.mu.Unlock()
			if stale || (queued && !s.responseIsActive()) {
				s.releaseResponse()
			}
		}
	}
}

func (s *Sideband) responseIsActive() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.respActive && time.Since(s.respStarted) < responseStalePeriod
}

// releaseResponse marks the session free and replays at most one held
// request.
//
// At most ONE, and the rest are dropped: if three tool results landed during
// a long answer, asking the model to narrate all three in sequence would
// have it deliver a monologue nobody asked for. The conversation items are
// all present either way, so the model has every result in context when it
// speaks; what is coalesced is the number of times it is prompted to.
func (s *Sideband) releaseResponse() {
	s.mu.Lock()
	s.respActive = false
	var next map[string]any
	if len(s.respQueued) > 0 {
		next = s.respQueued[len(s.respQueued)-1]
		s.respQueued = nil
	}
	s.mu.Unlock()
	if next != nil {
		s.send(next)
	}
}

// responseStalePeriod is how long an "active" response is believed before it
// is treated as lost. A response.done that never arrives -- a dropped event,
// a vendor hiccup -- would otherwise wedge the queue permanently, and a
// wedged queue is silence.
//
// Comfortably longer than any spoken answer and far shorter than a person's
// patience. Erring long risks a beat of delay; erring short risks talking
// over the assistant mid-sentence, which is worse.
const responseStalePeriod = 30 * time.Second

// dispatch runs one function call and answers it.
//
// Runs on its own goroutine so a slow tool never stalls the read loop -- the
// read loop is also how a barge-in or a second call arrives, and a bridge
// that stops reading during a tool call is a bridge that cannot be
// interrupted.
func (s *Sideband) dispatch(ev realtimeEvent) {
	args := map[string]any{}
	if len(ev.Arguments) > 0 {
		var raw string
		if err := json.Unmarshal(ev.Arguments, &raw); err == nil {
			_ = json.Unmarshal([]byte(raw), &args)
		} else {
			_ = json.Unmarshal(ev.Arguments, &args)
		}
	}
	s.emit(Trace{Kind: TraceToolCall, Name: ev.Name})

	// A scoped sideband cannot infer capture or response ownership from event
	// arrival. Require the provider's IDs to be carried by its final tool-call
	// event and let the immutable scoped bridge reject unmapped values.
	if bridge, ok := s.bridge.(CorrelatedBridge); ok {
		events, scoped := s.bridge.(ProviderEventBridge)
		if !scoped {
			s.Fence("scoped bridge lacks provider event verifier")
			return
		}
		correlation, err := events.ResolveToolCall(ProviderEvent{
			Type: ev.Type, CallID: s.callID, ItemID: ev.ItemID, ResponseID: ev.ResponseID,
			OutputID: ev.Item.ID, CallRef: ev.CallID,
		})
		if err != nil {
			s.Fence("scoped tool event rejected")
			return
		}
		s.dispatchScoped(bridge, ev, args, correlation)
		return
	}

	switch ev.Name {
	case ToolAsk:
		s.runAsk(ev.CallID, str(args["request"]))
	case ToolDispatch:
		s.runDispatch(ev.CallID, str(args["request"]))
	case ToolApproval:
		s.runApproval(ev.CallID, args)
	case ToolCancel:
		s.runCancel(ev.CallID)
	case ToolEnd:
		s.runEnd(ev.CallID, args)
	default:
		s.answer(ev.CallID, fmt.Sprintf("There is no tool called %q.", ev.Name),
			"Tell the user you tried to do something you have no way to do, and ask what they want instead.")
	}
}

func (s *Sideband) dispatchScoped(bridge CorrelatedBridge, ev realtimeEvent, args map[string]any, correlation Correlation) {
	replies, ok := s.bridge.(ScopedReplyBridge)
	if !ok {
		s.Fence("scoped bridge lacks prefix-gated reply controller")
		return
	}
	if ev.Name != ToolAsk && ev.Name != ToolDispatch {
		_ = replies.QueueScopedReply(correlation, ev.CallID, "This scoped voice attachment requires explicit text controls for approval, cancellation, reset, and archive.")
		return
	}
	request := strings.TrimSpace(str(args["request"]))
	if request == "" {
		_ = replies.QueueScopedReply(correlation, ev.CallID, "No request was given.")
		return
	}
	turn, err := bridge.SubmitCorrelated(correlation, request)
	if err != nil {
		_ = replies.QueueScopedReply(correlation, ev.CallID, "The selected Mission Control conversation rejected this request: "+trimErr(err))
		return
	}
	if ev.Name == ToolDispatch {
		_ = replies.QueueScopedReply(correlation, ev.CallID, "Started in the selected Mission Control conversation.")
		go s.awaitScopedLate(bridge, correlation, turn)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.cfg.syncTimeout)
	defer cancel()
	text, err := turn.Wait(ctx)
	if err == nil {
		_ = replies.QueueScopedReply(correlation, ev.CallID, text)
		return
	}
	if errors.Is(err, context.DeadlineExceeded) {
		_ = replies.QueueScopedReply(correlation, ev.CallID, "The selected Mission Control conversation is working on this.")
		go s.awaitScopedLate(bridge, correlation, turn)
		return
	}
	_ = replies.QueueScopedReply(correlation, ev.CallID, "The selected Mission Control conversation could not complete this request: "+trimErr(err))
}

func (s *Sideband) awaitScopedLate(bridge CorrelatedBridge, correlation Correlation, turn TurnHandle) {
	text, err := turn.Wait(context.Background())
	replies, ok := bridge.(ScopedReplyBridge)
	if !ok || s.isClosed() {
		return
	}
	if err != nil {
		_ = replies.QueueScopedReply(correlation, "", "The selected Mission Control conversation stopped early: "+trimErr(err))
		return
	}
	_ = replies.QueueScopedReply(correlation, "", text)
}

// SendScopedFunctionOutput deliberately writes only the tool result item.
// ScopedReplyBridge controls every later response.create behind a prefix ACK.
func (s *Sideband) SendScopedFunctionOutput(callID, output string) bool {
	return s.write(map[string]any{"type": "conversation.item.create", "item": map[string]any{
		"type": "function_call_output", "call_id": callID, "output": output,
	}})
}

// RequestScopedResponse is called only after the attachment controller has
// observed its deterministic local-prefix acknowledgement. Metadata binds the
// provider response.created event to that exact prefix/capture request.
func (s *Sideband) RequestScopedResponse(metadata map[string]string) error {
	s.mu.Lock()
	if s.closed || s.fenced {
		s.mu.Unlock()
		return errors.New("voice: sideband is closed or fenced")
	}
	s.mu.Unlock()
	if !s.write(map[string]any{"type": "response.create", "response": map[string]any{"metadata": metadata}}) {
		return errors.New("voice: could not request scoped response")
	}
	return nil
}

// RequestDrain asks the same provider sideband to cancel its known response
// and discard queued output. Browser drain remains separately acknowledged.
func (s *Sideband) RequestDrain() {
	_ = s.write(map[string]any{"type": "response.cancel"})
	_ = s.write(map[string]any{"type": "output_audio_buffer.clear"})
}

// Fence mutes a scoped attachment after unsolicited or ambiguous provider
// events. It never routes a late event to another bridge.
func (s *Sideband) Fence(detail string) {
	s.mu.Lock()
	if s.closed || s.fenced {
		s.mu.Unlock()
		return
	}
	s.fenced = true
	s.mu.Unlock()
	s.emit(Trace{Kind: TraceError, Detail: detail})
	s.RequestDrain()
}

// runAsk is the SYNCHRONOUS path -- bounded, never blocking until done.
//
// It waits up to the configured timeout. If the turn is still running when
// that expires, the wait is abandoned (the TURN is not: it keeps running),
// the model is told it is still working so it can keep the conversation
// alive, and the answer is injected on the asynchronous path when it lands.
//
// That inversion is the whole point. The naive design -- block until
// turn_end -- is the one everybody writes first and the one that breaks: a
// realtime model expects a tool to return in seconds and a chief-of-staff
// turn can run for minutes.
func (s *Sideband) runAsk(callID, request string) {
	if strings.TrimSpace(request) == "" {
		s.answer(callID, "No request was given.", "Ask the user what they would like you to ask the chief of staff.")
		return
	}
	turn, err := s.bridge.Submit(request)
	if err != nil {
		s.answer(callID, "The chief of staff could not be reached: "+trimErr(err),
			"Tell the user the chief of staff is not reachable right now.")
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), s.cfg.syncTimeout)
	defer cancel()
	text, err := turn.Wait(ctx)
	switch {
	case err == nil:
		s.answer(callID, text, "Say this back to the user in your own words, briefly and out loud.")
	case errors.Is(err, context.DeadlineExceeded):
		s.answer(callID, "The chief of staff is working on this now. The answer will follow shortly.",
			"Say, in one short line, that it is being looked into and you will have the answer in a moment. "+
				"Do NOT call the tool again -- the answer arrives on its own. Then carry on talking to the user.")
		go s.awaitLate(turn)
	default:
		s.answer(callID, "That did not work: "+trimErr(err),
			"Tell the user it did not work, briefly.")
	}
}

// runDispatch is the ASYNCHRONOUS path: it returns immediately and speaks
// the result when it lands.
func (s *Sideband) runDispatch(callID, request string) {
	if strings.TrimSpace(request) == "" {
		s.answer(callID, "No request was given.", "Ask the user what they would like done.")
		return
	}
	turn, err := s.bridge.Submit(request)
	if err != nil {
		s.answer(callID, "The chief of staff could not be reached: "+trimErr(err),
			"Tell the user the chief of staff is not reachable right now.")
		return
	}
	s.answer(callID, "Started. You will be told when it is done.",
		"Tell the user you have set it going, in one short line, and carry on.")
	go s.awaitLate(turn)
}

// awaitLate waits for a turn that outlived its tool call and injects the
// answer as a fresh utterance.
//
// It waits indefinitely rather than on a deadline. The turn resolves exactly
// once no matter what -- including when the sidecar dies, which synthesizes
// a terminal event -- so this goroutine cannot leak on a hung turn. It exits
// early if the sideband closes underneath it.
func (s *Sideband) awaitLate(turn TurnHandle) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-s.done:
			cancel()
		case <-ctx.Done():
		}
	}()

	text, err := turn.Wait(ctx)
	if s.isClosed() {
		return
	}
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return
		}
		s.emit(Trace{Kind: TraceInject, Detail: "failed: " + trimErr(err)})
		s.inject("The chief of staff stopped early: "+trimErr(err),
			"Tell the user it stopped early, briefly.")
		return
	}
	s.emit(Trace{Kind: TraceInject, Detail: fmt.Sprintf("answer, %d chars", len(text))})
	s.inject("The chief of staff has FINISHED and this is its final answer:\n\n"+text,
		"The answer you were waiting for has arrived and is in the message above. "+
			"Say it to the user NOW, in one or two short spoken sentences. "+
			"Do NOT say you are still waiting, and do NOT call any tool.")
}

func (s *Sideband) runCancel(callID string) {
	if err := s.bridge.Cancel(""); err != nil {
		s.answer(callID, "Nothing was running, or it could not be stopped: "+trimErr(err),
			"Tell the user there was nothing to stop.")
		return
	}
	s.answer(callID, "Stopped.", "Confirm to the user that you stopped it.")
}

// answer returns a function call's result and asks for a spoken response.
//
// Two messages, in this order: the result item, then the request for a
// response. The instructions field steers what the model does with it
// without putting words in its mouth.
func (s *Sideband) answer(callID, output, instructions string) {
	s.emit(Trace{Kind: TraceToolResult, Name: callID})
	if callID != "" {
		s.send(map[string]any{
			"type": "conversation.item.create",
			"item": map[string]any{
				"type":    "function_call_output",
				"call_id": callID,
				"output":  output,
			},
		})
	}
	s.requestResponse(instructions)
}

// requestResponse asks the model to speak -- but only if it is not already
// speaking.
//
// This indirection exists because of a hard platform fact: sending
// response.create while a response is in flight is not merely refused, it
// KILLS THE OBSERVER CONNECTION. Azure answers
// conversation_already_has_active_response and then closes the socket, and a
// closed sideband means no more tools and no more answers for the rest of
// the conversation. Recovering afterwards is far worse than not tripping it.
//
// So: put the item in, wait a beat, and see whether the model starts talking
// on its own. Adding a conversation item frequently prompts a response
// without being asked; if one starts, there is nothing to ask for. Only if
// the model stays quiet is a response requested, and only when nothing else
// is running.
//
// The delay costs about a second on the path where the model would have been
// silent. That is the right trade against losing the connection.
func (s *Sideband) requestResponse(instructions string) {
	marker := time.Now()
	go func() {
		select {
		case <-time.After(responseGrace):
		case <-s.done:
			return
		}
		s.mu.Lock()
		spokeOnItsOwn := s.lastResponseCreated.After(marker)
		s.mu.Unlock()
		if spokeOnItsOwn {
			// Already answering. Asking again is the fatal case.
			return
		}
		s.send(map[string]any{
			"type":     "response.create",
			"response": map[string]any{"instructions": instructions},
		})
	}()
}

// responseGrace is how long the model is given to start speaking on its own
// after an item is added, before one is asked for.
const responseGrace = 2 * time.Second

// inject makes the model say something that answers no pending tool call.
//
// It goes in as a USER-role text item rather than a second
// function_call_output for a call id that has already been answered.
// Re-using a spent call id is the shape the reference implementation used
// and is not something the vendor documents as legal; a conversation item is
// unambiguously legal and needs no correlation to survive.
//
// If the user is mid-sentence the model will not cut across them -- it waits
// for the turn boundary, which is the behaviour you want.
func (s *Sideband) inject(text, instructions string) {
	s.send(map[string]any{
		"type": "conversation.item.create",
		"item": map[string]any{
			"type": "message",
			"role": "user",
			"content": []map[string]any{
				{"type": "input_text", "text": text},
			},
		},
	})
	s.requestResponse(instructions)
}

// Notify is the server's way in: it makes the voice session say something
// that originated outside the conversation entirely.
func (s *Sideband) Notify(text, instructions string) {
	if s.isClosed() {
		return
	}
	s.inject(text, instructions)
}

func (s *Sideband) send(msg map[string]any) {
	if s.isClosed() {
		return
	}
	if msg["type"] == "response.create" {
		s.mu.Lock()
		if s.respActive && time.Since(s.respStarted) < responseStalePeriod {
			s.respQueued = append(s.respQueued, msg)
			s.mu.Unlock()
			return
		}
		// Deliberately NOT marked active here.
		//
		// Marking optimistically closes a narrow race (two results landing
		// together, both seeing an idle session) at the cost of a much
		// worse failure: if the vendor never actually starts a response,
		// no response.done ever arrives, and every later answer sits in a
		// queue nobody drains. Silence is the failure this whole area
		// exists to prevent, so the narrow race is left to the retry on
		// conversation_already_has_active_response, which recovers, while
		// the wedge -- which does not -- is designed out.
		s.lastResponseReq = msg
		s.mu.Unlock()
	}
	_ = s.write(msg)
}

func (s *Sideband) write(msg map[string]any) bool {
	b, err := json.Marshal(msg)
	if err != nil {
		return false
	}
	// Serialized: two writers interleaving frames on one WebSocket is a
	// corrupt stream, and answer() always writes a pair that must not be
	// split.
	s.writeMu.Lock()
	conn := s.conn
	defer s.writeMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
		s.emit(Trace{Kind: TraceError, Detail: "write: " + trimErr(err)})
		return false
	}
	return true
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

// trimErr bounds an error for a spoken or logged line. Errors in this
// package are built to carry no credential.
func trimErr(err error) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}
