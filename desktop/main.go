// Command muxterm-desktop is muxterm's native desktop shell.
//
// WHAT IT IS
//
// One native OS window, drawn by the platform webview, showing muxterm's REAL
// web UI -- the same web/dist bundle `muxterm serve` sends to a browser --
// served by muxterm's REAL HTTP/WebSocket server (internal/server) running
// inside this process on an ephemeral loopback port.
//
// It is not a second UI, not a rewrite, and not a fork of web/. Every byte the
// window renders comes from the same embedded assets and the same handlers a
// browser gets.
//
// ---------------------------------------------------------------------------
// THE ARCHITECTURAL CHOICE, AND WHY
// ---------------------------------------------------------------------------
//
// There were two candidate shapes for this slice:
//
//	(A) Wails hosts muxterm's server IN-PROCESS and the webview loads it over
//	    loopback HTTP.                                          <- CHOSEN
//	(B) Wails is a thin native shell over a SEPARATE `muxterm serve` child
//	    process bound to loopback.
//
// (A) wins on one hard technical constraint and three operational ones.
//
// The hard constraint is the frontend's URL contract. web/src/lib/base-path.ts
// derives BASE_PATH from document.baseURI, and wsUrl() turns that into
// `ws(s)://location.host/<base>/ws`. The page therefore REQUIRES an origin
// that is (a) a real HTTP origin and (b) has muxterm's WebSocket endpoint
// behind it. Handing the built files to the webview over Wails' own asset
// scheme satisfies neither: the origin is not http(s), and Wails' asset server
// is an http.Handler that cannot be hijacked for a WebSocket upgrade. Taking
// that path would mean re-plumbing /ws through generated Wails bindings -- a
// permanent fork of the single contract the browser and the desktop app share,
// and the fastest possible way to break `muxterm serve`.
//
// Pointing the webview at a real loopback HTTP origin keeps that contract
// byte-identical. The page cannot tell it is inside a desktop app, which is
// precisely the property that keeps the browser working unchanged.
//
// (A) over (B), given both would satisfy the above:
//
//   - One process to ship and one to crash. (B) needs a `muxterm` binary
//     discoverable on PATH at the right version, a port handshake to learn
//     where the child landed, and orphan cleanup when the window dies.
//   - No version skew. In (B) the app and the server are two separately
//     installed artifacts that can disagree.
//   - The shell can reach server internals it will need for later native work
//     (menu actions that talk to the hub, tray state) without a second RPC.
//
// THE TRADEOFF, NAMED: in (A) the desktop binary statically links the whole
// server, so the artifact is large (~40MB+ before the webview), and a server
// panic takes the window down with it. (B) would have isolated those. That is
// an acceptable trade for a single-user local app and is reversible: the
// window only ever talks to an HTTP origin, so swapping the in-process server
// for a child process later changes nothing the page can observe.
//
// ---------------------------------------------------------------------------
// WHY SESSIOND IS STILL A SEPARATE PROCESS
// ---------------------------------------------------------------------------
//
// sessiond owns every PTY. If it lived in this process, closing the window --
// or a webview crash, or an app update -- would destroy every running shell.
// Surviving that is muxterm's defining property, so this shell attaches to the
// daemon exactly as `muxterm serve` does, through the same EnsureDaemon + Unix
// socket path. Quitting the app leaves your terminals running, and a browser
// can still attach to them.
//
// ---------------------------------------------------------------------------
// DELIBERATE DIFFERENCES FROM `muxterm serve`
// ---------------------------------------------------------------------------
//
// All four exist so that launching this app on a machine already running a
// production muxterm cannot disturb it:
//
//   - The listen address is ALWAYS 127.0.0.1 on an ephemeral port. The config
//     file's [server] addr is ignored, so the desktop app can never collide
//     with, or shadow, an installed server on its real port.
//   - It never calls sessiond.WriteServerURL. That file is the handoff the MCP
//     server and local CLI helpers read; writing it would silently redirect
//     every local tool at this window's private server.
//   - ConfigPath is empty, so PATCH /api/config cannot write config.toml.
//   - BehindReverseProxy is forced false: this webview genuinely is a loopback
//     client and there is no proxy in front of it.
package main

import (
	"context"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/kenotron-ms/muxterm/internal/config"
	"github.com/kenotron-ms/muxterm/internal/server"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
	"github.com/kenotron-ms/muxterm/internal/transport"
	webstatic "github.com/kenotron-ms/muxterm/web"
)

// version is stamped at build time; "dev" suppresses the self-update offer.
var version = "dev"

