# muxterm Phase 5 — Config File + UI Polish Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Add a minimal user config (`~/.config/muxterm/config.toml`) that overrides ONLY muxterm's own hardcoded defaults (never tmux internals), ship the resolved config to the client on connect, formalize the `[keys]` UI-action bindings, and run a consistency polish pass that makes the chrome theme-driven.

**Architecture:** The **Go server** reads the TOML file once at startup, merges it over hardcoded defaults (malformed → defaults + a logged warning, never a crash), and ships the resolved config to the browser as part of the on-connect sync sequence (one source of truth). The browser applies the resolved config to the xterm.js theme/font/terminal options and to its UI keybindings, and the chrome components consume the resolved `[theme]` via CSS variables.

**Tech Stack:** Go 1.24 (`github.com/BurntSushi/toml`), TypeScript + Lit + xterm.js (Vite), Vitest (web unit), `playwright-cli` against the running `make dev` server (Go on `localhost:8080`), Go `testing` table tests.

---

## Phase 1–4 Actuals (grounding for implementers)

Use these exact names and values. Do not use hypothetical names from the plan when they differ from actuals.

### `CHROME` tokens — `web/src/lib/theme.ts`

9 tokens, exported as `CHROME`:
```ts
CHROME.bar         = '#16161e'   // title bar / tab strip BG
CHROME.body        = '#1a1b26'   // surface body / active tab merged BG
CHROME.border      = '#292e42'   // hairline separators
CHROME.textDim     = '#565f89'   // inactive/muted text
CHROME.textBright  = '#c0caf5'   // active/focused text
CHROME.accent      = '#7aa2f7'   // active-tab top accent line
CHROME.driverAccent= '#bb9af7'   // driver region magenta
CHROME.hover       = '#1f2335'   // icon-button hover BG
CHROME.danger      = '#f7768e'   // close-× hover
```

**Phase 5 polish pass goal:** every chrome component must use CHROME tokens — NO hardcoded hex.

### `TERMINAL_CONFIG` defaults — `web/src/lib/terminal-registry.ts` (lines 20–31)

These are the hardcoded defaults Phase 5 config system overrides:
```
fontFamily: 'SF Mono', 'JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', 'Fira Code', 'Menlo', 'Consolas', monospace
fontSize:   13
lineHeight: 1.2  (non-overridable by user, leave alone)
cursorBlink: true
cursorStyle: 'block'
scrollback:  10000
```
Non-overridable internals (leave alone): `allowTransparency: false`, `convertEol: false`.

### Chrome component CHROME status (which need Phase 5 polish)

