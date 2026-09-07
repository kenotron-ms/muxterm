package voice

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/kenotron-ms/muxterm/internal/config"
)

// ── a fake realtime endpoint ────────────────────────────────────────────────

// fakeRealtime is the vendor's realtime WebSocket, as much of it as the
// sideband talks to: it accepts an attach, records everything muxterm sends,
// and can push server events at it.
type fakeRealtime struct {
	srv *httptest.Server

	mu       sync.Mutex
	sent     []map[string]any
	authSeen string
	pathSeen string
	yieldCh  chan struct{}

	connMu sync.Mutex
	conn   *websocket.Conn
}

func newFakeRealtime(t *testing.T) *fakeRealtime {
	t.Helper()
	f := &fakeRealtime{yieldCh: make(chan struct{}, 64)}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The two HTTP legs a Manager needs before there is anything to
		// attach to: mint, then the SDP exchange whose Location header is
		// where the call id comes from. Tests that only exercise the
		// sideband never reach them.
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/realtime/client_secrets"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"value":"ek_fake","expires_at":0,"session":{"id":"sess_fake"}}`)
			return
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/realtime/calls"):
			w.Header().Set("Content-Type", "application/sdp")
			w.Header().Set("Location", "/openai/v1/realtime/calls/rtc_test")
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, "v=0\r\n")
			return
		}

		f.mu.Lock()
		f.authSeen = r.Header.Get("Authorization")
		f.pathSeen = r.URL.Path + "?" + r.URL.RawQuery
		f.mu.Unlock()

		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		f.connMu.Lock()
		f.conn = c
		f.connMu.Unlock()

		for {
			_, data, err := c.Read(r.Context())
			if err != nil {
				return
			}
			var m map[string]any
			if json.Unmarshal(data, &m) == nil {
				f.mu.Lock()
				f.sent = append(f.sent, m)
				f.mu.Unlock()
				select {
				case f.yieldCh <- struct{}{}:
				default:
				}
			}
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// push sends a server event to the attached sideband.
//
// Waits for the attach rather than asserting it: websocket.Dial returns as
// soon as the handshake completes, which can be marginally before the
// server handler has stored its side.
func (f *fakeRealtime) push(t *testing.T, ev map[string]any) {
	t.Helper()
	var c *websocket.Conn
	deadline := time.After(5 * time.Second)
	for c == nil {
		f.connMu.Lock()
		c = f.conn
		f.connMu.Unlock()
		if c != nil {
			break
		}
		select {
		case <-time.After(5 * time.Millisecond):
		case <-deadline:
			t.Fatal("nothing attached to the fake realtime endpoint")
		}
	}
	b, _ := json.Marshal(ev)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatalf("push: %v", err)
	}
}

// waitFor blocks until pred is satisfied by the messages muxterm has sent.
func (f *fakeRealtime) waitFor(t *testing.T, what string, pred func([]map[string]any) bool) []map[string]any {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		f.mu.Lock()
		got := make([]map[string]any, len(f.sent))
		copy(got, f.sent)
		f.mu.Unlock()
		if pred(got) {
			return got
		}
		select {
		case <-f.yieldCh:
		case <-time.After(20 * time.Millisecond):
		case <-deadline:
			f.mu.Lock()
			dump, _ := json.Marshal(f.sent)
			f.mu.Unlock()
			t.Fatalf("timed out waiting for %s; muxterm sent: %s", what, dump)
		}
	}
}

func (f *fakeRealtime) client(t *testing.T, syncTimeout time.Duration) *Client {
	t.Helper()
	cfg := config.VoiceConfig{
		Enabled:         true,
		Endpoint:        f.srv.URL + "/openai/v1",
		Model:           "test-realtime",
		AuthMode:        config.VoiceAuthAPIKey,
		APIKeyEnv:       "TEST_VOICE_KEY",
		SyncToolTimeout: syncTimeout,
	}
	t.Setenv("TEST_VOICE_KEY", "not-a-real-key")
	cred, err := NewCredential(cfg)
	if err != nil {
		t.Fatalf("NewCredential: %v", err)
	}
	return NewClient(cfg, cred)
}

// ── a fake chief of staff ───────────────────────────────────────────────────

type fakeBridge struct {
	mu        sync.Mutex
	submitted []string
	approvals []approvalCall
	cancels   int

	turn       *fakeTurn
	submitErr  error
	approveErr error
}

type approvalCall struct {
	requestID string
	approved  bool
}

func (b *fakeBridge) Submit(prompt string) (TurnHandle, error) {
	b.mu.Lock()
	b.submitted = append(b.submitted, prompt)
	b.mu.Unlock()
	if b.submitErr != nil {
		return nil, b.submitErr
	}
	if b.turn == nil {
		b.turn = &fakeTurn{done: make(chan struct{}), text: "done"}
		close(b.turn.done)
	}
	return b.turn, nil
}

