package sessiond

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/creack/pty"
)

// Pane owns one current immutable PTY root at a time. It streams only that
// root's output to its shared PaneBuffer and callbacks, accepts current-root
// input, and can transactionally replace the root without changing pane-local
// identity, dimensions, or scrollback.
type Pane struct {
	LocalID int
	Title   string // settable; OSC 0/2 title capture is a later phase

	// targetGeneration is assigned by Registry.PutPane and changes whenever a
	// pane registry identity is replaced. It is read only while Registry.mu is
	// held and binds close tickets independently of the root-process generation.
	targetGeneration uint64

	// SurfaceKind is "browser" for browser panes; empty string means "terminal".
	// Set once at construction; immutable thereafter.
	SurfaceKind string

	// Lock order:
	//
	//	Pane.lifecycleMu -> Pane.deliveryMu -> Server.mu (callbacks only;
	//	never while Pane.mu is held) -> Registry.mu -> Pane.mu -> paneRoot.mu
	//	-> PaneBuffer internal lock.
	//
	// Registry paths may take Registry.mu and then Pane.mu/paneRoot.mu, so they
	// never acquire lifecycleMu or deliveryMu. No callback, process, PTY, or
	// buffer operation runs while mu is held.
	lifecycleMu sync.Mutex
	deliveryMu  sync.Mutex
	mu          sync.Mutex

	cols int
	rows int

	// authorityConn is the conn currently authoritative for sizing this pane's
	// PTY (see ClaimAuthority/TouchAuthority/IsAuthoritative/ClearAuthorityIfOwner
	// below). nil means unclaimed — the first conn to claim wins.
	authorityConn *conn
	authorityAt   time.Time

	root        *paneRoot
	finalClosed bool
	buf         PaneBuffer
	callbacks   PaneCallbacks

	// replyTarget is nonnil only while the current root's chunk is being applied
	// to a VTBuffer under deliveryMu. The pane-local drain writes directly to
	// this exact immutable root and never recursively acquires deliveryMu.
	replyTarget atomic.Pointer[paneRoot]
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

// NewPaneWithOptions starts one exact structured command. It performs no shell,
// TERM, environment-inheritance, or working-directory transformation.
func NewPaneWithOptions(
	localID int,
	options PaneLaunchOptions,
	cols, rows int,
	buf PaneBuffer,
	callbacks PaneCallbacks,
) (*Pane, error) {
	launch, err := validatePaneLaunchOptions(options)
	if err != nil {
		return nil, err
	}
	generation, err := nextPaneRootGeneration()
	if err != nil {
		return nil, err
	}
	if buf == nil {
		buf = NewVTBuffer(cols, rows)
	}
	root, err := startPaneRoot(
		generation,
		launch,
		shellLifecycleCustom,
		"",
		nil,
		cols,
		rows,
	)
	if err != nil {
		return nil, errPaneRootStartFailed
	}
	p := newPaneFromRoot(localID, cols, rows, buf, callbacks, root)
	p.startCurrentRoot()
	return p, nil
}

// NewPane preserves the legacy default-shell and custom-command launch
// behavior. callbacks are captured before any read loop can publish effects.
func NewPane(
	localID int,
	argv []string,
	cols, rows int,
	buf PaneBuffer,
	onData func(localID int, data []byte),
	onExit func(localID int, exitCode int, runtimeMilliseconds int64),
	onPrompt func(localID int, msg *Message),
) (*Pane, error) {
	callbacks := PaneCallbacks{
		OnData:   onData,
		OnPrompt: onPrompt,
	}
	if onExit != nil {
		callbacks.OnExit = func(localID int, _ PaneRootIdentity, exitCode int, runtimeMilliseconds int64) {
			onExit(localID, exitCode, runtimeMilliseconds)
		}
	}
	return newPaneLegacy(localID, argv, cols, rows, buf, callbacks, true)
}

func newPaneLegacy(
	localID int,
	argv []string,
	cols, rows int,
	buf PaneBuffer,
	callbacks PaneCallbacks,
	autoStart bool,
) (*Pane, error) {
	generation, err := nextPaneRootGeneration()
	if err != nil {
		return nil, err
	}
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

	env := append(os.Environ(), "TERM=xterm-256color")
	env = append(env, launch.env...)
	cwd := ""
	if home := os.Getenv("HOME"); home != "" {
		cwd = home
	}
	root, err := startPaneRoot(
		generation,
		validatedPaneLaunchOptions{
			argv: clonePaneLaunchStrings(launch.argv),
			cwd:  cwd,
			env:  clonePaneLaunchStrings(env),
		},
		launch.source,
		launch.token,
		launch.cleanup,
		cols,
		rows,
	)
	if err != nil {
		return nil, fmt.Errorf("sessiond: start pane pty: %w", err)
	}
	p := newPaneFromRoot(localID, cols, rows, buf, callbacks, root)
	if autoStart {
		p.startCurrentRoot()
	}
	return p, nil
}

func newPaneFromRoot(
	localID, cols, rows int,
	buf PaneBuffer,
	callbacks PaneCallbacks,
	root *paneRoot,
) *Pane {
	p := &Pane{
		LocalID:   localID,
		cols:      cols,
		rows:      rows,
		root:      root,
		buf:       buf,
		callbacks: callbacks,
	}
	if vtb, ok := buf.(*VTBuffer); ok {
		go p.drainVTReplies(vtb)
	}
	return p
}

// startCurrentRoot starts the published root's read loop at most once. It is
// safe to call after construction and is a no-op for rootless or closed panes.
func (p *Pane) startCurrentRoot() {
	p.deliveryMu.Lock()
	p.mu.Lock()
	root := p.root
	current := root != nil && !p.finalClosed && p.SurfaceKind != "browser"
	p.mu.Unlock()
	if current {
		p.startRootReadLoop(root)
	}
	p.deliveryMu.Unlock()
}

// startRootReadLoop requires deliveryMu or equivalent unpublished ownership.
func (p *Pane) startRootReadLoop(root *paneRoot) {
	root.readOnce.Do(func() {
		root.mu.Lock()
		if root.retired {
			root.mu.Unlock()
			return
		}
		root.readStarted = true
		root.mu.Unlock()
		go p.readLoop(root)
	})
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

// readLoop owns only the immutable root it was given. Once that root is
// retired, reads may continue only long enough to discard bytes and reap it.
func (p *Pane) readLoop(root *paneRoot) {
	identity := root.identity
	chunk := make([]byte, 32*1024)
	for {
		n, err := root.ptmx.Read(chunk)
		if n > 0 {
			p.deliverRootData(root, identity, chunk[:n], time.Now())
		}
		if err != nil {
			break
		}
	}
	waitErr := root.cmd.Wait()
	root.markExited()
	root.cleanupRoot()
	exitCode := 0
	if root.cmd.ProcessState != nil {
		exitCode = root.cmd.ProcessState.ExitCode()
	} else if waitErr != nil {
		exitCode = -1
	}
	runtimeMs := time.Since(root.identity.StartedAt).Milliseconds()

	p.deliveryMu.Lock()
	p.mu.Lock()
	current := p.currentRootLocked(root, identity)
	p.mu.Unlock()
	if current && p.callbacks.OnExit != nil {
		p.callbacks.OnExit(p.LocalID, identity, exitCode, runtimeMs)
	}
	p.deliveryMu.Unlock()
}

func (p *Pane) deliverRootData(
	root *paneRoot,
	identity PaneRootIdentity,
	data []byte,
	observedAt time.Time,
) {
	p.deliveryMu.Lock()
	defer p.deliveryMu.Unlock()

	p.mu.Lock()
	current := p.currentRootLocked(root, identity)
	p.mu.Unlock()
	if !current {
		return
	}

	// Visible effect order is part of the pane contract.
	p.observeLifecycleData(root, data, observedAt)
	if code, prompted := scanOSC133(data); prompted && p.callbacks.OnPrompt != nil {
		p.callbacks.OnPrompt(p.LocalID, &Message{Type: TypeShellPrompt, ExitCode: code})
	}
	if p.buf != nil {
		p.replyTarget.Store(root)
		func() {
			defer p.replyTarget.CompareAndSwap(root, nil)
			_, _ = p.buf.Write(data)
		}()
	}
	if p.callbacks.OnData != nil {
		copied := make([]byte, len(data))
		copy(copied, data)
		p.callbacks.OnData(p.LocalID, copied)
	}
}

// drainVTReplies is the pane's single VT response drain. It never captures an
// initial PTY and never calls Pane.Write: each response is offered directly to
// the exact root published around the synchronous PaneBuffer.Write.
func (p *Pane) drainVTReplies(vtb *VTBuffer) {
	response := make([]byte, 4096)
	for {
		n, err := vtb.Read(response)
		if n > 0 {
			if root := p.replyTarget.Load(); root != nil {
				root.writeReply(response[:n])
			}
		}
		if err != nil {
			return
		}
	}
}

func (p *Pane) currentRootLocked(root *paneRoot, identity PaneRootIdentity) bool {
	return !p.finalClosed &&
		p.SurfaceKind != "browser" &&
		root != nil &&
		p.root == root &&
		root.identity == identity &&
		identity.Generation != 0
}

// CurrentRootIdentity returns a copy of the current immutable root identity.
func (p *Pane) CurrentRootIdentity() (PaneRootIdentity, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	root := p.root
	if root == nil ||
		root.identity.Generation == 0 ||
		p.finalClosed ||
		p.SurfaceKind == "browser" {
		return PaneRootIdentity{}, false
	}
	return root.identity, true
}

// ProcessGeneration returns the current root generation or zero for a
// rootless, browser, or closed pane.
func (p *Pane) ProcessGeneration() uint64 {
	identity, ok := p.CurrentRootIdentity()
	if !ok {
		return 0
	}
	return identity.Generation
}

// ReplaceRoot transactionally starts and publishes one exact structured root.
// Any failure before publication destroys only the private candidate.
func (p *Pane) ReplaceRoot(expectedGeneration uint64, options PaneLaunchOptions) (PaneRootIdentity, error) {
	launch, err := validatePaneLaunchOptions(options)
	if err != nil || expectedGeneration == 0 {
		return PaneRootIdentity{}, errPaneRootReplacementFailed
	}

	p.lifecycleMu.Lock()
	defer p.lifecycleMu.Unlock()

	p.deliveryMu.Lock()
	p.mu.Lock()
	incumbent := p.root
	if incumbent == nil ||
		!p.currentRootLocked(incumbent, incumbent.identity) ||
		incumbent.identity.Generation != expectedGeneration {
		p.mu.Unlock()
		p.deliveryMu.Unlock()
		return PaneRootIdentity{}, errPaneRootReplacementFailed
	}
	incumbentIdentity := incumbent.identity
	cols, rows := p.cols, p.rows
	p.mu.Unlock()
	p.deliveryMu.Unlock()

	generation, err := nextPaneRootGeneration()
	if err != nil {
		return PaneRootIdentity{}, errPaneRootReplacementFailed
	}
	candidate, err := startPaneRoot(
		generation,
		launch,
		shellLifecycleCustom,
		"",
		nil,
		cols,
		rows,
	)
	if err != nil {
		return PaneRootIdentity{}, errPaneRootReplacementFailed
	}

	p.deliveryMu.Lock()
	p.mu.Lock()
	if !p.currentRootLocked(incumbent, incumbentIdentity) {
		p.mu.Unlock()
		p.deliveryMu.Unlock()
		candidate.stop()
		return PaneRootIdentity{}, errPaneRootReplacementFailed
	}
	latestCols, latestRows := p.cols, p.rows
	p.mu.Unlock()

	if err := pty.Setsize(candidate.ptmx, &pty.Winsize{
		Rows: uint16(latestRows),
		Cols: uint16(latestCols),
	}); err != nil {
		p.deliveryMu.Unlock()
		candidate.stop()
		return PaneRootIdentity{}, errPaneRootReplacementFailed
	}

	p.mu.Lock()
	if !p.currentRootLocked(incumbent, incumbentIdentity) ||
		p.cols != latestCols ||
		p.rows != latestRows {
		p.mu.Unlock()
		p.deliveryMu.Unlock()
		candidate.stop()
		return PaneRootIdentity{}, errPaneRootReplacementFailed
	}
	incumbent.retire()
	p.root = candidate
	p.mu.Unlock()

	p.replyTarget.CompareAndSwap(incumbent, nil)
	p.startRootReadLoop(candidate)
	p.deliveryMu.Unlock()

	incumbent.stop()
	return candidate.identity, nil
}

// Write sends input to the child's stdin (the PTY master).
// For rootless, browser, or closed panes, input is silently discarded.
func (p *Pane) Write(input []byte) (int, error) {
	p.deliveryMu.Lock()
	defer p.deliveryMu.Unlock()
	p.mu.Lock()
	root := p.root
	current := root != nil && !p.finalClosed && p.SurfaceKind != "browser"
	p.mu.Unlock()
	if !current || root.ptmx == nil {
		return 0, nil
	}
	return root.ptmx.Write(input)
}

// Resize updates the stored dimensions, resizes the PTY, and notifies the
// buffer so that grid-aware implementations (VTBuffer) can resize their
// internal cell grid to match.
func (p *Pane) Resize(cols, rows int) error {
	p.deliveryMu.Lock()
	defer p.deliveryMu.Unlock()
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
	root := p.root
	current := root != nil && !p.finalClosed && p.SurfaceKind != "browser"
	p.mu.Unlock()
	var err error
	if current && root.ptmx != nil {
		err = pty.Setsize(root.ptmx, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
	}
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

// Info returns a frozen snapshot of this pane's identity and dimensions.
func (p *Pane) Info() PaneInfo {
	p.mu.Lock()
	cols, rows, title := p.cols, p.rows, p.Title
	surfaceKind := p.SurfaceKind
	p.mu.Unlock()
	return PaneInfo{
		PaneID:      p.LocalID,
		Cols:        cols,
		Rows:        rows,
		Title:       title,
		SurfaceKind: surfaceKind,
	}
}

// Close retires the current root and permanently closes the pane. Retirement is
// published before any OS effect, so a racing read loop cannot emit effects.
func (p *Pane) Close() {
	p.lifecycleMu.Lock()
	p.deliveryMu.Lock()
	p.mu.Lock()
	if p.finalClosed {
		p.mu.Unlock()
		p.deliveryMu.Unlock()
		p.lifecycleMu.Unlock()
		return
	}
	p.finalClosed = true
	root := p.root
	if root != nil {
		root.retire()
	}
	p.root = nil
	p.mu.Unlock()

	if root != nil {
		p.replyTarget.CompareAndSwap(root, nil)
	}
	p.deliveryMu.Unlock()
	if root != nil {
		root.stop()
	}
	p.lifecycleMu.Unlock()
}

// NewBrowserPane returns a client-rendered browser pane handle: a registry entry
// with the given workspace-local id, surfaceKind "browser", and no PTY. It holds
// no OS resources — the browser engine lives entirely on the client. Write,
// Resize, Replay, ReplayFrom, Seq, and Close all follow the existing bufferless
// (root == nil, buf == nil) pattern already handled by this file's methods.
func NewBrowserPane(localID int) *Pane {
	return &Pane{
		LocalID:     localID,
		SurfaceKind: "browser",
	}
}
