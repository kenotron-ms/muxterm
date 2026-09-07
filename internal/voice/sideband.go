package voice

import (
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

	conn *websocket.Conn

	mu      sync.Mutex
	closed  bool
	pending map[string]*approvalIntent

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
)

// Dial attaches a sideband to callID and starts listening.
//
// The ephemeral secret is the bearer here too, and it is the ONLY credential
// this connection ever sees: the long-lived one stays with the Client.
func Dial(ctx context.Context, c *Client, callID, ephemeral string, bridge Bridge, events func(Trace)) (*Sideband, error) {
	if callID == "" {
		return nil, errors.New("voice: cannot attach a sideband without a call id")
	}
	u, err := c.WebSocketURL(callID)
	if err != nil {
		return nil, err
	}

	sb := &Sideband{
		callID:  callID,
		url:     u,
		secret:  ephemeral,
		bridge:  bridge,
		cfg:     sidebandConfig{syncTimeout: c.Config().SyncToolTimeout},
		events:  events,
		pending: map[string]*approvalIntent{},
		done:    make(chan struct{}),
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
	_ = s.conn.Close(websocket.StatusNormalClosure, "")
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

// listen is the read loop. It exits on close, on a read error, or on the
// vendor hanging up -- and in every case it leaves the sideband marked
// closed, so an injection attempted afterwards reports a dead connection
// instead of writing into a socket nobody is reading.
func (s *Sideband) listen() {
	defer s.wg.Done()
	ctx := context.Background()
	for {
		typ, data, err := s.conn.Read(ctx)
		if err != nil {
			if !s.isClosed() {
				s.mu.Lock()
				s.closed = true
				s.mu.Unlock()
				s.emit(Trace{Kind: TraceClosed, Detail: "read: " + trimErr(err)})
			}
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		s.handle(data)
	}
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
	switch {
	case ev.Type == "response.function_call_arguments.done":
		go s.dispatch(ev)
	case strings.HasPrefix(ev.Type, "error"):
		s.emit(Trace{Kind: TraceError, Detail: snippet(ev.Error)})
		log.Printf("voice: sideband error event: %s", snippet(ev.Error))
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
	s.emit(Trace{Kind: TraceToolCall, Name: ev.Name})

	switch ev.Name {
	case ToolAsk:
		s.runAsk(ev.CallID, str(args["request"]))
	case ToolDispatch:
		s.runDispatch(ev.CallID, str(args["request"]))
	case ToolApproval:
		s.runApproval(ev.CallID, args)
	case ToolCancel:
		s.runCancel(ev.CallID)
	default:
		s.answer(ev.CallID, fmt.Sprintf("There is no tool called %q.", ev.Name),
			"Tell the user you tried to do something you have no way to do, and ask what they want instead.")
	}
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
		s.answer(callID, "Still working on it. The answer will arrive on its own shortly.",
			"Tell the user it is taking a moment and keep the conversation going. Do not ask again.")
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
		s.inject("The chief of staff stopped early: "+trimErr(err),
			"Tell the user it stopped early, briefly.")
		return
	}
	s.inject("The chief of staff has finished. Here is what came back:\n\n"+text,
		"That work you set going has finished. Tell the user the outcome now, briefly and out loud.")
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
	s.emit(Trace{Kind: TraceInject})
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
	s.send(map[string]any{
		"type":     "response.create",
		"response": map[string]any{"instructions": instructions},
	})
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
	b, err := json.Marshal(msg)
	if err != nil {
		return
	}
	// Serialized: two writers interleaving frames on one WebSocket is a
	// corrupt stream, and answer() always writes a pair that must not be
	// split.
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := s.conn.Write(ctx, websocket.MessageText, b); err != nil {
		s.emit(Trace{Kind: TraceError, Detail: "write: " + trimErr(err)})
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