func (b *fakeBridge) Approve(requestID string, approved bool, _ string) error {
	b.mu.Lock()
	b.approvals = append(b.approvals, approvalCall{requestID, approved})
	b.mu.Unlock()
	return b.approveErr
}

func (b *fakeBridge) Cancel(string) error {
	b.mu.Lock()
	b.cancels++
	b.mu.Unlock()
	return nil
}

func (b *fakeBridge) approvalsSeen() []approvalCall {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]approvalCall, len(b.approvals))
	copy(out, b.approvals)
	return out
}

type fakeTurn struct {
	done chan struct{}
	text string
	err  error
}

func (t *fakeTurn) ID() string { return "turn-1" }
func (t *fakeTurn) Wait(ctx context.Context) (string, error) {
	select {
	case <-t.done:
		return t.text, t.err
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// ── helpers ─────────────────────────────────────────────────────────────────

func attach(t *testing.T, f *fakeRealtime, b Bridge, syncTimeout time.Duration) *Sideband {
	t.Helper()
	sb, err := Dial(context.Background(), f.client(t, syncTimeout), "rtc_test", "ek_fake", b, nil, nil)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	t.Cleanup(sb.Close)
	return sb
}

func toolCall(name, callID string, args map[string]any) map[string]any {
	raw, _ := json.Marshal(args)
	return map[string]any{
		"type":      "response.function_call_arguments.done",
		"call_id":   callID,
		"name":      name,
		"arguments": string(raw),
	}
}

func outputs(msgs []map[string]any) []string {
	var out []string
	for _, m := range msgs {
		if m["type"] != "conversation.item.create" {
			continue
		}
		item, _ := m["item"].(map[string]any)
		if item == nil {
			continue
		}
		if s, ok := item["output"].(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// ── tests ───────────────────────────────────────────────────────────────────

// The sideband attaches by CALL ID with the ephemeral secret. It is an
// observer of the browser's session, not a second conversation.
func TestSidebandAttachesToTheCallWithTheEphemeralSecret(t *testing.T) {
	f := newFakeRealtime(t)
	attach(t, f, &fakeBridge{}, time.Second)

	deadline := time.After(3 * time.Second)
	for {
		f.mu.Lock()
		auth, path := f.authSeen, f.pathSeen
		f.mu.Unlock()
		if auth != "" {
			if auth != "Bearer ek_fake" {
				t.Fatalf("sideband presented %q; it must present the EPHEMERAL secret, never the long-lived credential", auth)
			}
			if !strings.Contains(path, "call_id=rtc_test") {
				t.Fatalf("sideband attached to %q, want a call_id query", path)
			}
			return
		}
		select {
		case <-time.After(10 * time.Millisecond):
		case <-deadline:
			t.Fatal("the sideband never attached")
		}
	}
}

// C5, synchronous path: short work returns as a direct tool result.
func TestAskReturnsTheAnswerWhenTheTurnIsQuick(t *testing.T) {
	f := newFakeRealtime(t)
	turn := &fakeTurn{done: make(chan struct{}), text: "three workspaces are open"}
	close(turn.done)
	b := &fakeBridge{turn: turn}
	attach(t, f, b, 5*time.Second)

	f.push(t, toolCall(ToolAsk, "call_1", map[string]any{"request": "how many workspaces"}))

	msgs := f.waitFor(t, "a function_call_output", func(m []map[string]any) bool {
		return len(outputs(m)) > 0
	})
	got := outputs(msgs)[0]
	if !strings.Contains(got, "three workspaces are open") {
		t.Fatalf("tool result = %q, want the chief of staff's answer", got)
	}
	if len(b.submitted) != 1 || b.submitted[0] != "how many workspaces" {
		t.Fatalf("bridge saw %v, want the request passed through verbatim", b.submitted)
	}
	// The pair, in order: the result, then the request to speak.
	f.waitFor(t, "response.create", func(m []map[string]any) bool {
		for _, x := range m {
			if x["type"] == "response.create" {
				return true
			}
		}
		return false
	})
}

// C5, the load-bearing behaviour: the synchronous path NEVER blocks until
// the turn is done. It gives up, says so, and lets the answer arrive later.
func TestAskHandsOffToTheAsyncPathRatherThanBlocking(t *testing.T) {
	f := newFakeRealtime(t)
	turn := &fakeTurn{done: make(chan struct{}), text: "the long answer"}
	b := &fakeBridge{turn: turn}
	attach(t, f, b, 60*time.Millisecond) // far shorter than the turn

	start := time.Now()
	f.push(t, toolCall(ToolAsk, "call_1", map[string]any{"request": "do something slow"}))

	msgs := f.waitFor(t, "the still-working reply", func(m []map[string]any) bool {
		return len(outputs(m)) > 0
	})
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("the synchronous tool took %v to answer; it must not block until turn_end", elapsed)
	}
	if got := outputs(msgs)[0]; !strings.Contains(strings.ToLower(got), "working on this now") {
		t.Fatalf("first reply = %q, want a still-working hand-off", got)
	}

	// The turn finishes late. Its answer must arrive as a fresh
	// utterance, NOT as a second function_call_output re-using a spent
	// call id.
	close(turn.done)
	msgs = f.waitFor(t, "the late answer", func(m []map[string]any) bool {
		for _, x := range m {
			item, _ := x["item"].(map[string]any)
			if item == nil {
				continue
			}
			if content, ok := item["content"].([]any); ok && len(content) > 0 {
				first, _ := content[0].(map[string]any)
				if s, _ := first["text"].(string); strings.Contains(s, "the long answer") {
					return true
				}
			}
		}
		return false
	})
	for _, x := range msgs {
		item, _ := x["item"].(map[string]any)
		if item == nil {
			continue
		}
		if item["type"] == "function_call_output" && item["call_id"] == "call_1" {
			if s, _ := item["output"].(string); strings.Contains(s, "the long answer") {
				t.Fatal("the late answer re-used a spent call id; it must be injected as a conversation item")
			}
		}
	}
}

// C5, asynchronous path: returns immediately, speaks the result when it lands.
func TestDispatchReturnsImmediately(t *testing.T) {
	f := newFakeRealtime(t)
	turn := &fakeTurn{done: make(chan struct{}), text: "the build passed"}
	b := &fakeBridge{turn: turn}
	attach(t, f, b, time.Hour) // a sync timeout long enough to hang the test if used

	start := time.Now()
	f.push(t, toolCall(ToolDispatch, "call_9", map[string]any{"request": "build the project"}))
	msgs := f.waitFor(t, "the immediate ack", func(m []map[string]any) bool {
		return len(outputs(m)) > 0
	})
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("dispatch took %v; it must return immediately", elapsed)
	}
	if got := outputs(msgs)[0]; !strings.Contains(strings.ToLower(got), "started") {
		t.Fatalf("dispatch ack = %q, want an immediate start acknowledgement", got)
	}

	close(turn.done)
	f.waitFor(t, "the injected result", func(m []map[string]any) bool {
		for _, x := range m {
			item, _ := x["item"].(map[string]any)
			if item == nil {
				continue
			}
			if content, ok := item["content"].([]any); ok && len(content) > 0 {
				first, _ := content[0].(map[string]any)
				if s, _ := first["text"].(string); strings.Contains(s, "the build passed") {
					return true
				}
			}
		}
		return false
	})
}

// C7, rule 1: the first call NEVER transmits, even when the model sets
// confirm true on it.
func TestApprovalNeverTransmitsOnTheFirstCall(t *testing.T) {
	for _, confirm := range []bool{false, true} {
		t.Run(map[bool]string{false: "confirm=false", true: "confirm=true"}[confirm], func(t *testing.T) {
			f := newFakeRealtime(t)
			b := &fakeBridge{}
			attach(t, f, b, time.Second)

			f.push(t, toolCall(ToolApproval, "c1", map[string]any{
				"request_id": "req-1", "decision": "approve", "confirm": confirm,
			}))
			f.waitFor(t, "the read-back reply", func(m []map[string]any) bool {
				return len(outputs(m)) > 0
			})
			if got := b.approvalsSeen(); len(got) != 0 {
				t.Fatalf("an approval was transmitted on the FIRST call (%v); the two-step gate is the whole safety property", got)
			}
		})
	}
}

// C7: a confirmed second call, naming the same decision, transmits.
func TestApprovalTransmitsOnConfirmedSecondCall(t *testing.T) {
	f := newFakeRealtime(t)
	b := &fakeBridge{}
	attach(t, f, b, time.Second)

	f.push(t, toolCall(ToolApproval, "c1", map[string]any{"request_id": "req-1", "decision": "approve", "confirm": false}))
	f.waitFor(t, "read-back", func(m []map[string]any) bool { return len(outputs(m)) >= 1 })

	f.push(t, toolCall(ToolApproval, "c2", map[string]any{"request_id": "req-1", "decision": "approve", "confirm": true}))
	deadline := time.After(3 * time.Second)
	for {
		if got := b.approvalsSeen(); len(got) == 1 {
			if got[0].requestID != "req-1" || !got[0].approved {
				t.Fatalf("transmitted %+v, want an approval of req-1", got[0])
			}
			return
		}
		select {
		case <-time.After(10 * time.Millisecond):
		case <-deadline:
			t.Fatal("a confirmed approval was never transmitted")
		}
	}
}

// C7, rule 3: confirming a DIFFERENT decision is a new answer, not a
// confirmation.
func TestApprovalRefusesAChangedDecisionOnConfirm(t *testing.T) {
	f := newFakeRealtime(t)
	b := &fakeBridge{}
	sb := attach(t, f, b, time.Second)

	f.push(t, toolCall(ToolApproval, "c1", map[string]any{"request_id": "req-1", "decision": "deny", "confirm": false}))
	f.waitFor(t, "read-back", func(m []map[string]any) bool { return len(outputs(m)) >= 1 })

	f.push(t, toolCall(ToolApproval, "c2", map[string]any{"request_id": "req-1", "decision": "approve", "confirm": true}))
	f.waitFor(t, "the refusal", func(m []map[string]any) bool { return len(outputs(m)) >= 2 })

	if got := b.approvalsSeen(); len(got) != 0 {
		t.Fatalf("a decision that CHANGED between read-back and confirmation was transmitted (%v)", got)
	}
	if sb.pendingApprovalCount() != 1 {
		t.Fatal("the new decision should be held as a fresh intent awaiting its own confirmation")
	}
}

// C7, rule 2: anything that is not a clear approval is a denial.
func TestUnrecognizedAnswersDenyByDefault(t *testing.T) {
	deny := []string{"", "maybe", "what", "no", "nope", "stop", "hold on", "approve it later", "unclear"}
	for _, word := range deny {
		if got := normalizeDecision(word); got != "deny" {
			t.Fatalf("normalizeDecision(%q) = %q; an answer that is not confidently an approval must deny", word, got)
		}
	}
	for _, word := range []string{"approve", "Approve", " yes ", "OK", "go ahead"} {
		if got := normalizeDecision(word); got != "approve" {
			t.Fatalf("normalizeDecision(%q) = %q, want approve", word, got)
		}
	}
}

// A failed send must not be reported as an approval: the sidecar does not
// have the decision and will time the request out to DENIED.
func TestApprovalReportsAFailedSendHonestly(t *testing.T) {
	f := newFakeRealtime(t)
	b := &fakeBridge{approveErr: errors.New("socket is dead")}
	attach(t, f, b, time.Second)

	f.push(t, toolCall(ToolApproval, "c1", map[string]any{"request_id": "req-1", "decision": "approve", "confirm": false}))
	f.waitFor(t, "read-back", func(m []map[string]any) bool { return len(outputs(m)) >= 1 })
	f.push(t, toolCall(ToolApproval, "c2", map[string]any{"request_id": "req-1", "decision": "approve", "confirm": true}))

	msgs := f.waitFor(t, "the failure reply", func(m []map[string]any) bool { return len(outputs(m)) >= 2 })
	last := outputs(msgs)[len(outputs(msgs))-1]
	if !strings.Contains(strings.ToLower(last), "denied") && !strings.Contains(strings.ToLower(last), "not") {
		t.Fatalf("a failed send reported %q; it must not read as a successful approval", last)
	}
}

// An unknown tool is answered, not ignored: an unanswered function call
// leaves the model waiting forever.
func TestUnknownToolIsAnswered(t *testing.T) {
	f := newFakeRealtime(t)
	attach(t, f, &fakeBridge{}, time.Second)
	f.push(t, toolCall("rm_minus_rf", "c1", map[string]any{}))
	msgs := f.waitFor(t, "a reply", func(m []map[string]any) bool { return len(outputs(m)) > 0 })
	if got := outputs(msgs)[0]; !strings.Contains(got, "rm_minus_rf") {
		t.Fatalf("unknown-tool reply = %q, want it to name the tool", got)
	}
}

// The sideband's WebSocket URL derives from the configured endpoint. An
// https endpoint must produce wss, never a silent downgrade.
func TestWebSocketURLDerivation(t *testing.T) {
	cfg := config.VoiceConfig{
		Enabled: true, Endpoint: "https://example.openai.azure.com/openai/v1",
		Model: "m", AuthMode: config.VoiceAuthEntra,
	}
	c := NewClient(cfg, &envCredential{env: "NOPE"})
	got, err := c.WebSocketURL("rtc_abc")
	if err != nil {
		t.Fatalf("WebSocketURL: %v", err)
	}
	want := "wss://example.openai.azure.com/openai/v1/realtime?call_id=rtc_abc"
	if got != want {
		t.Fatalf("WebSocketURL = %q, want %q", got, want)
	}
}

// A realtime session runs one response at a time. A second request during an
// active response is refused outright with
// conversation_already_has_active_response -- and that refusal EATS THE
// ANSWER: the tool result sits in the conversation with nothing ever asking
// the model to speak it. This is the most ordinary timing there is (the
// model is still saying "I'll go and ask" when the answer lands), so the
// request has to be held and replayed rather than sent and lost.
func TestResponseRequestIsHeldWhileAResponseIsActive(t *testing.T) {
	f := newFakeRealtime(t)
	turn := &fakeTurn{done: make(chan struct{}), text: "the answer"}
	b := &fakeBridge{turn: turn}
	attach(t, f, b, 40*time.Millisecond)

	// The model starts speaking.
	f.push(t, map[string]any{"type": "response.created", "response": map[string]any{"id": "resp_1"}})
	time.Sleep(50 * time.Millisecond)

	// A tool call lands and its answer comes back mid-utterance.
	f.push(t, toolCall(ToolAsk, "call_1", map[string]any{"request": "something"}))
	f.waitFor(t, "the tool result item", func(m []map[string]any) bool { return len(outputs(m)) > 0 })

	countCreates := func(m []map[string]any) int {
		n := 0
		for _, x := range m {
			if x["type"] == "response.create" {
				n++
			}
		}
		return n
	}
	f.mu.Lock()
	got := countCreates(f.sent)
	f.mu.Unlock()
	if got != 0 {
		t.Fatalf("%d response.create sent while a response was active; the vendor refuses those and the answer is lost", got)
	}

	// The utterance ends. The held request goes out now.
	f.push(t, map[string]any{"type": "response.done"})
	f.waitFor(t, "the replayed response.create", func(m []map[string]any) bool {
		return countCreates(m) >= 1
	})
}

// A response.done that never arrives must not wedge the queue permanently:
// a wedged queue is silence, which is the failure this whole area exists to
// prevent.
func TestAStaleActiveResponseDoesNotWedgeTheQueue(t *testing.T) {
	f := newFakeRealtime(t)
	sb := attach(t, f, &fakeBridge{}, time.Second)

	sb.mu.Lock()
	sb.respActive = true
	sb.respStarted = time.Now().Add(-2 * responseStalePeriod)
	sb.mu.Unlock()

	sb.send(map[string]any{"type": "response.create", "response": map[string]any{}})
	f.waitFor(t, "the response.create to go out anyway", func(m []map[string]any) bool {
		for _, x := range m {
			if x["type"] == "response.create" {
				return true
			}
		}
		return false
	})
}

// ── the spoken exit ─────────────────────────────────────────────────────────
//
// These drive the sideband with synthetic realtime events, exactly as the
// tests next door do. What they are proving is not that a function was
// called: it is that a live session survives the calls that must NOT end it,
// and that the one call which does end it ends it AFTER the goodbye has been
// delivered rather than merely requested.

// endWatch records the teardown the sideband asks for, and every trace it
// emits, with timestamps -- because the ordering is the claim.
type endWatch struct {
	mu     sync.Mutex
	traces []Trace
	ended  []string
	endAt  []time.Time
	sb     *Sideband
}

func (w *endWatch) trace(t Trace) {
	w.mu.Lock()
	w.traces = append(w.traces, t)
	w.mu.Unlock()
}

// end stands in for the Manager's teardown, and closes the sideband exactly
// as the real one does.
func (w *endWatch) end(reason string) {
	w.mu.Lock()
	w.ended = append(w.ended, reason)
	w.endAt = append(w.endAt, time.Now())
	sb := w.sb
	w.mu.Unlock()
	if sb != nil {
		sb.Close()
	}
}

func (w *endWatch) endCount() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.ended)
}

func (w *endWatch) firstEndAt() (time.Time, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.endAt) == 0 {
		return time.Time{}, false
	}
	return w.endAt[0], true
}

