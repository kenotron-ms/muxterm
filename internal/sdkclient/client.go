// Package sdkclient drives a coding-agent harness through its own SDK protocol
// instead of through a terminal.
//
// WHY THIS EXISTS. Every session muxterm has ever run is a process on the far
// end of a PTY (internal/sessiond/pane.go: exec.Command then pty.StartWithSize).
// Everything the daemon knows about such a session is either INFERRED from the
// bytes coming back -- foreground process group, OSC 133 marks, screen text --
// or DECLARED out of band by a hook the harness was configured to call
// (docs/session-state-protocol.md). Neither is the harness telling muxterm what
// happened; both are muxterm guessing well.
//
// The Codex app server publishes the thing that was missing: a JSON-RPC
// protocol in which starting a thread RETURNS a thread, starting a turn RETURNS
// a turn, and turn boundaries ARRIVE as `turn/started` and `turn/completed`
// notifications. A client that speaks it does not have to infer anything.
//
// SCOPE. This package speaks exactly the four requests and three notifications
// the first SDK-backed slice needs. It is deliberately not a generated binding
// for the whole protocol -- `codex app-server generate-json-schema` emits 275
// schema files, and pulling all of them in to start one thread would be a
// dependency, not a slice. The methods below are the stable, documented core of
// the v2 surface; anything else a later slice wants is additive.
//
// This package MUST NOT import internal/sessiond: sessiond imports this one.
package sdkclient

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"sync"
	"time"
)

// Protocol method names, verbatim from the app server's own generated schema
// (codex app-server generate-json-schema, ClientRequest.json / ServerNotification.json).
const (
	MethodInitialize  = "initialize"
	MethodThreadStart = "thread/start"
	MethodTurnStart   = "turn/start"

	NotifyThreadStarted = "thread/started"
	NotifyTurnStarted   = "turn/started"
	NotifyTurnCompleted = "turn/completed"
	NotifyItemCompleted = "item/completed"
)

// Thread is the harness's own session object, as returned by thread/start.
//
// ID is what makes an SDK-backed session addressable across a daemon restart:
// it is minted by the harness, persisted by the harness, and resumable by the
// harness. A PTY-backed session has no equivalent -- its identity is a pid,
// which the kernel reuses.
type Thread struct {
	ID         string `json:"id"`
	SessionID  string `json:"sessionId"`
	Cwd        string `json:"cwd"`
	CreatedAt  int64  `json:"createdAt"`
	CLIVersion string `json:"cliVersion"`
	Model      string `json:"model"`
}

// Turn is the RECEIPT. It is returned synchronously by turn/start, and it is
// the difference between this path and the PTY one: muxterm holds a
// harness-minted turn id and a declared status before the model has produced a
// single token. Writing a prompt into a terminal yields no such object -- there
// is nothing to hold, which is exactly why the existing managed-dispatch path
// has to record its outcome as "uncertain" (cmd/muxterm/session_send_cmd.go).
//
// Status is the harness's own vocabulary ("inProgress", "completed",
// "failed"), deliberately not translated here. Mapping it onto muxterm's
// lifecycle states is the caller's job, and doing it in one place keeps this
// package a transport.
type Turn struct {
	ID          string   `json:"id"`
	Status      string   `json:"status"`
	StartedAt   *int64   `json:"startedAt"`
	CompletedAt *int64   `json:"completedAt"`
	DurationMs  *int64   `json:"durationMs"`
	Error       *TurnErr `json:"error"`
}

// TurnErr is populated only when a Turn's status is failed.
type TurnErr struct {
	Message string `json:"message"`
}

// Notification is one server -> client push, already decoded far enough to
// route. Raw is kept so a caller can read fields this package does not model
// without this package having to grow a type for every one of them.
type Notification struct {
	Method   string
	ThreadID string
	Turn     *Turn
	Raw      json.RawMessage
}

