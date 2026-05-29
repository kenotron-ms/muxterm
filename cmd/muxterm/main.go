package main

import (
	"context"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"

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
	// Gap 2 fix: use EnsureRunning() to detect/start tmux and get session name.
	sessionName, err := tmux.EnsureRunning()
	if err != nil {
		return fmt.Errorf("tmux: %w", err)
	}

	ctrl, events, cleanup, err := startTmuxControl(sessionName)
	if err != nil {
		return err
	}
	defer cleanup()

	adapter := &controllerAdapter{ctrl: ctrl}
	// Gap 1 fix: serve embedded frontend via StaticFS.
	srv := server.New(server.Config{
		Addr:     cfg.Addr,
		StaticFS: mustSubFS(webstatic.Dist, "dist"),
	}, adapter)
	// Gap 3 fix: broadcast "detached" to all clients when tmux exits.
	go func() {
		wireEvents(events, srv.Hub())
		srv.Hub().BroadcastEvent("detached", map[string]string{"reason": "tmux disconnected"})
	}()

	go openBrowser("http://" + cfg.Addr)

	log.Printf("muxterm listening on %s", cfg.Addr)
	return runWithGracefulShutdown(srv)
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

	// Gap 2 fix: use EnsureRunning() to detect/start tmux and get session name.
	sessionName, err := tmux.EnsureRunning()
	if err != nil {
		return fmt.Errorf("tmux: %w", err)
	}

	ctrl, events, cleanup, err := startTmuxControl(sessionName)
	if err != nil {
		return err
	}
	defer cleanup()

	adapter := &controllerAdapter{ctrl: ctrl}
	// Gap 1 fix: serve embedded frontend via StaticFS.
	srv := server.New(server.Config{
		Addr:     cfg.Addr,
		Secret:   secret,
		StaticFS: mustSubFS(webstatic.Dist, "dist"),
	}, adapter)
	// Gap 3 fix: broadcast "detached" to all clients when tmux exits.
	go func() {
		wireEvents(events, srv.Hub())
		srv.Hub().BroadcastEvent("detached", map[string]string{"reason": "tmux disconnected"})
	}()

	// Generate and print access token
	token, err := server.GenerateToken(secret)
	if err != nil {
		return fmt.Errorf("generate token: %w", err)
	}
	log.Printf("muxterm listening on %s", cfg.Addr)
	log.Printf("access token: %s", token)

	return runWithGracefulShutdown(srv)
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

// runWithGracefulShutdown starts the server and blocks until SIGINT or SIGTERM,
// then performs a graceful shutdown (5s timeout handled by server.ListenAndServe).
func runWithGracefulShutdown(srv *server.Server) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return srv.ListenAndServe(ctx)
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
func startTmuxControl(sessionName string) (*tmux.Controller, chan tmux.Event, func(), error) {
	cmd := exec.Command("tmux", "-CC", "attach-session", "-t", sessionName)

	// Allocate a PTY. tmux -CC exits immediately with "%exit" when not
	// connected to a terminal, so a PTY is required.
	ptmx, err := pty.Start(cmd)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("start tmux with pty: %w", err)
	}

	events := make(chan tmux.Event, 100)
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
		ptmx.Close()
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
		cmd.Wait()
	}

	return ctrl, events, cleanup, nil
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
type controllerAdapter struct {
	ctrl *tmux.Controller
}

func (a *controllerAdapter) State() *tmux.TmuxState {
	return a.ctrl.State()
}

func (a *controllerAdapter) SendKeys(paneID, keys string) error {
	return a.ctrl.Commands().SendKeys(paneID, keys)
}

func (a *controllerAdapter) SelectWindow(windowID string) error {
	return a.ctrl.Commands().SelectWindow(windowID)
}

func (a *controllerAdapter) SelectPane(paneID string) error {
	return a.ctrl.Commands().SelectPane(paneID)
}

func (a *controllerAdapter) SplitWindow(targetPaneID string, horizontal bool) error {
	return a.ctrl.Commands().SplitWindow(targetPaneID, horizontal)
}

func (a *controllerAdapter) ResizePane(paneID, direction string, amount int) error {
	// TmuxEngine calls ResizePane per-direction ("x" or "y") but the
	// CommandWriter sets both dimensions at once. Look up the current
	// dimensions from state and only change the requested axis.
	state := a.ctrl.State()
	pane := state.FindPane(paneID)
	width, height := amount, amount
	if pane != nil {
		width = pane.Width
		height = pane.Height
	}
	switch direction {
	case "x":
		width = amount
	case "y":
		height = amount
	}
	return a.ctrl.Commands().ResizePane(paneID, width, height)
}

func (a *controllerAdapter) NewWindow(name string) error {
	return a.ctrl.Commands().NewWindow(name)
}

func (a *controllerAdapter) KillPane(paneID string) error {
	return a.ctrl.Commands().ClosePane(paneID)
}

func (a *controllerAdapter) RenameWindow(windowID, name string) error {
	return a.ctrl.Commands().RenameWindow(windowID, name)
}

func (a *controllerAdapter) NewSession(name string) error {
	return a.ctrl.Commands().CreateSession(name)
}

// wireEvents reads tmux events from the channel and broadcasts them via the hub.
// It exits when the events channel is closed (controller stopped).
func wireEvents(events <-chan tmux.Event, hub *server.Hub) {
	for ev := range events {
		switch e := ev.(type) {
		case tmux.OutputEvent:
			hub.BroadcastPaneOutput(e.PaneID, e.Data)
		case tmux.WindowAddEvent:
			hub.BroadcastEvent("window-add", e)
		case tmux.WindowCloseEvent:
			hub.BroadcastEvent("window-close", e)
		case tmux.WindowRenamedEvent:
			hub.BroadcastEvent("window-renamed", e)
		case tmux.LayoutChangeEvent:
			hub.BroadcastEvent("layout-change", e)
		case tmux.SessionChangedEvent:
			hub.BroadcastEvent("session-changed", e)
		case tmux.SessionWindowChangedEvent:
			hub.BroadcastEvent("session-window-changed", e)
		case tmux.PaneModeChangedEvent:
			hub.BroadcastEvent("pane-mode", e)
		case tmux.ExitEvent:
			hub.BroadcastEvent("detached", e)
		}
	}
}

// firstSession returns the name of the first available tmux session.
func firstSession() (string, error) {
	out, err := exec.Command("tmux", "list-sessions", "-F", "#{session_name}").Output()
	if err != nil {
		return "", err
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) == 0 || lines[0] == "" {
		return "", fmt.Errorf("no tmux sessions available")
	}
	return lines[0], nil
}