// waitTrace blocks until a trace of kind whose detail contains want shows up.
func (w *endWatch) waitTrace(t *testing.T, kind, want string) Trace {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		w.mu.Lock()
		for _, tr := range w.traces {
			if tr.Kind == kind && strings.Contains(tr.Detail, want) {
				w.mu.Unlock()
				return tr
			}
		}
		dump := make([]Trace, len(w.traces))
		copy(dump, w.traces)
		w.mu.Unlock()
		select {
		case <-time.After(10 * time.Millisecond):
		case <-deadline:
			t.Fatalf("timed out waiting for a %q trace containing %q; saw %v", kind, want, dump)
		}
	}
}

// attachEnding is attach() plus the two hooks the spoken exit needs: a trace
// sink and a teardown.
func attachEnding(t *testing.T, f *fakeRealtime, b Bridge) (*Sideband, *endWatch) {
	t.Helper()
	w := &endWatch{}
	sb, err := Dial(context.Background(), f.client(t, time.Second), "rtc_test", "ek_fake", b, w.trace, w.end)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	w.mu.Lock()
	w.sb = sb
	w.mu.Unlock()
	t.Cleanup(sb.Close)
	return sb, w
}

func endCall(callID string, args map[string]any) map[string]any {
	return toolCall(ToolEnd, callID, args)
}