// Client is one live connection to a `codex app-server --stdio` process.
//
// One process per client, deliberately. The app server also supports a shared
// daemon (`codex app-server daemon`, `--listen unix://`), and a later slice may
// want it so sessions outlive muxterm itself. It is not used here because a
// shared daemon makes the ownership question -- who is allowed to end this
// session -- a cross-process negotiation, and that is a different slice from
// proving the protocol works.
type Client struct {
	cmd     *exec.Cmd
	stdin   *json.Encoder
	stdout  *bufio.Scanner
	mu      sync.Mutex
	nextID  int
	pending map[int]chan *rpcResponse
	onNotif func(Notification)
	closed  bool
	stderr  *boundedBuffer
}

type rpcResponse struct {
	Result json.RawMessage
	Err    *rpcError
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type wireMessage struct {
	ID     *int            `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *rpcError       `json:"error,omitempty"`
}

// Start launches the app server and completes the initialize handshake.
//
// bin is the codex executable to run; the caller resolves it (exec.LookPath) so
// a missing harness is reported as a missing harness rather than as a protocol
// failure.
func Start(ctx context.Context, bin, clientName, clientVersion string, onNotif func(Notification)) (*Client, error) {
	cmd := exec.Command(bin, "app-server", "--stdio")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("app server stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("app server stdout: %w", err)
	}
	// Captured and bounded rather than discarded: when the handshake fails,
	// the harness's own complaint on stderr is the only useful diagnosis, and
	// an unbounded pipe nobody drains deadlocks the child once the OS buffer
	// fills.
	errBuf := &boundedBuffer{limit: 8192}
	cmd.Stderr = errBuf
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start app server: %w", err)
	}
	scanner := bufio.NewScanner(stdout)
	// Protocol frames carry whole turns, which are far larger than bufio's
	// 64KiB default. A frame over this ceiling ends the read loop loudly
	// instead of being silently truncated into unparseable JSON.
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	c := &Client{
		cmd:     cmd,
		stdin:   json.NewEncoder(stdin),
		stdout:  scanner,
		pending: make(map[int]chan *rpcResponse),
		onNotif: onNotif,
		stderr:  errBuf,
	}
	go c.readLoop()

	var initRes json.RawMessage
	if err := c.call(ctx, MethodInitialize, map[string]any{
		"clientInfo": map[string]string{"name": clientName, "version": clientVersion},
	}, &initRes); err != nil {
		c.Close()
		return nil, fmt.Errorf("initialize: %w (harness stderr: %s)", err, errBuf.String())
	}
	return c, nil
}

// readLoop demultiplexes responses from notifications until the pipe closes.
func (c *Client) readLoop() {
	for c.stdout.Scan() {
		line := c.stdout.Bytes()
		if len(line) == 0 {
			continue
		}
		var msg wireMessage
		if err := json.Unmarshal(line, &msg); err != nil {
			continue
		}
		if msg.ID != nil && msg.Method == "" {
			c.mu.Lock()
			ch, ok := c.pending[*msg.ID]
			delete(c.pending, *msg.ID)
			c.mu.Unlock()
			if ok {
				ch <- &rpcResponse{Result: msg.Result, Err: msg.Error}
			}
			continue
		}
		if msg.Method == "" || c.onNotif == nil {
			continue
		}
		n := Notification{Method: msg.Method, Raw: msg.Params}
		var envelope struct {
			ThreadID string `json:"threadId"`
			Turn     *Turn  `json:"turn"`
		}
		if err := json.Unmarshal(msg.Params, &envelope); err == nil {
			n.ThreadID, n.Turn = envelope.ThreadID, envelope.Turn
		}
		c.onNotif(n)
	}
	// The pipe is gone: fail every caller still waiting rather than leaving
	// them blocked on a response that can no longer arrive.
	c.mu.Lock()
	c.closed = true
	for id, ch := range c.pending {
		ch <- &rpcResponse{Err: &rpcError{Message: "app server closed the connection"}}
		delete(c.pending, id)
	}
	c.mu.Unlock()
}

// call issues one JSON-RPC request and decodes its result into out.
func (c *Client) call(ctx context.Context, method string, params any, out any) error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return errors.New("app server is closed")
	}
	c.nextID++
	id := c.nextID
	ch := make(chan *rpcResponse, 1)
	c.pending[id] = ch
	raw, err := json.Marshal(params)
	if err != nil {
		delete(c.pending, id)
		c.mu.Unlock()
		return err
	}
	err = c.stdin.Encode(wireMessage{ID: &id, Method: method, Params: raw})
	c.mu.Unlock()
	if err != nil {
		return fmt.Errorf("write %s: %w", method, err)
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case res := <-ch:
		if res.Err != nil {
			return fmt.Errorf("%s: %s", method, res.Err.Message)
		}
		if out == nil {
			return nil
		}
		return json.Unmarshal(res.Result, out)
	}
}

// ThreadStart creates a session inside the harness and returns its Thread.
//
// sandbox and approvalPolicy are passed through as the harness spells them
// ("read-only", "workspace-write"; "never", "on-request"). They are required
// rather than defaulted because an SDK-backed session has NO TERMINAL: an
// approval prompt has no screen to appear on and nobody to answer it, so a
// caller that does not state a policy would hang its session on the first tool
// call with no visible reason.
func (c *Client) ThreadStart(ctx context.Context, cwd, sandbox, approvalPolicy string) (*Thread, error) {
	var res struct {
		Thread Thread `json:"thread"`
	}
	params := map[string]any{"cwd": cwd, "sandbox": sandbox, "approvalPolicy": approvalPolicy}
	if err := c.call(ctx, MethodThreadStart, params, &res); err != nil {
		return nil, err
	}
	return &res.Thread, nil
}

// TurnStart delivers one user turn and returns the harness's receipt for it.
//
// THIS RETURN VALUE IS THE POINT OF THE WHOLE PACKAGE. The error is "the
// harness did not accept this turn"; a nil error with a Turn carrying an id is
// the harness stating, in its own protocol, that the turn is admitted and in
// progress. There is no third outcome in which muxterm has to guess -- which is
// the outcome the PTY path can only ever have, because a write into a terminal
// is acknowledged by the kernel, not by the agent.
func (c *Client) TurnStart(ctx context.Context, threadID, text string) (*Turn, error) {
	var res struct {
		Turn Turn `json:"turn"`
	}
	params := map[string]any{
		"threadId": threadID,
		"input":    []map[string]string{{"type": "text", "text": text}},
	}
	if err := c.call(ctx, MethodTurnStart, params, &res); err != nil {
		return nil, err
	}
	if res.Turn.ID == "" {
		// A response that parsed but carries no turn id is not a receipt.
		// Reporting success here would reintroduce exactly the uncertainty
		// this path exists to remove.
		return nil, errors.New("turn/start returned no turn id")
	}
	return &res.Turn, nil
}

// Stderr returns whatever the harness has written to stderr so far.
func (c *Client) Stderr() string { return c.stderr.String() }

// Close ends the app server process.
func (c *Client) Close() {
	c.mu.Lock()
	closed := c.closed
	c.closed = true
	c.mu.Unlock()
	if closed || c.cmd == nil || c.cmd.Process == nil {
		return
	}
	_ = c.cmd.Process.Kill()
	// Reap, so a long-lived daemon does not accumulate zombies. The process
	// has already been signalled, so this cannot block indefinitely.
	go func() { _ = c.cmd.Wait() }()
}

// Alive reports whether the app server connection is still usable.
func (c *Client) Alive() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.closed
}

// boundedBuffer keeps at most limit bytes, discarding the overflow. A harness
// that fails in a loop must not be able to grow the daemon's heap.
type boundedBuffer struct {
	mu    sync.Mutex
	buf   []byte
	limit int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.buf) < b.limit {
		room := b.limit - len(b.buf)
		if room > len(p) {
			room = len(p)
		}
		b.buf = append(b.buf, p[:room]...)
	}
	return len(p), nil
}

func (b *boundedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.buf)
}

// DefaultTimeout bounds one protocol request. Starting a thread contacts the
// harness's own config and auth; starting a turn returns before the model
// runs, so neither waits on inference.
const DefaultTimeout = 60 * time.Second
