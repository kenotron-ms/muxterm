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
	// the model to speak it, so Operator's reply is simply never
	// heard. It happens on the most ordinary timing there is: the model is
	// still saying "I'll go and ask" when the answer comes back.
	//
	// So response admission is a FIFO. The current request is reserved before
	// bytes leave this process; response.done/cancelled is the only eligibility
	// transition that releases the next request. A busy refusal moves the
	// current request back to the queue and waits for that same transition.
	// There is deliberately no timer retry: time cannot prove the provider is
	// eligible, and retrying on a timer was the race that made Voice Mode look
	// like it had failed.
	respActive  bool
	respCurrent map[string]any
	respQueued  []map[string]any
	eventKinds  map[string]int

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
	sb.emit(Trace{Kind: TraceConnected})

	sb.wg.Add(1)
	go sb.listen()
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
	s.emit(Trace{Kind: TraceClosed})
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
			s.emit(Trace{Kind: TraceClosed, Detail: "sideband read failed"})
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
		// Keep response admission state across an observer reattach. The
		// Realtime call is the same call, so treating reconnect as proof
		// that it is idle would duplicate a request or reintroduce the
		// active-response race. The next response.done/cancelled is the
		// authoritative eligibility transition.
		s.emit(Trace{Kind: TraceReattached})
		return true
	}
	return false
}

