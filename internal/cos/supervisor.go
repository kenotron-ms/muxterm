package cos

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Op names (spec 2.2). Anything else is an unknown op the sidecar must ignore
// rather than fault on (2.4 law 5).
const (
	opTurn     = "turn"
	opApproval = "approval"
	opCancel   = "cancel"
	opShutdown = "shutdown"
	opPing     = "ping"
	opClear    = "clear"
	opHistory  = "history"
)

// DefaultSessionID is the amplifier session the chief of staff owns. It is an
// ordinary session in the normal session store, so `amplifier resume
// muxterm-cos` reaches the same conversation from a terminal.
const DefaultSessionID = "muxterm-cos"

// Environment overrides. Both are escape hatches for a machine whose layout
// this package cannot infer.
const (
	EnvPython  = "MUXTERM_COS_PYTHON"
	EnvSidecar = "MUXTERM_COS_SIDECAR"
)

// sidecarRelPath is where the sidecar lives inside the muxterm source tree.
const sidecarRelPath = "sidecar/cos/main.py"

// Supervision tuning.
const (
	initialBackoff = 500 * time.Millisecond
	maxBackoff     = 30 * time.Second
	// stableUptime is how long an incarnation must survive for its restart
	// backoff to reset. Shorter than this and the sidecar is thrashing.
	stableUptime = 60 * time.Second
	// maxEarlyFailures caps consecutive incarnations that die before ever
	// reporting ready. A sidecar that cannot boot will not fix itself, and
	// retrying it forever would hide the real error behind an infinite loop.
	maxEarlyFailures = 5
	// DefaultReadyTimeout bounds how long a caller waits for boot. The
	// measured boot on the reference machine is ~2s; this is deliberately
	// generous for a cold bundle resolve.
	DefaultReadyTimeout = 90 * time.Second
	// opQueueDepth bounds unwritten ops. Ops are tiny and rare (one per turn,
	// one per approval), so a full queue means the sidecar has stopped reading
	// its stdin entirely.
	opQueueDepth = 64
	// stderrRingSize is how many recent sidecar log lines are retained for
	// error reporting. Per 2.1 stderr IS the sidecar's log channel, so this is
	// the only explanation available when boot fails.
	stderrRingSize = 200
	// maxLineBytes caps one NDJSON line. A turn_end carries the entire reply,
	// so the 64KB bufio.Scanner default is far too small.
	maxLineBytes = 16 << 20
	// requestTimeout bounds a clear or history round trip. Both read (and
	// clear rewrites) the session transcript on disk, so this is generous
	// compared to the milliseconds they take in practice. A sidecar that dies
	// mid-request does NOT wait this out: handleExit resolves every pending
	// request immediately.
	requestTimeout = 30 * time.Second
	// DefaultHistoryLimit is how many turns a replay carries when the caller
	// does not say. Deliberately small: history is a SUMMARY, and the point
	// of the cap is that a reconnecting browser never pulls a transcript-sized
	// payload down the WebSocket.
	DefaultHistoryLimit = 50
)

// ErrNotRunning reports that no sidecar process is currently accepting ops.
var ErrNotRunning = errors.New("cos: sidecar is not running")

// Config configures a Supervisor. The zero value is usable except that Logf
// defaults to log.Printf, which is what routes sidecar stderr into muxterm's
// normal logging.
type Config struct {
	// SessionID is the amplifier session id (default DefaultSessionID).
	SessionID string
	// Bundle names the amplifier bundle; empty lets the sidecar choose.
	Bundle string
	// Cwd is the sidecar's working directory; empty means the current one.
	Cwd string
	// LogLevel is passed through to the sidecar (default "info").
	LogLevel string
	// Python overrides interpreter discovery entirely. Takes precedence over
	// $MUXTERM_COS_PYTHON.
	Python string
	// Script overrides sidecar script discovery. Takes precedence over
	// $MUXTERM_COS_SIDECAR.
	Script string
	// Logf receives supervisor diagnostics and every sidecar stderr line
	// (default log.Printf).
	Logf func(format string, v ...any)
	// StatePath overrides where the status file is written. "-" disables the
	// status file entirely; empty uses StatePath().
	StatePath string
	// SubscriberDepth is the default per-subscriber buffer (0 =
	// DefaultSubscriberDepth).
	SubscriberDepth int
}