| File | Status |
|------|--------|
| `web/src/components/title-bar.ts` | ✅ Fully CHROME-tokenized — no changes needed |
| `web/src/components/region-tabstrip.ts` | ✅ Fully CHROME-tokenized — no changes needed |
| `web/src/components/region-menu.ts` | ✅ Fully CHROME-tokenized — no changes needed |
| `web/src/components/launcher-menu.ts` | ✅ Fully CHROME-tokenized — no changes needed (dead `.close-region:hover` CSS already removed) |
| `web/src/components/browser-surface.ts` | ❌ **5 hardcoded hex literals** need migration: `#1a1b26`, `#32344a`, `#24283b`, `#c0caf5`, `#7aa2f7`. NOTE: `#32344a` has no direct CHROME equivalent — map it to `CHROME.border` (#292e42) or add `CHROME.panelBorder = '#32344a'` as a new token. Decide in Phase 5. |
| `web/src/components/settings-surface.ts` | ✅ Mostly tokenized — one `#7aa2f7` as display text (accent label), not a CSS property. Acceptable, no change needed. |
| `web/src/components/status-bar.ts` | ❌ **Still uses raw hex** (deferred from Phase 4 review). Must be migrated to CHROME tokens in Phase 5 polish sweep. |

### `applyMuxtermConfig` — `cmd/muxterm/main.go:238`

Sets exactly 3 tmux options (all load-bearing — **do NOT expose via config**):
```
mouse          on
focus-events   on
history-limit  10000   // maps to scrollback; keep hardcoded (coupling risk not worth it for v1)
```
These are muxterm's implementation details — exposing them via config would let users break the app.

### Go TOML dependency

**Not present in `go.mod`.** Only two current deps: `github.com/coder/websocket v1.8.14` and `github.com/creack/pty v1.1.24`. Phase 5 must `go get github.com/BurntSushi/toml` (preferred, widely used) OR `github.com/pelletier/go-toml/v2` (struct-tag compatible with encoding/json). Either works; BurntSushi/toml is the simpler API for this use case.

### Phase 4 deferred stubs (DO NOT implement in Phase 5)

These stubs exist in `app.ts` or related files from Phase 4 as v1 deferred TODOs. Phase 5 must NOT attempt to complete them:
- `_splitRegion()` — region split is v1 deferred (only ⊟ Split right/down menu items are stubs)
- `_renameRegionWindow()` — window rename is v1 deferred

These are intentional TODOs, not oversights. Do not touch them.

### Phase 2 Verification Harness (use in E2E tasks)

- `window.__muxterm.snapshot(paneId: number)` → `StructuredSnapshot` (via `playwright-cli eval`)
- `web/e2e/helpers/fidelity.ts`: `compareContent(paneId, sessionName)` + `compareLayout(paneId, element)`
- Dev server on `http://localhost:8080` (confirmed)
- `cd web && npm test` for Vitest; `go test ./...` for Go

---

## Context the implementer needs (read first)

- **Design source of truth:** `docs/plans/2026-05-30-muxterm-panes-multisession-driver-design.md`, sections *"Config (muxterm-owned knobs only)"* (≈L365) and *"UI polish"* (≈L398).
- **Mockups to match:** `docs/plans/mockups/2026-05-30-muxterm-chrome/*.png`.
- **The hard rule (do NOT violate):** tmux internals are load-bearing and must stay hardcoded in `cmd/muxterm/main.go` `applyMuxtermConfig()` (≈L236). NEVER expose `mouse`, `focus-events`, `history-limit`, `window-size`, `aggressive-resize` through config. Config = "replace a default muxterm already controls" (theme, font, xterm.js presentation, UI keybindings, workspace presentation, driver autostart).
- **Existing defaults you are making overridable:**
  - `web/src/lib/theme.ts` — `THEME` palette object (Tokyo Night).
  - `web/src/lib/terminal-registry.ts` — `TERMINAL_CONFIG` (`fontFamily`, `fontSize`, `cursorStyle`, `cursorBlink`, `scrollback`).
  - There is no `bell` set today; add it (default `"visual"`).
- **Server → client message shape:** the server sends JSON text frames as single-key objects, e.g. `{"full-sync": <state>}` (see `internal/server/ws.go` `sendStateSync()` ≈L266 and `NewServerMsg()` ≈L220). The browser normalizes these in `web/src/ws.ts` (`normalizeMessage`, ≈L330) and dispatches into `web/src/state.ts` `MuxStore.applyMessage()` (≈L27). Raw messages are ALSO handed to `_controlMessageCb` before normalization — this plan uses a NEW `{"config": <resolved>}` text frame consumed via that raw control path.
- **Wiring entry points:** `cmd/muxterm/main.go` `runLocal()` (≈L69) and `runServe()` (≈L95) construct the server/hub. The config is loaded once in each and handed to the hub.
- **Test commands:**
  - Go: `go test ./...`
  - Web unit: `cd web && npm test` (Vitest; tests live in `web/src/__tests__/` and `web/src/lib/*.test.ts`).
  - E2E: `playwright-cli` against the user's running `make dev` (server `http://localhost:8080`). Use the Phase-2 xterm `StructuredSnapshot` harness for any terminal-content assertions. **NO OCR.**

**Scope — IN:** `config.toml` (muxterm-owned knobs only), resolved-config delivery to client, keybindings map + dispatch, consistency polish (theme tokens). **OUT/DEFERRED:** tmux passthrough (forbidden), hot-reload, per-pane overrides, the driver application, Tier-2 `MUXTERM_CTL`, PWA/WCO, multi-viewer (`shared_window_policy` is a RESERVED key only — parse + carry it, do not act on it), float (cut), phone.

---

## Task 1: Add TOML dependency + config package with hardcoded defaults

**Files:**
- Modify: `go.mod`, `go.sum` (via `go get`)
- Create: `internal/config/config.go`
- Test: `internal/config/config_test.go`

**Step 1: Add the TOML dependency**
Run: `go get github.com/BurntSushi/toml@latest`
Expected: `go.mod` now lists `github.com/BurntSushi/toml`; `go.sum` updated. No error.

**Step 2: Write the failing test for `Defaults()`**
Create `internal/config/config_test.go`:
```go
package config

import "testing"

func TestDefaults(t *testing.T) {
	d := Defaults()

	if d.Theme.Palette != "tokyo-night" {
		t.Errorf("Theme.Palette = %q, want tokyo-night", d.Theme.Palette)
	}
	if d.Font.Size != 13 {
		t.Errorf("Font.Size = %d, want 13", d.Font.Size)
	}
	if d.Terminal.Scrollback != 10000 {
		t.Errorf("Terminal.Scrollback = %d, want 10000", d.Terminal.Scrollback)
	}
	if d.Terminal.CursorStyle != "block" {
		t.Errorf("Terminal.CursorStyle = %q, want block", d.Terminal.CursorStyle)
	}
	if d.Terminal.Bell != "visual" {
		t.Errorf("Terminal.Bell = %q, want visual", d.Terminal.Bell)
	}
	if d.Keys.NextSession != "ctrl+shift+]" {
		t.Errorf("Keys.NextSession = %q, want ctrl+shift+]", d.Keys.NextSession)
	}
	if d.Workspace.DefaultPresentation != "docked" {
		t.Errorf("Workspace.DefaultPresentation = %q, want docked", d.Workspace.DefaultPresentation)
	}
	if d.Driver.Autostart != false {
		t.Errorf("Driver.Autostart = %v, want false", d.Driver.Autostart)
	}
}
```

**Step 3: Run the test to verify it fails**
Run: `go test ./internal/config/...`
Expected: FAIL — `undefined: Defaults` (package does not compile).

**Step 4: Write `internal/config/config.go`**
```go
// Package config loads muxterm's user config. It exposes ONLY muxterm-owned
// knobs (theme, font, xterm.js presentation, UI keybindings, workspace
// presentation, driver autostart). It deliberately does NOT expose tmux
// internals (mouse, focus-events, history-limit, window-size, aggressive-resize):
// those are load-bearing and stay hardcoded in cmd/muxterm. The resolved config
// is shipped to the browser on connect as the single source of truth.
package config

// Config is the resolved muxterm configuration (defaults merged with the file).
type Config struct {
	Theme     ThemeConfig     `toml:"theme"`
	Font      FontConfig      `toml:"font"`
	Terminal  TerminalConfig  `toml:"terminal"`
	Keys      KeysConfig      `toml:"keys"`
	Workspace WorkspaceConfig `toml:"workspace"`
	Driver    DriverConfig    `toml:"driver"`
}

type ThemeConfig struct {
	Palette string `toml:"palette"`
}

type FontConfig struct {
	Family string `toml:"family"`
	Size   int    `toml:"size"`
}

type TerminalConfig struct {
	CursorStyle string `toml:"cursor_style"`
	CursorBlink bool   `toml:"cursor_blink"`
	Scrollback  int    `toml:"scrollback"`
	Bell        string `toml:"bell"` // visual | audible | off
}

// KeysConfig maps muxterm's OWN UI actions to key chords. NEVER tmux keys.
type KeysConfig struct {
	NextSession    string `toml:"next_session"`
	Split          string `toml:"split"`
	MaximizeRegion string `toml:"maximize_region"`
	PopOut         string `toml:"pop_out"`
	OpenLauncher   string `toml:"open_launcher"`
	FocusDriver    string `toml:"focus_driver"`
}

type WorkspaceConfig struct {
	DefaultPresentation string   `toml:"default_presentation"` // docked | single
	Rails               []string `toml:"rails"`
}

type DriverConfig struct {
	Autostart bool `toml:"autostart"`
	// SharedWindowPolicy is RESERVED (multi-viewer is post-v1). Parsed and
	// carried through to the client, but not acted on in this phase.
	SharedWindowPolicy string `toml:"shared_window_policy"`
	Launch             string `toml:"launch"`
}

// Defaults returns the hardcoded muxterm defaults. These mirror the current
// hardcoded values in web/src/lib/theme.ts and terminal-registry.ts so that an
// absent or malformed config produces byte-for-byte today's behavior.
func Defaults() Config {
	return Config{
		Theme: ThemeConfig{Palette: "tokyo-night"},
		Font: FontConfig{
			Family: "'SF Mono', 'JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', 'Fira Code', 'Menlo', 'Consolas', monospace",
			Size:   13,
		},
		Terminal: TerminalConfig{
			CursorStyle: "block",
			CursorBlink: true,
			Scrollback:  10000,
			Bell:        "visual",
		},
		Keys: KeysConfig{
			NextSession:    "ctrl+shift+]",
			Split:          "ctrl+shift+\\",
			MaximizeRegion: "ctrl+shift+m",
			PopOut:         "ctrl+shift+o",
			OpenLauncher:   "ctrl+shift+p",
			FocusDriver:    "ctrl+shift+a",
		},
		Workspace: WorkspaceConfig{
			DefaultPresentation: "docked",
			Rails:               []string{"sessions"},
		},
		Driver: DriverConfig{
			Autostart:          false,
			SharedWindowPolicy: "follow",
			Launch:             "muxterm-agent",
		},
	}
}
```

**Step 5: Run the test to verify it passes**
Run: `go test ./internal/config/...`
Expected: PASS (`ok  github.com/user/muxterm/internal/config`).

**Step 6: Commit**
Run: `go mod tidy && git add go.mod go.sum internal/config/ && git commit -m "feat(config): add config package with hardcoded muxterm defaults"`

---

## Task 2: `Load()` — missing file returns defaults

**Files:**
- Modify: `internal/config/config.go`
- Test: `internal/config/config_test.go`

**Step 1: Write the failing test**
Append to `internal/config/config_test.go`:
```go
func TestLoadMissingFileReturnsDefaults(t *testing.T) {
	cfg, err := Load("/nonexistent/path/to/config.toml")
	if err != nil {
		t.Fatalf("Load returned error for missing file: %v", err)
	}
	if cfg != Defaults() {
		t.Errorf("Load(missing) did not equal Defaults()")
	}
}
```
NOTE: `cfg != Defaults()` compiles because `Config` is comparable EXCEPT `Workspace.Rails` (a slice). To keep this comparison valid, compare field-by-field instead. Replace the body with:
```go
func TestLoadMissingFileReturnsDefaults(t *testing.T) {
	cfg, err := Load("/nonexistent/path/to/config.toml")
	if err != nil {
		t.Fatalf("Load returned error for missing file: %v", err)
	}
	if cfg.Theme.Palette != "tokyo-night" || cfg.Terminal.Scrollback != 10000 {
		t.Errorf("Load(missing) did not fall back to defaults: %+v", cfg)
	}
}
```

**Step 2: Run the test to verify it fails**
Run: `go test ./internal/config/...`
Expected: FAIL — `undefined: Load`.

**Step 3: Implement `Load()` (missing-file path only for now)**
Add to `internal/config/config.go`:
```go
import (
	"errors"
	"io/fs"
	"log"
	"os"

	"github.com/BurntSushi/toml"
)

// Load reads the TOML config at path, merged over Defaults(). Resolution rules:
//   - missing file        -> Defaults() (no error: config is optional)
//   - malformed file       -> Defaults() + a logged warning (never returns an error,
//                             so a typo can never take the app down)
//   - present and valid    -> Defaults() with the file's set fields applied on top
//
// Because we start from Defaults() and decode INTO it, any key the user omits
// keeps its default value (partial configs are supported).
func Load(path string) (Config, error) {
	cfg := Defaults()

	if _, statErr := os.Stat(path); errors.Is(statErr, fs.ErrNotExist) {
		return cfg, nil
	}

	if _, err := toml.DecodeFile(path, &cfg); err != nil {
		log.Printf("config: %s is malformed (%v); using built-in defaults", path, err)
		return Defaults(), nil
	}
	return cfg, nil
}
```

**Step 4: Run the test to verify it passes**
Run: `go test ./internal/config/...`
Expected: PASS.

**Step 5: Commit**
Run: `git add internal/config/ && git commit -m "feat(config): Load() returns defaults when file is absent"`

---

## Task 3: `Load()` — valid file overrides defaults (partial config)

**Files:**
- Test: `internal/config/config_test.go`

**Step 1: Write the failing test (table-driven, uses a temp file)**
Append to `internal/config/config_test.go`:
```go
import "path/filepath" // add to the existing import block if not present

func writeTempConfig(t *testing.T, contents string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(p, []byte(contents), 0o644); err != nil {
		t.Fatalf("write temp config: %v", err)
	}
	return p
}

func TestLoadOverridesDefaults(t *testing.T) {
	const contents = `
[theme]
palette = "gruvbox"

[font]
size = 16

[terminal]
scrollback = 50000
bell = "off"

[keys]
open_launcher = "ctrl+k"

[workspace]
default_presentation = "single"
`
	cfg, err := Load(writeTempConfig(t, contents))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	// Overridden values:
	if cfg.Theme.Palette != "gruvbox" {
		t.Errorf("Theme.Palette = %q, want gruvbox", cfg.Theme.Palette)
	}
	if cfg.Font.Size != 16 {
		t.Errorf("Font.Size = %d, want 16", cfg.Font.Size)
	}
	if cfg.Terminal.Scrollback != 50000 {
		t.Errorf("Terminal.Scrollback = %d, want 50000", cfg.Terminal.Scrollback)
	}
	if cfg.Terminal.Bell != "off" {
		t.Errorf("Terminal.Bell = %q, want off", cfg.Terminal.Bell)
	}
	if cfg.Keys.OpenLauncher != "ctrl+k" {
		t.Errorf("Keys.OpenLauncher = %q, want ctrl+k", cfg.Keys.OpenLauncher)
	}
	if cfg.Workspace.DefaultPresentation != "single" {
		t.Errorf("Workspace.DefaultPresentation = %q, want single", cfg.Workspace.DefaultPresentation)
	}

	// Untouched keys keep defaults:
	if cfg.Font.Family != Defaults().Font.Family {
		t.Errorf("Font.Family was clobbered: %q", cfg.Font.Family)
	}
	if cfg.Keys.NextSession != "ctrl+shift+]" {
		t.Errorf("Keys.NextSession = %q, want default ctrl+shift+]", cfg.Keys.NextSession)
	}
}
```

**Step 2: Run the test to verify it passes immediately**
Run: `go test ./internal/config/...`
Expected: PASS (no production change — `Load()` already decodes into `Defaults()`). This test PROVES the partial-override merge works. If it FAILS, the merge is broken; do not proceed.

**Step 3: Commit**
Run: `git add internal/config/ && git commit -m "test(config): prove partial file overrides merge over defaults"`

---

## Task 4: `Load()` — malformed file falls back to defaults + warning (no crash)

**Files:**
- Test: `internal/config/config_test.go`

**Step 1: Write the failing test**
Append to `internal/config/config_test.go`:
```go
func TestLoadMalformedFallsBackToDefaults(t *testing.T) {
	// Invalid TOML: unterminated string / junk.
	const broken = "[theme]\npalette = \"unterminated"
	cfg, err := Load(writeTempConfig(t, broken))
	if err != nil {
		t.Fatalf("Load must NOT return an error for malformed config, got: %v", err)
	}
	if cfg.Theme.Palette != "tokyo-night" {
		t.Errorf("malformed config did not fall back to defaults: %+v", cfg)
	}
	if cfg.Terminal.Scrollback != 10000 {
		t.Errorf("malformed config did not fully reset to defaults: %+v", cfg)
	}
}
```

**Step 2: Run the test to verify it passes**
Run: `go test ./internal/config/...`
Expected: PASS (the malformed branch already returns `Defaults(), nil` and logs a warning). This test PROVES the no-crash contract.

**Step 3: Run the full Go suite to confirm nothing regressed**
Run: `go test ./...`
Expected: PASS across all packages.

**Step 4: Commit**
Run: `git add internal/config/ && git commit -m "test(config): malformed config falls back to defaults without error"`

---

## Task 5: Resolve the config path + load at startup; thread into the hub

**Files:**
- Create: `internal/config/path.go`
- Test: `internal/config/path_test.go`
- Modify: `cmd/muxterm/main.go` (`runLocal` ≈L69, `runServe` ≈L95)

**Step 1: Write the failing test for the path resolver**
Create `internal/config/path_test.go`:
```go
package config

import (
	"path/filepath"
	"testing"
)

func TestDefaultPathUsesXDGConfigHome(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "/tmp/xdg")
	got := DefaultPath()
	want := filepath.Join("/tmp/xdg", "muxterm", "config.toml")
	if got != want {
		t.Errorf("DefaultPath() = %q, want %q", got, want)
	}
}

func TestDefaultPathFallsBackToHome(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("HOME", "/home/tester")
	got := DefaultPath()
	want := filepath.Join("/home/tester", ".config", "muxterm", "config.toml")
	if got != want {
		t.Errorf("DefaultPath() = %q, want %q", got, want)
	}
}
```

**Step 2: Run to verify it fails**
Run: `go test ./internal/config/...`
Expected: FAIL — `undefined: DefaultPath`.

**Step 3: Implement the path resolver**
Create `internal/config/path.go`:
```go
package config

import (
	"os"
	"path/filepath"
)

// DefaultPath returns the canonical config location:
//   $XDG_CONFIG_HOME/muxterm/config.toml, or ~/.config/muxterm/config.toml.
func DefaultPath() string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".config")
	}
	return filepath.Join(base, "muxterm", "config.toml")
}
```

**Step 4: Run to verify it passes**
Run: `go test ./internal/config/...`
Expected: PASS.

**Step 5: Load config at startup and store it on the hub**
First add a config field + setter to the hub. In `internal/server/ws.go`, in the `Hub` struct (≈L155) add a field, and add a method (place near `NewHub`):
```go
// Add to the Hub struct:
//   resolvedConfig any // muxterm-owned resolved config, shipped to clients on connect

// SetResolvedConfig stores the resolved muxterm config to ship to clients on
// connect. Stored as `any` so the server package takes no dependency on the
// config package's concrete type (it only marshals it to JSON).
func (h *Hub) SetResolvedConfig(cfg any) {
	h.resolvedConfig = cfg
}
```
Then in `cmd/muxterm/main.go`, in BOTH `runLocal` and `runServe`, immediately after `srv := server.New(...)` and before the goroutines, add:
```go
	cfg := config.Load(configPathOrDefault())
	srv.Hub().SetResolvedConfig(cfg)
```
Wait — `config.Load` returns `(Config, error)`. Use:
```go
	resolved, _ := config.Load(config.DefaultPath()) // never errors; malformed -> defaults
	srv.Hub().SetResolvedConfig(resolved)
```
Add the import `"github.com/user/muxterm/internal/config"` to `cmd/muxterm/main.go`.

**Step 6: Build to verify wiring compiles**
Run: `go build ./...`
Expected: builds clean. (The stored config is not yet sent — that is Task 6.)

**Step 7: Commit**
Run: `git add internal/config/ internal/server/ws.go cmd/muxterm/main.go && git commit -m "feat(config): resolve path, load at startup, store resolved config on hub"`

---

## Task 6: Ship the resolved config to the client on connect

**Files:**
- Modify: `internal/server/ws.go` (`sendStateSync` ≈L266)
- Test: `internal/server/ws_config_test.go`

**Step 1: Write the failing test**
Create `internal/server/ws_config_test.go`:
```go
package server

import (
	"encoding/json"
	"testing"
)

// TestConfigMessageEnvelope verifies that a resolved config marshals into the
// single-key {"config": ...} envelope the browser's control path expects.
func TestConfigMessageEnvelope(t *testing.T) {
	resolved := map[string]any{
		"theme":    map[string]any{"palette": "tokyo-night"},
		"terminal": map[string]any{"scrollback": 10000},
	}
	data, err := NewServerMsg("config", resolved)
	if err != nil {
		t.Fatalf("NewServerMsg: %v", err)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := got["config"]; !ok {
		t.Fatalf("envelope missing top-level \"config\" key: %s", data)
	}
}
```

**Step 2: Run to verify it passes**
Run: `go test ./internal/server/ -run TestConfigMessageEnvelope`
Expected: PASS (`NewServerMsg` already exists). This pins the envelope contract.

**Step 3: Emit the config frame in `sendStateSync`**
In `internal/server/ws.go` `sendStateSync()`, immediately after the `if h.engine == nil { return }` guard and BEFORE the `full-sync` marshal, add:
```go
	// Ship the resolved muxterm config FIRST so the browser has theme/font/keys
	// available before it resets terminals and applies full-sync. Best-effort:
	// a nil config (older startup paths) simply sends nothing.
	if h.resolvedConfig != nil {
		if cfgData, cfgErr := NewServerMsg("config", h.resolvedConfig); cfgErr != nil {
			log.Printf("sendStateSync: config marshal error: %v", cfgErr)
		} else if writeErr := c.writeText(cfgData); writeErr != nil {
			log.Printf("sendStateSync: config write error: %v", writeErr)
		}
	}
```

**Step 4: Run the server suite + full build**
Run: `go test ./internal/server/... && go build ./...`
Expected: PASS + clean build.

**Step 5: Commit**
Run: `git add internal/server/ && git commit -m "feat(config): send resolved config frame to client on connect"`

---

## Task 7: Client resolved-config type + `applyConfig` (theme/font/terminal)

**Files:**
- Create: `web/src/lib/config.ts`
- Test: `web/src/lib/config.test.ts`

**Step 1: Write the failing test**
Create `web/src/lib/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseResolvedConfig, DEFAULT_RESOLVED_CONFIG } from './config.js';

describe('parseResolvedConfig', () => {
  it('returns defaults for an empty/garbage payload', () => {
    expect(parseResolvedConfig(null)).toEqual(DEFAULT_RESOLVED_CONFIG);
    expect(parseResolvedConfig({})).toEqual(DEFAULT_RESOLVED_CONFIG);
    expect(parseResolvedConfig('nope')).toEqual(DEFAULT_RESOLVED_CONFIG);
  });

  it('reads server snake_case fields into the typed config', () => {
    const cfg = parseResolvedConfig({
      theme: { palette: 'gruvbox' },
      font: { family: 'Iosevka', size: 16 },
      terminal: { cursor_style: 'bar', cursor_blink: false, scrollback: 50000, bell: 'off' },
      keys: { open_launcher: 'ctrl+k' },
      workspace: { default_presentation: 'single' },
    });
    expect(cfg.theme.palette).toBe('gruvbox');
    expect(cfg.font.family).toBe('Iosevka');
    expect(cfg.font.size).toBe(16);
    expect(cfg.terminal.cursorStyle).toBe('bar');
    expect(cfg.terminal.cursorBlink).toBe(false);
    expect(cfg.terminal.scrollback).toBe(50000);
    expect(cfg.terminal.bell).toBe('off');
    expect(cfg.keys.openLauncher).toBe('ctrl+k');
    expect(cfg.workspace.defaultPresentation).toBe('single');
  });

  it('keeps defaults for omitted fields', () => {
    const cfg = parseResolvedConfig({ theme: { palette: 'gruvbox' } });
    expect(cfg.font.size).toBe(DEFAULT_RESOLVED_CONFIG.font.size);
    expect(cfg.keys.nextSession).toBe(DEFAULT_RESOLVED_CONFIG.keys.nextSession);
  });
});
```

**Step 2: Run to verify it fails**
Run: `cd web && npm test -- config.test`
Expected: FAIL — cannot resolve `./config.js`.

**Step 3: Implement `web/src/lib/config.ts`**
```ts
/**
 * Client-side resolved muxterm config. The server resolves the user's
 * config.toml over hardcoded defaults and ships it as a `{"config": ...}`
 * frame on connect. This module is the single typed view of that payload,
 * plus a defensive parser (server is trusted, but never let a bad payload
 * crash the UI) and appliers for theme/font/terminal.
 */

export interface ResolvedConfig {
  theme: { palette: string };
  font: { family: string; size: number };
  terminal: {
    cursorStyle: 'block' | 'bar' | 'underline';
    cursorBlink: boolean;
    scrollback: number;
    bell: 'visual' | 'audible' | 'off';
  };
  keys: {
    nextSession: string;
    split: string;
    maximizeRegion: string;
    popOut: string;
    openLauncher: string;
    focusDriver: string;
  };
  workspace: { defaultPresentation: 'docked' | 'single'; rails: string[] };
  driver: { autostart: boolean; sharedWindowPolicy: string; launch: string };
}

// Mirrors internal/config.Defaults() exactly so client and server agree when
// no override is present.
export const DEFAULT_RESOLVED_CONFIG: ResolvedConfig = {
  theme: { palette: 'tokyo-night' },
  font: {
    family:
      "'SF Mono', 'JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', 'Fira Code', 'Menlo', 'Consolas', monospace",
    size: 13,
  },
  terminal: { cursorStyle: 'block', cursorBlink: true, scrollback: 10000, bell: 'visual' },
  keys: {
    nextSession: 'ctrl+shift+]',
    split: 'ctrl+shift+\\',
    maximizeRegion: 'ctrl+shift+m',
    popOut: 'ctrl+shift+o',
    openLauncher: 'ctrl+shift+p',
    focusDriver: 'ctrl+shift+a',
  },
  workspace: { defaultPresentation: 'docked', rails: ['sessions'] },
  driver: { autostart: false, sharedWindowPolicy: 'follow', launch: 'muxterm-agent' },
};

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function str(v: unknown, d: string): string {
  return typeof v === 'string' && v.length > 0 ? v : d;
}
function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
function bool(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d;
}

/** Parse a raw server `config` payload (snake_case) into a typed ResolvedConfig. */
export function parseResolvedConfig(raw: unknown): ResolvedConfig {
  const d = DEFAULT_RESOLVED_CONFIG;
  const r = obj(raw);
  const theme = obj(r.theme);
  const font = obj(r.font);
  const term = obj(r.terminal);
  const keys = obj(r.keys);
  const ws = obj(r.workspace);
  const drv = obj(r.driver);

  return {
    theme: { palette: str(theme.palette, d.theme.palette) },
    font: { family: str(font.family, d.font.family), size: num(font.size, d.font.size) },
    terminal: {
      cursorStyle: str(term.cursor_style, d.terminal.cursorStyle) as ResolvedConfig['terminal']['cursorStyle'],
      cursorBlink: bool(term.cursor_blink, d.terminal.cursorBlink),
      scrollback: num(term.scrollback, d.terminal.scrollback),
      bell: str(term.bell, d.terminal.bell) as ResolvedConfig['terminal']['bell'],
    },
    keys: {
      nextSession: str(keys.next_session, d.keys.nextSession),
      split: str(keys.split, d.keys.split),
      maximizeRegion: str(keys.maximize_region, d.keys.maximizeRegion),
      popOut: str(keys.pop_out, d.keys.popOut),
      openLauncher: str(keys.open_launcher, d.keys.openLauncher),
      focusDriver: str(keys.focus_driver, d.keys.focusDriver),
    },
    workspace: {
      defaultPresentation: str(ws.default_presentation, d.workspace.defaultPresentation) as ResolvedConfig['workspace']['defaultPresentation'],
      rails: Array.isArray(ws.rails) ? (ws.rails as string[]) : d.workspace.rails,
    },
    driver: {
      autostart: bool(drv.autostart, d.driver.autostart),
      sharedWindowPolicy: str(drv.shared_window_policy, d.driver.sharedWindowPolicy),
      launch: str(drv.launch, d.driver.launch),
    },
  };
}
```

**Step 4: Run to verify it passes**
Run: `cd web && npm test -- config.test`
Expected: PASS.

**Step 5: Commit**
Run: `git add web/src/lib/config.ts web/src/lib/config.test.ts && git commit -m "feat(config): client resolved-config type + defensive parser"`

---

## Task 8: Make `theme.ts` accept a palette override

**Files:**
- Modify: `web/src/lib/theme.ts`
- Test: `web/src/lib/theme.test.ts`

**Step 1: Write the failing test**
Create `web/src/lib/theme.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { THEME, resolvePalette, PALETTES } from './theme.js';

describe('resolvePalette', () => {
  it('returns the Tokyo Night palette by default', () => {
    expect(resolvePalette('tokyo-night')).toBe(THEME);
  });

  it('returns a known alternate palette by name', () => {
    expect(PALETTES['gruvbox']).toBeDefined();
    expect(resolvePalette('gruvbox')).toBe(PALETTES['gruvbox']);
  });

  it('falls back to Tokyo Night for an unknown palette name', () => {
    expect(resolvePalette('does-not-exist')).toBe(THEME);
  });
});
```

**Step 2: Run to verify it fails**
Run: `cd web && npm test -- theme.test`
Expected: FAIL — `resolvePalette` / `PALETTES` not exported.

**Step 3: Add the palette registry + resolver to `web/src/lib/theme.ts`**
Append below the existing `THEME` export (keep `THEME` as the canonical Tokyo Night object):
```ts
export type Palette = typeof THEME;

// Gruvbox dark — a second built-in palette so palette override is real, not a stub.
const GRUVBOX: Palette = {
  background: '#282828',
  foreground: '#ebdbb2',
  cursor: '#ebdbb2',
  cursorAccent: '#282828',
  selectionBackground: '#504945',
  black: '#282828',
  red: '#cc241d',
  green: '#98971a',
  yellow: '#d79921',
  blue: '#458588',
  magenta: '#b16286',
  cyan: '#689d6a',
  white: '#a89984',
  brightBlack: '#928374',
  brightRed: '#fb4934',
  brightGreen: '#b8bb26',
  brightYellow: '#fabd2f',
  brightBlue: '#83a598',
  brightMagenta: '#d3869b',
  brightCyan: '#8ec07c',
  brightWhite: '#ebdbb2',
};

export const PALETTES: Record<string, Palette> = {
  'tokyo-night': THEME,
  gruvbox: GRUVBOX,
};

/** Resolve a palette by name; unknown names fall back to Tokyo Night (THEME). */
export function resolvePalette(name: string): Palette {
  return PALETTES[name] ?? THEME;
}
```

**Step 4: Run to verify it passes**
Run: `cd web && npm test -- theme.test`
Expected: PASS.

**Step 5: Commit**
Run: `git add web/src/lib/theme.ts web/src/lib/theme.test.ts && git commit -m "feat(theme): palette registry + resolvePalette with safe fallback"`

---

## Task 9: Make `terminal-registry.ts` accept font/cursor/scrollback/bell overrides

**Files:**
- Modify: `web/src/lib/terminal-registry.ts`
- Test: `web/src/__tests__/terminal-registry.test.ts` (existing — append)

**Step 1: Write the failing test**
Append to `web/src/__tests__/terminal-registry.test.ts`:
```ts
import { buildTerminalConfig } from '../lib/terminal-registry.js';
import { DEFAULT_RESOLVED_CONFIG, parseResolvedConfig } from '../lib/config.js';
import { resolvePalette } from '../lib/theme.js';

describe('buildTerminalConfig', () => {
  it('uses defaults when given the default resolved config', () => {
    const tc = buildTerminalConfig(DEFAULT_RESOLVED_CONFIG);
    expect(tc.fontSize).toBe(13);
    expect(tc.cursorStyle).toBe('block');
    expect(tc.cursorBlink).toBe(true);
    expect(tc.scrollback).toBe(10000);
    expect(tc.theme).toBe(resolvePalette('tokyo-night'));
  });

  it('applies font/cursor/scrollback/palette overrides', () => {
    const cfg = parseResolvedConfig({
      theme: { palette: 'gruvbox' },
      font: { family: 'Iosevka', size: 18 },
      terminal: { cursor_style: 'bar', cursor_blink: false, scrollback: 99999 },
    });
    const tc = buildTerminalConfig(cfg);
    expect(tc.fontFamily).toBe('Iosevka');
    expect(tc.fontSize).toBe(18);
    expect(tc.cursorStyle).toBe('bar');
    expect(tc.cursorBlink).toBe(false);
    expect(tc.scrollback).toBe(99999);
    expect(tc.theme).toBe(resolvePalette('gruvbox'));
  });
});
```

**Step 2: Run to verify it fails**
Run: `cd web && npm test -- terminal-registry.test`
Expected: FAIL — `buildTerminalConfig` not exported.

**Step 3: Refactor `terminal-registry.ts` to derive its config from ResolvedConfig**
In `web/src/lib/terminal-registry.ts`:
1. Add imports near the top: `import { resolvePalette } from './theme.js';` and `import type { ResolvedConfig } from './config.js';` and `import { DEFAULT_RESOLVED_CONFIG } from './config.js';`
2. Replace the hardcoded `const TERMINAL_CONFIG = {...}` block with a builder + a mutable active config:
```ts
/** Build an xterm.js Terminal options object from the resolved muxterm config. */
export function buildTerminalConfig(cfg: ResolvedConfig) {
  return {
    theme: resolvePalette(cfg.theme.palette),
    fontFamily: cfg.font.family,
    fontSize: cfg.font.size,
    lineHeight: 1.2,
    cursorBlink: cfg.terminal.cursorBlink,
    cursorStyle: cfg.terminal.cursorStyle,
    scrollback: cfg.terminal.scrollback,
    allowTransparency: false,
    convertEol: false, // tmux sends \r\n — don't double-convert
  } as const;
}

// Active config used when ensure() creates new Terminals. Defaults until the
// server's resolved config arrives (see configureTerminals()).
let TERMINAL_CONFIG = buildTerminalConfig(DEFAULT_RESOLVED_CONFIG);

/**
 * Apply the resolved config to future Terminal creation. Called once on connect
 * after the `config` frame parses. No hot-reload in v1: existing Terminals keep
 * their current options; only Terminals created after this call pick up overrides.
 */
export function configureTerminals(cfg: ResolvedConfig): void {
  TERMINAL_CONFIG = buildTerminalConfig(cfg);
}
```
3. Confirm `ensure()` already references `TERMINAL_CONFIG` (it does, via `new Terminal(TERMINAL_CONFIG)` or `{ ...TERMINAL_CONFIG }`). If it spreads or passes it directly, leave it; the reassignment above is picked up because `TERMINAL_CONFIG` is now a `let`.

**Step 4: Run to verify it passes**
Run: `cd web && npm test -- terminal-registry.test`
Expected: PASS.

**Step 5: Run the full web suite to catch fallout from the const→let change**
Run: `cd web && npm test`
Expected: PASS. (If any test imported `TERMINAL_CONFIG` directly, update it to call `buildTerminalConfig(DEFAULT_RESOLVED_CONFIG)`.)

**Step 6: Commit**
Run: `git add web/src/lib/terminal-registry.ts web/src/__tests__/terminal-registry.test.ts && git commit -m "feat(terminal): derive xterm config from resolved config (font/cursor/scrollback/palette)"`

---

## Task 10: Store resolved config in `state.ts` + apply it on the `config` frame

**Files:**
- Modify: `web/src/state.ts`, `web/src/ws.ts`, `web/src/app.ts`
- Test: `web/src/__tests__/state.test.ts` (existing — append)

**Step 1: Write the failing test**
Append to `web/src/__tests__/state.test.ts`:
```ts
import { store } from '../state.js';
import { parseResolvedConfig, DEFAULT_RESOLVED_CONFIG } from '../lib/config.js';

describe('MuxStore.config', () => {
  it('defaults to DEFAULT_RESOLVED_CONFIG before any config frame', () => {
    expect(store.config).toEqual(DEFAULT_RESOLVED_CONFIG);
  });

  it('stores a parsed config via setConfig', () => {
    store.setConfig(parseResolvedConfig({ theme: { palette: 'gruvbox' } }));
    expect(store.config.theme.palette).toBe('gruvbox');
  });
});
```

**Step 2: Run to verify it fails**
Run: `cd web && npm test -- state.test`
Expected: FAIL — `store.config` / `store.setConfig` do not exist.

**Step 3: Add config storage to `MuxStore`**
In `web/src/state.ts`, add an import and members:
```ts
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from './lib/config.js';
```
Inside the `MuxStore` class:
```ts
  private _config: ResolvedConfig = DEFAULT_RESOLVED_CONFIG;

  get config(): ResolvedConfig {
    return this._config;
  }

  /** Store the server's resolved config (received on connect). */
  setConfig(cfg: ResolvedConfig): void {
    this._config = cfg;
    this._emit(); // notify subscribers (e.g. chrome re-render for theme tokens)
  }
```
NOTE: if the store's notify method is named differently than `_emit()`, use the existing one (grep the file for the method that iterates `_listeners`).

**Step 4: Consume the `config` frame on the client**
In `web/src/ws.ts`, the raw message is already passed to `_controlMessageCb` (≈L331) before normalization. In `web/src/app.ts`, where the control-message callback is registered, add handling for the `config` key. Find the control-message handler (it inspects `raw['detached']` etc.) and add:
```ts
      if ('config' in raw) {
        const cfg = parseResolvedConfig(raw['config']);
        store.setConfig(cfg);
        configureTerminals(cfg); // future Terminals pick up font/cursor/scrollback/palette
      }
```
Add imports to `web/src/app.ts`:
```ts
import { parseResolvedConfig } from './lib/config.js';
import { configureTerminals } from './lib/terminal-registry.js';
```
(`store` is already imported in app.ts; if not, `import { store } from './state.js';`.)

**Step 5: Run to verify it passes + full web suite**
Run: `cd web && npm test`
Expected: PASS.

**Step 6: Commit**
Run: `git add web/src/state.ts web/src/app.ts web/src/ws.ts && git commit -m "feat(config): store + apply resolved config on the config frame"`

---

## Task 11: Keybindings — map `[keys]` to UI actions + dispatch

**Files:**
- Create: `web/src/lib/keybindings.ts`
- Test: `web/src/lib/keybindings.test.ts`

**Step 1: Write the failing test**
Create `web/src/lib/keybindings.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { matchChord, makeKeyHandler } from './keybindings.js';
import { DEFAULT_RESOLVED_CONFIG } from './config.js';

function evt(opts: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: opts.key ?? '',
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
    metaKey: opts.metaKey ?? false,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

describe('matchChord', () => {
  it('matches "ctrl+shift+p" against the right event', () => {
    expect(matchChord('ctrl+shift+p', evt({ key: 'P', ctrlKey: true, shiftKey: true }))).toBe(true);
  });
  it('does not match when a modifier is missing', () => {
    expect(matchChord('ctrl+shift+p', evt({ key: 'P', ctrlKey: true }))).toBe(false);
  });
  it('matches a backslash chord', () => {
    expect(matchChord('ctrl+shift+\\', evt({ key: '\\', ctrlKey: true, shiftKey: true }))).toBe(true);
  });
});

describe('makeKeyHandler', () => {
  it('invokes the action mapped to the configured chord and prevents default', () => {
    const openLauncher = vi.fn();
    const handler = makeKeyHandler(DEFAULT_RESOLVED_CONFIG.keys, { openLauncher });
    const e = evt({ key: 'P', ctrlKey: true, shiftKey: true });
    handler(e);
    expect(openLauncher).toHaveBeenCalledOnce();
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it('ignores chords with no registered action', () => {
    const handler = makeKeyHandler(DEFAULT_RESOLVED_CONFIG.keys, {});
    const e = evt({ key: 'P', ctrlKey: true, shiftKey: true });
    expect(() => handler(e)).not.toThrow();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run to verify it fails**
Run: `cd web && npm test -- keybindings.test`
Expected: FAIL — module not found.

**Step 3: Implement `web/src/lib/keybindings.ts`**
```ts
/**
 * Keybindings — map the resolved [keys] config to muxterm's OWN UI actions.
 * These are muxterm chords only (launcher, split, maximize, pop-out, next
 * session, focus driver). They are NEVER tmux keys; tmux owns its own keys
 * inside the terminal. Defaults live in config.ts; this module only resolves a
 * chord string to the right action callback.
 */
import type { ResolvedConfig } from './config.js';

type Keys = ResolvedConfig['keys'];

/** Action callbacks the host (app.ts) provides. All optional. */
export interface UIActions {
  nextSession?: () => void;
  split?: () => void;
  maximizeRegion?: () => void;
  popOut?: () => void;
  openLauncher?: () => void;
  focusDriver?: () => void;
}

/** Normalize a KeyboardEvent into a canonical "ctrl+shift+x" chord string. */
function chordOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  if (e.metaKey) parts.push('meta');
  // Use the physical key, lowercased; single letters normalize to lowercase.
  parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase());
  return parts.join('+');
}

