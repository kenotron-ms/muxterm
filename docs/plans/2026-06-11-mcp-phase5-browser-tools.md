# muxterm MCP Agent Workbench — Phase 5: Browser Tools + Resources — Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Add the browser-interaction tool surface (navigation, interaction, observation) to the `muxterm mcp` server, expose pane output as MCP resources, and delete the dead `register*Tools` functions left over from the Phase 4 lazy-client refactor.

**Architecture:** Browser tools send a `browser-action` control message through the existing sessiond relay (MCP → daemon → browser WS client → iframe shim → result back). A new MCP-side `Client.SendBrowserAction` blocks until the matching `browser-action-result` arrives. Observation tools (`browser_snapshot`, `browser_eval`) parse typed result fields; `browser_screenshot` returns a deferred-to-Phase-6 placeholder. MCP resources (`pane://{id}`) expose `get_screen` output, with `resources/subscribe` pushing `notifications/resources/updated` when pane output arrives.

**Tech Stack:** Go 1.x, JSON-RPC 2.0 over stdio, the frozen sessiond binary-framed Unix-socket protocol, `go test`.

---

## READ THIS FIRST — Orientation for the implementer

You know nothing about this codebase. That is fine. Here is everything you need.

### What Phase 5 produces

A fully-operational `muxterm mcp` server with **browser automation tools** (13 of them: 4 navigation, 6 interaction, 3 observation), observable via **MCP resources** (`pane://{id}` with live subscription). After Phase 5, an agent connected to `muxterm mcp` can drive a browser pane end-to-end: `browser_goto` → `browser_snapshot` → `browser_click` / `browser_fill` → `browser_eval`.

### The package layout you will touch

- `internal/mcp/` — the MCP server. `server.go` (JSON-RPC dispatch), `client.go` (sessiond connection wrapper), `run.go` (tool registration + `lazyClient`), `tools_terminal.go` / `tools_workspace.go` / `tools_layout.go` (existing tools), `ansi.go` (ANSI strip). Shared helpers `argInt`, `argString`, `jsonText` live in `tools_terminal.go` and are usable from every file in the package.
- `internal/sessiond/` — the daemon protocol. `protocol.go` (the frozen `Message` envelope + type constants), `client.go` (the `Client` + `Handlers` event callbacks), `server.go` (the daemon, including the browser-action relay).
- `internal/proxy/proxy.go` — contains the **page shim** JavaScript (a big Go string literal). The shim's `handleAction` switch executes browser DOM commands.
- `cmd/muxterm/` — the CLI. `cli.go` (`--help` text), `mcp_integration_test.go` (the end-to-end stdio test that asserts the tool list).

### FOUR facts that will save you hours — read all four before coding

**1. CID is NOT a usable correlation key for browser actions — correlate by `paneID`.**

The delegation sketch keyed an in-flight map by a `cid` counter. **That cannot work here.** The daemon *zeroes* `CID` on both the `browser-action` and `browser-action-result` broadcasts before fanning them out. This is proven, not guessed:

- `internal/sessiond/server.go:335` — `case TypeBrowserAction: … msg.CID = 0; c.srv.broadcast(...)`
- `internal/sessiond/server.go:349` — `case TypeBrowserActionResult: msg.CID = 0 // event fan-out; …; c.srv.broadcast(...)`
- `internal/sessiond/server_relay_test.go:56-84` (`TestBrowserActionResultBroadcast`) asserts the broadcast `CID == 0`.

Because `CID == 0`, the result arrives at the MCP client as an **unsolicited event** (routed to `dispatchEvent`, not to a pending request — see `dispatchControl` at `client.go:162`). The only field that survives the round-trip and identifies which pane the result belongs to is **`PaneID`** (the browser WS client posts `{...msg, cid, paneId}` to the shim — see `web/src/components/browser-surface.ts:128` — and `internal/server/ws.go:237` relays the full message including `PaneID`). 

**Therefore: maintain one in-flight result channel per `paneID`. Only one browser action per pane at a time.** This is acceptable — agents drive a pane sequentially.

**2. `sessiond.Client` has NO public `Send` method.**

The delegation sketch wrote `c.conn.Send(msg)`. There is no such method. The fire-and-forget senders that exist are `Input` (pane data), `Resize`, and `BrowserActionResult` (`client.go:380`), each of which takes `writeMu` and calls `WriteControl`. You will **add a new `SendBrowserAction` method** to `sessiond.Client` modeled exactly on `BrowserActionResult`. The request/reply helper `request()` is the wrong tool (it blocks for a CID-matched reply that never comes — see fact 1).

**3. The `OnBrowserActionResult` event handler does NOT exist yet.**

`sessiond.Handlers` (`client.go:43-83`) has `OnBrowserAction` but no `OnBrowserActionResult`. And `dispatchEvent` (`client.go:401-451`) has a `case TypeBrowserAction` but no `case TypeBrowserActionResult`. You will add both, mirroring the existing `OnBrowserAction` pattern. These additions are protocol-additive and frozen-safe.

**4. The shim already handles every action EXCEPT `goto`.**

`internal/proxy/proxy.go` `handleAction` switch (around line 295) has cases: `snapshot`, `click`, `fill`, `type_`, `press`, `hover`, `select_`, `eval_`, `goBack`, `goForward`, `reload`. It has **no `goto`**. You will add one. Note the exact action strings the shim expects — your Go tools must send these literal strings:

| MCP tool | shim `action` string | operands used |
|---|---|---|
| `browser_goto` | `goto` (you add this) | `value` = url |
| `browser_go_back` | `goBack` | — |
| `browser_go_forward` | `goForward` | — |
| `browser_reload` | `reload` | — |
| `browser_click` | `click` | `ref` or `selector` |
| `browser_fill` | `fill` | `ref`/`selector`, `value` |
| `browser_type` | `type_` | `value` (the typed text) |
| `browser_press` | `press` | `key` |
| `browser_hover` | `hover` | `ref` or `selector` |
| `browser_select` | `select_` | `ref`/`selector`, `value` |
| `browser_snapshot` | `snapshot` | — |
| `browser_eval` | `eval_` | `expr`, optional `ref` |
| `browser_screenshot` | *(none — Phase 5 placeholder)* | — |

> **CRITICAL field-mapping trap:** `browser_type`'s argument is named `text` at the MCP tool boundary, but the shim's `type_` reads `msg.value`. So you must put the `text` argument into the message's **`Value`** field (JSON `value`), NOT the `Text` field. The `Message.Text` field (JSON `text`, `protocol.go:172`) is used for *screen-snapshot / eval text results*, never for browser input. Do not confuse them.

### The `Message` fields available for browser actions and results

From `internal/sessiond/protocol.go:166-180`:
- Outbound (browser-action): `Action` (`action`), `Ref` (`ref`), `Selector` (`selector`), `Value` (`value`), `Key` (`key`), `Expression` (`expr`), `PaneID` (`paneId`).
- Inbound (browser-action-result): `OK` (`ok`), `Snapshot` (`snapshot`), `Result` (`result`, a `json.RawMessage`), `Error` (`error`), `PaneID` (`paneId`).

### Tool count after Phase 5

12 existing + 13 browser = **25 tools**. The existing integration test asserts exactly 12 and **will break** — Task 7 updates it to 25. Do not skip that.

### Commands you will run (memorize these)

- Build gate: `go build ./...`
- Vet: `go vet ./internal/mcp/...`
- Package tests: `go test ./internal/mcp/...`
- Proxy tests (after shim edit): `go test ./internal/proxy/...`
- Full integration: `go test ./cmd/muxterm/...`

### Commit style