// Supervisor owns the sidecar process: it locates an interpreter, spawns the
// sidecar, restarts it with exponential backoff when it dies, and turns its
// stdout into a fan-out event stream.
//
// A sidecar crash NEVER propagates. Errors surface as fatal error events to
// subscribers and as failed turns to callers; nothing here panics, exits, or
// takes down the process that embeds it.
type Supervisor struct {
	cfg    Config
	broker *Broker
	q      *queue

	python string
	script string

	mu         sync.Mutex
	ops        chan []byte
	cmd        *exec.Cmd
	pid        int
	running    bool
	ready      bool
	readyEv    Event
	startedAt  time.Time
	restarts   int
	lastErr    error
	stderrRing []string

	// pending correlates a clear/history reply with the one caller waiting
	// for it. Keyed by the req_id written onto the op; the sidecar echoes it
	// back on the answer. Guarded by mu, like everything else here.
	pending map[string]chan Event
	reqSeq  int

	cancel      context.CancelFunc
	readyCh     chan struct{}
	readyOnce   sync.Once
	deadCh      chan struct{}
	deadOnce    sync.Once
	stopCh      chan struct{}
	stopOnce    sync.Once
	doneCh      chan struct{}
	started     bool
	loopStarted bool
}

// New returns an unstarted Supervisor. Nothing is spawned until Start.
func New(cfg Config) *Supervisor {
	if cfg.SessionID == "" {
		cfg.SessionID = DefaultSessionID
	}
	if cfg.LogLevel == "" {
		cfg.LogLevel = "info"
	}
	if cfg.Logf == nil {
		cfg.Logf = log.Printf
	}
	s := &Supervisor{
		cfg:     cfg,
		broker:  NewBroker(),
		readyCh: make(chan struct{}),
		deadCh:  make(chan struct{}),
		stopCh:  make(chan struct{}),
		doneCh:  make(chan struct{}),
		pending: make(map[string]chan Event),
	}
	s.q = newQueue(s.sendOp, cfg.Logf)
	return s
}

// Start resolves the interpreter and sidecar script, then launches the
// supervise loop in the background.
//
// Resolution errors are returned SYNCHRONOUSLY and are fatal: a missing
// interpreter or a missing sidecar script will not fix itself, so there is
// nothing to back off and retry. Everything after a successful spawn is
// handled by the supervise loop and surfaced as events.
func (s *Supervisor) Start(ctx context.Context) error {
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		return errors.New("cos: supervisor already started")
	}
	s.started = true
	s.mu.Unlock()

	python, pySrc, err := ResolveInterpreter(s.cfg.Python)
	if err != nil {
		s.fail(err)
		return err
	}
	script, scriptSrc, err := ResolveSidecarScript(s.cfg.Script)
	if err != nil {
		s.fail(err)
		return err
	}
	s.python, s.script = python, script
	s.cfg.Logf("cos: interpreter %s (%s)", python, pySrc)
	s.cfg.Logf("cos: sidecar %s (%s)", script, scriptSrc)

	runCtx, cancel := context.WithCancel(ctx)
	s.mu.Lock()
	s.cancel = cancel
	s.loopStarted = true
	s.mu.Unlock()
	go s.supervise(runCtx)
	return nil
}

// Subscribe returns a droppable view of the event stream. depth <= 0 uses the
// configured default. The caller must Close it.
func (s *Supervisor) Subscribe(depth int) *Subscription {
	if depth <= 0 {
		depth = s.cfg.SubscriberDepth
	}
	return s.broker.Subscribe(depth)
}

// Submit queues a prompt as one turn and returns its handle immediately.
// Turns are dispatched strictly one at a time (queue.go); submitting ten at
// once is safe and produces ten turns in submission order.
func (s *Supervisor) Submit(prompt string) *Turn { return s.q.submit(prompt) }

// Approve answers an approval_request. The turn stays blocked inside the
// sidecar until this arrives (2.4 law 3), so a caller that never answers hangs
// the session - answer, even if the answer is "no".
func (s *Supervisor) Approve(requestID string, approved bool, reason string) error {
	return s.sendOp(op{Op: opApproval, RequestID: requestID, Approved: &approved, Reason: reason})
}

// Cancel asks the sidecar to abandon a turn. The turn is not resolved here:
// it ends when the sidecar sends its terminal event, or when the process dies
// and one is synthesized.
func (s *Supervisor) Cancel(turnID string) error {
	return s.sendOp(op{Op: opCancel, TurnID: turnID})
}

// Ping sends a liveness probe; the reply arrives as a pong event.
func (s *Supervisor) Ping() error { return s.sendOp(op{Op: opPing}) }