/** True if the event matches the configured chord (e.g. "ctrl+shift+p"). */
export function matchChord(chord: string, e: KeyboardEvent): boolean {
  return chordOf(e) === chord.toLowerCase();
}

/**
 * Build a keydown handler that dispatches the matching UI action. Returns a
 * function suitable for window.addEventListener('keydown', handler).
 */
export function makeKeyHandler(keys: Keys, actions: UIActions): (e: KeyboardEvent) => void {
  const table: Array<[string, (() => void) | undefined]> = [
    [keys.nextSession, actions.nextSession],
    [keys.split, actions.split],
    [keys.maximizeRegion, actions.maximizeRegion],
    [keys.popOut, actions.popOut],
    [keys.openLauncher, actions.openLauncher],
    [keys.focusDriver, actions.focusDriver],
  ];
  return (e: KeyboardEvent) => {
    for (const [chord, action] of table) {
      if (action && matchChord(chord, e)) {
        e.preventDefault();
        action();
        return;
      }
    }
  };
}
```

**Step 4: Run to verify it passes**
Run: `cd web && npm test -- keybindings.test`
Expected: PASS.

**Step 5: Commit**
Run: `git add web/src/lib/keybindings.ts web/src/lib/keybindings.test.ts && git commit -m "feat(keys): keybindings module mapping [keys] config to UI actions"`

---

## Task 12: Wire keybindings into the app (bind to existing UI actions)

**Files:**
- Modify: `web/src/app.ts`
- Test: `web/src/__tests__/app.test.ts` (existing — append a focused test)

**Step 1: Write the failing test**
Append to `web/src/__tests__/app.test.ts` a test that the app registers a keydown handler driving `openLauncher`. Because `app.ts` wiring varies, assert against the exported helper instead — add to `app.ts` an exported `installKeybindings(actions)` and test it directly:
```ts
import { installKeybindings } from '../app.js';
import { store } from '../state.js';
import { parseResolvedConfig } from '../lib/config.js';

