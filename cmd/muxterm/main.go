package main

import (
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/user/muxterm/internal/deploy"
	"github.com/user/muxterm/internal/server"
	"github.com/user/muxterm/internal/service"
	"github.com/user/muxterm/internal/tmux"
	webstatic "github.com/user/muxterm/web"
)

var version = "dev"

func main() {
	cfg, err := ParseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	switch cfg.Mode {
	case "local":
		if err := runLocal(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "serve":
		if err := runServe(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "deploy":
		if err := runDeploy(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "install":
		if err := runInstall(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "uninstall":
		if err := runUninstall(); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "version":
		fmt.Printf("muxterm %s\n", version)
	}
}

// runLocal starts muxterm in local mode: launches tmux, starts the HTTP server
// on localhost, opens a browser, and blocks until shutdown.
func runLocal(cfg Config) error {
	pool := newControllerPool(startTmuxControl)
	adapter := &controllerAdapter{pool: pool}
	srv := server.New(server.Config{
		Addr:     cfg.Addr,
		StaticFS: mustSubFS(webstatic.Dist, "dist"),
	}, adapter)
	syncer := newStateSyncCoalescer(adapter, srv.Hub())

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// The supervisor owns the tmux lifecycle: it attaches a session, runs until
	// the session dies (e.g. last window closed), then waits for the user to ask
	// for a new one. The HTTP server stays up the whole time — closing the last
	// window shows the "no active session" page, it never shuts muxterm down.
	go supervisePool(ctx, pool, srv.Hub(), syncer)
	go periodicStateSync(ctx, adapter, srv.Hub())
	go openBrowser("http://" + cfg.Addr)

	log.Printf("muxterm listening on %s", cfg.Addr)
	return srv.ListenAndServe(ctx)
}

// runServe starts muxterm in serve mode: launches tmux, starts the HTTP server
// with token auth on the configured address, and blocks until shutdown.
func runServe(cfg Config) error {
	// Auto-generate secret if not provided
	secret := cfg.Secret
	if secret == "" {
		s, err := server.GenerateSecret()
		if err != nil {
			return fmt.Errorf("generate secret: %w", err)
		}
		secret = s
	}

	pool := newControllerPool(startTmuxControl)
	adapter := &controllerAdapter{pool: pool}
	srv := server.New(server.Config{
		Addr:     cfg.Addr,
		Secret:   secret,
		StaticFS: mustSubFS(webstatic.Dist, "dist"),
	}, adapter)
	syncer := newStateSyncCoalescer(adapter, srv.Hub())

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Supervisor owns the tmux lifecycle (see runLocal for rationale): the HTTP
	// server survives session death; closing the last window shows the
	// "no active session" page rather than tearing muxterm down.
	go supervisePool(ctx, pool, srv.Hub(), syncer)
	go periodicStateSync(ctx, adapter, srv.Hub())

	// Generate and print access token
	token, err := server.GenerateToken(secret)
	if err != nil {
		return fmt.Errorf("generate token: %w", err)
	}
	log.Printf("muxterm listening on %s", cfg.Addr)
	log.Printf("access token: %s", token)

	return srv.ListenAndServe(ctx)
}

// runDeploy deploys muxterm to a remote host via SSH.
func runDeploy(cfg Config) error {
	d, err := deploy.New()
	if err != nil {
		return fmt.Errorf("deploy init: %w", err)
	}
	return d.Deploy(cfg.Target)
}

// runInstall installs muxterm as a system service. If no secret is provided,
// one is auto-generated and printed to the user.
func runInstall(cfg Config) error {
	secret := cfg.Secret
	if secret == "" {
		s, err := server.GenerateSecret()
		if err != nil {
			return fmt.Errorf("generate secret: %w", err)
		}
		secret = s
	}
	svcCfg := service.ServiceConfig{
		Addr:   cfg.Addr,
		Secret: secret,
	}
	if err := service.Install(svcCfg); err != nil {
		return err
	}
	fmt.Printf("muxterm installed and running at http://%s\n", cfg.Addr)
	if cfg.Secret == "" {
		fmt.Printf("auto-generated secret: %s\n", secret)
	}
	return nil
}

// runUninstall removes the muxterm system service.
func runUninstall() error {
	if err := service.Uninstall(); err != nil {
		return err
	}
	fmt.Println("muxterm service removed")
	return nil
}

// runWithGracefulShutdown blocks until srv stops or a SIGINT/SIGTERM is received,
// then performs a graceful shutdown. This consolidates the signal-handling pattern
// shared by runLocal and runServe and is the canonical way to start the server
// in a signal-aware manner from a *server.Server value.
func runWithGracefulShutdown(srv *server.Server) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return srv.ListenAndServe(ctx)
}

// periodicStateSync pushes the live tmux state to all connected clients every 5s.
// Using LiveState() (direct tmux query) ensures the browser always converges to
// ground truth even if %window-close or other structural events were dropped.
func periodicStateSync(ctx context.Context, engine server.TmuxEngine, hub *server.Hub) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			state, err := engine.LiveState()
			if err != nil {
				log.Printf("periodicStateSync: live query failed: %v", err)
				continue
			}
			hub.BroadcastEvent("state", state)
		case <-ctx.Done():
			return
		}
	}
}

