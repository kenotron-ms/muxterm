# Settings UI Design (Phase 5)

## Goal

Build a macOS-style settings panel for muxterm — polished, intentional, and opinionated. Two sections only: Appearance and Notifications.

## Background

muxterm has accumulated several user-configurable values (theme, font, bell behavior) with no UI surface to change them. The only way to change settings today is to edit `~/.config/muxterm/config.toml` by hand. Phase 5 adds a proper settings panel that applies changes immediately, persists them to disk, and propagates them to all connected clients.

The design target is Apple System Settings, not VS Code's mechanical deep settings tree. Fewer sections, each one thoughtfully designed, with no Save button friction.

## Approach

**Sidebar + content area with apply-immediately, auto-persist semantics.**

The panel is a classic two-column layout: a narrow sidebar listing section names, a wider content area showing the selected section. Clicking a sidebar item swaps the content area — flat navigation, no nesting, no accordion.

Persistence is zero-friction: every user interaction immediately updates `store.config` optimistically, calls `configureTerminals()` so terminals reflect the change live, then debounces a `PATCH /api/config` write at 500 ms. No Save button. No Cancel. Changes are visible before they're persisted.

## Scope

**In scope:**

- **Appearance** — Theme thumbnails + Font family/size picker
- **Notifications** — Desktop alert permission + Bell behavior

**Explicitly out of scope for this phase:**

- Keybindings / shortcuts
- Terminal settings (cursor, scrollback)
- Advanced / workspace / driver settings

Bell behavior lives in Notifications only, not in a Terminal section.

## Layout

```
┌────────────────┬──────────────────────────────────────────┐
│  Appearance    │  [section content]                       │
│  Notifications │                                          │
└────────────────┴──────────────────────────────────────────┘
```

Clicking a sidebar item replaces the right panel content. Flat navigation — no nested sections, no accordion.

## Persistence Model

**Apply immediately, auto-persist. No Save button. No Cancel.**

```
User changes a value
  → store.config updates optimistically
  → configureTerminals() called → terminals update live
  → debounce 500ms
  → PATCH /api/config (partial config JSON)
  → server merges partial update
  → writes ~/.config/muxterm/config.toml
  → broadcasts {type:"config"} WebSocket message to all connected clients
```

All connected browser clients receive the broadcast and re-apply the config. This means a settings change on one device propagates to all open tabs.

## Appearance Section

### Theme Picker

A grid of theme thumbnail cards. Each card is a CSS-only fake terminal rendered using the theme's actual color tokens — background, foreground, blue for directories, green for executables, cursor color. No canvas. No screenshots. Renders instantly at any resolution.

Clicking a card applies the theme immediately. The selected card shows a checkmark overlay and a subtle border highlight.

**Initial themes:**

| Name | Notes |
|---|---|
| tokyo-night | Current default |
| catppuccin | Soft pastel palette |
| gruvbox | Warm retro |
| dracula | High-contrast purple |
| nord | Arctic blue |

### Font Picker

```
Family  ○ JetBrains Mono   ● FiraCode   ○ Cascadia
        ○ Hack              ○ Iosevka

Size    ●─────────────────── 13

Preview  The quick brown fox jumps $ █
```

**Font family** — five radio options. **Font size** — slider, range 8–24.

The preview line renders in the selected font via CSS (not xterm), so the user sees the change before terminals update.

**Hosted fonts** — bundled in `web/public/fonts/` (one subdirectory per family), served via `@font-face` declarations in a new `web/src/styles/fonts.css`. Loaded at startup through the existing `@xterm/addon-web-fonts` addon.

| Font | Notes |
|---|---|
| JetBrains Mono Nerd Font | Current default |
| FiraCode Nerd Font | Ligatures |
| Cascadia Code NF | Ligatures |
| Hack Nerd Font | No ligatures |
| Iosevka Nerd Font | Slim, modern |

All fonts are Nerd Font patched variants to ensure icon glyphs render correctly in terminal UIs.

## Notifications Section

```
Desktop Alerts

  Allow muxterm to send desktop notifications when
  a terminal needs your attention.

  [ Enable Desktop Notifications ]   ← button

  ────────────────────────────────────────────────

  Bell                  ● Visual   ○ Audible   ○ Off
                          (flash pane tab)
```

### Permission Flow

| State | UI shown |
|---|---|
| Not yet requested | "Enable Desktop Notifications" button |
| User clicks → granted | Button replaced with "Desktop Notifications: Enabled ✓" (not clickable) |
| User clicks → denied | "Blocked by browser — update in browser settings" with a help link |
| Already granted on load | Shows enabled state immediately — no button shown |

Permission state lives in the browser only (it is a browser API concern, not a `config.toml` concern).

### Bell Behavior

Maps to the existing `[terminal].bell` config field (`visual` / `audible` / `off`). Persists to `config.toml` via the standard apply-immediately flow.

- **Visual** — flashes the pane tab (current behavior)
- **Audible** — plays the system bell sound
- **Off** — silences all bell events

## Architecture

### New REST Endpoint

`PATCH /api/config`

Accepts a partial config JSON object. Merges with the current config, writes to `~/.config/muxterm/config.toml`, and broadcasts the updated config to all connected WebSocket clients via the existing `{type:"config"}` message.

The merge/write/broadcast pipeline is extracted into a shared handler used by both the REST endpoint and the MCP tools — no duplication.

### New MCP Tools

Two new tools registered in the muxterm MCP server:

**`get_config`** — no arguments. Returns the full resolved config as JSON.

**`update_config(changes: {...})`** — accepts a partial config object. Applies the same merge/write/broadcast pipeline as `PATCH /api/config`.