describe('installKeybindings', () => {
  it('dispatches the open-launcher action for the configured chord', () => {
    store.setConfig(parseResolvedConfig({ keys: { open_launcher: 'ctrl+shift+p' } }));
    const openLauncher = vi.fn();
    const remove = installKeybindings({ openLauncher });
    const e = new KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true });
    window.dispatchEvent(e);
    expect(openLauncher).toHaveBeenCalledOnce();
    remove();
  });
});
```

**Step 2: Run to verify it fails**
Run: `cd web && npm test -- app.test`
Expected: FAIL — `installKeybindings` not exported.

**Step 3: Implement `installKeybindings` in `app.ts`**
Add (exported) near the other top-level wiring:
```ts
import { makeKeyHandler, type UIActions } from './lib/keybindings.js';

/**
 * Install muxterm UI keybindings using the keys from the store's resolved
 * config. Returns a disposer that removes the listener. Re-call after the
 * config frame if you want it bound to overridden chords (no hot-reload, but
 * the config arrives shortly after connect).
 */
export function installKeybindings(actions: UIActions): () => void {
  const handler = makeKeyHandler(store.config.keys, actions);
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}
```
Then, where the app finishes setup, wire it to the REAL UI actions that already exist for launcher/split/maximize/pop-out/next-session/focus-driver (from Phases 2–4). For any action whose feature handler exists, pass it; for any not yet present, pass a no-op `() => {}` with a `// TODO(phaseX): wire when available` comment. Re-install after the `config` frame is applied (in the Task 10 control handler, after `store.setConfig(cfg)`):
```ts
        disposeKeys?.();
        disposeKeys = installKeybindings(uiActions);
```
where `disposeKeys` and `uiActions` are module-level in `app.ts`.