// C1: the tool surface is five tools, and the fifth is the one that hangs up.
func TestToolSurfaceCarriesTheSpokenExit(t *testing.T) {
	defs := ToolDefinitions()
	if len(defs) != 5 {
		t.Fatalf("ToolDefinitions() returned %d tools, want 5", len(defs))
	}
	last := defs[4]
	if last["name"] != ToolEnd {
		t.Fatalf("fifth tool is %v, want %s", last["name"], ToolEnd)
	}
	params, _ := last["parameters"].(map[string]any)
	props, _ := params["properties"].(map[string]any)
	if _, ok := props["confirm"]; !ok {
		t.Fatal("end_voice_session has no confirm parameter; the two-step gate has nothing to read")
	}
	if _, ok := props["farewell"]; !ok {
		t.Fatal("end_voice_session has no farewell parameter")
	}
	req, _ := params["required"].([]string)
	if len(req) != 1 || req[0] != "confirm" {
		t.Fatalf("required = %v, want [confirm] only -- a farewell the model omits must not fail the call", req)
	}
	if params["additionalProperties"] != false {
		t.Fatal("end_voice_session accepts additional properties")
	}
}

// C2, the gate: a FIRST call with confirm true is refused. Not dropped --
// refused, as a function call output the model can act on -- and the session
// is still live afterwards.
func TestEndRefusesAFirstCallWithConfirmTrue(t *testing.T) {
	f := newFakeRealtime(t)
	sb, w := attachEnding(t, f, &fakeBridge{})

	f.push(t, endCall("call_end_1", map[string]any{"confirm": true, "farewell": "bye"}))

	msgs := f.waitFor(t, "the refusal", func(m []map[string]any) bool { return len(outputs(m)) > 0 })
	got := outputs(msgs)[0]
	if !strings.Contains(strings.ToLower(got), "nothing was ended") {
		t.Fatalf("refusal = %q, want it to say plainly that nothing was ended", got)
	}
	// The way back is named in the response instructions, exactly as
	// approvals.go names answer_approval: the output says what happened,
	// the instructions say what to do next.
	f.waitFor(t, "the read-back instruction", func(m []map[string]any) bool {
		for _, x := range m {
			if x["type"] != "response.create" {
				continue
			}
			r, _ := x["response"].(map[string]any)
			if strings.Contains(str(r["instructions"]), ToolEnd) {
				return true
			}
		}
		return false
	})

	// The refusal is a function_call_output correlated to the call, which
	// is what makes it something the model can act on rather than a
	// silence it has to guess about.
	var sawOutput bool
	for _, m := range msgs {
		if m["type"] != "conversation.item.create" {
			continue
		}
		item, _ := m["item"].(map[string]any)
		if item["type"] == "function_call_output" && item["call_id"] == "call_end_1" {
			sawOutput = true
		}
	}
	if !sawOutput {
		t.Fatal("the refusal did not come back as a function_call_output for the call")
	}

	// Still live: not ending, not torn down, and still able to run a tool.
	if sb.isEnding() {
		t.Fatal("a first call with confirm true put the session into ending; it must refuse instead")
	}
	if w.endCount() != 0 {
		t.Fatalf("teardown ran %d times on a first call; want 0", w.endCount())
	}
	if !sb.hasEndIntent() {
		t.Fatal("no intent was recorded, so the confirmation step has nothing to confirm")
	}
	if sb.isClosed() {
		t.Fatal("the sideband closed on a first call")
	}

	// And it can still run one, which is the real claim: the refusal cost
	// the user a beat of confirmation, not their session.
	f.push(t, toolCall(ToolCancel, "call_still_alive", nil))
	f.waitFor(t, "a tool still running after the refusal", func(m []map[string]any) bool {
		for _, o := range outputs(m) {
			if strings.Contains(o, "Stopped.") {
				return true
			}
		}
		return false
	})
}