// openBrowser opens the given URL in the default browser. Non-fatal if it fails.
func openBrowser(url string) {
	var cmd string
	switch runtime.GOOS {
	case "darwin":
		cmd = "open"
	case "linux":
		cmd = "xdg-open"
	default:
		return
	}
	if err := exec.Command(cmd, url).Start(); err != nil {
		log.Printf("failed to open browser: %v", err)
	}
}

// startTmuxControl starts a tmux control-mode session and returns the controller,
// event channel, and a cleanup function. The caller must defer cleanup().
//
// tmux -CC requires a TTY; we use github.com/creack/pty to allocate one.
// The PTY master (ptmx) is used for both reading events (tmux stdout) and
// writing commands (tmux stdin). tmux -CC disables echo so commands we write
// are not echoed back into the event stream.
//
// attach-session does not resend window/layout events on connect, so the
// initial state is bootstrapped by querying tmux directly before the
// event-reading goroutine starts.
// applyMuxtermConfig sets the tmux options that muxterm requires.
// These are applied globally so they take effect immediately in the session.
func applyMuxtermConfig(ctrl *tmux.Controller) error {
	cmds := ctrl.Commands()
	settings := []struct{ key, val string }{
		{"mouse", "on"},            // mouse wheel, click, drag — required for scroll forwarding
		{"focus-events", "on"},     // terminal focus in/out events (nice-to-have)
		{"history-limit", "10000"}, // tmux owns scrollback; ensure enough depth for capture-pane replay
	}
	var errs []string
	for _, s := range settings {
		if err := cmds.SetOption(true, s.key, s.val); err != nil {
			errs = append(errs, fmt.Sprintf("set -g %s %s: %v", s.key, s.val, err))
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil
}

func startTmuxControl(sessionName string) (*tmux.Controller, *os.File, chan tmux.Event, func(), error) {
	cmd := exec.Command("tmux", "-CC", "attach-session", "-t", sessionName)

	// Allocate a PTY. tmux -CC exits immediately with "%exit" when not
	// connected to a terminal, so a PTY is required.
	ptmx, err := pty.Start(cmd)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("start tmux with pty: %w", err)
	}

	events := make(chan tmux.Event, 4096)
	ctrl := tmux.NewController(tmux.ControllerConfig{
		Reader: ptmx, // reads tmux event stream from PTY master
		Writer: ptmx, // writes commands to tmux via PTY master
		Events: events,
	})

	// Bootstrap initial state BEFORE starting the event goroutine.
	// attach-session only sends %session-changed on connect; windows/panes
	// must be queried explicitly. Doing this before ctrl.Run() ensures the
	// bootstrap and subsequent %session-changed events are serialised.
	if err := bootstrapTmuxState(ctrl.State(), sessionName); err != nil {
		log.Printf("tmux bootstrap: %v (continuing)", err)
	}

	go ctrl.Run()

	cleanup := func() {
		// Stop the controller first so any in-progress blocking send in Run()
		// unblocks via the done channel before we close the PTY beneath it.
		ctrl.Stop()
		ptmx.Close()
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
		cmd.Wait()
	}

	return ctrl, ptmx, events, cleanup, nil
}

// queryCurrentState asks tmux directly for the live session/window/pane
// structure. It is used both at startup (to bootstrap the in-memory state)
// and periodically (to produce authoritative snapshots for clients).
// Because tmux is the source of truth, this always reflects reality — unlike
// the in-memory state which can miss %window-close events.
func queryCurrentState(sessionName string) (*tmux.TmuxState, error) {
	state := &tmux.TmuxState{}
	err := bootstrapTmuxState(state, sessionName)
	return state, err
}

// bootstrapTmuxState queries the current tmux state (sessions, windows, panes)
// using regular tmux commands and applies it to state. This is necessary because
// attach-session in control mode only sends %session-changed, not %window-add or
// %layout-change, so the state would otherwise have sessions but no windows.
func bootstrapTmuxState(state *tmux.TmuxState, sessionName string) error {
	// Step 1: resolve session ID.
	out, err := exec.Command("tmux", "list-sessions",
		"-F", "#{session_name}\t#{session_id}").Output()
	if err != nil {
		return fmt.Errorf("list-sessions: %w", err)
	}
	sessionID := ""
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) == 2 && parts[0] == sessionName {
			sessionID = parts[1]
			break
		}
	}
	if sessionID == "" {
		return fmt.Errorf("session %q not found in list-sessions output", sessionName)
	}

	// Step 2: create/update the session entry and mark it active.
	state.ApplySessionChanged(sessionID, sessionName)

	// Step 3: list windows with layout and active flag.
	out, err = exec.Command("tmux", "list-windows", "-t", sessionName,
		"-F", "#{window_id}\t#{window_name}\t#{window_layout}\t#{window_active}").Output()
	if err != nil {
		return fmt.Errorf("list-windows: %w", err)
	}
	activeWindowID := ""
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 4)
		if len(parts) < 4 {
			continue
		}
		windowID, name, layout, activeFlag := parts[0], parts[1], parts[2], parts[3]
		state.ApplyWindowAdd(windowID)
		state.ApplyWindowRenamed(windowID, name)
		state.ApplyLayoutChange(windowID, layout)
		if activeFlag == "1" {
			activeWindowID = windowID
		}


	}

	// Step 4: mark the active window (sets Window.Active flags).
	if activeWindowID != "" {
		state.ApplySessionWindowChanged(sessionID, activeWindowID)
	}

	return nil
}

