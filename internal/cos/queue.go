package cos

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// ErrSidecarGone reports that the sidecar process died or was shut down while
// a turn was outstanding. The turn's outcome is UNKNOWN: it may have been
// partly applied inside the amplifier session before the process vanished.
var ErrSidecarGone = errors.New("cos: sidecar exited while a turn was in flight")

// ErrQueueClosed reports that the supervisor was closed before a queued turn
// could be dispatched.
var ErrQueueClosed = errors.New("cos: supervisor closed")

// ErrTurnFailed reports that a turn ended in an error event rather than a
// turn_end. The event itself carries the code and message.
var ErrTurnFailed = errors.New("cos: turn failed")

// Turn is a handle on one submitted prompt.
//
// A Turn is created the moment it is SUBMITTED, not when it is dispatched, so
// a caller can subscribe, submit, and filter events by ID with no race. It
// resolves exactly once, to exactly one terminal event (2.4 law 2) - including
// when the sidecar dies mid-turn, in which case the terminal event is
// synthesized rather than received.
type Turn struct {
	// ID is the turn_id on the wire. Every event belonging to this turn
	// carries it.
	ID string
	// Prompt is the text submitted.
	Prompt string
	// SubmittedAt is when Submit was called, which is not when the sidecar
	// started work: a queued turn waits for its predecessor.
	SubmittedAt time.Time

	done      chan struct{}
	closeOnce sync.Once

	mu         sync.Mutex
	dispatched time.Time
	term       Event
	err        error
}

// Done returns a channel closed when the turn reaches its terminal event.
//
// This is the AUTHORITATIVE completion signal, not the event stream: broker
// subscriptions drop events under backpressure, so a consumer that waited only
// for turn_end on its subscription could wait forever. Wait here; read the
// text from the event stream.
func (t *Turn) Done() <-chan struct{} { return t.done }

// Result returns the terminal event and, when the turn did not end cleanly, a
// non-nil error. It is only meaningful after Done is closed.
func (t *Turn) Result() (Event, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.term, t.err
}

// Wait blocks until the turn terminates or ctx is cancelled.
func (t *Turn) Wait(ctx context.Context) (Event, error) {
	select {
	case <-t.done:
		return t.Result()
	case <-ctx.Done():
		return Event{}, ctx.Err()
	}
}

// DispatchedAt reports when this turn was handed to the sidecar, or the zero
// time if it is still queued behind another turn.
func (t *Turn) DispatchedAt() time.Time {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.dispatched
}

// finish resolves the turn exactly once. Later calls are ignored, which is
// what makes "exactly one terminal event" true even if the sidecar sends a
// turn_end after an error, or the supervisor synthesizes a death notice for a
// turn that had already completed.
func (t *Turn) finish(ev Event, err error) {
	t.closeOnce.Do(func() {
		t.mu.Lock()
		t.term = ev
		t.err = err
		t.mu.Unlock()
		close(t.done)
	})
}

// queue is the single-consumer turn dispatcher and the enforcement point for
// 2.4 law 1.
//
// The sidecar refuses a second concurrent turn with an error, and one of the
// two turns is then silently lost - a defect proven empirically against a real
// amplifier session. This queue makes that refusal unreachable: at most one
// turn is outstanding at a time, everything else waits in FIFO order, and the
// next turn is dispatched only after the previous one has reached a terminal
// event.
//
// It is fed by the supervisor's reader goroutine (observe) rather than by a
// broker subscription, deliberately: subscriptions drop, and the control plane
// must not.
type queue struct {
	mu      sync.Mutex
	seq     int
	pending []*Turn
	active  *Turn
	ready   bool
	closed  bool
	closErr error

	send    func(o op) error
	publish func(Event)
	logf    func(string, ...any)
}

func newQueue(send func(op) error, publish func(Event), logf func(string, ...any)) *queue {
	return &queue{send: send, publish: publish, logf: logf}
}

// fail resolves a turn on its handle AND announces it on the event stream.
//
// Both halves are load-bearing. The handle is what a caller holding a *Turn
// waits on; the stream is what everyone ELSE watching the shared conversation
// sees, and a browser only ever has the stream. A synthesized terminal event
// delivered to the handle alone is invisible to them, which reintroduces the
// silent turn loss this queue exists to prevent: the prompt goes in and
// nothing ever comes back.
//
// Every other synthesized terminal event in this package already reaches the
// broker - handleExit publishes sidecarDown's, and all three callers of close
// publish close's. The two paths below were the exceptions.
func (q *queue) fail(t *Turn, code string, cause error) {
	ev := synthEvent(Event{
		Ev: EvError, TurnID: t.ID, Code: code,
		Message: cause.Error(), Fatal: true,
	})
	t.finish(ev, cause)
	if q.publish != nil {
		q.publish(ev)
	}
}

// submit enqueues a prompt and returns its handle immediately. Dispatch
// happens as soon as the sidecar is ready and no other turn is in flight.
func (q *queue) submit(prompt string) *Turn {
	q.mu.Lock()
	q.seq++
	t := &Turn{
		ID:          fmt.Sprintf("t-%d", q.seq),
		Prompt:      prompt,
		SubmittedAt: time.Now(),
		done:        make(chan struct{}),
	}
	if q.closed {
		q.mu.Unlock()
		// PERMANENT, which is exactly why it has to be said out loud: the
		// queue closes when the supervisor gives up for good, so this turn and
		// every one after it fails the same way until the process restarts. A
		// caller told nothing here goes on typing into a chief of staff that
		// is never coming back.
		q.fail(t, CodeShutdown, ErrQueueClosed)
		return t
	}
	q.pending = append(q.pending, t)
	q.mu.Unlock()
	q.pump()
	return t
}