// C2: a second call that is not a confirmation ends nothing either.
func TestEndDoesNotHangUpWithoutAConfirmation(t *testing.T) {
	f := newFakeRealtime(t)
	sb, w := attachEnding(t, f, &fakeBridge{})

	f.push(t, endCall("call_end_1", map[string]any{"confirm": false}))
	f.waitFor(t, "the read-back", func(m []map[string]any) bool { return len(outputs(m)) > 0 })

	f.push(t, endCall("call_end_2", map[string]any{"confirm": false}))
	f.waitFor(t, "the second read-back", func(m []map[string]any) bool { return len(outputs(m)) > 1 })

	if sb.isEnding() || w.endCount() != 0 {
		t.Fatal("two unconfirmed calls ended the session")
	}
}

// C3, the ordering, which is the whole point: a CONFIRMED call does not tear
// the session down when it returns. It says goodbye, and teardown happens
// only once the audio for that goodbye has finished reaching the user.
func TestConfirmedEndWaitsForTheGoodbyeToBeHeard(t *testing.T) {
	f := newFakeRealtime(t)
	sb, w := attachEnding(t, f, &fakeBridge{})

	f.push(t, endCall("call_end_1", map[string]any{"confirm": false}))
	w.waitTrace(t, TraceEnding, "intent recorded")

	f.push(t, endCall("call_end_2", map[string]any{"confirm": true, "farewell": "Talk to you later."}))
	w.waitTrace(t, TraceEnding, "confirmed; farewell requested")

	// The confirmed call has RETURNED. If teardown happened here the
	// goodbye would be cut off before a word of it was generated.
	if w.endCount() != 0 {
		t.Fatal("the session was torn down when the confirmed call returned, before any goodbye could be spoken")
	}

	// The model is asked to speak the farewell it supplied.
	msgs := f.waitFor(t, "the farewell instruction", func(m []map[string]any) bool {
		for _, x := range m {
			if x["type"] != "response.create" {
				continue
			}
			r, _ := x["response"].(map[string]any)
			if strings.Contains(str(r["instructions"]), "Talk to you later.") {
				return true
			}
		}
		return false
	})
	_ = msgs

	// Audio starts. Still not torn down: the user is mid-goodbye.
	f.push(t, map[string]any{"type": "output_audio_buffer.started"})
	time.Sleep(250 * time.Millisecond)
	if w.endCount() != 0 {
		t.Fatal("the session was torn down while the goodbye was still playing")
	}
	if !sb.isEnding() {
		t.Fatal("the session is not marked as ending while the goodbye plays")
	}

	// The buffer drains -- the user has HEARD it. Only now does the line
	// drop.
	stoppedAt := time.Now()
	f.push(t, map[string]any{"type": "output_audio_buffer.stopped"})

	deadline := time.After(5 * time.Second)
	for w.endCount() == 0 {
		select {
		case <-time.After(10 * time.Millisecond):
		case <-deadline:
			t.Fatal("the session never ended after the goodbye finished playing")
		}
	}
	endedAt, ok := w.firstEndAt()
	if !ok {
		t.Fatal("no teardown timestamp")
	}
	if endedAt.Before(stoppedAt) {
		t.Fatalf("teardown at %v preceded the end of the goodbye audio at %v", endedAt, stoppedAt)
	}

	// And the trace ring says the same story in order, which is what the
	// evidence for this component is read from.
	tr := w.waitTrace(t, TraceEnded, "heard in full")
	confirmed := w.waitTrace(t, TraceEnding, "confirmed; farewell requested")
	if !tr.At.After(confirmed.At) {
		t.Fatalf("the ended trace (%v) does not follow the confirmed trace (%v)", tr.At, confirmed.At)
	}
}