func main() {
	log.SetPrefix("muxterm-desktop: ")
	log.SetFlags(log.Ltime)

	// sessiond.Spawn re-execs THIS binary as `<exe> sessiond`, so the daemon
	// arm has to be handled before anything opens a window. See sessiond.go.
	if len(os.Args) > 1 && os.Args[1] == "sessiond" {
		if err := runSessiond(); err != nil {
			log.Fatalf("sessiond: %v", err)
		}
		return
	}

	origin, err := startLoopbackServer()
	if err != nil {
		log.Fatalf("could not start the muxterm server in-process: %v", err)
	}
	log.Printf("muxterm server ready on %s (in-process, loopback only)", origin)

	// The window opens on the one document Wails itself serves, whose only
	// job is to hand the webview over to the real HTTP origin above. From
	// that point the page is an ordinary same-origin HTTP document: fetch(),
	// the WebSocket, cookies and storage all behave exactly as in a browser.
	boot := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, bootstrapHTML, origin)
	})

	app := &desktopApp{origin: origin}

	err = wails.Run(&options.App{
		Title:            "muxterm",
		Width:            1280,
		Height:           820,
		MinWidth:         640,
		MinHeight:        480,
		BackgroundColour: &options.RGBA{R: 13, G: 17, B: 23, A: 255},
		AssetServer:      &assetserver.Options{Handler: boot},
		Menu:             app.menu(),
		OnStartup:        app.onStartup,
		Linux: &linux.Options{
			ProgramName: "muxterm",
			// The window must paint on machines whose GL stack is unhappy
			// (headless X, NVIDIA proprietary drivers -- the documented
			// WebKitGTK blank-window case). Terminal text is not a GPU
			// workload, so this costs muxterm nothing.
			WebviewGpuPolicy: linux.WebviewGpuPolicyNever,
		},
	})
	if err != nil {
		log.Fatalf("wails: %v", err)
	}
}

