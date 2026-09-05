package sessiond

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// Pane wraps exactly one PTY-backed child process. It streams output to a
// PaneBuffer (scrollback) and an optional onData callback, accepts input,
// resizes the PTY, and fires onExit exactly once when the process exits.
type Pane struct {
	LocalID int
	Title   string // settable; OSC 0/2 title capture is a later phase

	// titleOrigin says whether Title was chosen by a person or derived by the
	// daemon, and is guarded by mu exactly like Title itself -- the two are
	// one fact and must never be read apart. See autoname.go for why a name
	// without provenance cannot be safely re-derived.
	titleOrigin nameOrigin

	// targetGeneration is assigned by Registry.PutPane and changes whenever a
	// pane registry identity is replaced. It is read only while Registry.mu is
	// held and binds close tickets independently of the root-process generation.
	targetGeneration uint64

	mu   sync.Mutex // guards cols/rows/authorityConn/authorityAt
	cols int
	rows int

	// authorityConn is the conn currently authoritative for sizing this pane's
	// PTY (see ClaimAuthority/TouchAuthority/IsAuthoritative/ClearAuthorityIfOwner
	// below). nil means unclaimed — the first conn to claim wins.
	authorityConn *conn
	authorityAt   time.Time

	cmd       *exec.Cmd
	ptmx      *os.File
	buf       PaneBuffer
	startTime time.Time

	// activityMu guards the current root-process generation and its streaming
	// shell-lifecycle parser/evidence. Lifecycle output is written by readLoop
	// while close transactions may classify concurrently.
	activityMu       sync.Mutex
	rootPID          int
	rootGeneration   uint64
	rootStartedAt    time.Time
	rootExited       bool
	lifecycleSource  shellLifecycleSource
	lifecycleParser  shellLifecycleParser
	lifecycle        lifecycleEvidence
	lifecycleParsing bool
	activityRevision uint64

	// previewMu guards the sidebar-preview output signal, deliberately NOT
	// activityMu: activityMu guards the close-safety activity classifier, which
	// is authoritative state (see AGENTS.md "Pane activity ownership"). A
	// cosmetic preview must not be able to contend with — or be mistaken for —
	// that.
	//
	// lastWrite is the first output timestamp in sessiond: "activity" here has
	// always been an idle/busy/unknown classifier, never an output tracker. The
	// preview ticker uses it to pick each workspace's most-active pane.
	// previewSeq bumps on every PTY read and is the cheap dirty signal that
	// lets the ticker skip a workspace that has produced nothing since the last
	// tile.
	previewMu  sync.Mutex
	lastWrite  time.Time
	previewSeq uint64

	onData      func(localID int, data []byte)
	onExit      func(localID int, exitCode int, runtimeMilliseconds int64)
	onPromptPtr atomic.Pointer[func(int, *Message)] // written once (createPane), read by readLoop

	closeOnce              sync.Once
	integrationCleanupOnce sync.Once
	integrationCleanup     func()
}

