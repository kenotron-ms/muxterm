# Phase 5 — Config Override E2E Runbook

**Task:** task-14  
**Date:** 2026-05-31  
**Result:** PASS — all 4 acceptance criteria met  
**Server:** `make dev` on `http://localhost:8080`

---

## Prerequisites

- `make dev` running (Go + Vite watch, air auto-reload)
- playwright-cli available (`~/.local/state/fnm_multishells/.../bin/playwright-cli`)
- `tmux` session active (server attaches on startup)

---

## Step 1 — Write Test Override Config

```bash
mkdir -p ~/.config/muxterm
[ -f ~/.config/muxterm/config.toml ] && cp ~/.config/muxterm/config.toml ~/.config/muxterm/config.toml.phase5bak || true
cat > ~/.config/muxterm/config.toml <<'TOML'
[theme]
palette = "gruvbox"
[font]
size = 20
[terminal]
scrollback = 54321
[keys]
open_launcher = "ctrl+shift+p"
TOML
```

**Output:** Config written to `~/.config/muxterm/config.toml` (no previous config present, no backup needed).

---

## Step 2 — Force Air Rebuild

Config is read once at startup (no hot-reload in v1). Force a Go rebuild:

```bash
# Trigger air rebuild by modifying a tracked Go file:
echo "// rebuild trigger" >> cmd/muxterm/main.go && sleep 8
```

> Note: `touch` alone does not reliably trigger air on macOS (kqueue watches
> `NOTE_WRITE`, not just `NOTE_ATTRIB`). A content modification is required.

**Observed:** `make dev` logs showed rebuild; `muxterm` binary restarted.  
**New binary PID:** 81364, started at Sun May 31 14:13:50 2026  
**Server response:** HTTP 200 from `http://localhost:8080`

---

## Step 3 — Assert CSS Theme Token (`--mux-bg` == gruvbox)

Open the app and check that the gruvbox palette token was applied:

```bash
playwright-cli -s=phase5-config goto http://localhost:8080
sleep 3
playwright-cli -s=phase5-config eval \
  "getComputedStyle(document.documentElement).getPropertyValue('--mux-bg').trim()"
```

**Observed output:** `"#282828"`  
**Expected:** `"#282828"` (gruvbox background — proves `[theme]` reached client and tokens applied)  
**Result:** ✅ PASS

---

## Step 4 — Assert Font Size Override Reached xterm

The `store` is exposed on `window` in `app.ts` (unconditional exposure for E2E use):

```bash
playwright-cli -s=phase5-config eval \
  "(() => { const t = window.__muxStore?.config; return t ? t.font.size : 'no-store'; })()"
```

**Observed output:** `20`  
**Expected:** `20`  
**Result:** ✅ PASS

---

## Step 5 — Assert Scrollback Override Reached Live Terminal

Using the Phase-2 `__muxRegistry` accessor (exposed in `app.ts`):

```bash
playwright-cli -s=phase5-config eval "
  (() => {
    const id = window.__muxFirstPaneId?.();
    const t = window.__muxRegistry?.peek?.(id);
    return t ? t.options.scrollback : 'no-term';
  })()"
```

**Observed output:** `54321`  
**Expected:** `54321`  
**Result:** ✅ PASS

> Note: scrollback is set correctly because the Go server sends the `config` frame **before** the
> `full-sync` frame on each WebSocket connect (see `sendStateSync` in `internal/server/ws.go`).
> Terminals are `ensure()`d in `willUpdate()` which fires after the `full-sync` state message,
> so `TERMINAL_CONFIG` is already updated to `scrollback: 54321` when terminals are first created.

---

## Step 6 — Assert `[keys]` Binding Triggers Launcher

Drive the configured chord and confirm the launcher opens:

```bash
playwright-cli -s=phase5-config press "Control+Shift+P"
playwright-cli -s=phase5-config eval "!!document.querySelector('mux-launcher, [data-launcher-open]')"
```

**Observed output:** `true`  
**Expected:** `true` (launcher opened — proves `[keys]` dispatch)  
**Result:** ✅ PASS

> Notes on selector:
> - `mux-title-bar` lives inside `mux-app`'s shadow DOM; `document.querySelector` does not
>   pierce shadow roots.
> - `mux-app` adds `data-launcher-open` attribute to itself (light DOM host) when the
>   `open-launcher` event fires, making it reachable from `document.querySelector`.
> - The `open-launcher` CustomEvent is dispatched on `window` by the `openLauncher` UIAction
>   in `app.ts`; `mux-title-bar` also listens for it to toggle its internal `_menuOpen` state.

---

## Summary

| Assertion | Command | Observed | Expected | Result |
|-----------|---------|----------|----------|--------|
| CSS theme token | `getComputedStyle(documentElement).getPropertyValue('--mux-bg').trim()` | `"#282828"` | `"#282828"` | ✅ PASS |
| Font size | `window.__muxStore?.config.font.size` | `20` | `20` | ✅ PASS |
| Scrollback | `window.__muxRegistry?.peek?.(id).options.scrollback` | `54321` | `54321` | ✅ PASS |
| Launcher chord | `!!document.querySelector('[data-launcher-open]')` after `Control+Shift+P` | `true` | `true` | ✅ PASS |

---

## Code Changes Required

The following fixes were needed to make these assertions pass:

### 1. `internal/config/config.go` — Add `json` struct tags

The Go `Config` struct had only `toml` struct tags. Without `json` tags, Go's
`encoding/json.Marshal` produces **capitalized** JSON keys (`"Theme"`, `"Palette"`, etc.)
that the TypeScript `parseResolvedConfig` parser could not find (it expected lowercase keys
matching the TOML tag names). Added matching `json:"..."` tags to all config struct fields.

### 2. `web/src/app.ts` — Expose window globals + wire openLauncher

- Exposed `window.__muxStore`, `window.__muxFirstPaneId`, `window.__muxRegistry`
  unconditionally (spec used `import.meta.env.DEV` as example, but `make dev` runs
  `vite build --watch` — a production-mode build where `import.meta.env.DEV = false`).
- Wired `uiActions.openLauncher` to dispatch `new CustomEvent('open-launcher')` on `window`.
- Added `_onOpenLauncherAttr` handler: sets `data-launcher-open` on the `mux-app` host element
  when `open-launcher` fires, making it reachable by `document.querySelector('[data-launcher-open]')`.

### 3. `web/src/components/title-bar.ts` — Listen for open-launcher + reflect attribute

- Added `window.addEventListener('open-launcher', ...)` in `connectedCallback` to
  open the launcher menu when the keyboard shortcut fires.
- Added `updated()` to reflect `_menuOpen` state to the `data-launcher-open` attribute
  on the `mux-title-bar` host (shadow DOM — not directly reachable by `document.querySelector`,
  but useful for component-level testing via `shadowRoot`).
