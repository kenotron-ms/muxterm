package sessiond

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"sync/atomic"

	"github.com/creack/pty"
)

// Pane wraps exactly one PTY-backed child process. It streams output to a
// PaneBuffer (scrollback) and an optional onData callback, accepts input,
// resizes the PTY, and fires onExit exactly once when the process exits.
type Pane struct {
	LocalID int
	Title   string // settable; OSC 0/2 title capture is a later phase

	// SurfaceKind is "browser" for browser panes; empty string means "terminal".
	// Set once at construction; immutable thereafter.
	SurfaceKind string
	// Browser-only: the proxied port, stored path, and optional auth headers.
	// All immutable except BrowserPath, which SetBrowserPath() updates.
	BrowserPort  int
	BrowserPath  string
	ProxyHeaders map[string]string

	mu   sync.Mutex // guards cols/rows
	cols int
	rows int

	cmd  *exec.Cmd
	ptmx *os.File
	buf  PaneBuffer

	onData      func(localID int, data []byte)
	onExit      func(localID int)
	onPromptPtr atomic.Pointer[func(int, *Message)] // written once (createPane), read by readLoop

	// argv is the resolved command slice used to start this pane's process.
	// It is captured at NewPane time and used by crash-recovery snapshots to
	// re-spawn the pane after a daemon restart.
	argv []string

	// procWait is set by RestorePane for adopted processes whose cmd.Wait()
	// cannot be used (the exec.Cmd was not started by this process). When
	// non-nil, readLoop calls procWait() instead of cmd.Wait() to reap the
	// child after the PTY closes.
	procWait func()

	closeOnce sync.Once
}