// mustSubFS returns a sub-FS rooted at dir, panicking on error (embed paths
// are fixed at compile time so a panic here means a programming error).
func mustSubFS(fsys fs.FS, dir string) fs.FS {
	sub, err := fs.Sub(fsys, dir)
	if err != nil {
		panic(fmt.Sprintf("web embed sub: %v", err))
	}
	return sub
}

func printEvent(ev tmux.Event) {
	switch e := ev.(type) {
	case tmux.OutputEvent:
		data := string(e.Data)
		data = strings.ReplaceAll(data, "\n", `\n`)
		data = strings.ReplaceAll(data, "\r", `\r`)
		if len(data) > 80 {
			data = data[:80] + "..."
		}
		fmt.Printf("[OUTPUT]     %s %s\n", e.PaneID, data)
	case tmux.LayoutChangeEvent:
		fmt.Printf("[LAYOUT]     %s %s\n", e.WindowID, e.Layout)
	case tmux.WindowAddEvent:
		fmt.Printf("[WIN-ADD]    %s\n", e.WindowID)
	case tmux.WindowCloseEvent:
		fmt.Printf("[WIN-CLOSE]  %s\n", e.WindowID)
	case tmux.WindowRenamedEvent:
		fmt.Printf("[WIN-RENAME] %s %s\n", e.WindowID, e.Name)
	case tmux.SessionChangedEvent:
		fmt.Printf("[SESS-CHG]   %s %s\n", e.SessionID, e.Name)
	case tmux.SessionWindowChangedEvent:
		fmt.Printf("[SESS-WIN-CHG] %s %s\n", e.SessionID, e.WindowID)
	case tmux.SessionRenamedEvent:
		fmt.Printf("[SESS-RENAME] %s\n", e.Name)
	case tmux.CommandResultEvent:
		status := "OK"
		if !e.Success {
			status = "ERROR"
		}
		fmt.Printf("[CMD-RESULT] %s (%d lines)\n", status, len(e.Lines))
	default:
		fmt.Printf("[UNKNOWN]    %T\n", ev)
	}
}