// C3, the conservative half: a goodbye the user talks over is not a goodbye.
// The ending is abandoned and the conversation stays open.
func TestAnInterruptedGoodbyeLeavesTheSessionOpen(t *testing.T) {
	f := newFakeRealtime(t)
	sb, w := attachEnding(t, f, &fakeBridge{})

	f.push(t, endCall("call_end_1", map[string]any{"confirm": false}))
	w.waitTrace(t, TraceEnding, "intent recorded")
	f.push(t, endCall("call_end_2", map[string]any{"confirm": true}))
	w.waitTrace(t, TraceEnding, "confirmed; farewell requested")

	f.push(t, map[string]any{"type": "output_audio_buffer.started"})
	f.push(t, map[string]any{"type": "output_audio_buffer.cleared"})

	w.waitTrace(t, TraceEnding, "aborted")
	if w.endCount() != 0 {
		t.Fatal("a goodbye the user interrupted still ended the session")
	}
	if sb.isEnding() {
		t.Fatal("the session is still marked as ending after an interrupted goodbye")
	}
	if sb.hasEndIntent() {
		t.Fatal("an interrupted goodbye left a confirmable intent behind; it must start again from the top")
	}
	if sb.isClosed() {
		t.Fatal("the sideband closed on an interrupted goodbye")
	}
}