// resolveArgv returns argv unchanged, or a login-shell invocation when argv is
// empty, falling back to $SHELL then /bin/sh.
//
// The -l flag makes the shell behave as a login shell: it sources ~/.zprofile,
// ~/.bash_profile, ~/.profile etc., giving users the same environment they get
// in Ghostty, iTerm2, tmux, and SSH interactive sessions. Without -l, PATH
// additions from tools like brew, nvm, pyenv and rbenv are missing — especially
// important when muxterm runs as a launchd service with a sparse environment.
func resolveArgv(argv []string) []string {
	if len(argv) > 0 {
		return argv
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	return []string{shell, "-l"}
}

// NewPane starts a child process attached to a new PTY sized cols x rows and
// begins streaming its output. dir sets the working directory; when empty the
// process starts in $HOME (or the current working directory if $HOME is unset).
// buf may be nil (a default VTBuffer is used); onData and onExit may be nil.
func NewPane(
	localID int,
	argv []string,
	dir string,
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
	switch {
	case dir != "":
		c.Dir = dir
	case os.Getenv("HOME") != "":
		c.Dir = os.Getenv("HOME")
	}

	ptmx, err := pty.StartWithSize(c, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
	if err != nil {
		return nil, fmt.Errorf("sessiond: start pane pty: %w", err)
	}

	p := &Pane{
		LocalID: localID,
		argv:    argv,
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

// NewBrowserPane creates a lightweight browser-only pane (no PTY or buffer).
// If path is empty, it defaults to "/".
func NewBrowserPane(localID, port int, path string, headers map[string]string) *Pane {
	if path == "" {
		path = "/"
	}
	return &Pane{
		LocalID:      localID,
		Title:        fmt.Sprintf(":%d", port),
		SurfaceKind:  "browser",
		BrowserPort:  port,
		BrowserPath:  path,
		ProxyHeaders: headers,
	}
}

// scanOSC133 searches data for an OSC 133;D sequence (command-done marker) and
// returns the exit code and whether one was found. The terminator must be present
// in the same read buffer (BEL \x07 or ST \x1b\\); partial sequences without a
// terminator return (0, false) — do not buffer across reads.
func scanOSC133(data []byte) (exitCode int, found bool) {
	prefix := []byte("\x1b]133;D")
	idx := bytes.Index(data, prefix)
	if idx == -1 {
		return 0, false
	}
	rest := data[idx+len(prefix):]

	// Locate the earliest terminator: BEL (\x07) or ST (\x1b\\).
	belIdx := bytes.IndexByte(rest, '\x07')
	stIdx := bytes.Index(rest, []byte("\x1b\\"))

	termIdx := -1
	switch {
	case belIdx == -1 && stIdx == -1:
		// No terminator in this read — do not buffer across reads.
		return 0, false
	case belIdx == -1:
		termIdx = stIdx
	case stIdx == -1:
		termIdx = belIdx
	default:
		if belIdx < stIdx {
			termIdx = belIdx
		} else {
			termIdx = stIdx
		}
	}

	params := rest[:termIdx]
	if len(params) == 0 {
		// \x1b]133;D<terminator> — done, code 0.
		return 0, true
	}
	if params[0] != ';' {
		// Unexpected content between D and terminator (e.g., "Done").
		return 0, false
	}
	// params is ";exitcode" — skip the leading semicolon.
	code, err := strconv.Atoi(string(params[1:]))
	if err != nil {
		// Malformed exit code; treat as done with code 0.
		return 0, true
	}
	return code, true
}

// readLoop pumps PTY output into the buffer and onData callback until the PTY
// closes, then reaps the child and fires onExit exactly once.
func (p *Pane) readLoop() {
	chunk := make([]byte, 32*1024)
	for {
		n, err := p.ptmx.Read(chunk)
		if n > 0 {
			data := chunk[:n]
			if code, prompted := scanOSC133(data); prompted {
				if fn := p.onPromptPtr.Load(); fn != nil {
					(*fn)(p.LocalID, &Message{Type: TypeShellPrompt, ExitCode: code})
				}
			}
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
	if p.procWait != nil {
		p.procWait()
	} else if p.cmd != nil {
		_ = p.cmd.Wait()
	}
	if p.onExit != nil {
		p.onExit(p.LocalID)
	}
}

// Write sends input to the child's stdin (the PTY master).
// For browser panes (ptmx == nil), input is silently discarded.
func (p *Pane) Write(input []byte) (int, error) {
	if p.ptmx == nil {
		return 0, nil // browser pane: no PTY
	}
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
	if p.ptmx == nil {
		return nil // browser pane: no PTY to resize
	}
	err := pty.Setsize(p.ptmx, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
	if p.buf != nil {
		p.buf.Resize(cols, rows)
	}
	return err
}

// Replay returns a copy of the pane's scrollback buffer.
// For browser panes (buf == nil), returns nil.
func (p *Pane) Replay() []byte {
	if p.buf == nil {
		return nil // browser pane: no buffer
	}
	return p.buf.Replay()
}

// ReplayFrom returns the retained bytes whose absolute sequence is >= since
// and the absolute sequence of the first returned byte. It delegates directly
// to the underlying PaneBuffer.
// For browser panes (buf == nil), returns nil, 0.
func (p *Pane) ReplayFrom(since uint64) (data []byte, start uint64) {
	if p.buf == nil {
		return nil, 0
	}
	return p.buf.ReplayFrom(since)
}

// Seq returns the total bytes ever written to this pane's buffer (including
// bytes that have since been trimmed from the scrollback ring).
// For browser panes (buf == nil), returns 0.
func (p *Pane) Seq() uint64 {
	if p.buf == nil {
		return 0
	}
	return p.buf.Seq()
}

// SetTitle sets the pane's display title under lock.
func (p *Pane) SetTitle(name string) {
	p.mu.Lock()
	p.Title = name
	p.mu.Unlock()
}

// SetBrowserPath updates the pane's browser navigation path under lock.
func (p *Pane) SetBrowserPath(path string) {
	p.mu.Lock()
	p.BrowserPath = path
	p.mu.Unlock()
}

// Info returns a frozen snapshot of this pane's identity and dimensions.
func (p *Pane) Info() PaneInfo {
	p.mu.Lock()
	cols, rows, title := p.cols, p.rows, p.Title
	surfaceKind, browserPort, browserPath, proxyHeaders := p.SurfaceKind, p.BrowserPort, p.BrowserPath, p.ProxyHeaders
	p.mu.Unlock()
	return PaneInfo{
		PaneID:       p.LocalID,
		Cols:         cols,
		Rows:         rows,
		Title:        title,
		SurfaceKind:  surfaceKind,
		BrowserPort:  browserPort,
		BrowserPath:  browserPath,
		ProxyHeaders: proxyHeaders,
	}
}

// RestorePane reconstructs a Pane from a live-upgrade handoff. It adopts the
// already-running PTY at ptmx and the already-running child at pid, sets all
// state fields directly, and starts the read loop goroutine. The caller must
// have already written any scrollback bytes into buf before calling RestorePane
// so the buffer reflects the correct replay state.
func RestorePane(
	ptmx *os.File,
	pid, localID, cols, rows int,
	title, surfaceKind string,
	buf PaneBuffer,
	onData func(int, []byte),
	onExit func(int),
) *Pane {
	p := &Pane{
		LocalID:     localID,
		Title:       title,
		SurfaceKind: surfaceKind,
		cols:        cols,
		rows:        rows,
		ptmx:        ptmx,
		buf:         buf,
		onData:      onData,
		onExit:      onExit,
	}
	if pid > 0 {
		proc, err := os.FindProcess(pid)
		if err == nil {
			// Keep a Process handle so Close() can Kill() the child.
			p.cmd = &exec.Cmd{}
			p.cmd.Process = proc
			// procWait is used by readLoop instead of cmd.Wait() because the
			// Cmd was not started by this process and its internal state is
			// uninitialised; using os.Process.Wait() directly is safe.
			p.procWait = func() { _, _ = proc.Wait() }
		}
	}
	go p.readLoop()
	return p
}

// GetPtmxFD returns the raw OS file descriptor of this pane's PTY master.
// The returned integer is valid for the lifetime of p.ptmx; callers must not
// close it directly. Returns -1 and a non-nil error for browser panes or when
// the underlying syscall fails.
func (p *Pane) GetPtmxFD() (int, error) {
	if p.ptmx == nil {
		return -1, fmt.Errorf("sessiond: pane %d has no ptmx (browser pane?)", p.LocalID)
	}
	sc, err := p.ptmx.SyscallConn()
	if err != nil {
		return -1, fmt.Errorf("sessiond: SyscallConn: %w", err)
	}
	var fd int = -1
	if err := sc.Control(func(f uintptr) { fd = int(f) }); err != nil {
		return -1, fmt.Errorf("sessiond: Control: %w", err)
	}
	return fd, nil
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