Examples:
```
update_config({ theme: "catppuccin" })
update_config({ font: { size: 15 } })
update_config({ notifications: { bell: "audible" } })
```

### Font Loading

Fonts are served from `web/public/fonts/` with one subdirectory per font family. CSS `@font-face` declarations live in `web/src/styles/fonts.css`. The existing `@xterm/addon-web-fonts` addon loads them at startup — no new loading infrastructure needed.

### Theme Thumbnails

Pure CSS. Each theme card uses inline CSS custom properties populated from the theme's color token map. No image assets, no canvas rendering, no build step.

```
.theme-card {
  --card-bg: <theme background>;
  --card-fg: <theme foreground>;
  --card-dir: <theme blue>;
  --card-exec: <theme green>;
  --card-cursor: <theme cursor>;
}
```

### Changed / New Files

| File | Change |
|---|---|
| `web/src/components/settings-surface.ts` | Full refactor — live bindings, theme cards, font picker, permission flow |
| `web/src/lib/config.ts` | Add `PATCH /api/config` helper + 500ms debounce logic |
| `web/src/styles/fonts.css` | **New** — `@font-face` declarations for all 5 hosted fonts |
| `web/public/fonts/` | **New** — 5 Nerd Font family directories |
| `internal/server/config_handler.go` | **New** — `PATCH /api/config` REST endpoint |
| `internal/server/mcp_tools.go` | **New** — `get_config` and `update_config` MCP tools |
| `internal/config/config.go` | Add `Merge(partial Config) Config` helper |

## Data Flow

### Settings change (user interaction)

```
User changes a setting in the UI
  → settings-surface dispatches config-change event
  → store.config updates optimistically
  → configureTerminals() applies change to live xterm instances
  → config.ts debounce timer resets (500ms)
  → [500ms later] PATCH /api/config sent with partial changes
  → server: Merge() + write config.toml + broadcast {type:"config"}
  → all connected clients receive broadcast → re-apply config
```

### Config loaded on connect

```
Client connects
  → receives {type:"config"} in initial handshake
  → store.config set
  → configureTerminals() runs
  → settings-surface renders with current values
```

### Notification permission

```
User clicks "Enable Desktop Notifications"
  → Notification.requestPermission() fires (browser native)
  → granted: update UI, store permission state in component only
  → denied: show blocked message + help link
```

Permission state is never written to `config.toml`. It is managed entirely by the browser and reflected in the UI on load.

## Error Handling

| Scenario | Handling |
|---|---|
| `PATCH /api/config` fails (network, server error) | Log the error. The optimistic in-memory update is already applied — do not roll back. Retry on next user change. |
| Font fails to load via `@font-face` | xterm falls back to its configured fallback font. The preview line shows the fallback. No crash. |
| `Notification.requestPermission()` throws (unsupported browser) | Catch the exception, show a "Notifications not supported in this browser" message. |
| `update_config` MCP call with unknown keys | Server ignores unknown fields during merge — only known config keys are written to `config.toml`. |
| WebSocket broadcast fails (client disconnected) | Server skips that client. Reconnecting clients receive current config on their next connect. |

## Testing Strategy

Settings UI is verified via Playwright with the existing muxterm E2E harness.

**Theme picker:**
- Click each theme card, verify the `store.config.theme` value updates, verify the terminal background color changes in the xterm instance.

**Font picker:**
- Change font family, verify the preview line reflects the new font (CSS `font-family` check), verify `configureTerminals()` is called.
- Drag the size slider, verify the xterm `fontSize` option updates.

**Persistence:**
- Change a setting, wait 600ms, verify a `PATCH /api/config` request was made with the correct partial payload.

**Notification permission:**
- Mock `Notification.requestPermission()` to return `'granted'` → verify the button becomes the "Enabled ✓" state.
- Mock to return `'denied'` → verify the blocked message appears.
- Set `Notification.permission = 'granted'` before load → verify the enabled state is shown without showing the button.

**MCP tools:**
- `get_config` returns a JSON object with all expected top-level keys.
- `update_config({ theme: "dracula" })` → verify config file on disk reflects the change and a WebSocket broadcast was sent.

## Development Safety Model

All implementation work is done in a git worktree. The production muxterm instance is never touched.

**Production instance (untouched):**

| Property | Value |
|---|---|
| Branch | `main` |
| Port | `8311` |
| Socket | `$XDG_RUNTIME_DIR/muxterm/sessiond.sock` |
| Config | `~/.config/muxterm/config.toml` |

**Dev worktree:**

| Property | Value |
|---|---|
| Branch | `settings/phase5-settings-ui` |
| Port | `8401` (from dev range 8400–8499) |

The dev worktree is fully isolated via XDG environment variables:

```bash
XDG_RUNTIME_DIR=/tmp/muxterm-dev-8401 \
XDG_CONFIG_HOME=~/.config/muxterm-dev \
./bin/muxterm --addr 0.0.0.0:8401
```

**Port convention:** each worktree claims a port from 8400–8499 and documents it in a `.devport` file at the worktree root. The run script reads `.devport`:

```bash
PORT=$(cat .devport 2>/dev/null || echo 8400)
XDG_RUNTIME_DIR=/tmp/muxterm-dev-$PORT \
XDG_CONFIG_HOME=~/.config/muxterm-dev \
./bin/muxterm --addr 0.0.0.0:$PORT
```

**Worktree setup:**

```bash
git worktree add ../muxterm-settings settings/phase5-settings-ui
echo 8401 > ../muxterm-settings/.devport
```

## Open Questions

None — all major decisions were resolved in the design session.