Conventional commits: `feat:`, `test:`, `fix:`, `refactor:`, `chore:`. **One commit per task.**

---

## Task 1: Delete the orphaned `register*Tools` functions (dead code)

**Files:**
- Modify: `internal/mcp/tools_terminal.go` (delete `registerTerminalTools`, lines ~151-197)
- Modify: `internal/mcp/tools_workspace.go` (delete `registerWorkspaceTools`, lines ~86-140)
- Modify: `internal/mcp/tools_layout.go` (delete `registerLayoutTools`, lines ~136-214)

All live tool registration goes through `run.go::registerAllTools` (which calls `newTerminalTools(c).runCommand(args)` etc. via the `wrap` adapter). The three `register*Tools` functions are unreachable leftovers from the Phase 4 lazy-client refactor.

**Step 1: Confirm the functions are truly orphaned.**

Run:
```
grep -rn "registerTerminalTools\|registerWorkspaceTools\|registerLayoutTools" internal cmd
```
Expected: matches ONLY inside the three source files' own definitions (no callers in `run.go`, no callers in any `_test.go`). If a test references one, STOP and report — the premise is wrong. (At plan-writing time, the only matches were the definitions themselves and the Phase 4 plan doc.)

**Step 2: Delete `registerTerminalTools`.**

In `internal/mcp/tools_terminal.go`, delete the entire function beginning at the comment:
```go
// registerTerminalTools registers the run_command, send_input, and get_screen
```
through its closing `}`. Leave `newTerminalTools`, `argInt`, `argString`, `jsonText`, `runCommand`, `sendInput`, and `getScreen` intact.

**Step 3: Delete `registerWorkspaceTools`.**

In `internal/mcp/tools_workspace.go`, delete the entire function beginning at:
```go
// registerWorkspaceTools registers the list_workspaces, create_workspace,
```
through its closing `}`.

**Step 4: Delete `registerLayoutTools`.**

In `internal/mcp/tools_layout.go`, delete the entire function beginning at:
```go
// registerLayoutTools registers the create_pane, rename_pane, close_pane,
```
through its closing `}`.

**Step 5: Build + vet gate.**

Run: `go build ./... && go vet ./internal/mcp/...`
Expected: no errors. (If `go vet` complains about an unused import in any of the three files — none currently expected since `fmt` is still used by the handlers — remove the unused import.)

**Step 6: Confirm test count is unchanged.**

Run: `go test ./internal/mcp/... -count=1`
Expected: PASS, same set of tests as before (this task changes no behavior).

**Step 7: Commit.**
```
git add internal/mcp/tools_terminal.go internal/mcp/tools_workspace.go internal/mcp/tools_layout.go
git commit -m "refactor: remove orphaned register*Tools functions from Phase 4"
```

---

## Task 2: Add browser-action support to the sessiond client and the MCP client

**Files:**
- Modify: `internal/sessiond/client.go` (add `OnBrowserActionResult` handler, dispatch case, and `SendBrowserAction` method)
- Modify: `internal/mcp/client.go` (add `browserResultChans` field, wire the handler, add `SendBrowserAction`)
- Test: `internal/mcp/client_test.go` (add `TestSendBrowserActionResolves` and `TestSendBrowserActionTimeout`)

**Step 1: Add the `OnBrowserActionResult` handler field to `sessiond.Handlers`.**

In `internal/sessiond/client.go`, inside the `Handlers` struct (ends at line ~83), add directly after the `OnShellPrompt` field:

```go
	// OnBrowserActionResult fires when the daemon broadcasts a
	// TypeBrowserActionResult event (CID == 0; the daemon clears CID on
	// fan-out). msg carries PaneID plus the result fields (OK, Snapshot,
	// Result, Error). The MCP client correlates by PaneID since CID is gone.
	OnBrowserActionResult func(msg *Message)
```

**Step 2: Dispatch `TypeBrowserActionResult` in `dispatchEvent`.**

In `internal/sessiond/client.go`, in the `dispatchEvent` switch (around line 439, right after the `case TypeBrowserAction:` block), add:

```go
	case TypeBrowserActionResult:
		if h.OnBrowserActionResult != nil {
			h.OnBrowserActionResult(msg)
		}
```

**Step 3: Add the `SendBrowserAction` fire-and-forget method.**

In `internal/sessiond/client.go`, directly after `BrowserActionResult` (ends ~line 385), add:

```go
// SendBrowserAction forwards a browser-action command to the daemon, which
// clears its CID and broadcasts it to all workspace subscribers (the browser
// WS client relays it to the iframe shim). It is fire-and-forget: the result
// arrives later as a TypeBrowserActionResult event (see OnBrowserActionResult).
func (c *Client) SendBrowserAction(msg Message) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	msg.Type = TypeBrowserAction
	return WriteControl(c.conn, &msg)
}
```

**Step 4: Build gate.**

Run: `go build ./...`
Expected: no errors.

**Step 5: Add the `browserResultChans` field to the MCP `Client`.**

In `internal/mcp/client.go`, in the `Client` struct (lines 15-22), add a field inside the mu-guarded group:

```go
	browserResultChans map[int]chan *sessiond.Message // keyed by paneID, one in-flight action per pane
```

The struct comment already says "All fields except conn … are guarded by mu" — keep that true.

**Step 6: Initialise the map and wire the handler in `DialSocket`.**

In `internal/mcp/client.go`, in `DialSocket`, add the field to the `&Client{...}` literal (after `promptChans`):

```go
		browserResultChans: make(map[int]chan *sessiond.Message),
```

Then, inside the `conn.SetHandlers(sessiond.Handlers{...})` call, add a new handler after `OnShellPrompt`:

```go
		// OnBrowserActionResult delivers a browser-action-result event to the
		// channel armed for its pane by SendBrowserAction. Non-blocking send so
		// a late/duplicate result never stalls the read loop.
		OnBrowserActionResult: func(msg *sessiond.Message) {
			c.mu.Lock()
			ch := c.browserResultChans[msg.PaneID]
			c.mu.Unlock()
			if ch != nil {
				select {
				case ch <- msg:
				default:
				}
			}
		},
```

**Step 7: Add the `SendBrowserAction` method to the MCP `Client`.**

In `internal/mcp/client.go`, add `"context"` is already imported. Add the method at the end of the file:

```go
// SendBrowserAction sends a browser-action command for paneID and blocks until
// the matching browser-action-result event arrives or ctx is cancelled.
//
// Correlation is by paneID, NOT by CID: the daemon zeroes CID on both the
// browser-action and browser-action-result broadcasts (sessiond/server.go), so
// only one browser action may be in flight per pane at a time. params keys
// (all optional, all strings) map onto the Message: ref, selector, value, key,
// expr.
func (c *Client) SendBrowserAction(ctx context.Context, paneID int, action string, params map[string]any) (*sessiond.Message, error) {
	resultCh := make(chan *sessiond.Message, 1)
	c.mu.Lock()
	c.browserResultChans[paneID] = resultCh
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.browserResultChans, paneID)
		c.mu.Unlock()
	}()

	msg := sessiond.Message{
		Type:   sessiond.TypeBrowserAction,
		PaneID: paneID,
		Action: action,
	}
	if v, ok := params["ref"].(string); ok {
		msg.Ref = v
	}
	if v, ok := params["selector"].(string); ok {
		msg.Selector = v
	}
	if v, ok := params["value"].(string); ok {
		msg.Value = v
	}
	if v, ok := params["key"].(string); ok {
		msg.Key = v
	}
	if v, ok := params["expr"].(string); ok {
		msg.Expression = v
	}

	if err := c.conn.SendBrowserAction(msg); err != nil {
		return nil, err
	}

	select {
	case result := <-resultCh:
		return result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
```