// controllerAdapter wraps a tmux.Controller to satisfy server.TmuxEngine.
// The Controller's CommandWriter has compatible methods but with slightly
// different names and signatures in a few cases.
// errNoSession is returned by adapter methods when there is no live tmux
// control connection (e.g. the last window was closed and tmux destroyed the
// session). Commands are silently dropped in this state — the UI shows the
// "no active session" page until the user creates a new one.
var errNoSession = fmt.Errorf("no active tmux session")

type controllerAdapter struct {
	pool *controllerPool
}

func (a *controllerAdapter) State() *tmux.TmuxState {
	c := a.pool.controller()
	if c == nil {
		return &tmux.TmuxState{Sessions: []tmux.Session{}}
	}
	return c.State()
}

func (a *controllerAdapter) SendKeys(paneID, keys string) error {
	c := a.pool.controller()
	if c == nil {
		return errNoSession
	}
	// Use hex-encoded send-keys (-H) so raw terminal bytes (escape sequences,
	// backspace, Ctrl codes) pass through unmangled instead of going through
	// tmux's key-binding interpreter.
	return c.Commands().SendKeysLiteral(paneID, []byte(keys))
}

func (a *controllerAdapter) SelectWindow(windowID string) error {
	c := a.pool.controller()
	if c == nil {
		return errNoSession
	}
	return c.Commands().SelectWindow(windowID)
}

func (a *controllerAdapter) SelectPane(paneID string) error {
	c := a.pool.controller()
	if c == nil {
		return errNoSession
	}
	return c.Commands().SelectPane(paneID)
}

func (a *controllerAdapter) SplitWindow(targetPaneID string, horizontal bool) error {
	c := a.pool.controller()
	if c == nil {
		return errNoSession
	}
	return c.Commands().SplitWindow(targetPaneID, horizontal)
}

func (a *controllerAdapter) ResizePane(paneID string, cols, rows int) error {
	// Remember the size even if there's no live session — so the next attached
	// session can be sized to match the browser immediately.
	a.pool.rememberSize(cols, rows)

	c := a.pool.controller()
	if c == nil {
		return errNoSession
	}

	// In control mode (-CC), tmux does NOT read the PTY winsize for the client —
	// it learns the client size from `refresh-client -C WxH`. With
	// `window-size latest` (set in applyMuxtermConfig), the window then follows
	// this client size. So refresh-client is the ONE lever that resizes the
	// window. (resize-window gets clamped to the client size; pty.Setsize is
	// ignored by control-mode clients — both appeared to "do nothing".)
	return c.Commands().RefreshClientSize(cols, rows)
}

func (a *controllerAdapter) NewWindow(name string) error {
	c := a.pool.controller()
	if c == nil {
		return errNoSession
	}
	return c.Commands().NewWindow(name)
}

func (a *controllerAdapter) KillPane(paneID string) error {
	c := a.pool.controller()
	if c == nil {
		return errNoSession
	}
	return c.Commands().ClosePane(paneID)
}

func (a *controllerAdapter) CloseWindow(windowID string) error {
	c := a.pool.controller()
	if c == nil {
		return errNoSession
	}
	return c.Commands().CloseWindow(windowID)
}

func (a *controllerAdapter) RenameWindow(windowID, name string) error {
	c := a.pool.controller()
	if c == nil {
		return errNoSession
	}
	return c.Commands().RenameWindow(windowID, name)
}

