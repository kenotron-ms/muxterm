# muxterm MCP Agent Workbench Design

## Goal

`muxterm mcp` — a subcommand that exposes muxterm as a first-class MCP server. An agent connecting to it gets the full primitive set: create workspaces, arrange panes, drive terminals, control browser panes. The human watching the muxterm UI sees exactly what the agent(s) are building in real time — layout and all.

The "multi-agent hill climb" scenario this enables: a coordinator agent creates a workspace, splits it into terminal + browser panes, spawns sub-agents that each take a pane, reads their outputs to synthesise results, and reorganises the layout as the work evolves. Every agent talks MCP; muxterm is the shared substrate they all write to.

## Scope

**In scope:**
- `muxterm mcp` subcommand — stdio transport for local agents, optional HTTP/SSE for remote
- Workspace tools: `create_workspace`, `list_workspaces`, `switch_workspace`, `close_workspace`
- Pane layout tools: `create_pane` with placement intent (tab, split + direction), `rename_pane`, `close_pane`, `list_panes`, `get_layout` (ASCII workspace diagram with pane IDs + content hints)
- Terminal tools: `run_command` (send + wait for OSC 133 completion), `send_input` (raw, no wait), `get_screen` (VT grid as plain text)
- Browser tools: Playwright-CLI shaped — `browser_snapshot`, `browser_goto`, `browser_click`, `browser_fill`, `browser_type`, `browser_press`, `browser_hover`, `browser_select`, `browser_eval`, `browser_screenshot`, `browser_go_back`, `browser_go_forward`, `browser_reload`
- MCP resource for streaming pane output: `pane://{id}`
- SW bridge in browser panes — internal mechanism behind browser interaction tools

**Out of scope:**
- Subdomain routing — independent feature
- Multi-agent auth / agent identity — app layer above MCP
- CDP / Playwright server integration

**Not changing:**
- The frozen binary-framed WS protocol format — new message types are additive only
- Existing terminal I/O or VT buffer

## Architecture

`muxterm mcp` is a new subcommand in the existing single binary. It starts an MCP server and connects to the running muxterm HTTP server as a WebSocket client — the same connection type the browser UI uses, speaking the same protocol. No new internal coupling, no second path to sessiond.

```
Agent (any MCP client)
    ↕ stdio (local) or HTTP/SSE (remote)
muxterm mcp  ←→  ws://localhost:{port}/ws
                       ↕
                 muxterm HTTP server
                       ↕ Unix socket
                    sessiond
                    ├── terminal panes (PTY)
                    └── browser panes ← SW bridge via postMessage
```

**Transports:** `muxterm mcp` with no flags runs stdio — the convention for local agents (`claude --mcp-server "muxterm mcp"`). `--transport sse --port 9092` exposes HTTP/SSE for remote agents.

**New protocol messages (additive only):** Two new control message types bolt onto the existing frozen binary-framed envelope following the existing `[4-byte length][0x01 kind][JSON]` format:
- `browser-action` — MCP server sends command, HTTP server relays to browser WS client, browser postMessages to SW bridge, result flows back
- `screen-snapshot` — on-demand VT grid for a pane, returns ANSI-stripped plain text

**Layout commands** are relayed via a new `layout-command` message type: MCP server → HTTP server → pushes to all connected browser clients → browser handles dockview manipulation. The `get_layout` response is derived server-side from stored layout JSON + pane list, no round-trip to the browser needed.

**`run_command` completion:** OSC 133 shell integration sequences are parsed in sessiond's VT layer. When `OSC 133;D;{exitcode}` is seen in the PTY stream, an internal `command-done` event is emitted. The MCP `run_command` tool waits on this event. A timeout fallback (default 30s) covers shells without OSC 133 support. This is the industry standard used by VS Code, iTerm2, and Warp — not prompt regex.

## Components

### Terminal tools

- `run_command(pane_id, command, timeout_ms?)` → `{output, exit_code}` — writes command + newline, waits for OSC 133;D, returns ANSI-stripped output
- `send_input(pane_id, text)` → raw write, no wait — for interactive programs, ctrl sequences, arrow keys
- `get_screen(pane_id)` → current VT grid as plain text + `cursor: {row, col}`
- `list_panes(workspace?)` → panes with IDs, kinds, names, content hint (last output line or URL)

### Browser tools — Playwright-CLI shaped

The workflow is snapshot-first. The agent calls `browser_snapshot` to get an accessibility tree with numbered element refs (`e1`, `e2`...). All interaction commands reference those refs. The SW bridge maintains the ref map per snapshot. The MCP tool descriptions are lifted/adapted directly from playwright-cli's own command descriptions so agents familiar with playwright-cli recognise the patterns immediately.

```
browser_snapshot(pane_id)          → YAML accessibility tree with refs
browser_goto(pane_id, url)         → navigate (waits for page load event from SW)
browser_click(pane_id, ref)        → click e15
browser_fill(pane_id, ref, text)   → fill e5 "user@example.com"
browser_type(pane_id, text)        → type into focused element
browser_press(pane_id, key)        → press Enter / ArrowDown / etc.
browser_hover(pane_id, ref)        → hover e4
browser_select(pane_id, ref, val)  → select dropdown option
browser_eval(pane_id, expr, ref?)  → eval "document.title"
browser_screenshot(pane_id)        → base64 PNG
browser_go_back(pane_id)           → history.back() — via SW bridge, works without allow-same-origin
browser_go_forward(pane_id)        → history.forward()
browser_reload(pane_id)            → reload current page
```

