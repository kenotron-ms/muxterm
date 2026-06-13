# Sidebar Redesign + Tunnel System Design

## Goal

Replace the bottom workspace dock bar on wide screens with a resizable left sidebar containing workspace cards and a tunnel manager, while removing the broken browser pane surface in favour of a proper port-forwarding tunnel system.

## Background

The bottom workspace dock bar wastes vertical space on wide screens — horizontal screen real estate is abundant there, vertical space is precious. Tools like tmux and paneflow solve this with a left sidebar, and muxterm should follow the same pattern on desktop viewports.

The browser pane feature (embedding external sites in an iframe) is being removed. It was fundamentally broken for the open web: `X-Frame-Options`, CSP headers, cookie scoping, and `<base href>` injection are all unsolvable in the general case from inside a proxy shim. The replacement is a **tunnel system**: expose local ports as stable, auth-protected proxied URLs that open in the user's real browser, where the web platform works natively.

## Approach

- On wide screens (≥ 768px), render a resizable left sidebar and hide the bottom dock bar
- On narrow screens (< 768px), keep the existing bottom dock bar and mobile pane picker unchanged
- The sidebar contains two tabs — **Workspaces** and **Tunnels** — built on Radix UI Tabs
- Workspace cards show the active pane title and a count of remaining panes
- Tunnels are compact rows with status dot, port, short ID, copy-URL, and close actions
- The tunnel backend lives in `sessiond`: a lightweight in-memory registry, new WebSocket messages, and a new `/t/{id}/` HTTP proxy route
- All browser pane surface code (`mux-browser-surface`, `BrowserRenderer`, `/x/` external proxy, `/p/{port}/`) is deleted

## Architecture

```
┌──────────────┬─────────────────────────────────────┐
│   SIDEBAR    │                                     │
│   ~220px     │     dockview terminal area          │
│  (resizable) │     (panes, tabs, splits)           │
│              │                                     │
└──────────────┴─────────────────────────────────────┘
```

The sidebar is a flex column fixed to the left of the viewport, separated from the dockview area by a drag handle. It disappears entirely below the 768px breakpoint — the existing bottom dock bar reappears instead.

## Components

### Sidebar Shell

- Fixed left panel with a drag handle on the right edge
- Default width: ~220px · Min: 160px · Max: 360px
- Width persisted in `localStorage` per breakpoint so it survives page refresh
- Hidden on narrow screens (`< 768px`) via CSS media query or conditional render
- Contains the app header (`muxterm` branding) and the Radix Tabs root

### Sidebar Tabs

Two tabs using Radix UI Tabs:

```
╭──────────────────────╮
│ muxterm              │  ← header (branding)
├──────────────────────┤
│ Workspaces  Tunnels  │  ← Radix TabsList + TabsTrigger
├──────────────────────┤
│                      │
│   tab content        │
│                      │
╰──────────────────────╯
```

### Workspaces Tab

Workspace cards display the active pane title and a count of additional panes:

```
╭────────────────────╮
│ ● dev              │  ← active workspace (accent highlight)
│   nvim     +2      │  ← active pane title + count of others
╰────────────────────╯
╭────────────────────╮
│ ○ staging          │
│   npm run dev +1   │
╰────────────────────╯
╭────────────────────╮
│ ○ infra            │
│   zsh              │
╰────────────────────╯

  + New workspace
```

- `●` = active workspace, `○` = inactive
- Active workspace card has an accent border or background highlight
- Clicking a card switches to that workspace
- `+ New workspace` creates a new workspace inline

**Rename workspace:**
- Double-click the workspace name → inline text input appears in place
- Enter to confirm, Escape to cancel
- Same interaction pattern as the existing tab rename

**Remove workspace:**
- Hover over card → `✕` button appears
- Click `✕` → grace period begins (~10 seconds); workspace card dims in place
- Undo toast appears: `"dev" closed · Undo`
- Clicking Undo restores the workspace immediately, no state is lost
- After grace period expires: the workspace and all its panes are actually destroyed
- Mirrors the existing pane-close undo pattern for consistency

### Tunnels Tab

Compact row layout (Option A):