> The 10-second browser timeout from the design lives at the *tool* layer (Task 3, via `context.WithTimeout`), so `SendBrowserAction` relies solely on `ctx`. This keeps it testable with a short context.

**Step 8: Build gate.**

Run: `go build ./...`
Expected: no errors.

**Step 9: Write the unit tests.**

Add to `internal/mcp/client_test.go`. These use a second raw `sessiond` client as the "browser side" that receives the broadcast and replies — mirroring `internal/sessiond/server_relay_test.go`. Add this import if missing: `"github.com/user/muxterm/internal/sessiond"` (already imported in this file).

```go
// TestSendBrowserActionResolves verifies SendBrowserAction sends a browser-action
// and returns when a second client (the "browser side") broadcasts a matching
// browser-action-result for the same pane.
func TestSendBrowserActionResolves(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()

	mc, err := DialSocket(socketPath)
	if err != nil {
		t.Fatalf("DialSocket: %v", err)
	}
	defer mc.Close()

	wss, err := mc.conn.ListWorkspaces()
	if err != nil {
		t.Fatalf("ListWorkspaces: %v", err)
	}
	wsID := wss[0].WorkspaceID
	if err := mc.AttachWorkspace(wsID); err != nil {
		t.Fatalf("AttachWorkspace: %v", err)
	}

	// "Browser side": a second sessiond client attached to the same workspace.
	// It receives the browser-action broadcast, then replies with a result.
	gotAction := make(chan *sessiond.Message, 1)
	browser, err := sessiond.Dial(socketPath)
	if err != nil {
		t.Fatalf("browser Dial: %v", err)
	}
	defer browser.Close()
	browser.SetHandlers(sessiond.Handlers{
		OnBrowserAction: func(paneID int, action, ref, value, key, expr string) {
			gotAction <- &sessiond.Message{PaneID: paneID, Action: action, Ref: ref, Value: value, Key: key, Expression: expr}
			// Reply with a successful result for this pane.
			_ = browser.BrowserActionResult(sessiond.Message{PaneID: paneID, OK: true})
		},
	})
	go browser.Run()
	if _, err := browser.Attach(wsID, "wide"); err != nil {
		t.Fatalf("browser Attach: %v", err)
	}

	ctx, ctxCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer ctxCancel()

	res, err := mc.SendBrowserAction(ctx, 7, "click", map[string]any{"ref": "e5"})
	if err != nil {
		t.Fatalf("SendBrowserAction: %v", err)
	}
	if !res.OK {
		t.Errorf("result.OK = false, want true")
	}

	// Confirm the browser side observed the correct action fields.
	select {
	case a := <-gotAction:
		if a.Action != "click" || a.Ref != "e5" || a.PaneID != 7 {
			t.Errorf("browser saw action=%q ref=%q pane=%d, want click/e5/7", a.Action, a.Ref, a.PaneID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("browser never received the browser-action broadcast")
	}
}

// TestSendBrowserActionTimeout verifies SendBrowserAction returns ctx.Err() when
// no result ever arrives.
func TestSendBrowserActionTimeout(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()

	mc, err := DialSocket(socketPath)
	if err != nil {
		t.Fatalf("DialSocket: %v", err)
	}
	defer mc.Close()

	wss, _ := mc.conn.ListWorkspaces()
	if err := mc.AttachWorkspace(wss[0].WorkspaceID); err != nil {
		t.Fatalf("AttachWorkspace: %v", err)
	}

	ctx, ctxCancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer ctxCancel()

	_, err = mc.SendBrowserAction(ctx, 7, "click", map[string]any{"ref": "e5"})
	if err == nil {
		t.Fatal("expected timeout error, got nil")
	}
}
```

**Step 10: Run the tests.**

Run: `go test ./internal/mcp/... -run TestSendBrowserAction -v`
Expected: both PASS. Also run `go test ./internal/sessiond/... -count=1` to confirm the dispatch addition broke nothing.

**Step 11: Commit.**
```
git add internal/sessiond/client.go internal/mcp/client.go internal/mcp/client_test.go
git commit -m "feat: add SendBrowserAction with paneID-keyed result correlation"
```

---

## Task 3: Browser navigation tools + the shared browser helper + the shim `goto` case

**Files:**
- Modify: `internal/proxy/proxy.go` (add `goto` case to the shim)
- Create: `internal/mcp/tools_browser_nav.go` (the `browserTools` type, the shared `callAction` helper, and the 4 nav handlers)
- Test: `internal/mcp/tools_browser_nav_test.go`

**Step 1: Add the `goto` case to the shim.**

In `internal/proxy/proxy.go`, find the `goBack` function (around line 277). Add a new function immediately before it:

```go
  function gotoUrl(url) {
    location.href = url;
    return Promise.resolve({ok: true});
  }

```
> Use the name `gotoUrl` (not `goto`) because `goto` is a reserved word in JavaScript and would be a syntax error as a function name.

Then in the `handleAction` switch (around line 295), add a case alongside the other navigation cases (after `case 'reload':`):

```go
      case 'goto':      return gotoUrl(msg.value);
```

**Step 2: Verify the shim still parses + proxy tests pass.**

Run: `go build ./... && go test ./internal/proxy/... -count=1`
Expected: PASS. (If a proxy test snapshots the shim text verbatim, update that fixture to include the new case — the proxy test failure message will point at it.)

**Step 3: Create the shared browser helper and the nav tools.**

Create `internal/mcp/tools_browser_nav.go`:

```go
package mcp

import (
	"context"
	"time"
)

// browserTools groups the MCP browser tool handlers (navigation, interaction,
// and observation, split across three files in this package) and holds a
// reference to the Client. The default per-action timeout is the design's 10s.
type browserTools struct {
	c *Client
}

// newBrowserTools creates a browserTools instance backed by c.
func newBrowserTools(c *Client) *browserTools {
	return &browserTools{c: c}
}

// browserTimeout is the default wait for a browser-action-result (design: 10s).
const browserTimeout = 10 * time.Second

// callAction dispatches a browser action for the pane in args["pane_id"] and
// returns the standard {ok:true} / {error:...} JSON. params carries the action
// operands (ref/selector/value/key/expr). Used by every nav and interaction
// tool; observation tools format their own results.
func (bt *browserTools) callAction(args map[string]any, action string, params map[string]any) (string, error) {
	paneID, err := argInt(args, "pane_id")
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), browserTimeout)
	defer cancel()
	res, err := bt.c.SendBrowserAction(ctx, paneID, action, params)
	if err != nil {
		return "", err
	}
	if res.Error != "" {
		return jsonText(map[string]any{"error": res.Error}), nil
	}
	return jsonText(map[string]any{"ok": true}), nil
}

// browserGoto navigates the pane to args["url"] (shim action "goto", value=url).
func (bt *browserTools) browserGoto(args map[string]any) (string, error) {
	url, err := argString(args, "url")
	if err != nil {
		return "", err
	}
	return bt.callAction(args, "goto", map[string]any{"value": url})
}

// browserGoBack navigates back in history (shim action "goBack").
func (bt *browserTools) browserGoBack(args map[string]any) (string, error) {
	return bt.callAction(args, "goBack", nil)
}

// browserGoForward navigates forward in history (shim action "goForward").
func (bt *browserTools) browserGoForward(args map[string]any) (string, error) {
	return bt.callAction(args, "goForward", nil)
}

// browserReload reloads the current page (shim action "reload").
func (bt *browserTools) browserReload(args map[string]any) (string, error) {
	return bt.callAction(args, "reload", nil)
}
```

**Step 4: Build gate.**