Back/forward work because the SW bridge runs inside the frame's browsing context — `window.history.back()` is same-origin from the bridge's perspective. The `iframe` sandbox does not need `allow-same-origin`.

All browser commands route through the SW bridge via postMessage. Default timeout 10s. Returns `{error: 'bridge-not-ready'}` if the bridge is not registered.

### Workspace tools

```
create_workspace(name)           → workspace_id
list_workspaces()                → [{id, name, pane_count, active}]
switch_workspace(workspace_id)   → activates workspace in UI
close_workspace(workspace_id)    → closes workspace and all panes
```

### Pane layout tools

```
create_pane(kind, placement?, reference_pane?, url?)  → pane_id
  kind:      "terminal" | "browser"
  placement: "tab" | "split-right" | "split-left" | "split-above" | "split-below"
  reference_pane: pane to split from or add a tab next to

rename_pane(pane_id, name)   → updates dockview tab title
close_pane(pane_id)          → closes pane (PTY killed or browser removed)
```

`get_layout(workspace?)` — ASCII diagram of the current split layout, generated server-side from stored dockview layout JSON + pane list. No round-trip to the browser needed.

```
workspace: "dev"
┌─────────────────────┬──────────────────────┐
│ [1]* terminal       │ [3] browser           │
│ $ npm run dev       │ http://localhost:5173  │
├─────────────────────┤                       │
│ [2] terminal        │                       │
│ $ pytest -x         │                       │
└─────────────────────┴──────────────────────┘
active: 1
```

`*` marks the active pane. Multi-tab groups show the tab bar inline. Pane IDs in brackets are stable across the session and used in all subsequent tool calls.

All layout commands flow: MCP server → `layout-command` WS message → HTTP server → browser client → dockview operation. Layout changes echo back as `layout-save`, which sessiond stores.

## Data Flow

### Browser Pane SW Bridge

Two JS artifacts exist per browser pane:

**`/p/sw.js`** — a new endpoint served by the Go HTTP server. It registers under scope `/p/` — entirely separate from the muxterm PWA SW at `/sw.js`, so there is no scope overlap and no conflict. It persists across page navigations. Responsibilities: track URL history for back/forward, and notify the parent when a new page loads.

**The page shim** — injected by the Go proxy into every HTML response under `/p/`. On each page load it:
1. Announces itself to the parent: `postMessage({type: 'shim-ready', paneId, url})`
2. Registers a `message` listener for incoming browser action commands
3. Maintains the element ref map for the current snapshot (`e1`, `e2`...)

The ref map lives in the shim and is cleared on every navigation. After a page load the agent must call `browser_snapshot` again before using refs.

**Command flow:**
```
MCP → WS → HTTP server → browser WS client
  → iframe.contentWindow.postMessage(command)
  → shim receives, executes (click, fill, snapshot, eval...)
  → window.parent.postMessage(result)
  → browser WS client → HTTP server → WS → MCP
```

**SW's role in navigation:** Records every navigation URL via the `fetch` event (`mode: navigate`) so the MCP server knows the current URL per pane without polling. Sends a `page-navigated` notification to the parent on each navigation.

## Error Handling

**Browser bridge not ready:** If the shim is not registered (a non-HTML resource loaded, or the proxy was bypassed), browser action commands time out at 10s and return `{error: 'bridge-not-ready'}`. The agent retries after calling `browser_goto` or waits for a `shim-ready` notification.

**Command completion timeout:** `run_command` waits on the OSC 133;D completion event. For shells without OSC 133 support, a timeout fallback (default 30s, overridable via `timeout_ms`) returns the output captured so far. For long-running commands the caller uses `send_input` and polls `get_screen` instead.

**Browser command timeout:** All browser commands default to a 10s timeout and return a structured error rather than hanging.

## Testing Strategy

The SW bridge is the highest-uncertainty component. Before building the full MCP server, validate it with a minimal self-contained POC.

**POC scope — validate these three things:**
1. The Go proxy can inject a SW registration script into HTML responses, and the SW registers successfully under scope `/p/`
2. A `postMessage` from the parent (muxterm) reaches the page shim, executes a DOM action (click, query), and the result comes back via `postMessage`
3. `window.history.back()` called from within the shim navigates correctly and the SW's `fetch` event records the new URL

**POC implementation:**
- A single Go file serving: a hardcoded HTML page at `/p/test/`, the injected SW registration snippet, and `/p/sw.js`
- A simple browser test page with a button and a heading
- A minimal parent HTML page (at `/`) with a button that sends a postMessage to the iframe and a display area for the result
- A shim that handles `{type: 'click', selector}` and `{type: 'query', selector}` and posts results back
- Manual verification: open the parent page, click "send command", see the result

**Success criteria:**
- SW registers and stays alive across an in-page navigation (clicking a link within `/p/test/`)
- Parent receives the DOM query result after the postMessage round-trip
- `history.back()` from the shim navigates correctly; the SW fetch event fires

## Open Questions

**SW bridge viability** is the open risk. If the POC fails, fall back to the hidden iframe persistence approach: a non-navigating iframe maintains the postMessage relay across page loads. The design is already aware of this alternative and can adopt it without changing the MCP tool surface.