**Step 4: Run to verify it passes + full suite**
Run: `cd web && npm test`
Expected: PASS.

**Step 5: Commit**
Run: `git add web/src/app.ts web/src/__tests__/app.test.ts && git commit -m "feat(keys): install configurable UI keybindings, rebind on config frame"`

---

## Task 13: UI polish — theme tokens (chrome consumes `[theme]`)

**Files:**
- Modify: `web/src/lib/theme.ts` (add CSS-variable emitter)
- Modify: chrome components: `web/src/components/{layout.ts,tab-bar.ts,status-bar.ts,session-picker.ts,reconnect-overlay.ts,resize-handle.ts,pane.ts}`
- Modify: `web/src/app.ts` (apply tokens on config frame)
- Test: `web/src/lib/theme.test.ts` (append)

**Step 1: Write the failing test for the token emitter**
Append to `web/src/lib/theme.test.ts`:
```ts
import { paletteToCSSVars } from './theme.js';

describe('paletteToCSSVars', () => {
  it('emits --mux-* CSS variables for a palette', () => {
    const vars = paletteToCSSVars(resolvePalette('tokyo-night'));
    expect(vars['--mux-bg']).toBe('#1a1b26');
    expect(vars['--mux-fg']).toBe('#a9b1d6');
    expect(vars['--mux-accent']).toBe('#7aa2f7'); // blue accent from mockups
  });
});
```