// Clear prunes the sidecar's own transcript and returns how many messages
// were removed and how many survived.
//
// olderThanDays <= 0 means EVERYTHING. The prune itself happens inside the
// sidecar, because the sidecar owns the amplifier session: rewriting the
// session store from out here would race the process that is actively
// appending to it.
//
// Two refusals come back as errors rather than as a silent partial prune, and
// both are the sidecar's to make: it will not clear while a turn is in flight,
// and it never drops a message that references a still-live lane.
func (s *Supervisor) Clear(olderThanDays int) (removed, kept int, err error) {
	if olderThanDays < 0 {
		return 0, 0, fmt.Errorf("cos: older_than_days cannot be negative (got %d)", olderThanDays)
	}
	days := olderThanDays
	ev, err := s.request(op{Op: opClear, OlderThanDays: &days})
	if err != nil {
		return 0, 0, err
	}
	return ev.Removed, ev.Kept, nil
}

// History returns the newest turns of the conversation as the sidecar
// summarized them: a JSON array, forwarded verbatim by callers that render it.
//
// limit <= 0 uses DefaultHistoryLimit. The payload is a SUMMARY - prompt text,
// reply text, thinking, and one line per tool call. It is never the raw tool
// results and never the llm payloads, which for this session run to megabytes.
func (s *Supervisor) History(limit int) (json.RawMessage, error) {
	if limit <= 0 {
		limit = DefaultHistoryLimit
	}
	ev, err := s.request(op{Op: opHistory, Limit: limit})
	if err != nil {
		return nil, err
	}
	if len(ev.Turns) == 0 {
		return json.RawMessage("[]"), nil
	}
	return ev.Turns, nil
}

// request sends one op and waits for the reply carrying its req_id.
//
// This is the ONLY request/response path in the protocol - turns resolve
// through queue.go's Turn handle instead, because a turn is a long-lived
// thing with its own event stream, while a clear or a history fetch is a
// single question with a single answer.
//
// It never waits out a dead sidecar: handleExit and fail both resolve every
// outstanding request, so the longest a caller can block on a process that
// has gone away is the time it takes the supervise loop to notice.
func (s *Supervisor) request(o op) (Event, error) {
	ch := make(chan Event, 1)
	s.mu.Lock()
	s.reqSeq++
	id := fmt.Sprintf("r-%d", s.reqSeq)
	s.pending[id] = ch
	s.mu.Unlock()
	o.ReqID = id

	defer func() {
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
	}()

	if err := s.sendOp(o); err != nil {
		return Event{}, err
	}
	select {
	case ev := <-ch:
		if ev.Ev == EvError {
			msg := ev.Message
			if msg == "" {
				msg = ev.Code
			}
			return ev, fmt.Errorf("cos: %s op refused: %s", o.Op, msg)
		}
		return ev, nil
	case <-time.After(requestTimeout):
		return Event{}, fmt.Errorf("cos: no answer to the %s op within %s", o.Op, requestTimeout)
	case <-s.stopCh:
		return Event{}, ErrQueueClosed
	}
}

// deliver hands a req_id-bearing event to whoever is waiting for it, and
// reports whether anyone was. A reply nobody is waiting for (the caller timed
// out) falls through to the ordinary event path rather than being dropped.
func (s *Supervisor) deliver(ev Event) bool {
	s.mu.Lock()
	ch, ok := s.pending[ev.ReqID]
	if ok {
		delete(s.pending, ev.ReqID)
	}
	s.mu.Unlock()
	if !ok {
		return false
	}
	select {
	case ch <- ev:
	default:
	}
	return true
}

// failPending resolves every outstanding request, so a sidecar that dies with
// a clear or a history op in flight fails its caller immediately instead of
// making it sit out the timeout.
func (s *Supervisor) failPending(code, reason string) {
	s.mu.Lock()
	pending := s.pending
	s.pending = make(map[string]chan Event)
	s.mu.Unlock()
	for id, ch := range pending {
		select {
		case ch <- synthEvent(Event{
			Ev: EvError, ReqID: id, Code: code, Message: reason, Fatal: true,
		}):
		default:
		}
	}
}

