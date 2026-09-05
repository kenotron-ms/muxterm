package ssh

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// closeGrace bounds how long Close waits for ssh to exit on its own after the
// pipes are closed (one round trip: the remote sees EOF, exits, ssh follows).
// Past that it is killed, because a Close that can hang forever is a leak with
// extra steps.
const closeGrace = 2 * time.Second

// sshConn adapts an `ssh` subprocess's stdin/stdout pipes to net.Conn.
//
// Nothing here interprets the bytes: the pipes carry sessiond's frozen binary
// framing and a single mangled or reordered byte desynchronizes the stream
// permanently. The only value added over the raw pipes is lifecycle — reaping
// the child so it cannot become a zombie — and diagnosis: ssh's stderr is
// captured separately and folded into the error when it exits nonzero, because
// a bare "exit status 255" says nothing about whether the host was unreachable,
// the key was rejected, or the remote binary was missing.
type sshConn struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	stderr *syncBuffer
	target string

	closed atomic.Bool

	waitOnce sync.Once
	waitErr  error // set exactly once, inside waitOnce

	closeOnce sync.Once
	closeErr  error
}

var _ net.Conn = (*sshConn)(nil)

// Read delivers bytes from ssh's stdout. On a clean end of stream it reaps the
// process first, so a session that ended because ssh FAILED surfaces that
// failure (with stderr attached) instead of an indistinguishable io.EOF.
func (c *sshConn) Read(p []byte) (int, error) {
	n, err := c.stdout.Read(p)
	if err == nil {
		return n, nil
	}
	if c.closed.Load() {
		return n, net.ErrClosed
	}
	if errors.Is(err, io.EOF) {
		// reap blocks in cmd.Wait, which waits on os/exec's stderr-copying
		// goroutine as well as the process. A grandchild on the far side that
		// inherited ssh's stderr and outlives sessiond-connect keeps that pipe
		// open, so this can park indefinitely.
		//
		// Close is the escape valve, and it works by killing the child rather
		// than by bypassing reap: reap is waitOnce-guarded, so Close cannot
		// overtake a Read already inside it. Close runs reap on its own
		// goroutine, gives up after closeGrace, and kills the process -- which
		// closes stderr, releases the copier, and unblocks the parked Read.
		// A caller that never calls Close has no other way out.
		if werr := c.reap(); werr != nil {
			return n, werr
		}
		return n, io.EOF
	}
	return n, err
}

// Write sends bytes to ssh's stdin.
//
// It deliberately does NOT reap on error: reaping closes the stdout pipe, and
// doing that underneath a concurrent Read would discard bytes still in flight.
// A write failure means ssh is gone, and the Read side reports why a moment
// later when stdout hits EOF.
func (c *sshConn) Write(p []byte) (int, error) {
	n, err := c.stdin.Write(p)
	if err != nil && c.closed.Load() {
		return n, net.ErrClosed
	}
	return n, err
}

// CloseWrite closes only ssh's stdin, so the far side sees a real EOF on its
// read side while the reply direction stays open. This is the half-close a
// stream protocol needs to finish draining; a full Close would truncate it.
func (c *sshConn) CloseWrite() error {
	return c.stdin.Close()
}

// Close closes both pipes and reaps the ssh process, so no zombie survives the
// connection. If ssh does not exit within closeGrace it is killed; the
// resulting "signal: killed" is our own doing and is not reported as an error.
// Close is idempotent.
//
// Close always returns within roughly 2*closeGrace. The second bound matters:
// os/exec's Wait reaps the process first and only then waits for the goroutine
// draining stderr, so a killed ssh that left a grandchild holding that pipe is
// already reaped (no zombie) while Wait is still blocked. In that case Close
// stops waiting and lets the reaping goroutine finish on its own rather than
// hanging its caller.
func (c *sshConn) Close() error {
	c.closeOnce.Do(func() {
		c.closed.Store(true)
		_ = c.stdin.Close()
		// Closing stdout also unblocks any Read parked on it.
		_ = c.stdout.Close()

		done := make(chan error, 1)
		go func() { done <- c.reap() }()
		select {
		case err := <-done:
			c.closeErr = err
			return
		case <-time.After(closeGrace):
		}
		if c.cmd.Process != nil {
			_ = c.cmd.Process.Kill()
		}
		select {
		case <-done: // collect the killed child; nothing here is a real failure
		case <-time.After(closeGrace):
		}
		c.closeErr = nil
	})
	return c.closeErr
}

// LocalAddr reports a placeholder address. An ssh-carried stream is a pair of
// subprocess pipes and has no socket address on this side.
func (c *sshConn) LocalAddr() net.Addr { return addr{s: "local"} }

// RemoteAddr reports the ssh target. It is for diagnostics only and is not a
// resolvable network address — it may be an alias, a hostname, a v4 or v6
// literal, or a tailnet name.
func (c *sshConn) RemoteAddr() net.Addr { return addr{s: c.target} }

// SetDeadline is UNSUPPORTED on an ssh-carried connection: the stream is a pair
// of OS pipes to a subprocess, which have no deadline mechanism. It returns an
// error wrapping os.ErrNoDeadline so callers can detect the condition with
// errors.Is. Callers needing to bound an operation must close the connection
// instead, which unblocks a parked Read.
func (c *sshConn) SetDeadline(time.Time) error {
	return fmt.Errorf("ssh transport: deadlines unsupported: %w", os.ErrNoDeadline)
}

// SetReadDeadline is unsupported; see SetDeadline.
func (c *sshConn) SetReadDeadline(time.Time) error { return c.SetDeadline(time.Time{}) }

// SetWriteDeadline is unsupported; see SetDeadline.
func (c *sshConn) SetWriteDeadline(time.Time) error { return c.SetDeadline(time.Time{}) }

// reap waits for the ssh process exactly once and caches the result. A nonzero
// exit is returned with the captured stderr appended, which is the difference
// between a usable diagnostic and "exit status 255".
//
// It must only be called once all reads from the stdout pipe have finished (on
// EOF, or after Close has closed the pipe): os/exec closes the pipe inside
// Wait, so calling it earlier would race a live reader.
func (c *sshConn) reap() error {
	c.waitOnce.Do(func() {
		if err := c.cmd.Wait(); err != nil {
			c.waitErr = fmt.Errorf("ssh %s: %w%s", c.target, err, stderrSuffix(c.stderr.String()))
		}
	})
	return c.waitErr
}

// stderrSuffix renders captured ssh stderr as a trailing clause, or nothing at
// all when ssh said nothing.
func stderrSuffix(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	return ": " + strings.ReplaceAll(s, "\n", "; ")
}

// addr is the net.Addr for an ssh-carried connection: a label, not a resolvable
// address.
type addr struct{ s string }

// Network names the transport that carries the connection.
func (a addr) Network() string { return "ssh" }

// String renders the ssh target (or "local" for the near side).
func (a addr) String() string { return a.s }

// syncBuffer is a mutex-guarded bytes.Buffer. os/exec fills cmd.Stderr from its
// own copying goroutine, so the buffer is read and written from different
// goroutines whenever an error is formatted before Wait returns.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

// Write appends p under the lock.
func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

// String returns the captured bytes under the lock.
func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
