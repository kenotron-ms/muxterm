package sessiond

import (
	"io"
	"sync"
)

// defaultSubscriberDepth bounds the number of queued frames a slow client may
// fall behind before it is disconnected. It is large enough to absorb a normal
// burst yet small enough to prevent unbounded memory growth for a stalled
// client whose socket never drains.
const defaultSubscriberDepth = 256

// outFrame is one queued write to a single client: a control message, a pane-data
// frame, or a browser-data frame, distinguished by kind.
type outFrame struct {
	kind        byte     // FrameControl, FramePaneOutput, or FrameBrowserData
	msg         *Message // set when kind == FrameControl
	workspaceID string   // set when kind == FramePaneOutput (owning workspace)
	paneID      uint32   // set when kind == FramePaneOutput or FrameBrowserData
	data        []byte   // set when kind == FramePaneOutput or FrameBrowserData
}

// subscriber serializes all writes to one client through a bounded queue drained
// by a dedicated goroutine. Producers (the PTY read goroutine and request
// handlers) only ENQUEUE; they never block on the socket. A queue overflow
// disconnects that one subscriber only, never affecting other clients or the
// PTY drain.
type subscriber struct {
	w     io.WriteCloser
	queue chan outFrame
	done  chan struct{}
	once  sync.Once
}

// newSubscriber creates a subscriber writing to w with a bounded queue of the
// given depth and starts its dedicated writer goroutine. A depth <= 0 uses
// defaultSubscriberDepth.
func newSubscriber(w io.WriteCloser, depth int) *subscriber {
	if depth <= 0 {
		depth = defaultSubscriberDepth
	}
	s := &subscriber{
		w:     w,
		queue: make(chan outFrame, depth),
		done:  make(chan struct{}),
	}
	go s.writeLoop()
	return s
}

// writeLoop is the dedicated writer goroutine: it drains the queue one frame at
// a time, writing each to the client socket. Any write error or a Close signal
// (done) tears down the subscriber and returns.
func (s *subscriber) writeLoop() {
	for {
		select {
		case f := <-s.queue:
			var err error
			switch f.kind {
			case FramePaneOutput:
				err = WritePaneOutput(s.w, f.workspaceID, f.paneID, f.data)
			case FrameBrowserData:
				err = WriteBrowserData(s.w, f.paneID, f.data)
			default: // FrameControl
				err = WriteControl(s.w, f.msg)
			}
			if err != nil {
				s.Close()
				return
			}
		case <-s.done:
			return
		}
	}
}

// enqueueControl queues a control message for this client. It never blocks.
func (s *subscriber) enqueueControl(msg *Message) {
	s.enqueue(outFrame{kind: FrameControl, msg: msg})
}

// enqueuePaneData queues a pane-data frame for this client. The data is COPIED
// into a fresh slice so the caller may reuse its buffer. It never blocks.
func (s *subscriber) enqueuePaneData(workspaceID string, paneID uint32, data []byte) {
	cp := make([]byte, len(data))
	copy(cp, data)
	s.enqueue(outFrame{kind: FramePaneOutput, workspaceID: workspaceID, paneID: paneID, data: cp})
}

// enqueueBrowserData queues a browser-data frame (FrameBrowserData) for this
// client. The data is COPIED into a fresh slice so the caller may reuse its
// buffer. It never blocks.
func (s *subscriber) enqueueBrowserData(paneID uint32, data []byte) {
	cp := make([]byte, len(data))
	copy(cp, data)
	s.enqueue(outFrame{kind: FrameBrowserData, paneID: paneID, data: cp})
}

// enqueue places f on the bounded queue without ever blocking. If the
// subscriber is already disconnected it returns immediately. If the queue is
// full the client is too slow, so the subscriber disconnects itself (only this
// one) rather than block a producer.
func (s *subscriber) enqueue(f outFrame) {
	select {
	case <-s.done:
		return
	default:
	}
	select {
	case s.queue <- f:
	case <-s.done:
	default:
		// Queue full: this client is too slow. Disconnect it only.
		s.Close()
	}
}

// Close disconnects the subscriber: it closes done (signaling Done() listeners
// and stopping the writer goroutine) and closes the underlying writer. It is
// idempotent.
func (s *subscriber) Close() {
	s.once.Do(func() {
		close(s.done)
		s.w.Close()
	})
}

// Done returns a channel closed when the subscriber is disconnected.
func (s *subscriber) Done() <-chan struct{} {
	return s.done
}