// C3: audio that was already in flight when the user confirmed is not the
// goodbye, and its ending must not be read as the goodbye's.
func TestAudioFinishingFromBeforeTheConfirmationDoesNotHangUp(t *testing.T) {
	f := newFakeRealtime(t)
	_, w := attachEnding(t, f, &fakeBridge{})

	f.push(t, endCall("call_end_1", map[string]any{"confirm": false}))
	w.waitTrace(t, TraceEnding, "intent recorded")
	f.push(t, endCall("call_end_2", map[string]any{"confirm": true}))
	w.waitTrace(t, TraceEnding, "confirmed; farewell requested")

	// The read-back the user just said yes to, finishing now.
	f.push(t, map[string]any{"type": "output_audio_buffer.stopped"})
	time.Sleep(300 * time.Millisecond)
	if w.endCount() != 0 {
		t.Fatal("a buffer that stopped before the goodbye ever started was treated as the goodbye")
	}
}

// C4: a confirmed exit tears the session down through the MANAGER -- the same
// End the browser's POST reaches -- and the browser is told.
func TestConfirmedEndRemovesTheSessionFromTheManagerAndTellsTheBrowser(t *testing.T) {
	f := newFakeRealtime(t)

	cfg := config.VoiceConfig{
		Enabled:         true,
		Endpoint:        f.srv.URL + "/openai/v1",
		Model:           "test-realtime",
		AuthMode:        config.VoiceAuthAPIKey,
		APIKeyEnv:       "TEST_VOICE_KEY",
		SyncToolTimeout: time.Second,
	}
	t.Setenv("TEST_VOICE_KEY", "not-a-real-key")

	mgr, err := NewManager(cfg, &fakeBridge{})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	t.Cleanup(mgr.Close)

	var (
		toldMu sync.Mutex
		told   []string
	)
	mgr.SetOnEnded(func(sessionID, reason string) {
		toldMu.Lock()
		told = append(told, sessionID+" "+reason)
		toldMu.Unlock()
	})

	eph, err := mgr.Mint(context.Background())
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if _, err := mgr.Connect(context.Background(), eph.SessionID, "v=0\r\n"); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if mgr.Live() == nil {
		t.Fatal("no live session after Connect")
	}

	f.push(t, endCall("call_end_1", map[string]any{"confirm": false}))
	waitUntil(t, "the read-back", func() bool { return len(outputsOf(f)) > 0 })
	f.push(t, endCall("call_end_2", map[string]any{"confirm": true, "farewell": "Bye."}))
	waitUntil(t, "the farewell request", func() bool { return len(outputsOf(f)) > 1 })

	f.push(t, map[string]any{"type": "output_audio_buffer.started"})
	f.push(t, map[string]any{"type": "output_audio_buffer.stopped"})

	waitUntil(t, "the manager to drop the session", func() bool { return mgr.Live() == nil })

	toldMu.Lock()
	defer toldMu.Unlock()
	if len(told) != 1 {
		t.Fatalf("the browser was told %d times, want exactly once: %v", len(told), told)
	}
	if !strings.HasPrefix(told[0], eph.SessionID+" ") {
		t.Fatalf("the browser was told about %q, want session %q", told[0], eph.SessionID)
	}
	if !strings.Contains(told[0], "spoken") {
		t.Fatalf("the reason was %q, want it to say the session ended by spoken request", told[0])
	}

	// Idempotent: the browser's own POST for a session that has already
	// gone must not announce a second ending.
	mgr.End(eph.SessionID)
	if len(told) != 1 {
		t.Fatalf("a redundant End announced a second ending: %v", told)
	}
}