// WaitReady blocks until the sidecar reports ready, the supervisor gives up
// permanently, or ctx is cancelled. The ready event carries session id, bundle,
// tool count, and boot time.
func (s *Supervisor) WaitReady(ctx context.Context) (Event, error) {
	select {
	case <-s.readyCh:
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.readyEv, nil
	case <-s.deadCh:
		s.mu.Lock()
		err := s.lastErr
		s.mu.Unlock()
		if err == nil {
			err = ErrNotRunning
		}
		return Event{}, err
	case <-ctx.Done():
		return Event{}, ctx.Err()
	}
}

// Status is a point-in-time snapshot for `muxterm cos --status` and, later,
// the web overlay.
type Status struct {
	Running    bool          `json:"running"`
	Ready      bool          `json:"ready"`
	PID        int           `json:"pid,omitempty"`
	SessionID  string        `json:"sessionId"`
	Bundle     string        `json:"bundle,omitempty"`
	Tools      int           `json:"tools,omitempty"`
	BootMS     int64         `json:"bootMs,omitempty"`
	Resumed    bool          `json:"resumed,omitempty"`
	StartedAt  time.Time     `json:"startedAt,omitempty"`
	Uptime     time.Duration `json:"-"`
	UptimeSecs float64       `json:"uptimeSecs,omitempty"`
	Restarts   int           `json:"restarts"`
	ActiveTurn string        `json:"activeTurn,omitempty"`
	Pending    int           `json:"pending"`
	Python     string        `json:"python,omitempty"`
	Script     string        `json:"script,omitempty"`
	LastError  string        `json:"lastError,omitempty"`
}

// Status snapshots the supervisor.
func (s *Supervisor) Status() Status {
	activeTurn, pending, _ := s.q.stats()
	s.mu.Lock()
	defer s.mu.Unlock()
	st := Status{
		Running:    s.running,
		Ready:      s.ready,
		PID:        s.pid,
		SessionID:  s.cfg.SessionID,
		Bundle:     s.readyEv.Bundle,
		Tools:      s.readyEv.Tools,
		BootMS:     s.readyEv.BootMS,
		Resumed:    s.readyEv.Resumed,
		StartedAt:  s.startedAt,
		Restarts:   s.restarts,
		ActiveTurn: activeTurn,
		Pending:    pending,
		Python:     s.python,
		Script:     s.script,
	}
	if !s.startedAt.IsZero() && s.running {
		st.Uptime = time.Since(s.startedAt).Round(time.Second)
		st.UptimeSecs = st.Uptime.Seconds()
	}
	if s.lastErr != nil {
		st.LastError = s.lastErr.Error()
	}
	return st
}

// RecentStderr returns the retained tail of the sidecar's stderr, which per
// 2.1 is its log channel. This is what to print when boot fails: the Go side
// sees only "process exited", while the reason is always down there.
func (s *Supervisor) RecentStderr() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return strings.Join(s.stderrRing, "\n")
}

// Close shuts the sidecar down and releases everything.
//
// It escalates on a bounded schedule so a wedged sidecar can never hang the
// caller: graceful shutdown op, then SIGTERM, then SIGKILL, then give up
// waiting. Every outstanding turn is failed so no caller is left waiting.
func (s *Supervisor) Close() error {
	s.stopOnce.Do(func() {
		close(s.stopCh)
		_ = s.sendOp(op{Op: opShutdown})

		if !s.waitExit(2 * time.Second) {
			s.mu.Lock()
			cancel := s.cancel
			s.mu.Unlock()
			if cancel != nil {
				cancel() // exec.Cmd.Cancel -> SIGTERM
			}
			if !s.waitExit(2 * time.Second) {
				s.signal(syscall.SIGKILL)
				if !s.waitExit(2 * time.Second) {
					s.cfg.Logf("cos: sidecar did not exit after SIGKILL; abandoning it")
				}
			}
		}

		for _, ev := range s.q.close(ErrQueueClosed) {
			s.broker.Publish(ev)
		}
		s.broker.Close()
		s.removeState()
	})
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastErr
}

// waitExit waits up to d for the supervise loop to finish. A supervisor whose
// loop never launched (Start failed during discovery) has nothing to wait for.
func (s *Supervisor) waitExit(d time.Duration) bool {
	s.mu.Lock()
	loopStarted := s.loopStarted
	s.mu.Unlock()
	if !loopStarted {
		return true
	}
	select {
	case <-s.doneCh:
		return true
	case <-time.After(d):
		return false
	}
}

// signal delivers sig to the sidecar process if one is running.
func (s *Supervisor) signal(sig os.Signal) {
	s.mu.Lock()
	cmd := s.cmd
	s.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Signal(sig)
}

// --- supervision -----------------------------------------------------------