// bootstrapHTML is the only document Wails' own asset server ever serves.
// %s is the loopback origin of the in-process muxterm server.
//
// A redirect document rather than a redirect RESPONSE: WebKitGTK follows a
// 302 off the custom asset scheme inconsistently, and location.replace() from
// a real document works identically on all three platforms' webviews.
const bootstrapHTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>muxterm</title>
<style>html,body{margin:0;height:100%%;background:#0d1117;color:#8b949e;
font:14px system-ui,sans-serif;display:flex;align-items:center;
justify-content:center}</style></head>
<body>starting muxterm&hellip;
<script>location.replace(%q);</script></body></html>`

// desktopApp holds what the native layer needs after the webview exists.
type desktopApp struct {
	origin string
	ctx    context.Context
}

func (a *desktopApp) onStartup(ctx context.Context) { a.ctx = ctx }

// menu builds the native application menu.
//
// This is the slice's ONE demonstrated native capability, and it is two things
// at once: an OS-drawn menu bar (a browser tab cannot add one) and the trigger
// for a native file dialog that returns a REAL absolute filesystem path. A web
// page's <input type=file> hands back an opaque File object with no path --
// the file must be uploaded to be useful. Here the path itself comes back, so
// the shell can act on a file in place.
func (a *desktopApp) menu() *menu.Menu {
	m := menu.NewMenu()

	fileMenu := m.AddSubmenu("muxterm")
	fileMenu.AddText("Open File\u2026", keys.CmdOrCtrl("o"), a.openFile)
	fileMenu.AddSeparator()
	fileMenu.AddText("Quit", keys.CmdOrCtrl("q"), func(_ *menu.CallbackData) {
		if a.ctx != nil {
			wruntime.Quit(a.ctx)
		}
	})

	return m
}

// openFile opens the OS file picker and reports the chosen absolute path.
//
// It deliberately does not upload, read or send the file anywhere in this
// slice: the point being demonstrated is that the native layer can obtain a
// real path from the user, which is the capability every later feature
// (attach a file to Mission Control, open a project directory, drop a script
// into a pane) is built on.
func (a *desktopApp) openFile(_ *menu.CallbackData) {
	if a.ctx == nil {
		return
	}
	path, err := wruntime.OpenFileDialog(a.ctx, wruntime.OpenDialogOptions{
		Title: "Open a file \u2014 muxterm native file dialog",
	})
	if err != nil {
		log.Printf("native file dialog: %v", err)
		return
	}
	if path == "" {
		log.Printf("native file dialog: cancelled")
		return
	}
	log.Printf("native file dialog returned an absolute path: %s", path)
	wruntime.WindowSetTitle(a.ctx, "muxterm \u2014 "+path)
}

// startLoopbackServer builds muxterm's real server, starts it on an ephemeral
// loopback port, waits until it actually answers, and returns its origin.
func startLoopbackServer() (string, error) {
	addr, err := reserveLoopbackAddr()
	if err != nil {
		return "", err
	}

	// Load, not LoadStrictServer: the desktop app does not honour the
	// [server] section at all (it always binds loopback:0), so a malformed
	// file must not stop the window from opening. Everything the app DOES
	// read from config -- Mission Control, restore, terminal settings -- is
	// safe at its defaults.
	resolved, _ := config.Load(config.DefaultPath())

	localToken, err := sessiond.NewLocalToken()
	if err != nil {
		return "", fmt.Errorf("mint local token: %w", err)
	}

	srv := server.New(server.Config{
		Addr:        addr,
		StaticFS:    mustSubFS(webstatic.Dist, "dist"),
		PublicDocFS: mustSubFS(webstatic.PublicDist, "dist-public"),
		// ConfigPath empty on purpose: the desktop window must not be able
		// to rewrite the config file that the installed server reads.
		InitialConfig: resolved,
		// AuthServer nil: the only client is this webview, which is loopback
		// by construction and takes the IsLocalhost bypass. There is no
		// OAuth redirect to register because there is no browser to redirect.
		BehindReverseProxy: false,
		LocalToken:         localToken,
		Version:            version,
		// Remotes nil: SSH remotes are a named gap for this slice, see the PR.
		// nil makes the feature inert rather than half-wired.
	})
	srv.Hub().SetResolvedConfig(resolved)
	srv.Hub().SetDialer(localSessiondDialer())

	// NOT sessiond.WriteServerURL(...). See the package comment.

	go func() {
		if err := srv.ListenAndServe(context.Background()); err != nil {
			log.Fatalf("muxterm server stopped: %v", err)
		}
	}()

	origin := "http://" + addr
	if err := waitForHealth(origin, 10*time.Second); err != nil {
		return "", err
	}
	return origin, nil
}

// reserveLoopbackAddr asks the kernel for a free loopback port and gives it
// straight back.
//
// The gap between closing this listener and internal/server binding the same
// port is a real (if tiny) race. It is accepted deliberately rather than
// papered over: server.ListenAndServe owns a great deal of lifecycle -- the
// Mission Control sidecar shutdown, lifecycle notices, the publication sweeper
// -- and threading a pre-bound net.Listener into it would mean duplicating all
// of that here, where it would silently rot. If the bind loses the race the
// app fails loudly at startup instead of opening a window onto nothing.
func reserveLoopbackAddr() (string, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("reserve loopback port: %w", err)
	}
	addr := ln.Addr().String()
	if err := ln.Close(); err != nil {
		return "", fmt.Errorf("release reserved port: %w", err)
	}
	return addr, nil
}

// waitForHealth blocks until the in-process server answers GET /api/health.
//
// The window is only opened after this returns. Without it the webview races
// the listener and shows a connection-refused page that never retries, which
// looks exactly like a broken app.
func waitForHealth(origin string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: time.Second}
	var last error
	for time.Now().Before(deadline) {
		resp, err := client.Get(origin + "/api/health")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
			last = fmt.Errorf("health returned %s", resp.Status)
		} else {
			last = err
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("muxterm server did not become healthy on %s: %w", origin, last)
}

// localSessiondDialer is the desktop equivalent of cmd/muxterm's
// newSessiondDialer, minus the remote transport arm.
//
// Same three calls in the same order as serve mode -- SocketPath,
// DefaultLogPath, EnsureDaemon -- so a desktop-started daemon is
// indistinguishable from a CLI-started one and a browser can attach to the
// very same terminals. A non-zero host is refused rather than silently
// resolved to the local socket, because this build wires no transport.
func localSessiondDialer() server.DialFunc {
	return func(_ context.Context, host transport.HostRef) (server.DaemonConn, error) {
		if host.ID != "" {
			return nil, fmt.Errorf("muxterm-desktop has no remote transport: cannot reach %s", host.ID)
		}
		sock, err := sessiond.SocketPath()
		if err != nil {
			return nil, err
		}
		logPath, err := sessiond.DefaultLogPath()
		if err != nil {
			return nil, err
		}
		if err := sessiond.EnsureDaemon(sock, logPath); err != nil {
			return nil, err
		}
		return sessiond.Dial(sock)
	}
}

func mustSubFS(fsys fs.FS, dir string) fs.FS {
	sub, err := fs.Sub(fsys, dir)
	if err != nil {
		panic(fmt.Sprintf("web embed sub: %v", err))
	}
	return sub
}