// realtimeEvent is the subset of the vendor's server events this bridge
// acts on. Everything else is ignored by design: the protocol evolves
// additively, and an unknown event must never be fatal.
type realtimeEvent struct {
	Type      string          `json:"type"`
	CallID    string          `json:"call_id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
	Error     json.RawMessage `json:"error"`
}

func (s *Sideband) handle(data []byte) {
	var ev realtimeEvent
	if err := json.Unmarshal(data, &ev); err != nil {
		return
	}
	s.seen(ev.Type)
	switch {
	case ev.Type == "response.function_call_arguments.done":
		go s.dispatch(ev)
	case ev.Type == "response.created":
		s.mu.Lock()
		s.respActive = true
		s.mu.Unlock()
	case ev.Type == "output_audio_buffer.started":
		// The assistant is audibly speaking. Treated as busy even without
		// a response.created: the browser's audio turn can reach this
		// observer without its creation event. Over-blocking until the
		// terminal provider event is safe; under-blocking costs the session.
		s.mu.Lock()
		s.respActive = true
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
		// The observer is not always told when the browser's audio starts a
		// response. A busy refusal is therefore admission state, not a Voice
		// Mode fault: retain the request and wait for response completion.
		if bytes.Contains(ev.Error, []byte("conversation_already_has_active_response")) {
			s.emit(Trace{Kind: TraceBusy})
			s.holdBusyResponse()
			return
		}
		// Provider error bodies can reflect call/request identifiers or
		// credentials. Record only that one occurred, never its body.
		s.emit(Trace{Kind: TraceError, Detail: "provider event"})
		log.Printf("voice: sideband error event")
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

// holdBusyResponse converts a provider conflict into a durable admission wait.
// The rejected response.create has not created a response; its corresponding
// conversation item is already present, so replaying the same request after
// the next provider completion is correct and cannot duplicate that item.
func (s *Sideband) holdBusyResponse() {
	s.mu.Lock()
	if s.respCurrent != nil {
		s.respQueued = append([]map[string]any{s.respCurrent}, s.respQueued...)
		s.respCurrent = nil
	}
	// The error itself proves another provider response is active. Preserve
	// that fact through a reconnect and release only on response.done.
	s.respActive = true
	s.mu.Unlock()
}

// releaseResponse marks the provider eligible and dispatches exactly the next
// admitted request. It is only called from response.done/cancelled, never by a
// timer, so every request is attempted once per real eligibility transition.
func (s *Sideband) releaseResponse() {
	s.mu.Lock()
	s.respActive = false
	s.respCurrent = nil
	var next map[string]any
	if len(s.respQueued) > 0 {
		next = s.respQueued[0]
		s.respQueued = s.respQueued[1:]
		s.respActive = true
		s.respCurrent = next
	}
	s.mu.Unlock()
	if next != nil {
		s.write(next)
	}
}

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
	if ev.Name != ToolOperatorContext {
		s.emit(Trace{Kind: TraceToolCall, Name: ev.Name})
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
	case ToolOperatorContext:
		s.runOperatorConversationContext(ev.CallID, args)
	default:
		s.answer(ev.CallID, fmt.Sprintf("There is no tool called %q.", ev.Name),
			"Tell the user you tried to do something you have no way to do, and ask what they want instead.")
	}
}

// runOperatorConversationContext returns only a function-call output. It
// deliberately does not call answer/requestResponse: looking up prior context
// must not create speech, narrate, alter the COS FIFO, or race an active text
// or voice response. The realtime model uses this output within the response
// that asked for it, or waits for the next user request.
func (s *Sideband) runOperatorConversationContext(callID string, args map[string]any) {
	view := ConversationContextView(str(args["view"]))
	reader, ok := s.bridge.(ContextBridge)
	// Enforce the closed wire contract even if a malformed provider event
	// bypassed the JSON schema: exactly one enum field, never a selector.
	if !ok || len(args) != 1 || !view.Valid() {
		s.answerReadOnly(callID, unavailableOperatorConversationContext())
		return
	}
	snapshot, err := reader.ReadOperatorConversationContext(context.Background(), view)
	if err != nil {
		// Do not disclose whether any other session/conversation exists, nor
		// reflect server, provider, filesystem, or authentication errors.
		s.answerReadOnly(callID, unavailableOperatorConversationContext())
		return
	}
	data, err := json.Marshal(snapshot)
	if err != nil {
		s.answerReadOnly(callID, unavailableOperatorConversationContext())
		return
	}
	s.answerReadOnly(callID, string(data))
}

func unavailableOperatorConversationContext() string {
	return `{"kind":"prior_operator_conversation_context","notice":"Prior Operator context is unavailable. Do not infer missing history.","items":[],"current_work":[]}`
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
		s.answer(callID, "No request was given.", "Ask the user what they would like you to ask Operator.")
		return
	}
	turn, err := s.bridge.Submit(request)
	if err != nil {
		s.answer(callID, "Operator could not be reached: "+trimErr(err),
			"Tell the user Operator is not reachable right now.")
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), s.cfg.syncTimeout)
	defer cancel()
	text, err := turn.Wait(ctx)
	switch {
	case err == nil:
		s.answer(callID, text, "Say this back to the user in your own words, briefly and out loud.")
	case errors.Is(err, context.DeadlineExceeded):
		s.answer(callID, "Operator is working on this now. The answer will follow shortly.",
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
		s.answer(callID, "Operator could not be reached: "+trimErr(err),
			"Tell the user Operator is not reachable right now.")
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
		s.inject("Operator stopped early: "+trimErr(err),
			"Tell the user it stopped early, briefly.")
		return
	}
	s.emit(Trace{Kind: TraceInject, Detail: fmt.Sprintf("answer, %d chars", len(text))})
	s.inject("Operator has FINISHED and this is its final answer:\n\n"+text,
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
	// callID is provider correlation, not a user-facing tool name. Never put
	// it in the trace surface.
	s.emit(Trace{Kind: TraceToolResult})
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

// answerReadOnly returns a tool result without asking the model to speak.
// It exists for the conversation-context tool, whose lookup is observation
// only. In particular it cannot create a competing response while text work
// or a spoken reply is active.
func (s *Sideband) answerReadOnly(callID, output string) {
	if callID == "" {
		return
	}
	s.send(map[string]any{
		"type": "conversation.item.create",
		"item": map[string]any{
			"type":    "function_call_output",
			"call_id": callID,
			"output":  output,
		},
	})
}

// requestResponse admits a spoken response only when the provider has no
// active response.
//
// This indirection exists because of a hard platform fact: sending
// response.create while a response is in flight is not merely refused, it
// KILLS THE OBSERVER CONNECTION. Azure answers
// conversation_already_has_active_response and then closes the socket, and a
// closed sideband means no more tools and no more answers for the rest of
// the conversation. Recovering afterwards is far worse than not tripping it.
//
// A completion event, not elapsed time, is the admission proof. The request is
// retained in FIFO order through an active response, a busy refusal, or an
// observer reconnect; it is never spun, silently dropped, or retried on a
// clock.
func (s *Sideband) requestResponse(instructions string) {
	s.send(map[string]any{
		"type":     "response.create",
		"response": map[string]any{"instructions": instructions},
	})
}

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
		if s.respActive {
			s.respQueued = append(s.respQueued, msg)
			s.mu.Unlock()
			return
		}
		// Reserve the only provider response slot before writing. A second
		// completion or tool result that arrives while the write is in flight
		// therefore queues instead of racing another response.create.
		s.respActive = true
		s.respCurrent = msg
		s.mu.Unlock()
	}
	s.write(msg)
}

func (s *Sideband) write(msg map[string]any) {
	if s.isClosed() {
		return
	}
	b, err := json.Marshal(msg)
	if err != nil {
		return
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
		s.emit(Trace{Kind: TraceError, Detail: "sideband write failed"})
	}
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