// NewSession is the "create a session" request from the empty-state page. When
// no control connection is live (the common case — the last window was closed),
// we signal the supervisor to attach a fresh session rather than sending a
// command down a dead connection. When a session IS live this is a no-op: the
// single-session UI already has its session.
func (a *controllerAdapter) NewSession(name string) error {
	if a.pool.controller() == nil {
		a.pool.requestRecreate()
		return nil
	}
	return nil
}

// AttachSession requests switching the active tmux session to name.
func (a *controllerAdapter) AttachSession(name string) error {
	a.pool.requestSwitch(name)
	return nil
}

// SessionList returns a snapshot of all running tmux sessions.
// Returns nil if tmux is not available or no sessions exist.
func (a *controllerAdapter) SessionList() []server.SessionInfo {
	out, err := exec.Command("tmux", "list-sessions", "-F", "#{session_name}\t#{session_windows}").Output()
	if err != nil {
		return nil
	}
	var result []server.SessionInfo
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 {
			continue
		}
		n, _ := strconv.Atoi(parts[1])
		result = append(result, server.SessionInfo{Name: parts[0], Windows: n})
	}
	return result
}

// LiveState queries tmux directly for the current session/window/pane structure.
// Always accurate regardless of missed %window-close or other dropped events.
// Returns an empty state (not an error) when no session is attached, so the
// periodic sync keeps clients on the "no active session" page.
func (a *controllerAdapter) LiveState() (*tmux.TmuxState, error) {
	c := a.pool.controller()
	if c == nil {
		return &tmux.TmuxState{Sessions: []tmux.Session{}}, nil
	}
	name := c.State().ActiveSessionName()
	if name == "" {
		return c.State(), nil // not bootstrapped yet, return cached state
	}
	return queryCurrentState(name)
}

// captureScrollbackLines is how many lines of tmux history to replay on
// connect/refresh. tmux owns the scrollback buffer (history-limit 10000);
// replaying this many lines on reconnect restores what the user could previously
// scroll through. Must be ≤ history-limit set in applyMuxtermConfig.
const captureScrollbackLines = 10000

func (a *controllerAdapter) CapturePaneContent(paneID string) ([]byte, error) {
	// Capture scrollback history + the current screen. With xterm.js (a real
	// terminal emulator with its own scrollback buffer), writing history lines
	// fills the buffer and the viewport stays pinned to the bottom — so a
	// refresh restores everything the user could previously scroll through.
	out, err := exec.Command("tmux", "capture-pane", "-t", paneID, "-p", "-e",
		"-S", fmt.Sprintf("-%d", captureScrollbackLines)).Output()
	if err != nil {
		return nil, err
	}

	// Strip tmux's DCS pass-through wrappers (\033Ptmux;...\033\) around
	// terminal control sequences. (xterm.js handles standard DCS, but tmux's
	// nested control-mode variant would still surface as stray "tmux;" text.)
	out = stripDCS(out)

	// Split into lines and drop trailing blank rows. tmux pads the screen
	// region with empty lines below the prompt; if we wrote those, the cursor
	// would land below the prompt. Dropping them puts the last line = prompt.
	lines := bytes.Split(out, []byte("\n"))
	end := len(lines)
	for end > 0 && len(bytes.TrimRight(lines[end-1], " \t\r")) == 0 {
		end--
	}
	lines = lines[:end]

	// Join with \r\n (each line starts at column 0). Deliberately NO trailing
	// newline: that leaves the cursor at the end of the last line — exactly
	// where a shell cursor sits, on the prompt. xterm.js gets the vertical
	// position right on its own; no cursor-up math needed (that was a
	// wterm-era workaround).
	out = bytes.Join(lines, []byte("\r\n"))

	// Nudge the cursor to tmux's real column on that last line (handles
	// prompts where the cursor isn't flush against the rendered text).
	if meta, mErr := exec.Command("tmux", "display-message", "-pt", paneID,
		"#{cursor_x}").Output(); mErr == nil {
		if cx, cErr := strconv.Atoi(strings.TrimSpace(string(meta))); cErr == nil && cx >= 0 {
			out = append(out, []byte(fmt.Sprintf("\033[%dG", cx+1))...)
		}
	}

	return out, nil
}