// pump dispatches the next queued turn if - and only if - the sidecar is ready
// and nothing is in flight. Calling it when neither is true is a no-op, so it
// is safe to call from anywhere the state might have changed.
func (q *queue) pump() {
	for {
		q.mu.Lock()
		if q.closed || !q.ready || q.active != nil || len(q.pending) == 0 {
			q.mu.Unlock()
			return
		}
		t := q.pending[0]
		q.pending = q.pending[1:]
		q.active = t
		t.mu.Lock()
		t.dispatched = time.Now()
		t.mu.Unlock()
		send := q.send
		q.mu.Unlock()

		err := send(op{Op: opTurn, TurnID: t.ID, Prompt: t.Prompt})
		if err == nil {
			return
		}

		// The write failed, so the sidecar never saw this turn. Fail it
		// explicitly - a silently dropped turn is the exact defect this queue
		// exists to prevent - then loop to try the next one.
		q.mu.Lock()
		if q.active == t {
			q.active = nil
		}
		q.mu.Unlock()
		q.logf("cos: dispatch of turn %s failed: %v", t.ID, err)
		q.fail(t, CodeDispatchFailed, fmt.Errorf("%w: %v", ErrTurnFailed, err))
	}
}

// observe consumes one event from the sidecar reader and advances queue state.
//
// It runs ON THE READER GOROUTINE, so it must never block: everything here is
// a lock-protected state change plus a non-blocking channel send into the
// supervisor's writer goroutine.
func (q *queue) observe(ev Event) {
	switch ev.Ev {
	case EvReady:
		q.setReady(true)
		return
	case EvPong:
		return
	}

	if !ev.IsTerminal() {
		return
	}

	q.mu.Lock()
	active := q.active
	// A terminal event with no turn_id (a sidecar-level fatal) applies to
	// whatever is in flight; otherwise it must name the active turn. An event
	// for some other turn id is stale - possibly the tail of a turn that was
	// already failed by a restart - and is ignored.
	if active == nil || (ev.TurnID != "" && ev.TurnID != active.ID) {
		q.mu.Unlock()
		return
	}
	q.active = nil
	q.mu.Unlock()

	if ev.TurnID == "" {
		ev.TurnID = active.ID
	}
	active.finish(ev, terminalError(ev))
	q.pump()
}

// terminalError maps a terminal event onto an error value, so a caller can
// branch on err != nil instead of re-deriving the rules.
func terminalError(ev Event) error {
	switch ev.Ev {
	case EvTurnEnd:
		return nil
	case EvCancelled, EvTurnCancelled:
		return fmt.Errorf("%w: cancelled", ErrTurnFailed)
	case EvError:
		msg := ev.Message
		if msg == "" {
			msg = ev.Code
		}
		return fmt.Errorf("%w: %s (%s)", ErrTurnFailed, msg, ev.Code)
	}
	return nil
}

// setReady records whether the sidecar can accept a turn right now, and
// dispatches the queue head when it can.
func (q *queue) setReady(ready bool) {
	q.mu.Lock()
	q.ready = ready
	q.mu.Unlock()
	if ready {
		q.pump()
	}
}

// sidecarDown fails the in-flight turn with a SYNTHESIZED fatal error and
// returns it, so the supervisor can publish the same event to subscribers.
//
// This is 2.4 law 2 held up from the Go side: the sidecar cannot send a
// terminal event for a turn it died in the middle of, so this package sends
// one on its behalf. Without it, a caller waits forever on a process that no
// longer exists.
//
// Queued-but-undispatched turns are deliberately KEPT: they never reached the
// sidecar, so no work was lost, and the supervisor's restart will dispatch
// them into the replacement process. Only the turn that was actually in flight
// - whose effect on the amplifier session is unknown - is failed.
func (q *queue) sidecarDown(reason string) (Event, bool) {
	q.mu.Lock()
	q.ready = false
	active := q.active
	q.active = nil
	q.mu.Unlock()

	if active == nil {
		return Event{}, false
	}
	ev := synthEvent(Event{
		Ev:      EvError,
		TurnID:  active.ID,
		Code:    CodeSidecarExit,
		Message: reason,
		Fatal:   true,
	})
	active.finish(ev, fmt.Errorf("%w: %s", ErrSidecarGone, reason))
	return ev, true
}

// close fails every outstanding turn - in flight and queued - and refuses new
// submissions. Called when the supervisor gives up permanently or is shut
// down, so that nothing is left waiting on a process that will never return.
func (q *queue) close(cause error) []Event {
	if cause == nil {
		cause = ErrQueueClosed
	}
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return nil
	}
	q.closed = true
	q.ready = false
	q.closErr = cause
	victims := q.pending
	if q.active != nil {
		victims = append([]*Turn{q.active}, victims...)
	}
	q.active = nil
	q.pending = nil
	q.mu.Unlock()

	evs := make([]Event, 0, len(victims))
	for _, t := range victims {
		ev := synthEvent(Event{
			Ev: EvError, TurnID: t.ID, Code: CodeShutdown,
			Message: cause.Error(), Fatal: true,
		})
		t.finish(ev, cause)
		evs = append(evs, ev)
	}
	return evs
}

// stats reports queue depth for status output.
func (q *queue) stats() (activeID string, pending int, ready bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.active != nil {
		activeID = q.active.ID
	}
	return activeID, len(q.pending), q.ready
}