// resolveArgv returns argv unchanged, or a login-shell invocation when argv is
// empty, falling back to $SHELL then /bin/sh.
//
// The -l flag makes the shell behave as a login shell: it sources ~/.zprofile,
// ~/.bash_profile, ~/.profile etc., giving users the same environment they get
// in Ghostty, iTerm2, tmux, and SSH interactive sessions. Without -l, PATH
// additions from tools like brew, nvm, pyenv and rbenv are missing — especially
// important when muxterm runs as a launchd service with a sparse environment.
//
// bash special-case: a bash login shell (bash -l) sources the profile chain
// (~/.bash_profile, ~/.bash_login, or ~/.profile — whichever is found first)
// but does NOT source ~/.bashrc — that's stock bash behavior, and most
// distro-default profile files don't source .bashrc from a login shell
// context either. Since PS1/aliases/functions typically live in .bashrc, a
// plain "bash -l" silently drops them. To get both the login-shell PATH
// correctness AND .bashrc, we run bash as "bash -l -c 'exec bash -i'": the
// outer login shell sources the profile chain (fixing PATH), then execs an
// inner *non-login* interactive shell, which reliably sources ~/.bashrc,
// inheriting the corrected environment from the exec.
func resolveArgv(argv []string) []string {
	if len(argv) > 0 {
		return argv
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	if filepath.Base(shell) == "bash" {
		return []string{shell, "-l", "-c", fmt.Sprintf("exec %s -i", shell)}
	}
	return []string{shell, "-l"}
}

// NewPane starts a child process attached to a new PTY sized cols x rows and
// begins streaming its output. buf may be nil (a default VTBuffer is used);
// onData, onExit, and onPrompt may be nil.
//
// onPrompt is stored before the readLoop goroutine starts to eliminate the
// race between the shell emitting OSC 133;D (prompt-ready signal) and the
// caller registering the callback after NewPane returns. Without this, the
// first prompt can fire while onPromptPtr is still nil and TypeShellPrompt
// is silently dropped — causing clients that wait on TypeShellPrompt (e.g.
// amplifier-app-cli) to hang indefinitely.
//
// cwd overrides the child's working directory. Empty string preserves
// today's behavior for every existing caller: unconditionally forced to
// $HOME (see below). A non-empty value is used verbatim instead — the only
// caller that passes one is the session-restore applier (snapshot.go),
// restarting a pane in the directory it was last seen in.
func NewPane(
	localID int,
	argv []string,
	cols, rows int,
	buf PaneBuffer,
	onData func(localID int, data []byte),
	onExit func(localID int, exitCode int, runtimeMilliseconds int64),
	onPrompt func(localID int, msg *Message),
	cwd string,
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
	launch, err := preparePaneLaunch(argv)
	if err != nil {
		return nil, err
	}

	c := exec.Command(launch.argv[0], launch.argv[1:]...)
	c.Env = append(os.Environ(), "TERM=xterm-256color")
	c.Env = append(c.Env, launch.env...)
	if cwd != "" {
		// Restore path: reopen the pane in the directory it was last seen
		// in, rather than forcing $HOME.
		c.Dir = cwd
	} else if home := os.Getenv("HOME"); home != "" {
		c.Dir = home
	}

	ptmx, err := pty.StartWithSize(c, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
	if err != nil {
		if launch.cleanup != nil {
			launch.cleanup()
		}
		return nil, fmt.Errorf("sessiond: start pane pty: %w", err)
	}
	startedAt := time.Now()

	p := &Pane{
		LocalID:            localID,
		cols:               cols,
		rows:               rows,
		cmd:                c,
		ptmx:               ptmx,
		buf:                buf,
		startTime:          startedAt,
		onData:             onData,
		onExit:             onExit,
		integrationCleanup: launch.cleanup,
	}
	generation := p.bindRootProcess(c.Process.Pid, launch.source, launch.token, startedAt)
	if onPrompt != nil {
		p.onPromptPtr.Store(&onPrompt)
	}
	// If the buffer is a VTBuffer, drain its internal emulator reply pipe and
	// forward replies to the PTY -- but ONLY when the slave's live termios
	// shows the child is actually in raw/noecho mode right now, i.e. it
	// deliberately went raw to read exactly this kind of reply itself (the
	// standard termenv/lipgloss/real-TUI idiom: MakeRaw, write query, read,
	// restore).
	//
	// Why gate at all: the vt emulator writes terminal query responses (DA1,
	// DA2, DSR, cursor-position, OSC color queries, in-band resize, etc.)
	// into a synchronous io.Pipe; something must continuously drain it or
	// the first such response blocks emu.Write forever, permanently hanging
	// readLoop. But writing that reply to ptmx is indistinguishable, to the
	// kernel, from a keystroke: if the slave is in the default cooked mode
	// (ICANON+ECHO -- true for any process that hasn't explicitly gone raw),
	// the line discipline echoes it straight back into the same stream
	// readLoop is recording into VTBuffer, producing visible garbage (e.g.
	// "^[]11;rgb:.../^[\^[[6n"-shaped bytes leaking in front of a prompt
	// after something like `gh auth switch`). Cooked mode can never deliver
	// an un-terminated reply to a line-buffered read() anyway (no trailing
	// newline), so dropping it there costs nothing real -- it was never
	// going to reach the child as usable input either way, and left
	// in place it can sit as stray un-terminated bytes ahead of whatever
	// real input line comes next.
	//
	// Lifecycle note: this goroutine exits when vtb.Read returns an error
	// (pane torn down). It may briefly outlive Close() if blocked on
	// emu.Read() waiting for a response that never arrives -- acceptable
	// given the small number of panes and that the emulator produces
	// responses only on demand.
	if vtb, ok := buf.(*VTBuffer); ok {
		go forwardQueryReplies(ptmx, vtb)
	}
	go p.readLoop(generation)
	return p, nil
}

// forwardQueryReplies drains buf's internal emulator query-reply pipe and
// forwards each reply to the PTY master, but only when the slave's current
// termios shows the child is in raw/noecho mode -- see the doc comment at
// this goroutine's call site in NewPane for the full rationale.
func forwardQueryReplies(ptmx *os.File, buf *VTBuffer) {
	chunk := make([]byte, 4096)
	for {
		n, err := buf.Read(chunk)
		if n > 0 && slaveIsRawNoEcho(ptmx) {
			_, _ = ptmx.Write(chunk[:n])
		}
		// else: silently dropped -- see NewPane's doc comment.
		if err != nil {
			return
		}
	}
}

// slaveIsRawNoEcho reports whether the PTY slave's current termios has ECHO
// disabled, i.e. the child process has deliberately gone raw (the standard
// idiom for a program about to read a terminal-capability query reply
// itself). Fails closed: if termios can't be read, treat as cooked mode so
// a reply is dropped rather than risking an echo leak.
//
// Uses ptmx.SyscallConn()/raw.Control() rather than ptmx.Fd() -- see
// inspectForegroundPGRP in foreground_pgrp_supported.go for the identical
// pattern and why: os.File.Fd() forces the underlying fd into blocking mode
// as a side effect and detaches it from the runtime's netpoller, which is
// unsafe here since this same ptmx is simultaneously used for concurrent
// async Read (readLoop) and Write (Pane.Write, and this goroutine's own
// forwarding write) from other goroutines. SyscallConn()'s Control callback
// gets a valid fd for the ioctl's duration without that side effect.
func slaveIsRawNoEcho(ptmx *os.File) bool {
	raw, err := ptmx.SyscallConn()
	if err != nil {
		return false
	}
	var (
		t        *unix.Termios
		ioctlErr error
	)
	if err := raw.Control(func(fd uintptr) {
		t, ioctlErr = unix.IoctlGetTermios(int(fd), tcgetsRequest)
	}); err != nil {
		return false
	}
	if ioctlErr != nil || t == nil {
		return false
	}
	return t.Lflag&unix.ECHO == 0
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
func (p *Pane) readLoop(generation uint64) {
	chunk := make([]byte, 32*1024)
	for {
		n, err := p.ptmx.Read(chunk)
		if n > 0 {
			data := chunk[:n]
			p.observeLifecycleData(generation, data, time.Now())
			if code, prompted := scanOSC133(data); prompted {
				if fn := p.onPromptPtr.Load(); fn != nil {
					(*fn)(p.LocalID, &Message{Type: TypeShellPrompt, ExitCode: code})
				}
			}
			_, _ = p.buf.Write(data)
			p.noteWrite(time.Now())
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
	err2 := p.cmd.Wait()
	p.markRootExited(generation)
	p.cleanupIntegration()
	exitCode := 0
	if p.cmd.ProcessState != nil {
		exitCode = p.cmd.ProcessState.ExitCode()
	} else if err2 != nil {
		exitCode = -1
	}
	runtimeMs := time.Since(p.startTime).Milliseconds()
	if p.onExit != nil {
		p.onExit(p.LocalID, exitCode, runtimeMs)
	}
}

// noteWrite records that the PTY produced output at now. Called from readLoop,
// the single place per-pane output is observed server-side, so every byte the
// pane emits advances both fields exactly once.
func (p *Pane) noteWrite(now time.Time) {
	p.previewMu.Lock()
	p.lastWrite = now
	p.previewSeq++
	p.previewMu.Unlock()
}

// PreviewActivity returns when this pane last produced PTY output and a
// counter that changes on every such write. A zero time and seq mean the pane
// has never written (a freshly spawned pane). Callers compare seq against the
// value they last saw rather than reading it as a byte count.
func (p *Pane) PreviewActivity() (lastWrite time.Time, seq uint64) {
	p.previewMu.Lock()
	defer p.previewMu.Unlock()
	return p.lastWrite, p.previewSeq
}

// Write sends input to the child's stdin (the PTY master).
// A pane with no PTY (ptmx == nil) silently discards input.
func (p *Pane) Write(input []byte) (int, error) {
	if p.ptmx == nil {
		return 0, nil // no PTY attached
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
		return nil // no PTY to resize
	}
	err := pty.Setsize(p.ptmx, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
	if p.buf != nil {
		p.buf.Resize(cols, rows)
	}
	return err
}

// ClaimAuthority makes c the authoritative conn for this pane's PTY sizing if
// authority is unclaimed (nil), stale (now is after the current authority's
// timestamp), or c is already the authoritative conn. Ties go to the incoming
// caller (>=). Returns true if this call changed which conn is authoritative
// (including the nil -> c case), which tells the caller whether other conns
// need a pane-resized broadcast.
func (p *Pane) ClaimAuthority(c *conn, now time.Time) (promoted bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.authorityConn == nil || !now.Before(p.authorityAt) || c == p.authorityConn {
		changed := p.authorityConn != c
		p.authorityConn = c
		p.authorityAt = now
		return changed
	}
	return false
}

// TouchAuthority applies the same most-recent-wins claim logic as
// ClaimAuthority, for callers (keystroke-triggered reclaim) that have no
// cols/rows to apply and so don't act on the promoted return value the same
// way a resize/pane-focus caller would.
func (p *Pane) TouchAuthority(c *conn, now time.Time) {
	p.ClaimAuthority(c, now)
}

// IsAuthoritative reports whether c is the current authoritative conn for this
// pane's PTY sizing.
func (p *Pane) IsAuthoritative(c *conn) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.authorityConn == c
}

// ClearAuthorityIfOwner clears the authoritative conn if it is currently c.
// Called on disconnect so a dead conn never blocks a future legitimate claim.
func (p *Pane) ClearAuthorityIfOwner(c *conn) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.authorityConn == c {
		p.authorityConn = nil
	}
}

// Replay returns a copy of the pane's scrollback buffer.
// A pane with no buffer (buf == nil) returns nil.
func (p *Pane) Replay() []byte {
	if p.buf == nil {
		return nil // no buffer attached
	}
	return p.buf.Replay()
}

// ReplayFrom returns the retained bytes whose absolute sequence is >= since
// and the absolute sequence of the first returned byte. It delegates directly
// to the underlying PaneBuffer.
// A pane with no buffer (buf == nil) returns nil, 0.
func (p *Pane) ReplayFrom(since uint64) (data []byte, start uint64) {
	if p.buf == nil {
		return nil, 0
	}
	return p.buf.ReplayFrom(since)
}

// Seq returns the total bytes ever written to this pane's buffer (including
// bytes that have since been trimmed from the scrollback ring).
// A pane with no buffer (buf == nil) returns 0.
func (p *Pane) Seq() uint64 {
	if p.buf == nil {
		return 0
	}
	return p.buf.Seq()
}

// SetTitle sets the pane's display title under lock and records it as a
// deliberate choice, which makes it permanent as far as the deriver is
// concerned. This is the setter behind the public rename verb (rename-pane,
// reached from the browser, the CLI, and MCP) and it is the ONLY way a title
// becomes explicit -- anything the daemon works out for itself goes through
// setTitleDerived instead, so the two intents cannot be confused at a call
// site.
func (p *Pane) SetTitle(name string) {
	p.setTitle(name, originExplicit)
}

// setTitleDerived offers a title the daemon derived, and reports whether the
// pane took it. It declines -- silently, and returning false -- when a person
// has already named this pane, and when the title already reads exactly this.
// Callers broadcast if and only if it returns true; see applyDerivedNames for
// why that is what keeps a once-a-second pass quiet.
func (p *Pane) setTitleDerived(name string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !acceptsDerivedName(p.Title, p.titleOrigin, name) {
		return false
	}
	p.Title = name
	p.titleOrigin = originDerived
	return true
}

// setTitle is the one place Title and its provenance are written, so they can
// never drift apart.
func (p *Pane) setTitle(name string, origin nameOrigin) {
	p.mu.Lock()
	p.Title = name
	p.titleOrigin = origin
	p.mu.Unlock()
}

// titleOriginSnapshot returns the provenance of the current title. Read under
// the same lock as the title, for the snapshot writer -- which must persist the
// two together or a restart silently downgrades a person's rename to a guess.
func (p *Pane) titleOriginSnapshot() nameOrigin {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.titleOrigin
}

// Info returns a frozen snapshot of this pane's identity and dimensions.
func (p *Pane) Info() PaneInfo {
	p.mu.Lock()
	cols, rows, title := p.cols, p.rows, p.Title
	p.mu.Unlock()
	return PaneInfo{
		PaneID: p.LocalID,
		Cols:   cols,
		Rows:   rows,
		Title:  title,
	}
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
		p.cleanupIntegration()
	})
}

func (p *Pane) cleanupIntegration() {
	p.integrationCleanupOnce.Do(func() {
		if p.integrationCleanup != nil {
			p.integrationCleanup()
		}
	})
}