// supervise runs incarnations of the sidecar until the context is cancelled,
// Close is called, or the sidecar proves it cannot boot.
func (s *Supervisor) supervise(ctx context.Context) {
	defer close(s.doneCh)
	// No turn may outlive the loop that would have run it. This covers the
	// case Close does not: an embedder that cancels its context and never
	// calls Close would otherwise leave callers waiting on a process that is
	// gone. q.close is idempotent, so Close calling it again is a no-op and
	// the FIRST cause recorded wins.
	defer func() {
		for _, ev := range s.q.close(ErrQueueClosed) {
			s.broker.Publish(ev)
		}
	}()

	backoff := initialBackoff
	earlyFailures := 0

	for {
		if s.stopping(ctx) {
			return
		}
		start := time.Now()
		reachedReady, err := s.runOnce(ctx)
		uptime := time.Since(start)

		if s.stopping(ctx) {
			return
		}

		reason := "sidecar exited"
		if err != nil {
			reason = "sidecar exited: " + err.Error()
		}
		s.cfg.Logf("cos: %s after %s (ready=%v)", reason, uptime.Round(time.Millisecond), reachedReady)
		s.handleExit(reason)

		if reachedReady {
			earlyFailures = 0
			if uptime >= stableUptime {
				backoff = initialBackoff
			}
		} else {
			earlyFailures++
			if earlyFailures >= maxEarlyFailures {
				s.fail(fmt.Errorf("sidecar exited %d times before becoming ready (last: %v); giving up",
					earlyFailures, err))
				return
			}
		}

		s.cfg.Logf("cos: restarting sidecar in %s", backoff)
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			return
		case <-s.stopCh:
			return
		}
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
		s.mu.Lock()
		s.restarts++
		s.mu.Unlock()
	}
}

// stopping reports whether the supervisor should stop restarting.
func (s *Supervisor) stopping(ctx context.Context) bool {
	select {
	case <-s.stopCh:
		return true
	case <-ctx.Done():
		return true
	default:
		return false
	}
}

// runOnce spawns one sidecar incarnation and blocks until it exits. It returns
// whether that incarnation ever reported ready, plus the process's exit error.
func (s *Supervisor) runOnce(ctx context.Context) (reachedReady bool, err error) {
	args := []string{s.script, "--session-id", s.cfg.SessionID, "--log-level", s.cfg.LogLevel}
	if s.cfg.Bundle != "" {
		args = append(args, "--bundle", s.cfg.Bundle)
	}
	cwd := s.cfg.Cwd
	if cwd == "" {
		if wd, wdErr := os.Getwd(); wdErr == nil {
			cwd = wd
		}
	}
	if cwd != "" {
		args = append(args, "--cwd", cwd)
	}

	cmd := exec.CommandContext(ctx, s.python, args...) //nolint:gosec // interpreter and script are resolved, not user text
	cmd.Dir = cwd
	// PYTHONUNBUFFERED is load-bearing: a block-buffered child would hold
	// whole events in libc until the buffer filled, turning a token stream
	// into one late burst and making a mid-turn crash lose everything.
	cmd.Env = append(os.Environ(), "PYTHONUNBUFFERED=1", "PYTHONIOENCODING=utf-8")
	// Graceful first. WaitDelay bounds the gap between the process exiting and
	// its pipes closing, so Wait can never block forever on an inherited fd.
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = 5 * time.Second

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return false, fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return false, fmt.Errorf("stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		return false, fmt.Errorf("stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return false, fmt.Errorf("start %s: %w", s.python, err)
	}

	ops := make(chan []byte, opQueueDepth)
	incarnation := make(chan struct{})
	s.mu.Lock()
	s.cmd = cmd
	s.pid = cmd.Process.Pid
	s.ops = ops
	s.running = true
	s.startedAt = time.Now()
	s.mu.Unlock()
	s.cfg.Logf("cos: sidecar started pid=%d session=%s", cmd.Process.Pid, s.cfg.SessionID)

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); s.writeLoop(stdin, ops, incarnation) }()
	go func() { defer wg.Done(); s.readStderr(stderr) }()

	// Reading stdout on this goroutine is what makes the exit ordering safe:
	// cmd.Wait closes the pipes, so it must not run until every read is done.
	reachedReady = s.readStdout(stdout)

	close(incarnation) // stops writeLoop, which closes stdin
	wg.Wait()
	waitErr := cmd.Wait()

	s.mu.Lock()
	s.running = false
	s.ready = false
	s.ops = nil
	s.pid = 0
	s.mu.Unlock()

	return reachedReady, waitErr
}