**Step 2: Run to verify it fails**
Run: `cd web && npm test -- theme.test`
Expected: FAIL — `paletteToCSSVars` not exported.

**Step 3: Add the token emitter + an applier to `theme.ts`**
```ts
/** Map a palette to the canonical --mux-* CSS variables the chrome consumes. */
export function paletteToCSSVars(p: Palette): Record<string, string> {
  return {
    '--mux-bg': p.background,
    '--mux-fg': p.foreground,
    '--mux-accent': p.blue, // accent used across chrome (mockups: #7aa2f7)
    '--mux-border': p.brightBlack,
    '--mux-selection': p.selectionBackground,
    '--mux-warn': p.yellow,
    '--mux-error': p.red,
    '--mux-ok': p.green,
  };
}

/** Apply palette tokens to a root element (defaults to document root). */
export function applyThemeTokens(p: Palette, root: HTMLElement = document.documentElement): void {
  const vars = paletteToCSSVars(p);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
}
```

**Step 4: Run to verify the unit test passes**
Run: `cd web && npm test -- theme.test`
Expected: PASS.

**Step 5: Apply tokens on the config frame**
In `web/src/app.ts` control handler (Task 10), after `store.setConfig(cfg)` add:
```ts
        applyThemeTokens(resolvePalette(cfg.theme.palette));
```
Import: `import { applyThemeTokens, resolvePalette } from './lib/theme.js';`
Also call `applyThemeTokens(resolvePalette(store.config.theme.palette))` once at startup so default tokens exist before any frame.