// C6: adding a fifth tool did not perturb the four. The four definitions are
// pinned here as JSON, so a future edit to any of them fails this test rather
// than quietly changing the model's contract.
func TestTheFourExistingToolsAreUnchanged(t *testing.T) {
	defs := ToolDefinitions()
	if len(defs) < 4 {
		t.Fatalf("ToolDefinitions() returned %d tools", len(defs))
	}
	got, err := json.Marshal(defs[:4])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(got) != fourToolsGolden {
		t.Fatalf("the four existing tool definitions changed.\n got: %s\nwant: %s", got, fourToolsGolden)
	}
}

// ── helpers ────────────────────────────────────────────────────────────────

func waitUntil(t *testing.T, what string, pred func() bool) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		if pred() {
			return
		}
		select {
		case <-time.After(10 * time.Millisecond):
		case <-deadline:
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

func outputsOf(f *fakeRealtime) []string {
	f.mu.Lock()
	got := make([]map[string]any, len(f.sent))
	copy(got, f.sent)
	f.mu.Unlock()
	return outputs(got)
}

// The four tools that existed before the spoken exit was added, pinned as
// JSON.
//
// C6's proof, and a guard rather than a decoration: adding a fifth tool must
// not perturb the four, and neither must the sixth. If a name, a description,
// a parameter or a required list here ever changes, this constant stops
// matching and the test next door says so -- which is what you want from a
// contract the model has already been taught.
//
// Generated from ToolDefinitions()[:4]; json.Marshal sorts map keys, so the
// encoding is stable.
const fourToolsGolden = `[{"description":"Ask the chief of staff something and wait for the answer. For short questions and quick lookups only. If it takes longer than a few seconds you will be told it is still working and the answer will arrive later on its own -- so keep talking to the user.","name":"ask_chief_of_staff","parameters":{"additionalProperties":false,"properties":{"request":{"description":"What to ask the chief of staff, in plain language, as the user asked it.","type":"string"}},"required":["request"],"type":"object"},"type":"function"},{"description":"Give the chief of staff a piece of real work and return IMMEDIATELY. Use this for anything that will take more than a few seconds: building, editing files, searching a repository, running commands. You will be told the moment it finishes, and you should keep the conversation going in the meantime.","name":"dispatch_chief_of_staff","parameters":{"additionalProperties":false,"properties":{"request":{"description":"The work to do, in plain language, as the user asked for it.","type":"string"}},"required":["request"],"type":"object"},"type":"function"},{"description":"Answer a pending approval request from the chief of staff. Call it TWICE: first with confirm false to have the decision read back to the user, then -- only after they confirm out loud -- with confirm true. A first call with confirm true is refused.","name":"answer_approval","parameters":{"additionalProperties":false,"properties":{"confirm":{"description":"False on the first call. True only after the user has confirmed the decision you read back to them.","type":"boolean"},"decision":{"description":"What the user decided. Use deny if you are not sure.","enum":["approve","deny"],"type":"string"},"request_id":{"description":"The id of the approval request you were told about.","type":"string"}},"required":["request_id","decision","confirm"],"type":"object"},"type":"function"},{"description":"Stop whatever the chief of staff is currently doing. Use it when the user says stop, cancel, or never mind.","name":"cancel_chief_of_staff","parameters":{"additionalProperties":false,"properties":{},"type":"object"},"type":"function"}]`
