// Command muxterm-desktop is muxterm's native desktop shell.
//
// WHAT THIS IS
//
// One native window, drawn by the OS webview, showing muxterm's REAL web UI
// (web/dist, the same bundle `muxterm serve` sends to a browser) served by
// muxterm's REAL HTTP/WebSocket server (internal/server) running INSIDE this
// process on an ephemeral loopback port.
//
// It is not a second UI, not a rewrite, and not a fork of web/. Every byte the
// window renders comes from the same embedded assets and the same handlers the
// browser gets.
//
// WHY THE SERVER RUNS IN-PROCESS RATHER THAN THE WEBVIEW LOADING FILES
//
// The frontend derives every runtime URL from the document's own origin:
// web/src/lib/base-path.ts computes BASE_PATH from document.baseURI and
// wsUrl() turns that into a ws:// or wss:// URL. Handing the webview the built
// files over Wails' own asset scheme would give the page a non-HTTP origin
// with no WebSocket endpoint behind it, so /ws would have to be re-plumbed
// through generated bindings -- a permanent fork of the one contract the
// browser and the desktop app currently share.
//
// Pointing the webview at a real loopback HTTP origin keeps that contract
// identical. The page cannot tell it is in a desktop app, which is exactly the
// property that keeps `muxterm serve` in a browser working unchanged.
//
// WHY SESSIOND IS STILL A SEPARATE PROCESS
//
// sessiond owns every PTY. If it lived in this process, closing the window --
// or a webview crash, or a desktop app update -- would destroy every running
// shell. That is muxterm's defining persistence boundary, so this shell
// connects to the daemon exactly as `muxterm serve` does, via the same
// EnsureDaemon + Unix socket path. Quitting the app leaves your terminals
// running, and a browser can still attach to them.
//
// DELIBERATE DIFFERENCES FROM `muxterm serve` (all for safety on a machine
// that is already running a production muxterm):
//
//   - The listen address is ALWAYS 127.0.0.1 on an ephemeral port. The
//     config file's [server] addr is ignored, so launching the desktop app can
//     never collide with, or shadow, an installed server on its real port.
//   - It never calls sessiond.WriteServerURL. That file is the handoff the MCP
//     server and local CLI helpers read; writing it would silently redirect
//     every local tool at this window's private server.
//   - ConfigPath is empty, so PATCH /api/config cannot write config.toml.
//   - BehindReverseProxy is forced false: this webview genuinely is a loopback
//     client, and there is no proxy in front of it.
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
	// arm has to come first -- see desktop/sessiond.go.
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
	log.Printf("muxterm server listening on %s (in-process, loopback only)", origin)

	// The window opens on a Wails-served bootstrap document whose only job is
	// to hand the webview over to the real HTTP origin above. From that point
	// the page is an ordinary same-origin HTTP document and fetch(), the
	// WebSocket, and cookies all behave exactly as they do in a browser.
	boot := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, bootstrapHTML, origin)
	})

	err = wails.Run(&options.App{
		Title:            "muxterm",
		Width:            1280,
		Height:           820,
		BackgroundColour: &options.RGBA{R: 13, G: 17, B: 23, A: 255},
		AssetServer:      &assetserver.Options{Handler: boot},
		OnStartup:        onStartup,
		Linux: &linux.Options{
			ProgramName: "muxterm",
			// The window must paint on machines whose GL stack is unhappy
			// (headless CI, NVIDIA proprietary drivers -- the documented
			// WebKitGTK blank-window case). Terminal text is not a GPU
			// workload, so this costs nothing muxterm needs.
			WebviewGpuPolicy: linux.WebviewGpuPolicyNever,
		},
	})
	if err != nil {
		log.Fatalf("wails: %v", err)
	}
}

