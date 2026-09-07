package voice

import (
	"context"
	"encoding/json"
	"errors"
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
func (f *fakeRealtime) push(t *testing.T, ev map[string]any) {
	t.Helper()
	f.connMu.Lock()
	c := f.conn
	f.connMu.Unlock()
	if c == nil {
		t.Fatal("nothing attached to the fake realtime endpoint yet")
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
	sb, err := Dial(context.Background(), f.client(t, syncTimeout), "rtc_test", "ek_fake", b, nil)
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
	if got := outputs(msgs)[0]; !strings.Contains(strings.ToLower(got), "still working") {
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