// readStdout consumes NDJSON events until the pipe closes. It reports whether
// a ready event was seen.
//
// A malformed line is logged and skipped, never fatal (2.4 law 5): a sidecar
// that leaks one stray line to stdout must not take the session down with it.
func (s *Supervisor) readStdout(r io.Reader) bool {
	sawReady := false
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), maxLineBytes)
	for sc.Scan() {
		line := sc.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		ev, err := ParseEvent(line)
		if err != nil {
			s.cfg.Logf("cos: ignoring unparseable sidecar line (%v): %s", err, truncate(string(line), 200))
			continue
		}
		if ev.Ev == EvReady {
			sawReady = true
		}
		s.handleEvent(ev)
	}
	if err := sc.Err(); err != nil {
		s.cfg.Logf("cos: sidecar stdout read error: %v", err)
	}
	return sawReady
}

// handleEvent advances queue state FIRST, then fans out.
//
// The order matters: the queue is the control plane and must never miss a
// terminal event, while broker subscribers are droppable by design. Feeding
// the queue from a subscription instead would make a slow WebSocket client
// able to hang a turn.
func (s *Supervisor) handleEvent(ev Event) {
	if ev.Ev == EvReady {
		s.markReady(ev)
	}
	// A req_id-bearing event is an ANSWER to one caller, not news for
	// everybody: routing it to the waiter and stopping keeps a history
	// payload off every subscribed browser's socket.
	if ev.ReqID != "" && s.deliver(ev) {
		return
	}
	// An older sidecar refuses clear/history with unknown_op and no req_id.
	// Only this build's request ops can produce one, so it is safe - and much
	// kinder than a 30-second wait - to resolve every outstanding request with
	// it rather than leaving a confirm dialog spinning on a reply that is
	// never coming.
	if ev.Ev == EvError && ev.Code == CodeUnknownOp && ev.ReqID == "" {
		s.failPending(CodeUnknownOp, firstNonEmpty(ev.Message, "this sidecar does not support that operation"))
	}
	s.q.observe(ev)
	s.broker.Publish(ev)
}

// markReady records the ready event, unblocks WaitReady, and publishes the
// status file that `muxterm cos --status` reads.
func (s *Supervisor) markReady(ev Event) {
	s.mu.Lock()
	s.ready = true
	s.readyEv = ev
	st := State{
		PID:       s.pid,
		OwnerPID:  os.Getpid(),
		SessionID: firstNonEmpty(ev.SessionID, s.cfg.SessionID),
		Bundle:    ev.Bundle,
		Tools:     ev.Tools,
		BootMS:    ev.BootMS,
		Resumed:   ev.Resumed,
		StartedAt: s.startedAt,
		Python:    s.python,
		Script:    s.script,
	}
	s.mu.Unlock()

	s.cfg.Logf("cos: %s", ev)
	s.writeState(st)
	s.readyOnce.Do(func() { close(s.readyCh) })
}

// readStderr routes the sidecar's log channel (2.1) into muxterm's logging and
// retains a tail for error reporting.
func (s *Supervisor) readStderr(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 8*1024), 1<<20)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r\n")
		if line == "" {
			continue
		}
		s.mu.Lock()
		s.stderrRing = append(s.stderrRing, line)
		if len(s.stderrRing) > stderrRingSize {
			s.stderrRing = s.stderrRing[len(s.stderrRing)-stderrRingSize:]
		}
		s.mu.Unlock()
		s.cfg.Logf("cos/sidecar: %s", line)
	}
}

// writeLoop is the only writer to the sidecar's stdin.
//
// Ops go through a channel rather than being written inline because
// queue.pump runs on the READER goroutine: a direct write to a full pipe would
// deadlock the reader against a sidecar that is blocked writing to us.
func (s *Supervisor) writeLoop(w io.WriteCloser, ops <-chan []byte, done <-chan struct{}) {
	defer w.Close() //nolint:errcheck // closing stdin signals EOF to the sidecar
	for {
		select {
		case line := <-ops:
			if _, err := w.Write(line); err != nil {
				s.cfg.Logf("cos: write to sidecar failed: %v", err)
				return
			}
		case <-done:
			return
		}
	}
}