Run: `go build ./...`
Expected: no errors. (Registration happens in Task 7; for now these are unused methods, which is fine — methods don't trigger "declared but not used".)

**Step 5: Write the nav tests.**

The tests reuse the "browser side" responder pattern from Task 2. To avoid copy-paste, add a small helper at the top of the new test file. Create `internal/mcp/tools_browser_nav_test.go`:

```go
package mcp

import (
	"testing"
	"time"

	"github.com/user/muxterm/internal/sessiond"
)

// browserResponder attaches a second sessiond client to wsID acting as the
// "browser side". It records every browser-action it receives into actions and
// immediately replies with reply (PaneID is copied from the incoming action).
// Returns the captured-action channel and a close func.
func browserResponder(t *testing.T, socketPath, wsID string, reply sessiond.Message) (<-chan *sessiond.Message, func()) {
	t.Helper()
	actions := make(chan *sessiond.Message, 8)
	b, err := sessiond.Dial(socketPath)
	if err != nil {
		t.Fatalf("browserResponder Dial: %v", err)
	}
	b.SetHandlers(sessiond.Handlers{
		OnBrowserAction: func(paneID int, action, ref, value, key, expr string) {
			actions <- &sessiond.Message{PaneID: paneID, Action: action, Ref: ref, Value: value, Key: key, Expression: expr}
			r := reply
			r.PaneID = paneID
			_ = b.BrowserActionResult(r)
		},
	})
	go b.Run()
	if _, err := b.Attach(wsID, "wide"); err != nil {
		t.Fatalf("browserResponder Attach: %v", err)
	}
	return actions, func() { b.Close() }
}

// attachedMCPClient dials a fresh MCP client and attaches it to the cold-start
// default workspace. Returns the client and the workspace id.
func attachedMCPClient(t *testing.T, socketPath string) (*Client, string) {
	t.Helper()
	mc, err := DialSocket(socketPath)
	if err != nil {
		t.Fatalf("DialSocket: %v", err)
	}
	t.Cleanup(func() { mc.Close() })
	wss, err := mc.conn.ListWorkspaces()
	if err != nil {
		t.Fatalf("ListWorkspaces: %v", err)
	}
	wsID := wss[0].WorkspaceID
	if err := mc.AttachWorkspace(wsID); err != nil {
		t.Fatalf("AttachWorkspace: %v", err)
	}
	return mc, wsID
}

func TestBrowserGotoSendsAction(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()
	mc, wsID := attachedMCPClient(t, socketPath)
	actions, closeB := browserResponder(t, socketPath, wsID, sessiond.Message{OK: true})
	defer closeB()

	out, err := newBrowserTools(mc).browserGoto(map[string]any{"pane_id": 3, "url": "http://example.com"})
	if err != nil {
		t.Fatalf("browserGoto: %v", err)
	}
	if out != `{"ok":true}` {
		t.Errorf("browserGoto result = %s, want {\"ok\":true}", out)
	}
	select {
	case a := <-actions:
		if a.Action != "goto" || a.Value != "http://example.com" || a.PaneID != 3 {
			t.Errorf("browser saw action=%q value=%q pane=%d, want goto/http://example.com/3", a.Action, a.Value, a.PaneID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no browser-action received")
	}
}

func TestBrowserNavActionStrings(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()
	mc, wsID := attachedMCPClient(t, socketPath)
	actions, closeB := browserResponder(t, socketPath, wsID, sessiond.Message{OK: true})
	defer closeB()

	bt := newBrowserTools(mc)
	cases := []struct {
		call func(map[string]any) (string, error)
		want string
	}{
		{bt.browserGoBack, "goBack"},
		{bt.browserGoForward, "goForward"},
		{bt.browserReload, "reload"},
	}
	for _, tc := range cases {
		if _, err := tc.call(map[string]any{"pane_id": 1}); err != nil {
			t.Fatalf("%s: %v", tc.want, err)
		}
		select {
		case a := <-actions:
			if a.Action != tc.want {
				t.Errorf("action = %q, want %q", a.Action, tc.want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("no browser-action received for %q", tc.want)
		}
	}
}
```

**Step 6: Run the tests.**

Run: `go test ./internal/mcp/... -run TestBrowserGoto -v` then `go test ./internal/mcp/... -run TestBrowserNav -v`
Expected: PASS.

**Step 7: Commit.**
```
git add internal/proxy/proxy.go internal/mcp/tools_browser_nav.go internal/mcp/tools_browser_nav_test.go
git commit -m "feat: add browser navigation tools (goto/back/forward/reload) + shim goto"
```

---

## Task 4: Browser interaction tools

**Files:**
- Create: `internal/mcp/tools_browser_interact.go`
- Test: `internal/mcp/tools_browser_interact_test.go`

**Step 1: Create the interaction tools (methods on the same `browserTools` type).**

Create `internal/mcp/tools_browser_interact.go`:

```go
package mcp

// browserClick clicks an element by ref or CSS selector (shim action "click").
// Accepts ref (preferred) or selector; the shim resolves ref || selector.
func (bt *browserTools) browserClick(args map[string]any) (string, error) {
	ref, _ := args["ref"].(string)
	sel, _ := args["selector"].(string)
	return bt.callAction(args, "click", map[string]any{"ref": ref, "selector": sel})
}

// browserFill fills an input field with value (shim action "fill").
func (bt *browserTools) browserFill(args map[string]any) (string, error) {
	value, err := argString(args, "value")
	if err != nil {
		return "", err
	}
	ref, _ := args["ref"].(string)
	sel, _ := args["selector"].(string)
	return bt.callAction(args, "fill", map[string]any{"ref": ref, "selector": sel, "value": value})
}

// browserType types text into the focused element (shim action "type_").
// NOTE: the tool argument is "text" but the shim reads msg.value, so text is
// mapped onto the Value field here.
func (bt *browserTools) browserType(args map[string]any) (string, error) {
	text, err := argString(args, "text")
	if err != nil {
		return "", err
	}
	return bt.callAction(args, "type_", map[string]any{"value": text})
}

// browserPress presses a keyboard key on the focused element (shim action "press").
func (bt *browserTools) browserPress(args map[string]any) (string, error) {
	key, err := argString(args, "key")
	if err != nil {
		return "", err
	}
	return bt.callAction(args, "press", map[string]any{"key": key})
}

// browserHover hovers over an element (shim action "hover").
func (bt *browserTools) browserHover(args map[string]any) (string, error) {
	ref, _ := args["ref"].(string)
	sel, _ := args["selector"].(string)
	return bt.callAction(args, "hover", map[string]any{"ref": ref, "selector": sel})
}

// browserSelect selects an option in a <select> dropdown (shim action "select_").
func (bt *browserTools) browserSelect(args map[string]any) (string, error) {
	value, err := argString(args, "value")
	if err != nil {
		return "", err
	}
	ref, _ := args["ref"].(string)
	sel, _ := args["selector"].(string)
	return bt.callAction(args, "select_", map[string]any{"ref": ref, "selector": sel, "value": value})
}
```

**Step 2: Build gate.**

Run: `go build ./...`
Expected: no errors.

**Step 3: Write the interaction tests.**

Create `internal/mcp/tools_browser_interact_test.go`. These reuse `browserResponder` and `attachedMCPClient` from `tools_browser_nav_test.go` (same package).

```go
package mcp

import (
	"testing"
	"time"

	"github.com/user/muxterm/internal/sessiond"
)

func TestBrowserInteractActionStrings(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()
	mc, wsID := attachedMCPClient(t, socketPath)
	actions, closeB := browserResponder(t, socketPath, wsID, sessiond.Message{OK: true})
	defer closeB()

	bt := newBrowserTools(mc)
	cases := []struct {
		name      string
		call      func(map[string]any) (string, error)
		args      map[string]any
		wantAct   string
		check     func(*sessiond.Message) bool
	}{
		{"click", bt.browserClick, map[string]any{"pane_id": 1, "ref": "e5"}, "click",
			func(m *sessiond.Message) bool { return m.Ref == "e5" }},
		{"fill", bt.browserFill, map[string]any{"pane_id": 1, "ref": "e2", "value": "hi"}, "fill",
			func(m *sessiond.Message) bool { return m.Ref == "e2" && m.Value == "hi" }},
		{"type", bt.browserType, map[string]any{"pane_id": 1, "text": "abc"}, "type_",
			func(m *sessiond.Message) bool { return m.Value == "abc" }}, // text -> Value
		{"press", bt.browserPress, map[string]any{"pane_id": 1, "key": "Enter"}, "press",
			func(m *sessiond.Message) bool { return m.Key == "Enter" }},
		{"hover", bt.browserHover, map[string]any{"pane_id": 1, "ref": "e4"}, "hover",
			func(m *sessiond.Message) bool { return m.Ref == "e4" }},
		{"select", bt.browserSelect, map[string]any{"pane_id": 1, "ref": "e9", "value": "opt1"}, "select_",
			func(m *sessiond.Message) bool { return m.Ref == "e9" && m.Value == "opt1" }},
	}
	for _, tc := range cases {
		out, err := tc.call(tc.args)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if out != `{"ok":true}` {
			t.Errorf("%s result = %s, want {\"ok\":true}", tc.name, out)
		}
		select {
		case a := <-actions:
			if a.Action != tc.wantAct {
				t.Errorf("%s action = %q, want %q", tc.name, a.Action, tc.wantAct)
			}
			if !tc.check(a) {
				t.Errorf("%s operands wrong: %+v", tc.name, a)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%s: no browser-action received", tc.name)
		}
	}
}
```

**Step 4: Run the tests.**

Run: `go test ./internal/mcp/... -run TestBrowserInteract -v`
Expected: PASS.

**Step 5: Commit.**
```
git add internal/mcp/tools_browser_interact.go internal/mcp/tools_browser_interact_test.go
git commit -m "feat: add browser interaction tools (click/fill/type/press/hover/select)"
```

---

## Task 5: Browser observation tools

**Files:**
- Create: `internal/mcp/tools_browser_observe.go`
- Test: `internal/mcp/tools_browser_observe_test.go`

`browser_snapshot` and `browser_eval` format their own results (they do NOT use `callAction`). `browser_screenshot` is a Phase 5 placeholder — the shim has no `screenshot` action, so the tool returns a structured error without touching the daemon.

**Step 1: Create the observation tools.**

Create `internal/mcp/tools_browser_observe.go`:

```go
package mcp

import (
	"context"
	"encoding/json"
)

// browserSnapshot captures the accessibility tree of a browser pane (shim
// action "snapshot"). Returns {snapshot: "<yaml>"} or {error: "..."}.
func (bt *browserTools) browserSnapshot(args map[string]any) (string, error) {
	paneID, err := argInt(args, "pane_id")
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), browserTimeout)
	defer cancel()
	res, err := bt.c.SendBrowserAction(ctx, paneID, "snapshot", nil)
	if err != nil {
		return "", err
	}
	if res.Error != "" {
		return jsonText(map[string]any{"error": res.Error}), nil
	}
	return jsonText(map[string]any{"snapshot": res.Snapshot}), nil
}

// browserEval evaluates a JavaScript expression in a browser pane (shim action
// "eval_"). Optional ref is passed to the shim as the `el` argument. Returns
// {result: <value>} (the raw JS result) or {error: "..."}.
func (bt *browserTools) browserEval(args map[string]any) (string, error) {
	paneID, err := argInt(args, "pane_id")
	if err != nil {
		return "", err
	}
	expr, err := argString(args, "expr")
	if err != nil {
		return "", err
	}
	params := map[string]any{"expr": expr}
	if ref, ok := args["ref"].(string); ok && ref != "" {
		params["ref"] = ref
	}
	ctx, cancel := context.WithTimeout(context.Background(), browserTimeout)
	defer cancel()
	res, err := bt.c.SendBrowserAction(ctx, paneID, "eval_", params)
	if err != nil {
		return "", err
	}
	if res.Error != "" {
		return jsonText(map[string]any{"error": res.Error}), nil
	}
	// res.Result is a json.RawMessage carrying the JS value; default to null.
	result := res.Result
	if len(result) == 0 {
		result = json.RawMessage("null")
	}
	out, _ := json.Marshal(map[string]json.RawMessage{"result": result})
	return string(out), nil
}

// browserScreenshot is a Phase 5 placeholder. The shim has no screenshot action
// yet, so this returns a structured error without contacting the daemon.
// TODO(Phase 6): implement a real screenshot path in the shim and wire it here.
func (bt *browserTools) browserScreenshot(args map[string]any) (string, error) {
	if _, err := argInt(args, "pane_id"); err != nil {
		return "", err
	}
	return jsonText(map[string]any{"error": "screenshot not available in Phase 5"}), nil
}
```

**Step 2: Build gate.**

Run: `go build ./...`
Expected: no errors.

**Step 3: Write the observation tests.**

Create `internal/mcp/tools_browser_observe_test.go`. The snapshot/eval responders need to reply with the relevant typed fields, so use a dedicated responder reply per test.

```go
package mcp

import (
	"strings"
	"testing"

	"github.com/user/muxterm/internal/sessiond"
)

func TestBrowserSnapshotReturnsTree(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()
	mc, wsID := attachedMCPClient(t, socketPath)
	_, closeB := browserResponder(t, socketPath, wsID, sessiond.Message{Snapshot: "button \"OK\" e1"})
	defer closeB()

	out, err := newBrowserTools(mc).browserSnapshot(map[string]any{"pane_id": 2})
	if err != nil {
		t.Fatalf("browserSnapshot: %v", err)
	}
	if !strings.Contains(out, `"snapshot"`) || !strings.Contains(out, "e1") {
		t.Errorf("snapshot result = %s, want a snapshot field containing e1", out)
	}
}

func TestBrowserEvalReturnsResult(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()
	mc, wsID := attachedMCPClient(t, socketPath)
	_, closeB := browserResponder(t, socketPath, wsID, sessiond.Message{Result: []byte(`"hello"`)})
	defer closeB()

	out, err := newBrowserTools(mc).browserEval(map[string]any{"pane_id": 2, "expr": "document.title"})
	if err != nil {
		t.Fatalf("browserEval: %v", err)
	}
	if out != `{"result":"hello"}` {
		t.Errorf("eval result = %s, want {\"result\":\"hello\"}", out)
	}
}

func TestBrowserScreenshotPlaceholder(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()
	mc, _ := attachedMCPClient(t, socketPath)

	out, err := newBrowserTools(mc).browserScreenshot(map[string]any{"pane_id": 2})
	if err != nil {
		t.Fatalf("browserScreenshot: %v", err)
	}
	if !strings.Contains(out, "not available") {
		t.Errorf("screenshot result = %s, want a placeholder error", out)
	}
}
```

**Step 4: Run the tests.**

Run: `go test ./internal/mcp/... -run TestBrowser -v`
Expected: PASS (all nav + interact + observe tests).

**Step 5: Commit.**
```
git add internal/mcp/tools_browser_observe.go internal/mcp/tools_browser_observe_test.go
git commit -m "feat: add browser observation tools (snapshot/eval) + screenshot placeholder"
```

---

## Task 6: MCP resources for pane output (list, read, subscribe + streaming notifications)

> **This is the largest task in Phase 5.** It spans `server.go` (JSON-RPC methods + a concurrency-safe writer + notifications), `client.go` (an output-notifier hook), and `run.go` (wiring the provider + hook after the lazy dial). Work the steps in order; build after each.

**Files:**
- Modify: `internal/mcp/server.go` (capabilities, resource provider hooks, `resources/*` methods, notification writer, output mutex)
- Modify: `internal/mcp/client.go` (output-notifier hook)
- Modify: `internal/mcp/run.go` (wire the provider + notifier through the lazy client)
- Test: `internal/mcp/server_test.go` (resources/list, resources/read, subscribe → notification)

**Step 1: Make the Server's writes concurrency-safe.**

Notifications are written from the sessiond read-loop goroutine while `Run` writes responses from the main goroutine. Concurrent `json.Encoder.Encode` calls race. In `internal/mcp/server.go`, add `"sync"` to imports, then add a mutex field to `Server`:

```go
	outMu sync.Mutex // serializes all writes to out (responses + notifications)
```

Wrap the `Encode` call in BOTH `writeResult` and `writeError` with `s.outMu.Lock()` / `defer s.outMu.Unlock()` (lock at the top of each function, before building/encoding).

**Step 2: Add the resource-provider hooks and subscription state to `Server`.**

In `internal/mcp/server.go`, add fields to `Server`:

```go
	// Resource provider, set by SetResourceProvider. resourceList returns the
	// current pane resources; resourceRead returns the text for a pane:// URI.
	resourceList func() []map[string]any
	resourceRead func(uri string) (string, error)

	subsMu        sync.Mutex
	subscriptions map[string]bool // subscribed pane:// URIs
```

Initialise `subscriptions` in `NewServerWithIO`:

```go
		subscriptions: make(map[string]bool),
```

Add the setter:

```go
// SetResourceProvider installs the callbacks backing the resources/* methods.
// list returns the current pane resource descriptors; read returns the text
// content for a pane:// URI. Both may be nil (resources disabled).
func (s *Server) SetResourceProvider(list func() []map[string]any, read func(uri string) (string, error)) {
	s.resourceList = list
	s.resourceRead = read
}
```

**Step 3: Declare the resources capability in `initialize`.**

In `handleInitialize`, change the `capabilities` map to:

```go
		"capabilities": map[string]any{
			"tools":     map[string]any{},
			"resources": map[string]any{"subscribe": true},
		},
```

**Step 4: Route the new methods in `handleLine`.**

In the `switch req.Method` in `handleLine`, add cases (before `default:`):

```go
	case "resources/list":
		if !notification {
			s.handleResourcesList(req.ID)
		}

	case "resources/read":
		if !notification {
			s.handleResourcesRead(req.ID, req.Params)
		}

	case "resources/subscribe":
		if !notification {
			s.handleResourcesSubscribe(req.ID, req.Params)
		}

	case "resources/unsubscribe":
		if !notification {
			s.handleResourcesUnsubscribe(req.ID, req.Params)
		}
```

**Step 5: Implement the handlers + the notification writer.**

Add to `internal/mcp/server.go`:

```go
// handleResourcesList responds with the current pane resources. Returns an
// empty list when no provider is set or the provider returns nothing.
func (s *Server) handleResourcesList(id json.RawMessage) {
	var resources []map[string]any
	if s.resourceList != nil {
		resources = s.resourceList()
	}
	if resources == nil {
		resources = []map[string]any{}
	}
	s.writeResult(id, map[string]any{"resources": resources})
}

// handleResourcesRead returns the text content for params.uri.
func (s *Server) handleResourcesRead(id json.RawMessage, rawParams json.RawMessage) {
	var params struct {
		URI string `json:"uri"`
	}
	if err := json.Unmarshal(rawParams, &params); err != nil || params.URI == "" {
		s.writeError(id, codeInvalidParams, "invalid params: missing uri")
		return
	}
	if s.resourceRead == nil {
		s.writeError(id, codeInternalError, "resources not available")
		return
	}
	text, err := s.resourceRead(params.URI)
	if err != nil {
		s.writeError(id, codeInternalError, err.Error())
		return
	}
	s.writeResult(id, map[string]any{
		"contents": []map[string]any{
			{"uri": params.URI, "mimeType": "text/plain", "text": text},
		},
	})
}

// handleResourcesSubscribe records params.uri as subscribed so later pane
// output triggers a notifications/resources/updated notification.
func (s *Server) handleResourcesSubscribe(id json.RawMessage, rawParams json.RawMessage) {
	var params struct {
		URI string `json:"uri"`
	}
	if err := json.Unmarshal(rawParams, &params); err != nil || params.URI == "" {
		s.writeError(id, codeInvalidParams, "invalid params: missing uri")
		return
	}
	s.subsMu.Lock()
	s.subscriptions[params.URI] = true
	s.subsMu.Unlock()
	s.writeResult(id, map[string]any{})
}

// handleResourcesUnsubscribe removes params.uri from the subscription set.
func (s *Server) handleResourcesUnsubscribe(id json.RawMessage, rawParams json.RawMessage) {
	var params struct {
		URI string `json:"uri"`
	}
	if err := json.Unmarshal(rawParams, &params); err != nil || params.URI == "" {
		s.writeError(id, codeInvalidParams, "invalid params: missing uri")
		return
	}
	s.subsMu.Lock()
	delete(s.subscriptions, params.URI)
	s.subsMu.Unlock()
	s.writeResult(id, map[string]any{})
}

// NotifyResourceUpdated sends a notifications/resources/updated notification for
// uri if (and only if) a client is subscribed to it. Safe to call from any
// goroutine.
func (s *Server) NotifyResourceUpdated(uri string) {
	s.subsMu.Lock()
	subscribed := s.subscriptions[uri]
	s.subsMu.Unlock()
	if !subscribed {
		return
	}
	s.writeNotification("notifications/resources/updated", map[string]any{"uri": uri})
}

// writeNotification sends a JSON-RPC 2.0 notification (no id). outMu-guarded.
func (s *Server) writeNotification(method string, params any) {
	s.outMu.Lock()
	defer s.outMu.Unlock()
	msg := map[string]any{"jsonrpc": "2.0", "method": method}
	if params != nil {
		msg["params"] = params
	}
	if err := s.out.Encode(msg); err != nil {
		fmt.Fprintf(os.Stderr, "mcp: write notification error: %v\n", err)
	}
}
```

**Step 6: Build gate.**

Run: `go build ./...`
Expected: no errors.

**Step 7: Add the output-notifier hook to the MCP `Client`.**

In `internal/mcp/client.go`, add a field to `Client`:

```go
	outputNotifier func(paneID int) // optional; fired (best-effort) on each pane output
```

Add a setter:

```go
// SetOutputNotifier installs a best-effort callback fired after each pane
// output is buffered. Used to drive MCP resource update notifications.
func (c *Client) SetOutputNotifier(fn func(paneID int)) {
	c.mu.Lock()
	c.outputNotifier = fn
	c.mu.Unlock()
}
```

In the `OnPaneOutput` handler inside `DialSocket`, after appending to the buffer and unlocking, fire the notifier:

```go
			OnPaneOutput: func(paneID uint32, data []byte) {
				c.mu.Lock()
				id := int(paneID)
				c.outputBufs[id] = append(c.outputBufs[id], data...)
				notify := c.outputNotifier
				c.mu.Unlock()
				if notify != nil {
					notify(id)
				}
			},
```

**Step 8: Wire the provider + notifier in `run.go`.**

In `internal/mcp/run.go`, add `"fmt"` is already imported. In `registerWithLazy`, after `registerAllTools(srv, wrap)`, install the resource provider. The provider closures dial lazily via `lc.get()` and set the output notifier exactly once after a successful dial.

Add to `registerWithLazy`:

```go
	// MCP resources: expose one pane://{id} resource per pane in the attached
	// workspace, backed by get_screen. The output notifier is installed on the
	// first successful dial so subscribed panes push update notifications.
	srv.SetResourceProvider(
		func() []map[string]any {
			c, err := lc.get()
			if err != nil {
				return nil
			}
			c.SetOutputNotifier(func(paneID int) {
				srv.NotifyResourceUpdated(fmt.Sprintf("pane://%d", paneID))
			})
			ws := c.Workspace()
			if ws == "" {
				return nil
			}
			comp, err := c.conn.Attach(ws, "wide")
			if err != nil {
				return nil
			}
			resources := make([]map[string]any, 0, len(comp.Panes))
			for _, p := range comp.Panes {
				resources = append(resources, map[string]any{
					"uri":      fmt.Sprintf("pane://%d", p.PaneID),
					"name":     fmt.Sprintf("Pane %d output", p.PaneID),
					"mimeType": "text/plain",
				})
			}
			return resources
		},
		func(uri string) (string, error) {
			c, err := lc.get()
			if err != nil {
				return "", err
			}
			var paneID int
			if _, perr := fmt.Sscanf(uri, "pane://%d", &paneID); perr != nil {
				return "", fmt.Errorf("invalid pane uri: %s", uri)
			}
			snap, err := c.conn.ScreenSnapshot(paneID)
			if err != nil {
				return "", err
			}
			return snap.Text, nil
		},
	)
```

> The notifier is set inside the list provider (cheap, idempotent). If you prefer a single dedicated install point, set it in `read` too — both are fine since `SetOutputNotifier` is mutex-guarded and overwrites with an equivalent closure.

**Step 9: Build gate.**

Run: `go build ./...`
Expected: no errors.

**Step 10: Write the resource tests.**

These exercise the JSON-RPC layer directly with an in-memory provider (no daemon needed for list/read/subscribe routing), plus one end-to-end notification test using the wired stack. Add to `internal/mcp/server_test.go`:

```go
// feedLine writes one JSON-RPC line through the server's handleLine and returns
// the decoded response from out. Helper for resource tests.
//
// (If server_test.go already has an equivalent request helper, reuse it instead
// of adding this one.)

func TestResourcesListAndRead(t *testing.T) {
	var out bytes.Buffer
	srv := NewServerWithIO(strings.NewReader(""), &out)
	srv.SetResourceProvider(
		func() []map[string]any {
			return []map[string]any{{"uri": "pane://1", "name": "Pane 1 output", "mimeType": "text/plain"}}
		},
		func(uri string) (string, error) { return "hello screen", nil },
	)

	srv.handleLine(`{"jsonrpc":"2.0","id":5,"method":"resources/list"}`)
	srv.handleLine(`{"jsonrpc":"2.0","id":6,"method":"resources/read","params":{"uri":"pane://1"}}`)

	lines := splitNonEmpty(out.String())
	if len(lines) < 2 {
		t.Fatalf("expected 2 responses, got %d: %s", len(lines), out.String())
	}
	if !strings.Contains(lines[0], `"uri":"pane://1"`) {
		t.Errorf("resources/list missing pane://1: %s", lines[0])
	}
	if !strings.Contains(lines[1], `"text":"hello screen"`) {
		t.Errorf("resources/read missing text: %s", lines[1])
	}
}

func TestResourcesSubscribeNotifies(t *testing.T) {
	var out bytes.Buffer
	srv := NewServerWithIO(strings.NewReader(""), &out)
	srv.SetResourceProvider(
		func() []map[string]any { return nil },
		func(uri string) (string, error) { return "", nil },
	)

	// Not subscribed yet: no notification.
	srv.NotifyResourceUpdated("pane://1")
	if strings.Contains(out.String(), "resources/updated") {
		t.Fatal("notification sent before subscribe")
	}

	srv.handleLine(`{"jsonrpc":"2.0","id":7,"method":"resources/subscribe","params":{"uri":"pane://1"}}`)
	srv.NotifyResourceUpdated("pane://1")

	if !strings.Contains(out.String(), `"method":"notifications/resources/updated"`) ||
		!strings.Contains(out.String(), `"uri":"pane://1"`) {
		t.Errorf("expected updated notification for pane://1, got: %s", out.String())
	}
}
```

> `splitNonEmpty` is a tiny helper: split `out.String()` on `"\n"` and drop empty lines. If `server_test.go` already has one (the integration tests use a similar split), reuse it; otherwise add it once at the top of the test file. Confirm `bytes` and `strings` are imported in `server_test.go`.

**Step 11: Run the tests.**

Run: `go test ./internal/mcp/... -run TestResources -v`
Expected: PASS. Then run the full package: `go test ./internal/mcp/... -count=1`.

**Step 12: Commit.**
```
git add internal/mcp/server.go internal/mcp/client.go internal/mcp/run.go internal/mcp/server_test.go
git commit -m "feat: add MCP pane:// resources with read + streaming subscribe"
```

---

## Task 7: Register the browser tools, update capabilities text, fix the tool-count test

**Files:**
- Modify: `internal/mcp/run.go` (register the 13 browser tools)
- Modify: `cmd/muxterm/cli.go` (mention browser tools in `--help`)
- Modify: `cmd/muxterm/mcp_integration_test.go` (12 → 25 tools)

**Step 1: Register the browser tools in `registerAllTools`.**

In `internal/mcp/run.go`, at the END of `registerAllTools` (after the `get_layout` registration, before the closing `}`), add the 13 browser tools. Use the existing `wrap` adapter pattern. (Descriptions are adapted from playwright-cli so agents recognise the patterns.)

```go
	// --- Browser navigation tools ---

	srv.Register(
		"browser_goto",
		"Navigate a browser pane to the specified URL. Waits for the page to load (shim-ready signal). Returns {ok: true} on success.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pane_id": map[string]any{"type": "integer"},
				"url":     map[string]any{"type": "string"},
			},
			"required": []string{"pane_id", "url"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) { return newBrowserTools(c).browserGoto(args) }),
	)

	srv.Register(
		"browser_go_back",
		"Navigate back in the browser pane's history. Equivalent to clicking the browser's back button. Returns {ok: true}.",
		map[string]any{
			"type":       "object",
			"properties": map[string]any{"pane_id": map[string]any{"type": "integer"}},
			"required":   []string{"pane_id"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) { return newBrowserTools(c).browserGoBack(args) }),
	)

	srv.Register(
		"browser_go_forward",
		"Navigate forward in the browser pane's history. Equivalent to clicking the browser's forward button. Returns {ok: true}.",
		map[string]any{
			"type":       "object",
			"properties": map[string]any{"pane_id": map[string]any{"type": "integer"}},
			"required":   []string{"pane_id"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) { return newBrowserTools(c).browserGoForward(args) }),
	)

	srv.Register(
		"browser_reload",
		"Reload the current page in a browser pane. Returns {ok: true}.",
		map[string]any{
			"type":       "object",
			"properties": map[string]any{"pane_id": map[string]any{"type": "integer"}},
			"required":   []string{"pane_id"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) { return newBrowserTools(c).browserReload(args) }),
	)

	// --- Browser interaction tools ---

	srv.Register(
		"browser_click",
		"Click an element in a browser pane. Accepts a ref from browser_snapshot (e.g., e15) or a CSS selector.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pane_id":  map[string]any{"type": "integer"},
				"ref":      map[string]any{"type": "string"},
				"selector": map[string]any{"type": "string"},
			},
			"required": []string{"pane_id"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) { return newBrowserTools(c).browserClick(args) }),
	)

	srv.Register(
		"browser_fill",
		"Fill an input field with a value. Accepts a ref or CSS selector. Dispatches input and change events.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pane_id":  map[string]any{"type": "integer"},
				"ref":      map[string]any{"type": "string"},
				"selector": map[string]any{"type": "string"},
				"value":    map[string]any{"type": "string"},
			},
			"required": []string{"pane_id", "value"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) { return newBrowserTools(c).browserFill(args) }),
	)

	srv.Register(
		"browser_type",
		"Type text into the currently focused element, character by character with keyboard events.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pane_id": map[string]any{"type": "integer"},
				"text":    map[string]any{"type": "string"},
			},
			"required": []string{"pane_id", "text"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) { return newBrowserTools(c).browserType(args) }),
	)

	srv.Register(
		"browser_press",
		"Press a keyboard key on the currently focused element. Examples: Enter, ArrowDown, Escape, Tab.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pane_id": map[string]any{"type": "integer"},
				"key":     map[string]any{"type": "string"},
			},
			"required": []string{"pane_id", "key"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) { return newBrowserTools(c).browserPress(args) }),
	)

	srv.Register(
		"browser_hover",
		"Hover the mouse over an element. Dispatches mouseover and mouseenter events.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pane_id":  map[string]any{"type": "integer"},
				"ref":      map[string]any{"type": "string"},
				"selector": map[string]any{"type": "string"},
			},
			"required": []string{"pane_id"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) { return newBrowserTools(c).browserHover(args) }),
	)

	srv.Register(
		"browser_select",
		"Select an option in a <select> dropdown element. Pass the option value attribute.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pane_id":  map[string]any{"type": "integer"},
				"ref":      map[string]any{"type": "string"},
				"selector": map[string]any{"type": "string"},
				"value":    map[string]any{"type": "string"},
			},
			"required": []string{"pane_id", "value"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) { return newBrowserTools(c).browserSelect(args) }),
	)

	// --- Browser observation tools ---

	srv.Register(
		"browser_snapshot",
		"Capture the current accessibility tree of a browser pane as YAML. Returns element refs (e1, e2...) for use with browser_click, browser_fill, and other interaction tools. Call this before any interaction to get current refs.",
		map[string]any{
			"type":       "object",
			"properties": map[string]any{"pane_id": map[string]any{"type": "integer"}},
			"required":   []string{"pane_id"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) { return newBrowserTools(c).browserSnapshot(args) }),
	)

	srv.Register(
		"browser_eval",
		"Evaluate a JavaScript expression in a browser pane. Returns the result. Optionally pass a ref to receive it as the `el` argument: browser_eval(pane_id, 'el => el.textContent', 'e5').",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pane_id": map[string]any{"type": "integer"},
				"expr":    map[string]any{"type": "string"},
				"ref":     map[string]any{"type": "string"},
			},
			"required": []string{"pane_id", "expr"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) { return newBrowserTools(c).browserEval(args) }),
	)

	srv.Register(
		"browser_screenshot",
		"Capture a base64 PNG screenshot of a browser pane. Use when the accessibility tree is insufficient (canvas-heavy pages, custom renders).",
		map[string]any{
			"type":       "object",
			"properties": map[string]any{"pane_id": map[string]any{"type": "integer"}},
			"required":   []string{"pane_id"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) { return newBrowserTools(c).browserScreenshot(args) }),
	)
```

Also update the doc comments on `NewStdioServer`, `registerWithLazy`, and `registerAllTools` that say "all 12 MCP tools" to say "all 25 MCP tools".

**Step 2: Update the `--help` text.**

In `cmd/muxterm/cli.go`, in the `mcp` flag-set `fs.Usage` closure (around line 81-87), add a line after the "stdout is the JSON-RPC transport…" line:

```go
		fmt.Fprintln(os.Stdout, "Exposes terminal, workspace, layout, and browser automation tools, plus pane:// resources.")
```

**Step 3: Build gate.**

Run: `go build ./...`
Expected: no errors.

**Step 4: Update the integration tool-count test.**

In `cmd/muxterm/mcp_integration_test.go`, rename `TestMCPToolsListReturns12Tools` → `TestMCPToolsListReturns25Tools` and append the 13 browser tools to `wantTools` in registration order (the order they appear in `registerAllTools`):

```go
	wantTools := []string{
		"run_command",
		"send_input",
		"get_screen",
		"list_workspaces",
		"create_workspace",
		"switch_workspace",
		"close_workspace",
		"create_pane",
		"rename_pane",
		"close_pane",
		"list_panes",
		"get_layout",
		"browser_goto",
		"browser_go_back",
		"browser_go_forward",
		"browser_reload",
		"browser_click",
		"browser_fill",
		"browser_type",
		"browser_press",
		"browser_hover",
		"browser_select",
		"browser_snapshot",
		"browser_eval",
		"browser_screenshot",
	}
```

Update the test's doc comment ("exactly 12 tools" → "exactly 25 tools") to match.

**Step 5: Run the integration test.**

Run: `go test ./cmd/muxterm/... -run TestMCP -v`
Expected: PASS (`TestMCPInitializeOverStdio` and `TestMCPToolsListReturns25Tools`). This confirms `tools/list` returns all 25 tools in order over real stdio, without a daemon.

**Step 6: Full build + test gate.**

Run: `go build ./... && go test ./internal/mcp/... ./internal/sessiond/... ./internal/proxy/... ./cmd/muxterm/... -count=1`
Expected: all PASS.

**Step 7: Commit.**
```
git add internal/mcp/run.go cmd/muxterm/cli.go cmd/muxterm/mcp_integration_test.go
git commit -m "feat: register browser tools + resources capability, update tool-count test"
```

---

## Done criteria

- [ ] The three orphaned `register*Tools` functions are deleted; build + vet clean.
- [ ] `sessiond.Client.SendBrowserAction` + `Handlers.OnBrowserActionResult` + `dispatchEvent` case exist; protocol additive only.
- [ ] `mcp.Client.SendBrowserAction` correlates by **paneID** (not CID) and times out via context.
- [ ] The shim handles `goto` (via `gotoUrl`); proxy tests pass.
- [ ] 13 browser tools exist: `browser_goto`, `browser_go_back`, `browser_go_forward`, `browser_reload`, `browser_click`, `browser_fill`, `browser_type`, `browser_press`, `browser_hover`, `browser_select`, `browser_snapshot`, `browser_eval`, `browser_screenshot`.
- [ ] `browser_type`'s `text` argument maps to the message **`Value`** field (verified by `TestBrowserInteractActionStrings`).
- [ ] `browser_screenshot` returns the Phase 5 placeholder `{"error":"screenshot not available in Phase 5"}` with a Phase 6 TODO.
- [ ] MCP resources work: `resources/list` returns `pane://{id}`, `resources/read` returns screen text, `resources/subscribe` causes `notifications/resources/updated` on pane output; `initialize` advertises `resources: {subscribe: true}`.
- [ ] Server writes are mutex-guarded (responses + notifications share `outMu`).
- [ ] `muxterm mcp` `--help` mentions browser tools + resources.
- [ ] `tools/list` returns exactly **25** tools in registration order (`TestMCPToolsListReturns25Tools`).
- [ ] `go build ./...` and `go test ./internal/mcp/... ./internal/sessiond/... ./internal/proxy/... ./cmd/muxterm/...` all pass.
- [ ] Each task committed with a conventional-commit message (7 commits).
```