// bootstrapHTML is the one document Wails itself serves. %s is the loopback
// origin of the in-process muxterm server.
const bootstrapHTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>muxterm</title>
<style>html,body{margin:0;height:100%%;background:#0d1117;color:#8b949e;
font:14px system-ui,sans-serif;display:flex;align-items:center;
justify-content:center}</style></head>
<body>starting muxterm&hellip;
<script>location.replace(%q);</script></body></html>`

// onStartup runs once the webview exists, so the native runtime is usable.
func onStartup(ctx context.Context) {
	demonstrateNativeClipboard(ctx)
}

// demonstrateNativeClipboard exercises ONE native capability end to end so the
// desktop build proves it has real OS access rather than merely linking
// against an API.
//
// A browser page cannot do this: writing the system clipboard from script
// requires a user gesture and a permission grant, and reading it back is
// gated behind an explicit permission prompt. A native process just does it.
func demonstrateNativeClipboard(ctx context.Context) {
	token := fmt.Sprintf("muxterm-native-clipboard-%d", time.Now().UnixNano())
	if err := wruntime.ClipboardSetText(ctx, token); err != nil {
		log.Printf("NATIVE-CLIPBOARD: FAILED to write: %v", err)
		return
	}
	got, err := wruntime.ClipboardGetText(ctx)
	if err != nil {
		log.Printf("NATIVE-CLIPBOARD: FAILED to read back: %v", err)
		return
	}
	if got != token {
		log.Printf("NATIVE-CLIPBOARD: MISMATCH wrote=%q read=%q", token, got)
		return
	}
	log.Printf("NATIVE-CLIPBOARD: OK round-tripped %q through the OS clipboard", got)
}

// startLoopbackServer builds muxterm's real server and starts it on a private
// loopback port, returning the origin the webview should load.
func startLoopbackServer() (string, error) {
	addr, err := freeLoopbackAddr()
	if err != nil {
		return "", err
	}

	// The config file is READ for everything except the [server] section, so
	// the desktop window honours the user's Mission Control and UI settings.
	// A malformed file is not fatal here (unlike serve mode, which must refuse
	// rather than silently move a public listener): this listener is loopback
	// and ephemeral by construction, so defaults are safe.
	resolved, malformed, _ := config.LoadStrictServer(config.DefaultPath())
	if malformed {
		log.Printf("config %s could not be parsed; continuing with defaults",
			config.DefaultPath())
		resolved = config.Config{}
	}
	resolved.Server = config.ServerConfig{Addr: addr}

	srv := server.New(server.Config{
		Addr:        addr,
		StaticFS:    mustSub(webstatic.Dist, "dist"),
		PublicDocFS: mustSub(webstatic.PublicDist, "dist-public"),

		// Empty: the desktop app must never write the user's config.toml.
		ConfigPath:    "",
		InitialConfig: resolved,

		// nil AuthServer + loopback listener: every request from this webview
		// takes the IsLocalhost bypass, and anything that somehow arrived from
		// off-box would be denied outright. No browser login for a local app.
		AuthServer:         nil,
		BehindReverseProxy: false,

		Version: version,
	})
	srv.Hub().SetResolvedConfig(resolved)
	srv.Hub().SetDialer(localSessiondDialer())

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return "", fmt.Errorf("listen %s: %w", addr, err)
	}
	go func() {
		// srv.Handler() on a listener this process already holds, rather than
		// srv.ListenAndServe(ctx). Two reasons, both deliberate:
		//
		//  1. The port can never drift from the one the webview was told to
		//     load -- ListenAndServe binds its own socket, so an ephemeral
		//     port would have to be guessed and re-resolved.
		//  2. ListenAndServe also starts the Mission Control lifecycle-notice
		//     loop and the chief-of-staff sidecar. That sidecar holds the
		//     owner's amplifier session, and a desktop window launched beside
		//     an installed `muxterm serve` would become a SECOND writer on one
		//     transcript. Until the desktop app has its own session identity,
		//     not starting it is the correct behaviour, not a gap.
		//
		// Everything the UI actually talks to -- /api/*, /ws, the static
		// bundle, tunnels, publications -- is on this handler and unchanged.
		if err := http.Serve(ln, srv.Handler()); err != nil {
			log.Printf("server stopped: %v", err)
		}
	}()

	return "http://" + addr + "/", nil
}

// localSessiondDialer connects the hub to THIS machine's sessiond, taking the
// same EnsureDaemon path `muxterm serve` takes, so the desktop window attaches
// to the workspaces already running rather than starting a private daemon.
//
// Remote (SSH) hosts are deliberately unreachable in this slice: the transport
// lives in cmd/muxterm and is not yet exposed to this module. A remote request
// fails loudly instead of silently falling back to the local daemon.
func localSessiondDialer() server.DialFunc {
	return func(_ context.Context, host transport.HostRef) (server.DaemonConn, error) {
		if host.ID != "" {
			return nil, fmt.Errorf(
				"the desktop shell cannot reach remote host %s yet; use `muxterm serve` in a browser",
				host.ID)
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

// freeLoopbackAddr asks the kernel for an unused loopback port and returns it
// as a host:port string.
func freeLoopbackAddr() (string, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	addr := ln.Addr().String()
	if err := ln.Close(); err != nil {
		return "", err
	}
	return addr, nil
}

func mustSub(fsys fs.FS, dir string) fs.FS {
	sub, err := fs.Sub(fsys, dir)
	if err != nil {
		panic(fmt.Sprintf("web embed sub %s: %v", dir, err))
	}
	return sub
}