**Step 6: Replace hardcoded chrome colors with the tokens (consistency pass)**
For EACH component file listed above, replace hardcoded hex colors in the `static styles = css\`...\`` blocks with `var(--mux-*)` tokens. Examples:
- `layout.ts`: `background: #1a1b26;` → `background: var(--mux-bg);`
- `reconnect-overlay.ts`: `border-top-color: #7aa2f7;` → `border-top-color: var(--mux-accent);`; `color: #e0af68;` → `color: var(--mux-warn);`
- `tab-bar.ts` / `status-bar.ts` / `session-picker.ts` / `resize-handle.ts`: replace background/foreground/border/accent hexes with the matching `--mux-*` token; match the validated mockups (active tab uses `--mux-accent`, dividers use `--mux-border`).
- `pane.ts`: it imports `THEME` for background; leave the xterm theme object as-is (that path is the live palette via `buildTerminalConfig`), but for the CSS wrapper background switch `unsafeCSS(THEME.background)` → `var(--mux-bg)`.

Do these as a focused, mechanical sweep. Do NOT restructure markup — colors/tokens only (consistency pass, not a redesign).

**Step 7: Run the FULL web suite to catch broken component tests**
Run: `cd web && npm test`
Expected: PASS. Fix any component test asserting a literal hex by asserting the `var(--mux-*)` token instead.