// stripDCS removes DCS (Device Control String) pass-through sequences from
// terminal output. tmux wraps escape sequences from pane applications in
// DCS format (\033Ptmux;...\033\) when forwarding to control-mode clients.
// wterm doesn't handle this DCS variant and renders "tmux;" as literal text.
func stripDCS(data []byte) []byte {
	// Fast path: skip if no DCS introducer present.
	if !bytes.Contains(data, []byte{0x1b, 'P'}) {
		return data
	}
	result := make([]byte, 0, len(data))
	i := 0
	for i < len(data) {
		// 7-bit DCS start: ESC P (0x1b 0x50)
		if i+1 < len(data) && data[i] == 0x1b && data[i+1] == 'P' {
			i += 2 // skip ESC P
			// Scan forward to ST: either ESC \ (0x1b 0x5c) or 8-bit ST (0x9c)
			for i < len(data) {
				if data[i] == 0x9c { // 8-bit ST
					i++
					break
				}
				if i+1 < len(data) && data[i] == 0x1b && data[i+1] == '\\' { // 7-bit ST
					i += 2
					break
				}
				i++
			}
			continue
		}
		// 8-bit DCS start: 0x90
		if data[i] == 0x90 {
			i++
			for i < len(data) {
				if data[i] == 0x9c {
					i++
					break
				}
				if i+1 < len(data) && data[i] == 0x1b && data[i+1] == '\\' {
					i += 2
					break
				}
				i++
			}
			continue
		}
		result = append(result, data[i])
		i++
	}
	return result
}

// emptyTmuxState is the state broadcast when no tmux session is attached. The
// empty (non-nil) Sessions slice marshals to `[]`, which the browser reads as
// "no active session" and renders the create-session page.
func emptyTmuxState() *tmux.TmuxState {
	return &tmux.TmuxState{Sessions: []tmux.Session{}}
}

// supervisePool owns the tmux control lifecycle for a pool of sessions. On boot
// it attaches the first session; then it blocks waiting for switch requests,
// recreate requests, or context cancellation.
func supervisePool(ctx context.Context, pool *controllerPool, hub *server.Hub, syncer *stateSyncCoalescer) {
	name, err := tmux.EnsureRunning()
	if err != nil {
		log.Printf("supervisor: ensure session: %v", err)
	} else {
		startSession(ctx, pool, hub, syncer, name, true)
	}

	for {
		select {
		case <-ctx.Done():
			return
		case name := <-pool.switchReq:
			startSession(ctx, pool, hub, syncer, name, true)
		case <-pool.recreate:
			name, err := tmux.EnsureRunning()
			if err != nil {
				log.Printf("supervisor: ensure session: %v", err)
				continue
			}
			startSession(ctx, pool, hub, syncer, name, true)
		}
	}
}

// startSession attaches (or reuses) a named tmux session and, if newly attached,
// configures it and launches an event-reader goroutine. It always triggers a
// state push and logs progress.
func startSession(ctx context.Context, pool *controllerPool, hub *server.Hub, syncer *stateSyncCoalescer, name string, activate bool) {
	wasExisting := pool.get(name) != nil
	cs, err := pool.ensure(name)
	if err != nil {
		log.Printf("supervisor: startSession %q: %v", name, err)
		return
	}
	if activate {
		pool.setActive(name)
	}
	if !wasExisting {
		if err := applyMuxtermConfig(cs.ctrl); err != nil {
			log.Printf("warn: tmux config for %q: %v", name, err)
		}
		// Size the fresh session to the browser's last-known dimensions.
		if cols, rows := pool.size(); cols > 0 && rows > 0 {
			_ = cs.ctrl.Commands().RefreshClientSize(cols, rows)
		}
		go func() {
			wireEvents(name, pool, cs.events, hub, cs.ctrl, syncer)
			pool.remove(name)
			if len(pool.names()) == 0 {
				hub.BroadcastEvent("state", emptyTmuxState())
			} else {
				syncer.trigger()
			}
			log.Printf("supervisor: session %q ended", name)
		}()
	}
	syncer.trigger()
	log.Printf("supervisor: attached to session %q (activate=%v)", name, activate)
}

