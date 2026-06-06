package sessiond

import (
	"fmt"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
)

// Pane wraps exactly one PTY-backed child process. It streams output to a
// PaneBuffer (scrollback) and an optional onData callback, accepts input,
// resizes the PTY, and fires onExit exactly once when the process exits.
type Pane struct {
	LocalID int
	Title   string // settable; OSC 0/2 title capture is a later phase

	mu   sync.Mutex // guards cols/rows
	cols int
	rows int

	cmd  *exec.Cmd
	ptmx *os.File
	buf  PaneBuffer

	onData func(localID int, data []byte)
	onExit func(localID int)

	closeOnce sync.Once
}

// resolveArgv returns argv unchanged, or a single-element shell command when
// argv is empty, falling back to $SHELL then /bin/sh.
func resolveArgv(argv []string) []string {
	if len(argv) > 0 {
		return argv
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	return []string{shell}
}

// NewPane starts a child process attached to a new PTY sized cols x rows and
// begins streaming its output. buf may be nil (a default VTBuffer is used);
// onData and onExit may be nil.
func NewPane(
	localID int,
	argv []string,
	cols, rows int,
	buf PaneBuffer,
	onData func(localID int, data []byte),
	onExit func(localID int),
) (*Pane, error) {
	if buf == nil {
		// Production default: VTBuffer (screen-state replay). Raw byte replay
		// (RawBuffer) garbles the terminal on reconnect when the client's
		// dimensions differ from when the bytes were recorded — ANSI cursor-
		// positioning sequences apply relative to the original grid size.
		// VTBuffer serializes the live cell grid, which is always correct
		// regardless of dimension changes. See the decision record in
		// docs/plans/2026-06-01-session-persistence-design.md.
		buf = NewVTBuffer(cols, rows)
	}
	argv = resolveArgv(argv)

	c := exec.Command(argv[0], argv[1:]...)
	c.Env = append(os.Environ(), "TERM=xterm-256color")
	if home := os.Getenv("HOME"); home != "" {
		c.Dir = home
	}

	ptmx, err := pty.StartWithSize(c, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
	if err != nil {
		return nil, fmt.Errorf("sessiond: start pane pty: %w", err)
	}

	p := &Pane{
		LocalID: localID,
		cols:    cols,
		rows:    rows,
		cmd:     c,
		ptmx:    ptmx,
		buf:     buf,
		onData:  onData,
		onExit:  onExit,
	}
	go p.readLoop()
	return p, nil
}

// readLoop pumps PTY output into the buffer and onData callback until the PTY
// closes, then reaps the child and fires onExit exactly once.
func (p *Pane) readLoop() {
	chunk := make([]byte, 32*1024)
	for {
		n, err := p.ptmx.Read(chunk)
		if n > 0 {
			data := chunk[:n]
			_, _ = p.buf.Write(data)
			if p.onData != nil {
				cp := make([]byte, n)
				copy(cp, data)
				p.onData(p.LocalID, cp)
			}
		}
		if err != nil {
			break
		}
	}
	_ = p.cmd.Wait()
	if p.onExit != nil {
		p.onExit(p.LocalID)
	}
}

// Write sends input to the child's stdin (the PTY master).
func (p *Pane) Write(input []byte) (int, error) {
	return p.ptmx.Write(input)
}

// Resize updates the stored dimensions, resizes the PTY, and notifies the
// buffer so that grid-aware implementations (VTBuffer) can resize their
// internal cell grid to match.
func (p *Pane) Resize(cols, rows int) error {
	p.mu.Lock()
	// Idempotent: if the dimensions are unchanged, skip pty.Setsize entirely.
	// Setsize delivers SIGWINCH, which makes the shell redraw its prompt; those
	// redraw bytes are appended to the scrollback buffer. A client re-attaching
	// (refresh/reconnect) fits to the SAME size the PTY already has, so without
	// this guard every attach injects a redundant prompt redraw that accumulates
	// in the buffer (one stray prompt fragment per refresh).
	if cols == p.cols && rows == p.rows {
		p.mu.Unlock()
		return nil
	}
	p.cols = cols
	p.rows = rows
	p.mu.Unlock()
	err := pty.Setsize(p.ptmx, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
	p.buf.Resize(cols, rows)
	return err
}

// Replay returns a copy of the pane's scrollback buffer.
func (p *Pane) Replay() []byte {
	return p.buf.Replay()
}

// ReplayFrom returns the retained bytes whose absolute sequence is >= since
// and the absolute sequence of the first returned byte. It delegates directly
// to the underlying PaneBuffer.
func (p *Pane) ReplayFrom(since uint64) (data []byte, start uint64) {
	return p.buf.ReplayFrom(since)
}

// Seq returns the total bytes ever written to this pane's buffer (including
// bytes that have since been trimmed from the scrollback ring).
func (p *Pane) Seq() uint64 { return p.buf.Seq() }

// SetTitle sets the pane's display title under lock.
func (p *Pane) SetTitle(name string) {
	p.mu.Lock()
	p.Title = name
	p.mu.Unlock()
}

// Info returns a frozen snapshot of this pane's identity and dimensions.
func (p *Pane) Info() PaneInfo {
	p.mu.Lock()
	cols, rows, title := p.cols, p.rows, p.Title
	p.mu.Unlock()
	return PaneInfo{PaneID: p.LocalID, Cols: cols, Rows: rows, Title: title}
}

// Close kills the child (if any) and closes the PTY, which ends the read loop
// and drives onExit. It is safe to call repeatedly.
func (p *Pane) Close() {
	p.closeOnce.Do(func() {
		if p.cmd != nil && p.cmd.Process != nil {
			_ = p.cmd.Process.Kill()
		}
		if p.ptmx != nil {
			_ = p.ptmx.Close()
		}
	})
}