// op is one line of the Go -> sidecar protocol (2.2).
//
// Approved is a POINTER because a denial is approved=false, and a plain bool
// with omitempty would silently drop the field - leaving the sidecar to guess,
// on the one op where guessing wrong runs a command the user just refused.
// OlderThanDays is a POINTER for a smaller but related reason: 0 means "clear
// everything", and omitempty on a plain int would drop it - which the sidecar
// also reads as everything, so the two agree, but only by accident. Writing
// it explicitly means the wire says what the caller meant.
type op struct {
	Op        string `json:"op"`
	TurnID    string `json:"turn_id,omitempty"`
	Prompt    string `json:"prompt,omitempty"`
	RequestID string `json:"request_id,omitempty"`
	Approved  *bool  `json:"approved,omitempty"`
	Reason    string `json:"reason,omitempty"`

	// clear / history
	ReqID         string `json:"req_id,omitempty"`
	OlderThanDays *int   `json:"older_than_days,omitempty"`
	Limit         int    `json:"limit,omitempty"`
}

// sendOp encodes and queues one op for the writer goroutine. It never blocks.
func (s *Supervisor) sendOp(o op) error {
	s.mu.Lock()
	ops := s.ops
	s.mu.Unlock()
	if ops == nil {
		return ErrNotRunning
	}
	body, err := json.Marshal(o)
	if err != nil {
		return fmt.Errorf("cos: encode %s op: %w", o.Op, err)
	}
	line := append(body, '\n')
	select {
	case ops <- line:
		return nil
	default:
		return fmt.Errorf("cos: sidecar is not reading its stdin (%d ops queued)", opQueueDepth)
	}
}

// handleExit is the crash path: it fails the in-flight turn with a synthesized
// terminal event and tells subscribers the stream has a gap.
func (s *Supervisor) handleExit(reason string) {
	s.removeState()
	s.failPending(CodeSidecarExit, reason)
	ev, hadTurn := s.q.sidecarDown(reason)
	if !hadTurn {
		ev = synthEvent(Event{Ev: EvError, Code: CodeSidecarExit, Message: reason, Fatal: true})
	}
	s.broker.Publish(ev)
}

// fail records a permanent failure: no further restarts, every outstanding
// turn resolved, WaitReady unblocked with the cause.
func (s *Supervisor) fail(err error) {
	s.mu.Lock()
	s.lastErr = err
	s.mu.Unlock()
	s.cfg.Logf("cos: %v", err)
	s.failPending(CodeSidecarUnavailable, err.Error())
	s.broker.Publish(synthEvent(Event{
		Ev: EvError, Code: CodeSidecarUnavailable, Message: err.Error(), Fatal: true,
	}))
	for _, ev := range s.q.close(err) {
		s.broker.Publish(ev)
	}
	s.deadOnce.Do(func() { close(s.deadCh) })
}

// --- discovery -------------------------------------------------------------

// ResolveInterpreter finds the python that can import the amplifier stack.
//
// Order (spec 3.2), first hit wins:
//
//  1. override (a --python flag), then $MUXTERM_COS_PYTHON. Both are explicit,
//     so a broken value is an ERROR rather than a silent fallback - falling
//     back would hide the operator's typo behind a system python that cannot
//     import amplifier.
//  2. the shebang of the resolved `amplifier` binary. On a uv tool install,
//     ~/.local/bin/amplifier is a symlink into the tool's own venv and its
//     first line names that venv's python - which is exactly the interpreter
//     that already has amplifier_app_cli importable.
//  3. python3 on PATH, which is a guess and will only work if the stack
//     happens to be installed there.
func ResolveInterpreter(override string) (path, source string, err error) {
	if override != "" {
		p, err := resolveExecutable(override)
		if err != nil {
			return "", "", fmt.Errorf("cos: configured python %q: %w", override, err)
		}
		return p, "config", nil
	}
	if env := os.Getenv(EnvPython); env != "" {
		p, err := resolveExecutable(env)
		if err != nil {
			return "", "", fmt.Errorf("cos: %s=%q: %w", EnvPython, env, err)
		}
		return p, "$" + EnvPython, nil
	}
	if p, err := pythonFromAmplifierShebang(); err == nil {
		return p, "amplifier shebang", nil
	} else if !errors.Is(err, exec.ErrNotFound) {
		// Worth saying out loud: this is the path that normally wins, so a
		// silent fall-through to a system python is how someone ends up
		// debugging an ImportError instead of a discovery bug.
		log.Printf("cos: amplifier shebang lookup failed (%v); falling back to python3", err)
	}
	p, err := exec.LookPath("python3")
	if err != nil {
		return "", "", fmt.Errorf("cos: no python interpreter found: set %s or install amplifier: %w", EnvPython, err)
	}
	return p, "python3 on PATH", nil
}

