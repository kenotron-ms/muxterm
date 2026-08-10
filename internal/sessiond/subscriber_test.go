package sessiond

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"
)

// blockingWriter is an io.WriteCloser whose Write blocks until Close is called.
// It models a stalled client whose socket never drains, so the subscriber's
// dedicated writer goroutine is stuck mid-write while producers keep enqueueing.
type blockingWriter struct {
	release chan struct{}
	once    sync.Once
}

func newBlockingWriter() *blockingWriter {
	return &blockingWriter{release: make(chan struct{})}
}

func (b *blockingWriter) Write(p []byte) (int, error) {
	<-b.release
	return 0, io.ErrClosedPipe
}

func (b *blockingWriter) Close() error {
	b.once.Do(func() { close(b.release) })
	return nil
}

// safeBuffer is a thread-safe io.WriteCloser backing the fast client, so the
// test goroutine can read accumulated bytes while the writer goroutine writes.
type safeBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *safeBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *safeBuffer) Close() error { return nil }

func (s *safeBuffer) Bytes() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]byte(nil), s.buf.Bytes()...)
}

// countFrames counts complete frames in data by decoding with ReadFrame until
// EOF (or a short final frame), returning the number of whole frames present.
func countFrames(data []byte) int {
	r := bytes.NewReader(data)
	n := 0
	for {
		if _, _, err := ReadFrame(r); err != nil {
			return n
		}
		n++
	}
}

// TestSubscriberStalledClientDoesNotBlockEnqueue verifies that enqueueing many
// frames to a stalled client returns without blocking and that the stalled
// subscriber is disconnected on queue overflow (signaled via Done()).
func TestSubscriberStalledClientDoesNotBlockEnqueue(t *testing.T) {
	bw := newBlockingWriter()
	s := newSubscriber(bw, 0) // default depth

	done := make(chan struct{})
	go func() {
		for i := 0; i < 1000; i++ {
			s.enqueueControl(&Message{Type: TypeOK, CID: uint64(i)})
		}
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("enqueue blocked on a stalled client")
	}

	select {
	case <-s.Done():
	case <-time.After(time.Second):
		t.Fatal("stalled subscriber was not disconnected on overflow")
	}
}

// TestSubscriberStalledDoesNotStarveFastClient verifies that fanning out frames
// to a stalled subscriber and a fast subscriber delivers all frames to the fast
// client despite the stalled peer never draining its socket.
func TestSubscriberStalledDoesNotStarveFastClient(t *testing.T) {
	bw := newBlockingWriter()
	stalled := newSubscriber(bw, 0)

	fastBuf := &safeBuffer{}
	fast := newSubscriber(fastBuf, 0)

	subs := []*subscriber{stalled, fast}
	const frames = 50
	for i := 0; i < frames; i++ {
		data := []byte(fmt.Sprintf("frame-%d\n", i))
		for _, sub := range subs {
			sub.enqueuePaneData(1, data)
		}
	}

	deadline := time.After(5 * time.Second)
	for {
		if countFrames(fastBuf.Bytes()) >= frames {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("fast client starved by stalled peer: only %d/%d frames received",
				countFrames(fastBuf.Bytes()), frames)
		case <-time.After(10 * time.Millisecond):
		}
	}

	fast.Close()
	stalled.Close()

	// Sanity: ReadFrame errors are EOF-shaped, not protocol corruption.
	if _, _, err := ReadFrame(bytes.NewReader(nil)); err != nil && !errors.Is(err, io.EOF) {
		t.Fatalf("unexpected ReadFrame error on empty input: %v", err)
	}
}