// stateSyncCoalescer collapses a burst of structural tmux events into a single
// authoritative state push. tmux emits several events for one logical action
// (e.g. new-window → window-add + layout-change + session-window-changed); rather
// than send each as a fragile incremental delta, we wait a short quiet period and
// then push ONE full snapshot queried live from tmux. The browser reconciles
// idempotently, so it always converges to ground truth — no partial data, no
// duplicates, no event-ordering hazards.
type stateSyncCoalescer struct {
	engine server.TmuxEngine
	hub    *server.Hub
	mu     sync.Mutex
	timer  *time.Timer
}

func newStateSyncCoalescer(engine server.TmuxEngine, hub *server.Hub) *stateSyncCoalescer {
	return &stateSyncCoalescer{engine: engine, hub: hub}
}

// trigger schedules an authoritative state push, coalescing rapid calls into one.
func (c *stateSyncCoalescer) trigger() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.timer != nil {
		c.timer.Stop()
	}
	c.timer = time.AfterFunc(40*time.Millisecond, func() {
		state, err := c.engine.LiveState()
		if err != nil {
			log.Printf("stateSync: live query failed: %v", err)
			return
		}
		c.hub.BroadcastEvent("state", state)
	})
}

// wireEvents reads tmux events from the channel and routes them. Structural
// events (windows/panes/sessions appearing, closing, renaming, relayout) all
// funnel into a single coalesced authoritative state push so the browser's
// structure always reflects tmux truth. Only pane OUTPUT (terminal bytes) and
// content captures stream as deltas.
// It exits when the events channel is closed (controller stopped).
func wireEvents(sessionName string, pool *controllerPool, events <-chan tmux.Event, hub *server.Hub, ctrl *tmux.Controller, sync *stateSyncCoalescer) {
	for ev := range events {
		switch e := ev.(type) {
		case tmux.OutputEvent:
			// First-attached-wins ownership: skip output for panes owned by
			// another session (avoids duplicate broadcasts when sessions share panes).
			if !pool.claimPane(sessionName, e.PaneID) {
				continue
			}
			// Strip tmux DCS pass-through wrappers (\033Ptmux;...\033\) around
			// terminal escape sequences (OSC, shell integration, etc.).
			data := stripDCS(e.Data)
			hub.BroadcastPaneOutput(e.PaneID, data)

		// ── Structural events → one coalesced authoritative state snapshot ──
		case tmux.WindowAddEvent:
			sync.trigger()
		case tmux.WindowCloseEvent:
			sync.trigger()
		case tmux.WindowRenamedEvent:
			sync.trigger()
		case tmux.LayoutChangeEvent:
			sync.trigger()
		case tmux.SessionChangedEvent:
			sync.trigger()
		case tmux.SessionWindowChangedEvent:
			sync.trigger()
			// NOTE: We intentionally do NOT capture-pane on window switch.
			// Clients keep a persistent xterm terminal per pane (the terminal
			// registry), seeded once on connect via sendStateSync and kept
			// current by the continuous %output feed (tmux -CC streams output
			// for ALL panes regardless of active window). Re-capturing here
			// would write a screenful on top of an already-populated terminal,
			// duplicating content on every tab switch.
		case tmux.SessionsChangedEvent:
			hub.BroadcastSessionList()
			sync.trigger()
		case tmux.PaneModeChangedEvent:
			// Pane mode (copy-mode etc.) — structural enough to resync.
			sync.trigger()
		case tmux.ExitEvent:
			// Control connection is exiting (session destroyed). Don't broadcast
			// "detached" — that would flash the reconnect overlay. wireEvents is
			// about to return; the supervisor takes over and shows the
			// "no active session" page instead.
			return
		}
	}
}


