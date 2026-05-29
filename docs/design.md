# muxterm Design

## Goal

A web-native tmux client that surfaces tmux's power through a browser UI newcomers can use without learning tmux keybindings -- tabs, panes, and splits rendered as DOM elements, each backed by a ghostty-web terminal canvas, driven by tmux control mode.

## Background

Terminal multiplexers like tmux are essential for remote development workflows, especially with AI coding tools like Claude Code that run long-lived terminal sessions. But tmux has a steep learning curve: prefix keys, arcane commands, no visual affordances. Newcomers bounce off it.

Zellij's web client proved the concept -- a multiplexer accessible through a browser. But Zellij uses a single terminal canvas where the server composites everything as ANSI escape sequences. No web-native interactions. You can't click a tab or drag a pane border.

iTerm2 took a different approach with tmux: it uses control mode (`tmux -CC`) to get structured state, then renders native macOS tabs and split panes -- one terminal view per pane. This gives users the full power of tmux with a native UI they already understand.

Nobody has built the iTerm2 approach for the web. muxterm is that project.

## Target Audience

Newcomers to tmux who want remote terminal access for AI coding tools (Claude Code, etc.). They install muxterm, open a browser, and get a working terminal environment with tabs, panes, and a status bar. They don't need to know it's tmux underneath. As they grow, they discover the tmux engine and can customize via plugins and `.tmux.conf`.

## Approach

**iTerm2-style control mode client.** The Go server opens a persistent `tmux -CC attach` connection, parses the structured event stream into a live model of tmux state, and syncs it to the browser. The browser renders tmux state as native DOM elements -- each tmux pane is a separate ghostty-web canvas, windows are tabs, status bar is a DOM component. User actions translate to tmux commands sent back through control mode.

**Rejected alternatives:**

- **Zellij approach (single canvas):** tmux renders everything as ANSI escape sequences into one terminal canvas. Simpler, but no web-native interactions -- can't click tabs, can't drag splits. Wrong for newcomers who expect a GUI.
- **PTY-per-pane with polling:** Spawn `tmux attach` per pane, poll `tmux list-windows` for state. Scales poorly (10 panes = 10 processes), UI always behind real-time state. The muxplex architecture proved this is a dead end.
- **Hybrid (control mode for state, PTY for I/O):** Use control mode for events but maintain separate PTY attachments per pane for terminal I/O. Adds complexity without clear benefit over pure control mode, which already carries `%output` events.

## Architecture

```
Browser (Lit + ghostty-web)
    |  single WebSocket (control + terminal I/O per pane)
    v
Go server (muxterm)
    |  tmux -CC attach (control mode)
    v
tmux server
    |  PTY per pane
    v
shells / processes
```

**One process, one binary.** The Go server:

- Serves the Vite-built frontend (static files embedded via Go's `embed.FS`)
- Maintains a persistent `tmux -CC` control mode connection
- Parses control mode events into a live `TmuxState` model (sessions, windows, panes, layout)
- Relays pane I/O to/from the browser via WebSocket
- Translates browser actions into tmux commands
- Handles auth (token-based, localhost bypass)

**The browser sees tmux's actual state**, not a polled approximation. When tmux creates a pane, the browser knows immediately. When a pane outputs text, it flows through the control mode `%output` event to the correct ghostty-web instance.

**tmux's own TUI is suppressed** in the control mode session. The Go server configures tmux to not draw its status bar or pane borders (those are for terminal clients). The browser renders the equivalent in DOM.

## Components

### tmux Control Mode Engine (`internal/tmux/`)

tmux control mode (`tmux -CC attach -t session`) produces a structured event stream instead of raw terminal output:

```
%session-changed $1 dev
%window-add @3
%window-renamed @3 vim
%output %5 ls\nfoo  bar  baz\n
%layout-change @2 b]90,200x50,0,0{100x50,0,0,3,100x50,101,0,4}
%session-window-changed $1 @3
%pane-mode-changed %5
```

Key events and their UI effects:

| Event | UI Action |
|-------|-----------|
| `%output %N data` | Route bytes to pane N's ghostty-web canvas |
| `%layout-change @W layout` | Re-render pane splits via CSS flex |
| `%window-add @W` | Add tab to tab bar |
| `%window-renamed @W name` | Update tab label |
| `%session-window-changed $S @W` | Switch active tab |
| `%pane-mode-changed %N` | Update pane chrome (e.g. copy mode indicator) |

Input flows via tmux commands: user types in pane 5 -> Go server sends `send-keys -t %5 <data>` through control mode. Click tab -> `select-window -t @W`. Split pane -> `split-window`. Resize -> `resize-pane`.

#### In-memory state model

```go
type TmuxState struct {
    Sessions      []Session
    ActiveSession string
}

type Session struct {
    Name    string
    Windows []Window
}

type Window struct {
    ID     string // @N
    Name   string
    Panes  []Pane
    Layout string // tmux layout string
}

type Pane struct {
    ID     string // %N
    Width  int
    Height int
    Active bool
}
```

#### Sub-components

- **`control.go`** -- Persistent `tmux -CC` connection management, raw event stream reading, event parsing into typed Go structs.
- **`model.go`** -- `TmuxState`, `Session`, `Window`, `Pane` structs. Methods to apply incremental updates from control mode events.
- **`layout.go`** -- Parser for tmux's layout string format (e.g. `b]90,200x50,0,0{100x50,0,0,3,100x50,101,0,4}`). Converts to a tree of horizontal/vertical splits with proportions.
- **`command.go`** -- Functions to send tmux commands through control mode: `send-keys`, `split-window`, `select-window`, `resize-pane`, `new-window`, `kill-pane`, etc.

### WebSocket Server (`internal/server/`)

Serves the frontend, handles WebSocket connections, routes pane I/O between browser and control mode.

- **`server.go`** -- HTTP server, static file serving via `embed.FS`, health endpoint, WebSocket upgrade handler.
- **`ws.go`** -- WebSocket handler. Routes binary frames (pane I/O) to/from the control mode engine by pane ID. Routes text frames (control messages) to/from the state model.
- **`auth.go`** -- Token generation (HMAC, shared secret), token validation on WebSocket upgrade, localhost bypass (no auth needed for local use).

### Deploy (`internal/deploy/`)

- **`ssh.go`** -- `muxterm deploy user@host` implementation. SCP binary to remote host, generate auth secret, write systemd unit, start service, print URL.

### Frontend (`web/src/`)

Lit web components built with Vite + Rolldown. ghostty-web for terminal rendering.

#### Component tree

```
<mux-app>
  <mux-tab-bar>
    <mux-tab name="vim" active>
    <mux-tab name="build">
    <mux-tab name="logs">
    <mux-tab-add>                  <- "+" button -> new-window
  </mux-tab-bar>
  <mux-layout layout="...">       <- parses tmux layout string -> CSS flex splits
    <mux-pane id="%5" active>     <- ghostty-web Terminal inside
    <mux-resize-handle>            <- drag -> resize-pane command
    <mux-pane id="%6">
  </mux-layout>
  <mux-status-bar>                 <- rendered from tmux status-format
  </mux-status-bar>
</mux-app>
```

#### Component details

- **`app.ts`** (`<mux-app>`) -- Root component. Owns the WebSocket connection. Receives state updates, distributes to children. Coordinates pane I/O routing.
- **`components/tab-bar.ts`** (`<mux-tab-bar>`, `<mux-tab>`) -- Renders tmux windows as clickable tabs. Click fires `select-window` command. "+" button fires `new-window`. Tab context menu for rename/close.
- **`components/layout.ts`** (`<mux-layout>`) -- Parses tmux's layout string into nested CSS flex containers. Each leaf node is a `<mux-pane>`. Proportions match tmux's geometry exactly.
- **`components/pane.ts`** (`<mux-pane>`) -- Wraps a single ghostty-web `Terminal` instance. Receives `%output` data via `term.write(data)`. Captures keyboard input via `onData` callback, sends back with pane ID prefix. Handles fit/resize.
- **`components/resize-handle.ts`** (`<mux-resize-handle>`) -- Draggable handle between panes. Drag sends `resize-pane` to tmux. tmux recalculates layout, emits `%layout-change`, `<mux-layout>` re-renders.
- **`components/status-bar.ts`** (`<mux-status-bar>`) -- Renders tmux status line. Session name, window count, pane info, clock.
- **`ws.ts`** -- WebSocket client. Parses binary frames (extracts pane ID, routes data). Parses text frames (JSON control messages). Provides `send()` for outgoing messages.
- **`state.ts`** -- Reactive tmux state store. Receives incremental updates from WebSocket control messages. Lit components observe and re-render.

## Data Flow

### Terminal output (tmux -> browser)

```
shell writes to stdout
  -> tmux server receives on PTY fd
  -> control mode emits: %output %5 <raw bytes>
  -> Go server parses event, extracts pane ID and data
  -> Go server writes binary WS frame: [paneId:4bytes][data]
  -> Browser reads binary frame, extracts pane ID
  -> Routes data to <mux-pane id="%5">
  -> pane.term.write(data)
  -> ghostty-web WASM parser interprets escape sequences
  -> Canvas renders text
```

### Keyboard input (browser -> tmux)

```
User types in <mux-pane id="%5">
  -> ghostty-web onData fires with raw bytes
  -> <mux-pane> prepends pane ID: [paneId:4bytes][keydata]
  -> WebSocket sends binary frame
  -> Go server extracts pane ID and data
  -> Go server sends: send-keys -t %5 <data>
  -> tmux routes input to pane 5's shell
```

### User action (e.g. click tab)

```
User clicks <mux-tab name="build">
  -> <mux-tab-bar> sends text frame: {"select-window": "@3"}
  -> Go server receives, sends: select-window -t @3
  -> tmux switches active window
  -> Control mode emits: %session-window-changed $1 @3
  -> Go server sends text frame: {"session-window-changed": ...}
  -> <mux-app> updates state
  -> <mux-tab-bar> re-renders (new active tab)
  -> <mux-layout> re-renders with new window's panes
  -> New panes' ghostty-web instances start receiving %output data
```

### Pane resize (drag handle)

```
User drags <mux-resize-handle>
  -> Sends text frame: {"resize-pane": {"id": "%5", "cols": 100, "rows": 40}}
  -> Go server sends: resize-pane -t %5 -x 100 -y 40
  -> tmux recalculates layout
  -> Control mode emits: %layout-change @2 <new layout string>
  -> Go server sends text frame with new layout
  -> <mux-layout> re-parses layout string
  -> CSS flex splits update, <mux-pane> canvases resize
  -> Each pane's ghostty-web fit() recalculates character grid
```

## WebSocket Protocol

One WebSocket connection between browser and Go server. Binary/text frame split.

### Binary frames -- pane I/O (hot path)

Each binary frame has a 4-byte pane ID prefix, then raw terminal data:

```
[pane_id: 4 bytes LE uint32][data: N bytes]
```

- **Server -> client:** Pane output. Browser reads pane ID, routes data to that pane's ghostty-web `term.write(data)`.
- **Client -> server:** User input. Browser prepends active pane ID. Go server extracts pane ID, sends `send-keys -t %N <data>`.

4 bytes per frame overhead. Zero JSON parsing on the hot path.

### Text frames -- control messages (cold path)

```json
// Server -> Client: state sync
{"state": {"sessions": [...], "activeSession": "dev"}}
{"window-add": {"id": "@3", "name": "vim"}}
{"window-renamed": {"id": "@3", "name": "make"}}
{"layout-change": {"window": "@2", "layout": "..."}}
{"session-changed": {"name": "dev"}}
{"pane-mode": {"id": "%5", "mode": "copy"}}
{"detached": {"reason": "tmux server exited"}}

// Client -> Server: user actions
{"select-window": "@3"}
{"select-pane": "%5"}
{"split": {"direction": "horizontal", "pane": "%5"}}
{"resize-pane": {"id": "%5", "cols": 80, "rows": 24}}
{"new-window": {}}
{"close-pane": "%5"}
{"rename-window": {"id": "@3", "name": "build"}}
{"create-session": {"name": "test"}}
```

Every tmux control mode event maps to a JSON message. Every user action maps to a tmux command. The Go server is a translator between the two protocols.

## Deployment Model

Three modes of operation:

### 1. Local mode (zero config)

```bash
muxterm
```

Opens browser to `http://localhost:8080`. Connects to the local tmux server. No auth needed (localhost bypass). If tmux isn't running, starts a server with a default session. This is the newcomer's first experience -- install, run, use.

### 2. Remote mode (push over SSH)

```bash
muxterm deploy user@myserver.com
```

SSHs into the server, copies the muxterm binary, installs it as a systemd service, generates a random auth token, and prints the URL. The user opens their browser and connects. tmux sessions persist across disconnects -- that's the whole point.

Under the hood:
- `scp` the binary to the remote host
- Generate a random auth secret
- Write a systemd unit file
- Start the service
- Print: `muxterm running at https://myserver.com:8080 (token: abc123)`

### 3. Service mode (already deployed)

```bash
muxterm serve --addr 0.0.0.0:8080 --secret <token>
```

For when the binary is already on the server. Runs as a long-lived service with token auth.

### Distribution

Single Go binary with embedded frontend. No runtime dependencies except tmux. Install via:
- `go install github.com/<org>/muxterm@latest`
- Direct download from GitHub releases
- Package managers (brew, apt) later

## Error Handling

| Failure | Response |
|---------|----------|
| tmux server not running | Start tmux with a default session. If start fails, show clear error in browser: "tmux not found" or "tmux failed to start". |
| Control mode connection drops | Attempt reconnect with backoff. Browser shows "Reconnecting..." overlay. On reconnect, request full state sync. |
| tmux session killed externally | Control mode emits `%session-changed` or `%exit`. Browser navigates to session picker or creates new default session. |
| Pane exits (shell closes) | tmux emits `%layout-change` (pane removed). Browser re-renders layout without that pane. |
| WebSocket drops (network) | Browser reconnects with backoff. On reconnect, sends auth token + requests full state sync. Go server replays current `TmuxState`. |
| Go server crashes | systemd restarts it (service mode). Browser reconnects. tmux sessions are unaffected -- they're independent processes. |
| Invalid tmux command from browser | Go server validates before sending to tmux. Returns `{"error": "..."}` text frame. Browser shows toast. |
| tmux version incompatibility | Go server checks `tmux -V` on startup. Warns or exits if below minimum supported version. |

Key resilience property: **tmux sessions are the source of truth.** Everything else -- the Go server, WebSocket connections, browser state -- is ephemeral and reconstructable from tmux's actual state via control mode.

## Testing Strategy

### Go server

- **Unit tests for control mode parser:** Feed known `%output`, `%layout-change`, `%window-add` event strings, verify parsed Go structs. Cover edge cases: multi-line output, binary data in `%output`, malformed events.
- **Unit tests for layout parser:** tmux layout strings -> split trees. Verify proportions, nesting, pane IDs.
- **Unit tests for command builder:** Verify `send-keys`, `split-window`, `resize-pane` produce correct tmux command strings with proper escaping.
- **Integration tests:** Start a real tmux server, open control mode, send commands, verify events arrive and state model updates correctly.
- **WebSocket tests:** Connect a test client, send control messages, verify state sync and pane I/O routing.

### Frontend

- **Component tests:** Each Lit component tested in isolation. Verify `<mux-layout>` renders correct flex splits from a layout string. Verify `<mux-tab-bar>` renders tabs from state. Verify `<mux-pane>` routes data to ghostty-web.
- **Integration tests:** Full `<mux-app>` with mocked WebSocket. Simulate state updates, verify DOM renders correctly. Simulate user actions (click tab, type in pane), verify correct messages sent.

### End-to-end

- **Playwright tests:** Start muxterm, open browser, verify tabs render, terminal shows content, keyboard input works, pane splits display correctly.

## Project Structure

```
~/workspace/muxterm/
├── cmd/
│   └── muxterm/
│       └── main.go           # CLI entry: serve, deploy, version
├── internal/
│   ├── tmux/
│   │   ├── control.go        # tmux -CC connection, event parser
│   │   ├── model.go          # TmuxState, Session, Window, Pane structs
│   │   ├── layout.go         # tmux layout string parser
│   │   └── command.go        # send-keys, split-window, etc.
│   ├── server/
│   │   ├── server.go         # HTTP + WS server, static file serving
│   │   ├── ws.go             # WebSocket handler, pane I/O routing
│   │   └── auth.go           # token generation, validation, localhost bypass
│   └── deploy/
│       └── ssh.go            # push-to-remote via SSH
├── web/
│   ├── src/
│   │   ├── app.ts            # <mux-app> root component
│   │   ├── components/
│   │   │   ├── tab-bar.ts    # <mux-tab-bar> + <mux-tab>
│   │   │   ├── layout.ts     # <mux-layout> layout parser + CSS splits
│   │   │   ├── pane.ts       # <mux-pane> ghostty-web Terminal wrapper
│   │   │   ├── status-bar.ts # <mux-status-bar>
│   │   │   └── resize-handle.ts # <mux-resize-handle> drag-to-resize
│   │   ├── ws.ts             # WebSocket client, message routing
│   │   └── state.ts          # reactive tmux state store
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json          # lit, ghostty-web, vite, @rolldown/vite-plugin
├── go.mod
├── go.sum
├── Makefile                   # build Go + Vite, embed frontend in binary
└── docs/
    └── design.md              # this document
```

**Build pipeline:** `make build` runs Vite + Rolldown to produce `web/dist/`, then `go build` with `embed.FS` produces a single binary containing the frontend.

**Dependencies:**

- **Go:** `gorilla/websocket` or `nhooyr.io/websocket`
- **Frontend:** `lit`, `ghostty-web`, `vite`, `@rolldown/vite-plugin`
- **Runtime:** tmux (must be installed on the host)

## Design Decisions & Rationale

1. **iTerm2 approach (DOM per pane), not Zellij approach (single canvas).** Newcomers expect web-native interactions -- clicking tabs, dragging splits. A single terminal canvas where you press `Ctrl+B` to switch windows is exactly the learning curve we're eliminating.

2. **tmux control mode, not PTY-per-pane.** Single connection to tmux gives real-time state. No process spawning, no polling. iTerm2 proved this works at scale.

3. **Go single binary.** No runtime deps besides tmux. Single process serves frontend + WebSocket + control mode. Deploy = copy one file.

4. **Lit web components.** Each component maps to a tmux concept. Reactive rendering from tmux state. Web-standard, lightweight, no framework lock-in.

5. **ghostty-web for terminal rendering.** Battle-tested WASM terminal parser from Ghostty. Better VT100 compliance than xterm.js. ~400KB bundle.

6. **Binary pane ID prefix for I/O, JSON for control.** Hot path (every keystroke, every byte of output) is zero-overhead binary. Cold path (tab switches, layout changes) is readable JSON. No serialization cost on the data path.

7. **tmux plugins drive the UX.** The product doesn't invent its own extension system. tmux already has plugins, themes, and `.tmux.conf`. The web UI renders what tmux provides. The ecosystem of existing tmux plugins (catppuccin, powerline, tpm) enriches muxterm automatically.

8. **Local-first, push-to-remote deployment.** Zero friction for the newcomer (just `muxterm`). Remote access is a second step (`muxterm deploy`), not a prerequisite. Same model as VS Code Remote.

## Open Questions

- **tmux control mode version compatibility.** Control mode has evolved across tmux versions. What's the minimum tmux version we support? 3.0+? 3.3+? Need to audit which `%events` are available in each version.

- **Pane resize via drag.** When the user drags a resize handle, we send `resize-pane` to tmux. But tmux might recalculate the layout differently than the user expects (tmux has its own layout algorithms). How closely can we match drag intent to tmux's resize behavior?

- **Status bar rendering.** tmux's `status-format` uses its own format string language with color codes and conditionals. Do we parse and render it ourselves, or ask tmux to evaluate the format and send the rendered result?

- **Copy mode.** When a pane enters copy mode (scrollback browsing), the behavior is complex -- tmux renders its own UI inside the pane. Do we let that render through ghostty-web (simple, works immediately), or build a web-native scrollback UI (better UX but much harder)?

- **Session picker.** On first connect, if multiple tmux sessions exist, how does the user choose which to view? A landing page with session list? Auto-attach to most recent?

- **`%output` data encoding.** Control mode wraps terminal output in `%output %N` framing. Need to confirm: is the data base64-encoded or raw? How are binary sequences (e.g. image protocols) handled? This affects the parser complexity.

- **Multiple browser tabs.** If the user opens muxterm in two browser tabs, both connect to the same tmux session. Do we allow this (both see the same state, input goes to the active pane of whoever typed last)? Or restrict to one active client?