**Step 8: Type-check / build the frontend**
Run: `cd web && npx tsc --noEmit && npm run build`
Expected: no type errors; build succeeds.

**Step 9: Commit**
Run: `git add web/src/lib/theme.ts web/src/components/ web/src/app.ts && git commit -m "polish(chrome): theme tokens (--mux-*); chrome consumes [theme] palette"`

---

## Task 14: E2E — config overrides take effect against the running dev server

> Run against the user's already-running `make dev` (Go on `http://localhost:8080`). Confirm the port from `cmd/muxterm/cli.go` (default `localhost:8080`). Use the **playwright-cli** skill. Use the Phase-2 xterm `StructuredSnapshot` harness (`terminalRegistry.snapshot(paneId)` via `page.evaluate`) for any terminal-content assertions. **NO OCR.**

**Files:**
- Create: `.playwright-cli/phase5-config-e2e.md` (a short runbook recording the exact commands + expected results, committed as the E2E artifact)

**Step 1: Back up any existing user config, then write a test override**
Run:
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
Expected: file written. (Config is read at startup — see Step 2.)

**Step 2: Restart the server so it re-reads config (no hot-reload in v1)**
The Go server is hot-reloaded by `air`, but config is read once at process start. Force a restart by touching a Go source so `air` rebuilds:
```bash
touch cmd/muxterm/main.go
sleep 3   # let air rebuild + relaunch
```
Expected: `make dev` logs show a rebuild + "muxterm listening on localhost:8080".

**Step 3: Open the app and assert the palette token applied**
Use playwright-cli to navigate and read the CSS variable:
```bash
playwright-cli open http://localhost:8080
playwright-cli eval "getComputedStyle(document.documentElement).getPropertyValue('--mux-bg').trim()"
```
Expected output: `#282828` (gruvbox background — proves `[theme]` reached the client and tokens applied).

**Step 4: Assert the font size override reached xterm**
```bash
playwright-cli eval "(() => { const t = window.__muxStore?.config; return t ? t.font.size : 'no-store'; })()"
```
NOTE: if the store is not on `window`, temporarily expose it for E2E by adding `;(window as any).__muxStore = store;` in `app.ts` (guarded behind `import.meta.env.DEV`). Expected output: `20`.

**Step 5: Assert scrollback override reached a live terminal via the Phase-2 snapshot harness**
```bash
playwright-cli eval "(() => { const id = window.__muxFirstPaneId?.(); const t = window.__muxRegistry?.peek?.(id); return t ? t.options.scrollback : 'no-term'; })()"
```
(Use whatever Phase-2 accessor the registry exposes for inspecting a Terminal; if none exists, assert via `terminalRegistry.snapshot(paneId).scrollbackDepth` is allowed to be ≤ 54321 and the option is set.) Expected: `54321`.

**Step 6: Assert the `[keys]` binding triggers its UI action**
Drive the configured chord and confirm the launcher opens:
```bash
playwright-cli press "Control+Shift+P"
playwright-cli eval "!!document.querySelector('mux-launcher, [data-launcher-open]')"
```
Expected output: `true` (the global launcher opened — proves `[keys]` dispatch). If the launcher component selector differs, use the actual launcher element from Phase 4.

**Step 7: Record results + commit the runbook**
Write `.playwright-cli/phase5-config-e2e.md` capturing each command and its observed output (paste the real values). Then:
Run: `git add .playwright-cli/phase5-config-e2e.md web/src/app.ts && git commit -m "test(e2e): config overrides (theme/font/scrollback/keys) verified vs make dev"`

---

## Task 15: E2E — malformed config falls back gracefully (app still runs) + cleanup

**Files:**
- Modify/Append: `.playwright-cli/phase5-config-e2e.md`

**Step 1: Write a deliberately malformed config**
Run:
```bash
cat > ~/.config/muxterm/config.toml <<'TOML'
[theme]
palette = "unterminated
[terminal]
scrollback = not-a-number
TOML
```

**Step 2: Restart the server and confirm it logs a warning, not a crash**
Run:
```bash
touch cmd/muxterm/main.go
sleep 3
```
Expected: `make dev` log contains `config: ...config.toml is malformed (...); using built-in defaults` AND `muxterm listening on localhost:8080` (process did NOT exit).

**Step 3: Confirm the app loads with DEFAULT theme (graceful fallback)**
```bash
playwright-cli open http://localhost:8080
playwright-cli eval "getComputedStyle(document.documentElement).getPropertyValue('--mux-bg').trim()"
```
Expected output: `#1a1b26` (Tokyo Night default — proves malformed config fell back, app fully functional).

**Step 4: Restore the user's original config**
Run:
```bash
if [ -f ~/.config/muxterm/config.toml.phase5bak ]; then
  mv ~/.config/muxterm/config.toml.phase5bak ~/.config/muxterm/config.toml
else
  rm -f ~/.config/muxterm/config.toml
fi
touch cmd/muxterm/main.go && sleep 3
```
Expected: original config restored (or removed if none existed); server back to the user's normal state.

**Step 5: Final full verification sweep**
Run:
```bash
go test ./... && cd web && npm test && npx tsc --noEmit && npm run build && cd ..
```
Expected: all green — Go suite passes, Vitest passes, no type errors, frontend builds.

**Step 6: Record results + final commit**
Append the malformed-fallback observations to `.playwright-cli/phase5-config-e2e.md`. Then:
Run: `git add -A && git commit -m "test(e2e): malformed config graceful fallback verified; phase 5 complete"`

---

## Done criteria (Phase 5)

- [ ] `~/.config/muxterm/config.toml` overrides ONLY muxterm-owned knobs; tmux options remain hardcoded in `applyMuxtermConfig()`.
- [ ] Missing config → defaults; valid config → partial override merge; malformed config → defaults + logged warning, never a crash (Go table tests green).
- [ ] Resolved config is shipped to the client on connect (`{"config": ...}` frame) and stored in `MuxStore`.
- [ ] Theme palette, font, cursor, scrollback, and bell overrides reach xterm.js for newly-created terminals.
- [ ] `[keys]` chords dispatch the correct muxterm UI actions (never tmux keys).
- [ ] Chrome consumes `--mux-*` theme tokens; consistency polish matches the validated mockups; no markup redesign.
- [ ] E2E (playwright-cli vs `make dev`, NO OCR) proves theme/font/scrollback/keys overrides AND malformed-config graceful fallback.
- [ ] `go test ./...`, `cd web && npm test`, `tsc --noEmit`, and `npm run build` all pass.

**Deferred (do NOT implement here):** tmux passthrough (forbidden), hot-reload, per-pane overrides, the driver application, Tier-2 `MUXTERM_CTL`, PWA/WCO, multi-viewer (`shared_window_policy` parsed/carried only), float (cut), phone.