// resolveExecutable turns a user-supplied interpreter into an absolute path,
// accepting either a bare name on PATH or a filesystem path.
func resolveExecutable(name string) (string, error) {
	if strings.ContainsRune(name, os.PathSeparator) {
		info, err := os.Stat(name)
		if err != nil {
			return "", err
		}
		if info.IsDir() {
			return "", fmt.Errorf("is a directory")
		}
		return name, nil
	}
	return exec.LookPath(name)
}

// pythonFromAmplifierShebang reads the interpreter out of the amplifier
// launcher's shebang line.
func pythonFromAmplifierShebang() (string, error) {
	amp, err := exec.LookPath("amplifier")
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(amp)
	if err != nil {
		real = amp
	}
	f, err := os.Open(real) //nolint:gosec // path came from PATH lookup
	if err != nil {
		return "", err
	}
	defer f.Close() //nolint:errcheck

	// Bounded read: `amplifier` may be a compiled binary with no newline for
	// megabytes, and slurping that to find a shebang would be absurd.
	head, err := io.ReadAll(io.LimitReader(f, 4096))
	if err != nil {
		return "", err
	}
	line, _, _ := strings.Cut(string(head), "\n")
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "#!") {
		return "", fmt.Errorf("%s has no shebang", real)
	}
	fields := strings.Fields(strings.TrimPrefix(line, "#!"))
	if len(fields) == 0 {
		return "", fmt.Errorf("%s has an empty shebang", real)
	}
	interp := fields[0]
	if filepath.Base(interp) == "env" && len(fields) > 1 {
		return exec.LookPath(fields[1])
	}
	if !strings.Contains(strings.ToLower(filepath.Base(interp)), "python") {
		return "", fmt.Errorf("%s shebang %q is not a python interpreter", real, line)
	}
	if _, err := os.Stat(interp); err != nil {
		return "", fmt.Errorf("shebang interpreter %s: %w", interp, err)
	}
	return interp, nil
}

// ResolveSidecarScript locates sidecar/cos/main.py.
//
// Order, first hit wins: override, $MUXTERM_COS_SIDECAR, a walk up from the
// muxterm binary (covers bin/muxterm in a worktree and an installed layout),
// then a walk up from the working directory (covers `go run`, whose binary
// lives in a temp dir that tells us nothing).
//
// An explicit override that does not exist is an ERROR, never a fall-through:
// silently running a different sidecar than the one asked for is worse than
// failing.
func ResolveSidecarScript(override string) (path, source string, err error) {
	if override != "" {
		abs, err := existingFile(override)
		if err != nil {
			return "", "", fmt.Errorf("cos: configured sidecar %q: %w", override, err)
		}
		return abs, "config", nil
	}
	if env := os.Getenv(EnvSidecar); env != "" {
		abs, err := existingFile(env)
		if err != nil {
			return "", "", fmt.Errorf("cos: %s=%q: %w", EnvSidecar, env, err)
		}
		return abs, "$" + EnvSidecar, nil
	}

	var tried []string
	if exe, err := os.Executable(); err == nil {
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			exe = real
		}
		p, cands := searchUp(filepath.Dir(exe), 5)
		if p != "" {
			return p, "next to the muxterm binary", nil
		}
		tried = append(tried, cands...)
	}
	if wd, err := os.Getwd(); err == nil {
		p, cands := searchUp(wd, 8)
		if p != "" {
			return p, "in the working directory tree", nil
		}
		tried = append(tried, cands...)
	}
	return "", "", fmt.Errorf("cos: could not find %s; set %s. Tried: %s",
		sidecarRelPath, EnvSidecar, strings.Join(tried, ", "))
}

// searchUp walks up to levels parent directories from dir looking for the
// sidecar script, returning the paths it tried when it finds nothing.
func searchUp(dir string, levels int) (string, []string) {
	var tried []string
	for i := 0; i <= levels; i++ {
		cand := filepath.Join(dir, sidecarRelPath)
		if abs, err := existingFile(cand); err == nil {
			return abs, nil
		}
		tried = append(tried, cand)
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", tried
}

// existingFile returns the absolute path of an existing regular file.
func existingFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("is a directory")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return path, nil //nolint:nilerr // a usable relative path beats no path
	}
	return abs, nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