```
╭────────────────────────────╮
│ Workspaces  Tunnels        │
├────────────────────────────┤
│  ●  :5173    x7k2    ⎘  ✕  │
│  ●  :3000    ab9m    ⎘  ✕  │
│  ○  :8080    zr4q    ⎘  ✕  │
│                             │
│  + Forward a port           │
╰────────────────────────────╯
```

Column semantics per row:
- `●` / `○` — status: active (proxying) or inactive/stale
- `:PORT` — the local port being forwarded
- `x7k2` — short ID assigned by sessiond (4–6 chars, base36)
- `⎘` — copies the full tunnel URL (with auth token) to clipboard
- `✕` — closes the tunnel immediately

**Inline port input:**

Clicking `+ Forward a port` expands an inline input:

```
│  + Forward a port           │
│  ┌──────────────┐           │
│  │ :  _____     │ [Forward] │
│  └──────────────┘           │
```

Type a port number, press Enter or click Forward → the new row appears immediately above with its assigned ID.

### Tunnel URL Format

```
http://machine:9090/t/x7k2/?token=abc...xyz
```

- Auth token is embedded in the URL — self-contained and shareable
- Works from any browser with network access to the machine
- Opened in the real browser — no iframe, no proxy shims

## Data Flow

### Workspace Switching

1. User clicks a workspace card
2. Frontend emits existing workspace-switch message over WebSocket
3. Dockview area updates to the selected workspace's pane layout

### Tunnel Lifecycle

**Create:**
1. User enters a port and presses Forward
2. Frontend sends `create-tunnel { port }` over WebSocket
3. `sessiond` generates a short base36 ID, registers `id → port`, replies `tunnel-created { id, port }`
4. Row appears in the Tunnels tab

**Copy URL:**
1. User clicks `⎘`
2. Frontend constructs `http://<host>/t/<id>/?token=<hmac-token>` and copies to clipboard

**Proxy request:**
1. Browser (real browser, not iframe) navigates to the tunnel URL
2. `server.go` validates the HMAC token
3. Looks up `id → port` in the tunnel registry
4. Raw-proxies the request to `localhost:<port>` — no header stripping, no shim injection

**Close:**
1. User clicks `✕`
2. Frontend sends `close-tunnel { id }` over WebSocket
3. `sessiond` removes the entry, replies `tunnel-closed { id }`
4. Row disappears from the tab

## Error Handling

| Scenario | Handling |
|---|---|
| Sidebar width drag below min | Clamp to 160px |
| Sidebar width drag above max | Clamp to 360px |
| `localStorage` unavailable | Fall back to default width, no persistence |
| Tunnel port already in use | Server replies with error; frontend shows inline error on the row |
| Tunnel ID not found on proxy request | `404 Not Found` |
| HMAC token invalid on proxy request | `403 Forbidden` |
| sessiond restart | Tunnel registry is ephemeral; all tunnels gone; frontend reconciles on next `list-tunnels` response |
| Workspace remove undone after close | Workspace is fully restored from held state before destruction timer fires |

## Testing Strategy

**Sidebar layout:**
- Verify sidebar appears at ≥768px, bottom bar appears at <768px
- Drag handle: test min/max clamping, verify width persists after page reload
- Verify sidebar is absent from the DOM on narrow viewport (not just hidden)

**Workspace cards:**
- Active card has accent styling; inactive cards do not
- Double-click rename: confirm saves, Escape cancels
- Remove + undo: workspace reappears in correct position with all panes intact
- Remove without undo: workspace and panes are gone after grace period

**Tunnels:**
- Create tunnel: row appears with correct port and assigned ID
- Copy URL: clipboard contains correctly constructed URL with token
- Close tunnel: row removed; subsequent proxy request returns 404
- Inline port input: Enter and button click both trigger forward action
- Stale tunnel (sessiond restart): frontend clears all rows on reconnect/list refresh

**Tunnel proxy:**
- Valid token + known ID: proxies to correct local port transparently
- Invalid token: returns 403
- Unknown ID: returns 404
- Confirm no response header mutation (no `X-Frame-Options` stripping, no shim injection)

**Browser pane removal:**
- Verify `mux-browser-surface` custom element no longer registered
- Verify `/x/` and `/p/` routes return 404
- Verify no remaining import of `BrowserRenderer`

## Open Questions

None — all design decisions have been validated.
