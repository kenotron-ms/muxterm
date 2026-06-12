# MCP Agent Workbench — Phase 3: SW Bridge → Agent Bridge + Browser Plumbing

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Upgrade the proxy shim from a URL-rewriting POC into a full agent bridge (snapshot + DOM interaction + navigation), migrate the service worker to the `/p/` scope, and close the browser-action result loop so MCP clients receive results.

**Architecture:** The injected shim runs *inside* every proxied `/p/` page. It listens for `postMessage` commands from the parent (muxterm), executes accessibility-tree snapshots and DOM actions, and posts results back. A new `/p/`-scoped service worker reports navigations. On the muxterm side, the browser-action *result* is routed back over the WebSocket to sessiond, which broadcasts it so the originating MCP client receives it. Finally, the layout-command handler graduates from a Phase 2 stub into real dockview operations.

**Tech Stack:** Go 1.22 (`net/http`, `ServeMux` longest-match routing), TypeScript + Lit 3 + dockview-core, vanilla JS injected shim, service workers.

---

## READ THIS FIRST — Orientation for the implementer

You know nothing about this codebase. That is fine. Here is everything you need.

### What Phase 3 accomplishes

Phase 1 proved a service worker bridge can intercept and round-trip `postMessage` commands. Phase 2 built the server foundations (OSC 133, screen-snapshot, browser-action relay, layout-command relay, get_layout ASCII) and the *client-side plumbing stubs*. Phase 3 makes the bridge **real**:

1. **Task 1** — Move the agent SW from root scope `/` to `/p/` scope so embedded pages are isolated from muxterm itself, and have it report navigations.
2. **Tasks 2–4** — Build the agent bridge shim: a `postMessage` command listener, an accessibility-tree `snapshot()` with element refs, element resolution, DOM interaction commands (click/fill/type/press/hover/select/eval), and navigation commands (back/forward/reload).
3. **Task 5** — Close the result loop on the **Go side** so a `browser-action-result` from the browser reaches the MCP client. (The TypeScript half already landed — see the reality check below.)
4. **Task 6** — Replace the layout-command stub with real dockview operations.

### The files you will touch

- `internal/proxy/proxy.go` — Go file holding the injected `shimScript` (a Go string literal containing JavaScript), the root `swScript`, `ServeServiceWorker`, and `injectShim()`. **Tasks 1–4 edit JavaScript that lives inside Go backtick strings.** Be careful with backticks: the shim string is delimited by Go backticks (`` ` ``), so the JS inside **cannot** contain a literal backtick. Use string concatenation with `'...'` quotes (the existing shim already does this).
- `internal/server/server.go` — route registration. Task 1 adds one route.
- `internal/sessiond/protocol.go` — frozen wire-protocol message-type constants and the `Message` struct. Task 5 adds a constant (and possibly fields).
- `internal/sessiond/server.go` — the daemon's `conn.handle(msg)` switch. Task 5 adds a case.
- `internal/server/ws.go` — the serve-layer `handleTextInput` switch that relays browser messages to the daemon. Task 5 adds a case.
- `internal/server/daemon.go` — the `DaemonConn` interface seam. Task 5 adds a method.
- `internal/sessiond/client.go` — `*sessiond.Client` (implements `DaemonConn`). Task 5 implements the new method.
- `web/src/components/mux-dock.ts` — Lit element wrapping dockview. Task 6 replaces the `handleLayoutCommand` stub (lines 1219–1229).
- `web/src/types.ts` — Task 6 adds a `LayoutCommand` interface.

### REALITY CHECK — read before Task 5 (saves you 20 minutes)

The Phase 2 review-fix commit (`7d33fd6`) **already landed the entire TypeScript half of the result loop.** Do not re-add it. Verify these exist, then move on:

- `web/src/types.ts:52` → `BrowserActionResult: 'browser-action-result'` (in the `SessiondType` const map). ✅ present
- `web/src/ws.ts:93–96` → `sendBrowserActionResult(detail)` sends `{ type: SessiondType.BrowserActionResult, ...detail }` via `sendSessiond`. ✅ present
- `web/src/app.ts:678–682` → `_onBrowserActionResult` calls `this._socket?.sendBrowserActionResult(detail)`, wired up in `connectedCallback`/`disconnectedCallback`. ✅ present

So the message already leaves the browser correctly. **The gap is entirely on the Go side**, and it is worse than "missing a case": `internal/server/ws.go handleTextInput` has a `default` branch that replies with `"unknown action: browser-action-result"` — so today the result is actively rejected. Task 5 fixes the Go path: protocol constant → serve-layer forward → daemon broadcast.

### Build gates (memorize these)

- Go build: `go build ./...`
- Go tests: `go test ./internal/...`
- TypeScript fast check: `cd web && npm run check:fast`

### Commit style

Conventional commits: `feat:`, `test:`, `fix:`, `chore:`. **One commit per task.**

### Test conventions you will copy

- Proxy unit tests live in `internal/proxy/proxy_test.go` (uses `httptest`, helpers `proxyFor`, `portOf`, `proxyURL`).
- Route tests live in `internal/server/routes_test.go`. `TestServiceWorkerRoute` (line 14) is the exact pattern for "GET a JS route, assert `Content-Type` and a substring" — copy it for Task 1.

---

## Task 1: Migrate the agent SW to `/p/` scope

**Why:** The existing shim registers a service worker at `/sw.js` with scope `/`. For agent use the SW must be scoped to `/p/` so embedded pages are isolated from muxterm's own origin surface. A script at `/p/sw.js` with scope `/p/` needs **no** `Service-Worker-Allowed` header (the script path prefix already covers the scope).

**Files:**
- Modify: `internal/proxy/proxy.go` (add `pSwScript` const + `ServeAgentServiceWorker`; change SW registration inside `shimScript` at line 86)
- Modify: `internal/server/server.go:56-60` (add `GET /p/sw.js` route)
- Test: `internal/server/routes_test.go` (new test, mirrors `TestServiceWorkerRoute` at line 14)

**Step 1: Write the failing test**

Add to `internal/server/routes_test.go`:

```go
// TestAgentServiceWorkerRoute verifies GET /p/sw.js serves the agent-bridge SW.
func TestAgentServiceWorkerRoute(t *testing.T) {
	srv := newTestServer(t) // same helper TestServiceWorkerRoute uses
	req := httptest.NewRequest(http.MethodGet, "/p/sw.js", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	ct := w.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "application/javascript") {
		t.Errorf("Content-Type = %q, want application/javascript", ct)
	}
	if !strings.Contains(w.Body.String(), "mux-page-navigated") {
		t.Error("/p/sw.js body should contain 'mux-page-navigated'")
	}
}
```

> If `newTestServer` is not the helper name in this file, read the top of `routes_test.go` and reuse whatever `TestServiceWorkerRoute` uses to build the server.

**Step 2: Run the test to verify it fails**

Run: `go test ./internal/server/ -run TestAgentServiceWorkerRoute -v`
Expected: FAIL — route 404s (no `/p/sw.js` registered), or the proxy `/p/` catch-all returns a bad-gateway/400.

**Step 3: Add the `pSwScript` const and `ServeAgentServiceWorker` in `internal/proxy/proxy.go`**

After the existing `swScript` const (ends at line 127), add:

```go
// pSwScript is the muxterm agent-bridge service worker, served at /p/sw.js with
// scope /p/. It records navigations and notifies controlled clients (the shim)
// so the parent can track page transitions. Because the script path (/p/sw.js)
// is within its scope (/p/), no Service-Worker-Allowed header is required.
const pSwScript = `
// muxterm agent bridge SW — scope /p/
const navigations = [];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate') {
    navigations.push(e.request.url);
    // Notify all controlled clients of navigation
    self.clients.matchAll().then(clients => {
      clients.forEach(c => c.postMessage({
        type: 'mux-page-navigated',
        url: e.request.url
      }));
    });
  }
  // Fall through — don't intercept
});
`

// ServeAgentServiceWorker serves /p/sw.js (scope /p/) with the JS content type
// and no-store caching. No Service-Worker-Allowed header is needed because the
// script path is inside the requested scope.
func ServeAgentServiceWorker(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	fmt.Fprint(w, pSwScript)
}
```

**Step 4: Change the SW registration inside `shimScript`**

In `internal/proxy/proxy.go`, the shim currently registers (line 86):

```js
    navigator.serviceWorker.register('/sw.js', {scope: '/'})
```

Change it to:

```js
    navigator.serviceWorker.register('/p/sw.js', {scope: '/p/'})
```

> Leave the root `swScript`/`ServeServiceWorker` untouched — non-agent proxy pages still use it.

**Step 5: Register the route in `internal/server/server.go`**

Immediately before the `/p/` catch-all (line 60), add:

```go
	// Agent-bridge SW must be registered alongside the /p/ catch-all. Go 1.22
	// ServeMux uses longest-match, so the more specific /p/sw.js wins over /p/
	// regardless of order; declared first for clarity.
	s.mux.HandleFunc("GET /p/sw.js", func(w http.ResponseWriter, r *http.Request) {
		proxy.ServeAgentServiceWorker(w, r)
	})
```

**Step 6: Run the build gate**

Run: `go build ./...`
Expected: success.

**Step 7: Run the test to verify it passes**

Run: `go test ./internal/server/ -run TestAgentServiceWorkerRoute -v`
Expected: PASS.

**Step 8: Commit**

`git add internal/proxy/proxy.go internal/server/server.go internal/server/routes_test.go && git commit -m "feat: migrate agent service worker to /p/ scope"`

---

## Task 2: Agent bridge shim — message listener, snapshot, element resolution

This is the core of the shim. It is appended to the **end** of the existing `shimScript` (after the `console.debug('[muxterm shim] active …')` line, before the closing `})();</script>`). It adds the `postMessage` command listener, the accessibility-tree `snapshot()`, and `resolveTarget()`.

**Files:**
- Modify: `internal/proxy/proxy.go` (append the bridge IIFE to `shimScript`)
- Test: `internal/proxy/proxy_test.go` (new test asserting injected HTML contains bridge markers)

**Step 1: Write the failing test**

Add to `internal/proxy/proxy_test.go`:

```go
// TestInjectShimContainsAgentBridge verifies injectShim emits the agent-bridge
// snapshot/resolution machinery into proxied HTML.
func TestInjectShimContainsAgentBridge(t *testing.T) {
	out := string(injectShim([]byte("<html><head></head><body></body></html>")))
	for _, want := range []string{
		"mux-shim-ready",
		"handleAction",
		"mux-page-navigated",
		"function snapshot()",
		"function resolveTarget(",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("injected HTML missing %q", want)
		}
	}
}
```

**Step 2: Run the test to verify it fails**

Run: `go test ./internal/proxy/ -run TestInjectShimContainsAgentBridge -v`
Expected: FAIL — markers absent.

**Step 3: Append the bridge IIFE to `shimScript`**

In `internal/proxy/proxy.go`, inside `shimScript`, after the existing
`console.debug('[muxterm shim] active — fetch + XHR + WebSocket covered');`
line and before the closing `})();` of the existing IIFE, add a **new, separate IIFE**:

```js
// muxterm agent bridge — appended to shimScript
(function() {
  const _refs = new Map(); // refId (number) -> Element

  // Listen for browser-action commands from parent
  window.addEventListener('message', function(ev) {
    const msg = ev.data;
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('mux-')) return;
    const cid = msg.cid;
    handleAction(msg).then(function(result) {
      window.parent.postMessage(Object.assign({}, result, {type: msg.type + '-result', cid: cid}), '*');
    }).catch(function(err) {
      window.parent.postMessage({type: msg.type + '-result', cid: cid, error: String(err)}, '*');
    });
  });

  // Announce to parent
  window.parent.postMessage({type: 'mux-shim-ready', url: location.href}, '*');

  // SW navigation events -> parent
  navigator.serviceWorker.addEventListener('message', function(ev) {
    if (ev.data && ev.data.type === 'mux-page-navigated') {
      window.parent.postMessage({type: 'mux-page-navigated', url: ev.data.url}, '*');
    }
  });

  function handleAction(msg) {
    switch (msg.action) {
      case 'snapshot': return Promise.resolve(snapshot());
      case 'click':    return click(msg.ref || msg.selector);
      case 'fill':     return fill(msg.ref || msg.selector, msg.value || '');
      case 'type':     return type_(msg.value || '');
      case 'press':    return press(msg.key || '');
      case 'hover':    return hover(msg.ref || msg.selector);
      case 'select':   return select_(msg.ref || msg.selector, msg.value || '');
      case 'eval':     return eval_(msg.expr || '', msg.ref);
      case 'go-back':  return goBack();
      case 'go-forward': return goForward();
      case 'reload':   return reload();
      default: return Promise.reject(new Error('unknown action: ' + msg.action));
    }
  }

  function snapshot() {
    _refs.clear();
    var counter = [0];
    var lines = buildTree(document.body, 0, counter);
    return {snapshot: lines.join('\n')};
  }

  function buildTree(el, depth, counter) {
    if (!el || !isVisible(el)) return [];
    var lines = [];
    var indent = '  '.repeat(depth);
    var role = el.getAttribute('role') || getImplicitRole(el);
    var name = getAccessibleName(el);
    var attrs = [];
    if (isInteractive(el) || role || name) {
      var refId = ++counter[0];
      _refs.set(refId, el);
      attrs.push('[ref=e' + refId + ']');
    }
    if (el.getAttribute('placeholder')) attrs.push('[placeholder="' + el.getAttribute('placeholder') + '"]');
    if (el.style.cursor === 'pointer') attrs.push('[cursor=pointer]');
    var tagLine = indent + '- ' + (role || el.tagName.toLowerCase());
    if (name) tagLine += ' "' + name + '"';
    if (el.tagName === 'H1'||el.tagName === 'H2'||el.tagName === 'H3'||el.tagName === 'H4'||el.tagName === 'H5'||el.tagName === 'H6') {
      attrs.push('[level=' + el.tagName[1] + ']');
    }
    tagLine += attrs.join(' ');
    // Add text content for leaf-ish nodes
    var text = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3 ? el.childNodes[0].nodeValue.trim() : '';
    if (text && text.length < 80) tagLine += ': ' + text;
    if (attrs.length > 0 || role || name) lines.push(tagLine);
    el.childNodes.forEach(function(child) {
      if (child.nodeType === 1) {
        buildTree(child, depth + 1, counter).forEach(function(l) { lines.push(l); });
      }
    });
    return lines;
  }

  function isVisible(el) {
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }
  function isInteractive(el) {
    var tag = el.tagName;
    return tag==='A'||tag==='BUTTON'||tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||
      el.getAttribute('onclick')!==null||el.getAttribute('tabindex')!==null;
  }
  function getImplicitRole(el) {
    var map = {A:'link',BUTTON:'button',H1:'heading',H2:'heading',H3:'heading',H4:'heading',
      H5:'heading',H6:'heading',P:'paragraph',UL:'list',OL:'list',LI:'listitem',
      INPUT:'textbox',TEXTAREA:'textbox',SELECT:'combobox',IMG:'img',NAV:'navigation',
      MAIN:'main',HEADER:'banner',FOOTER:'contentinfo',FORM:'form',TABLE:'table'};
    return map[el.tagName] || '';
  }
  function getAccessibleName(el) {
    return el.getAttribute('aria-label') || el.getAttribute('alt') ||
      el.getAttribute('title') || (el.tagName === 'INPUT' ? el.getAttribute('placeholder') : '') ||
      (el.tagName === 'BUTTON' || el.tagName === 'A' ? el.textContent.trim().slice(0,50) : '') || '';
  }

  function resolveTarget(refOrSelector) {
    if (!refOrSelector) throw new Error('no target specified');
    if (/^e\d+$/.test(refOrSelector)) {
      var id = parseInt(refOrSelector.slice(1));
      var el = _refs.get(id);
      if (!el) throw new Error('ref ' + refOrSelector + ' not found — call snapshot first');
      return el;
    }
    var el = document.querySelector(refOrSelector);
    if (!el) throw new Error('selector "' + refOrSelector + '" matched no element');
    return el;
  }
})();
```

> **Backtick discipline:** the bridge above uses only `'...'` string literals — no backticks — because `shimScript` is delimited by Go backticks. Keep it that way through Tasks 3 and 4.
>
> **Note:** `handleAction` references `click`, `fill`, `type_`, etc. which you add in Tasks 3–4. Go does not compile-check the JS string, so `go build` succeeds now; the functions become defined in the next two tasks. The shim is not exercised in a browser until all three tasks land.

**Step 4: Run the build gate**

Run: `go build ./...`
Expected: success.

**Step 5: Run the test to verify it passes**

Run: `go test ./internal/proxy/ -run TestInjectShimContainsAgentBridge -v`
Expected: PASS.

**Step 6: Commit**

`git add internal/proxy/proxy.go internal/proxy/proxy_test.go && git commit -m "feat: add agent bridge shim snapshot and element resolution"`

---

## Task 3: Agent bridge shim — DOM interaction commands

Adds the interaction command implementations referenced by `handleAction`: `click`, `fill`, `type_`, `press`, `hover`, `select_`, `eval_`. These go **inside the same bridge IIFE** added in Task 2 (anywhere among the other function declarations — placing them right after `resolveTarget` is fine).

**Files:**
- Modify: `internal/proxy/proxy.go` (extend the bridge IIFE in `shimScript`)
- Test: `internal/proxy/proxy_test.go` (new test asserting interaction functions present)

**Step 1: Write the failing test**

Add to `internal/proxy/proxy_test.go`:

```go
// TestInjectShimContainsInteractionCommands verifies the DOM interaction verbs
// are present in the injected shim.
func TestInjectShimContainsInteractionCommands(t *testing.T) {
	out := string(injectShim([]byte("<html><head></head><body></body></html>")))
	for _, want := range []string{
		"function click(",
		"function fill(",
		"function type_(",
		"function press(",
		"function hover(",
		"function select_(",
		"function eval_(",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("injected HTML missing %q", want)
		}
	}
}
```

**Step 2: Run the test to verify it fails**

Run: `go test ./internal/proxy/ -run TestInjectShimContainsInteractionCommands -v`
Expected: FAIL.

**Step 3: Add the interaction functions to the bridge IIFE**

Inside the Task 2 bridge IIFE (before its closing `})();`), add:

```js
function click(target) {
  var el = resolveTarget(target);
  el.click();
  return Promise.resolve({ok: true});
}

function fill(target, value) {
  var el = resolveTarget(target);
  var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  nativeInputValueSetter.call(el, value);
  el.dispatchEvent(new Event('input', {bubbles: true}));
  el.dispatchEvent(new Event('change', {bubbles: true}));
  return Promise.resolve({ok: true});
}

function type_(value) {
  var el = document.activeElement || document.body;
  for (var i = 0; i < value.length; i++) {
    var ch = value[i];
    el.dispatchEvent(new KeyboardEvent('keydown', {key: ch, bubbles: true}));
    el.dispatchEvent(new KeyboardEvent('keypress', {key: ch, bubbles: true}));
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ||
                   Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      if (setter && setter.set) setter.set.call(el, el.value + ch);
    }
    el.dispatchEvent(new KeyboardEvent('keyup', {key: ch, bubbles: true}));
    el.dispatchEvent(new Event('input', {bubbles: true}));
  }
  return Promise.resolve({ok: true});
}

function press(key) {
  var el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', {key: key, bubbles: true}));
  el.dispatchEvent(new KeyboardEvent('keyup', {key: key, bubbles: true}));
  if (key === 'Enter' && (el.tagName === 'INPUT' || el.tagName === 'BUTTON')) {
    el.dispatchEvent(new Event('submit', {bubbles: true}));
    if (el.form) el.form.dispatchEvent(new Event('submit', {bubbles: true}));
  }
  return Promise.resolve({ok: true});
}

function hover(target) {
  var el = resolveTarget(target);
  el.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));
  el.dispatchEvent(new MouseEvent('mouseenter', {bubbles: true}));
  return Promise.resolve({ok: true});
}

function select_(target, value) {
  var el = resolveTarget(target);
  if (el.tagName !== 'SELECT') throw new Error('select target must be a <select> element');
  el.value = value;
  el.dispatchEvent(new Event('change', {bubbles: true}));
  return Promise.resolve({ok: true});
}

function eval_(expr, ref) {
  try {
    var el = ref ? resolveTarget(ref) : undefined;
    var fn = new Function('el', 'return (' + expr + ')');
    var result = fn(el);
    if (result && typeof result.then === 'function') {
      return result.then(function(v) { return {result: v}; });
    }
    return Promise.resolve({result: result});
  } catch(e) {
    return Promise.reject(e);
  }
}
```

**Step 4: Run the build gate**

Run: `go build ./...`
Expected: success.

**Step 5: Run the test to verify it passes**

Run: `go test ./internal/proxy/ -run TestInjectShimContainsInteractionCommands -v`
Expected: PASS.

**Step 6: Commit**

`git add internal/proxy/proxy.go internal/proxy/proxy_test.go && git commit -m "feat: add DOM interaction commands to agent bridge shim"`

---

## Task 4: Agent bridge shim — navigation commands

Adds `goBack`, `goForward`, `reload` to the bridge IIFE. These work because the shim runs **inside** the frame — same-origin from the frame's own perspective, even though the outer sandbox is opaque to the parent. `reload()` uses `location.replace(href)` instead of `location.reload()` for the same reason. See design doc section 5.

**Files:**
- Modify: `internal/proxy/proxy.go` (extend the bridge IIFE in `shimScript`)
- Test: `internal/proxy/proxy_test.go` (new test asserting navigation functions present)

**Step 1: Write the failing test**

Add to `internal/proxy/proxy_test.go`:

```go
// TestInjectShimContainsNavigationCommands verifies the navigation verbs are
// present in the injected shim.
func TestInjectShimContainsNavigationCommands(t *testing.T) {
	out := string(injectShim([]byte("<html><head></head><body></body></html>")))
	for _, want := range []string{
		"function goBack(",
		"function goForward(",
		"location.replace(",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("injected HTML missing %q", want)
		}
	}
}
```

**Step 2: Run the test to verify it fails**

Run: `go test ./internal/proxy/ -run TestInjectShimContainsNavigationCommands -v`
Expected: FAIL.

**Step 3: Add the navigation functions to the bridge IIFE**

Inside the bridge IIFE (before its closing `})();`), add:

```js
function goBack() {
  window.history.back();
  return Promise.resolve({ok: true});
}

function goForward() {
  window.history.forward();
  return Promise.resolve({ok: true});
}

function reload() {
  // Runs inside the frame; the frame has no same-origin access to its parent,
  // so we self-navigate via location.replace rather than location.reload().
  var href = location.href;
  location.replace(href);
  return Promise.resolve({ok: true});
}
```

**Step 4: Run the build gate**

Run: `go build ./...`
Expected: success.

**Step 5: Run the test to verify it passes**

Run: `go test ./internal/proxy/ -run TestInjectShimContainsNavigationCommands -v`
Expected: PASS.

**Step 6: Run the full proxy suite (regression guard)**

Run: `go test ./internal/proxy/ -v`
Expected: PASS (all shim tests plus the pre-existing URL-rewrite tests).

**Step 7: Commit**

`git add internal/proxy/proxy.go internal/proxy/proxy_test.go && git commit -m "feat: add navigation commands to agent bridge shim"`

---

## Task 5: Route browser-action results back to the MCP client (Go side)

**Problem:** The browser already sends `{type: 'browser-action-result', ...}` back over the WebSocket (the TS half landed in commit `7d33fd6` — see the REALITY CHECK). But the Go path rejects it: `internal/server/ws.go handleTextInput` has no case for it, so it falls into the `default` branch and replies `"unknown action: browser-action-result"`. The result never reaches the daemon, so the MCP client never sees it.

This task adds the Go path: a protocol constant, a `DaemonConn` forward method (+ its `*sessiond.Client` implementation), a `ws.go` relay case, and a `sessiond/server.go` broadcast case (mirroring the existing `TypeBrowserAction` handling at `server.go:330-336`).

> **Do NOT touch `web/src/types.ts`, `web/src/ws.ts`, or `web/src/app.ts` for the result path** — verify they already contain the pieces listed in the REALITY CHECK, then leave them alone.

**Files:**
- Modify: `internal/sessiond/protocol.go` (add `TypeBrowserActionResult` const near line 54)
- Modify: `internal/server/daemon.go` (add method to `DaemonConn` interface, line 10–27)
- Modify: `internal/sessiond/client.go` (implement the new method)
- Modify: `internal/server/ws.go` (add case in `handleTextInput`, before the `default` at line 237)
- Modify: `internal/sessiond/server.go` (add case in `conn.handle`, after the `TypeBrowserAction` case at line 330)
- Test: `internal/sessiond/server_test.go` (or the existing relay test file — see Step 1)

**Step 1: Write the failing test**

Find the existing test that exercises `TypeBrowserAction` broadcast (grep for `TypeBrowserAction` under `internal/sessiond/`). Mirror it for the result direction. Add to the same file (e.g. `internal/sessiond/server_test.go`):

```go
// TestBrowserActionResultBroadcast verifies a browser-action-result from one
// connection is broadcast (as an event, cid=0) to all subscribers of the
// attached workspace so the originating MCP client receives it.
func TestBrowserActionResultBroadcast(t *testing.T) {
	// Use the same in-process daemon + two-conn harness the TypeBrowserAction
	// test uses. Attach both conns to one workspace; have conn A send a
	// browser-action-result; assert conn B receives a message of type
	// "browser-action-result" with CID == 0.
	//
	// Copy the setup/teardown from the existing TypeBrowserAction relay test
	// in this package and swap the message type + asserted fields.
}
```

> Read the neighbouring `TypeBrowserAction` test first and copy its harness verbatim; only the message type and assertions change. Keep the body concrete (no TODOs) before running.

**Step 2: Run the test to verify it fails**

Run: `go test ./internal/sessiond/ -run TestBrowserActionResultBroadcast -v`
Expected: FAIL — `TypeBrowserActionResult` undefined / no broadcast case.

**Step 3: Add the protocol constant**

In `internal/sessiond/protocol.go`, in the Events block, right after the `TypeBrowserAction`/`TypeLayoutCommand` lines (54–55), add:

```go
	TypeBrowserActionResult = "browser-action-result" // browser → MCP: result of a browser-action
```

> **Result payload fields:** the shim returns `{ok: true}`, `{snapshot: "..."}`, `{result: ...}`, or `{error: "..."}`. Of these, only `error` maps onto an existing `Message` field. If the design requires `snapshot`/`result`/`ok` to survive the Go round-trip (the daemon unmarshals into `sessiond.Message` and drops unknown JSON keys), add fields to the `Message` struct (after line 174) — e.g.:
> ```go
> Snapshot string          `json:"snapshot,omitempty"` // browser-action-result: a11y tree
> Result   json.RawMessage `json:"result,omitempty"`   // browser-action-result: eval result
> OK       bool            `json:"ok,omitempty"`       // browser-action-result: success flag
> ```
> Confirm against the design doc whether these are needed; if the MCP server only consumes `error` + `snapshot`, add just those. **Do not** add fields the design doesn't use (YAGNI).

**Step 4: Add the forward method to the `DaemonConn` seam**

`internal/server/daemon.go` has no generic forward — every relayed type is an explicit method. Add one to the interface (inside the `DaemonConn interface` block, lines 10–27):

```go
	// BrowserActionResult forwards a browser-action-result envelope from the
	// browser to the daemon (fire-and-forget; the daemon broadcasts it).
	BrowserActionResult(msg sessiond.Message) error
```

**Step 5: Implement it on `*sessiond.Client`**

In `internal/sessiond/client.go`, alongside the other fire-and-forget methods (`Input`, `Resize` at lines 335–348), add:

```go
func (c *Client) BrowserActionResult(msg Message) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	msg.Type = TypeBrowserActionResult
	return WriteControl(c.conn, &msg)
}
```

> Note the method signature on the interface uses `sessiond.Message` (server package), and the implementation uses the unqualified `Message` (same package). They are the same type.

**Step 6: Add the relay case in `ws.go`**

In `internal/server/ws.go handleTextInput`, immediately before the `default:` branch (line 237), add:

```go
	case sessiond.TypeBrowserActionResult:
		// Forward to the daemon, which broadcasts it back to the workspace's
		// subscribers so the originating MCP client receives the result.
		if err := c.daemon.BrowserActionResult(msg); err != nil {
			log.Printf("handleTextInput: browser-action-result relay error: %v", err)
		}
```

**Step 7: Add the broadcast case in `sessiond/server.go`**

In `internal/sessiond/server.go conn.handle`, mirror the `TypeBrowserAction` case (lines 330–336). Add after it:

```go
	case TypeBrowserActionResult:
		if c.attached == "" {
			c.replyError(msg.CID, CodeUnknownWorkspace, "not attached to a workspace")
			return
		}
		// Clear cid — it's an event fan-out; the MCP client correlates by its
		// own pending browser-action request.
		msg.CID = 0
		c.srv.broadcast(c.attached, &msg)
```

**Step 8: Run the build gate**

Run: `go build ./... && cd web && npm run check:fast && cd ..`
Expected: Go builds; TS `check:fast` passes (no TS changes, but confirms the existing result-path TS still type-checks).

**Step 9: Run the test to verify it passes**

Run: `go test ./internal/sessiond/ -run TestBrowserActionResultBroadcast -v`
Expected: PASS.

**Step 10: Run the broader Go suite (regression guard)**

Run: `go test ./internal/sessiond/ ./internal/server/`
Expected: PASS.

**Step 11: Commit**

`git add internal/sessiond/protocol.go internal/sessiond/client.go internal/sessiond/server.go internal/sessiond/server_test.go internal/server/daemon.go internal/server/ws.go && git commit -m "feat: route browser-action results back to MCP client"`

---

## Task 6: Layout-command full implementation (TypeScript)

Replaces the Phase 2 `handleLayoutCommand` stub (`web/src/components/mux-dock.ts:1219-1229`, which only logs + emits `layout-command-received`) with real dockview operations, and adds the `LayoutCommand` type.

**Files:**
- Modify: `web/src/types.ts` (add `LayoutCommand` interface)
- Modify: `web/src/components/mux-dock.ts:1219-1229` (replace the stub body)

> **Integration-tested, not unit-tested.** Layout-command behaviour is exercised when the MCP server drives it end-to-end; unit-testing here would require mocking dockview internals, which the repo does not do. The gate for this task is `npm run check:fast` + the existing E2E harness. Do **not** invent dockview mocks.

**Step 1: Add the `LayoutCommand` interface to `web/src/types.ts`**

Add (near the other exported interfaces):

```typescript
export interface LayoutCommand {
  command: 'create-pane' | 'rename-pane' | 'close-pane' | 'switch-workspace';
  paneId?: number;
  name?: string;
  kind?: 'terminal' | 'browser';
  placement?: 'tab' | 'split-right' | 'split-left' | 'split-above' | 'split-below';
  referencePaneId?: number;
  url?: string;
  workspaceId?: string;
}
```

**Step 2: Run check:fast to confirm the type compiles in isolation**

Run: `cd web && npm run check:fast && cd ..`
Expected: PASS (the new interface is unused so far — that's fine).

**Step 3: Replace the `handleLayoutCommand` stub**

In `web/src/components/mux-dock.ts`, replace the entire stub method (lines 1219–1229) with:

```typescript
  handleLayoutCommand(msg: LayoutCommand): void {
    if (!this._dv) return;

    switch (msg.command) {
      case 'create-pane': {
        // Use existing _requestPane placement logic.
        this._nextPlacement = msg.placement === 'tab' ? 'tab' : 'split';
        if (msg.referencePaneId && msg.placement !== 'tab') {
          this._splitReferenceId = String(msg.referencePaneId);
        }
        this._placementReferenceId = msg.referencePaneId
          ? String(msg.referencePaneId)
          : (this._dv.activePanel?.id ?? null);
        // app.ts handles creating the pane on the server.
        this.dispatchEvent(
          new CustomEvent('pane-create', {
            bubbles: true,
            composed: true,
            detail: { kind: msg.kind, url: msg.url },
          }),
        );
        break;
      }
      case 'rename-pane': {
        if (msg.paneId === undefined) return;
        this._customTitles.set(msg.paneId, msg.name ?? '');
        const panel = this._panels.get(msg.paneId);
        if (panel) {
          // dockview has no direct setTitle; update the tab content element.
          const tabEl = (panel as unknown as { view?: { tab?: { element?: HTMLElement } } })
            .view?.tab?.element?.querySelector<HTMLElement>('.dv-default-tab-content');
          if (tabEl) tabEl.textContent = msg.name ?? '';
        }
        // Notify server to persist the title.
        this.dispatchEvent(
          new CustomEvent('pane-rename', {
            bubbles: true,
            composed: true,
            detail: { paneId: msg.paneId, name: msg.name ?? '' },
          }),
        );
        break;
      }
      case 'close-pane': {
        if (msg.paneId === undefined) return;
        const panel = this._panels.get(msg.paneId);
        if (panel && this._dv) {
          this._dv.removePanel(panel);
        }
        break;
      }
      case 'switch-workspace': {
        if (!msg.workspaceId) return;
        this.dispatchEvent(
          new CustomEvent('workspace-select', {
            bubbles: true,
            composed: true,
            detail: { workspaceId: msg.workspaceId },
          }),
        );
        break;
      }
    }
  }
```

**Step 4: Update the import / call site**

- Add `LayoutCommand` to the type import from `../types` (or `./types`, match the file's existing import path) at the top of `mux-dock.ts`.
- `web/src/app.ts:673-676` `_onLayoutCommand` passes a `Record<string, unknown>` into `handleLayoutCommand`. With the stricter `LayoutCommand` parameter type, `check:fast` may flag the call. Cast at the call site: `this._dock?.handleLayoutCommand(msg as unknown as LayoutCommand)`, importing `LayoutCommand` in `app.ts` — **or** keep `handleLayoutCommand(msg: LayoutCommand)` and adjust `_onLayoutCommand` to type its detail as `LayoutCommand`. Pick whichever keeps `check:fast` clean with the least churn.

> **VERIFY the referenced private fields exist** before relying on them. Grep `mux-dock.ts` for `_nextPlacement`, `_splitReferenceId`, `_placementReferenceId`, `_customTitles`, `_panels`, and `_dv`. `_customTitles`, `_panels`, and `_dv` are confirmed present (used near lines 1190–1198). If `_nextPlacement` / `_splitReferenceId` / `_placementReferenceId` are named differently in the current `_requestPane` flow, align to the actual field names rather than introducing new ones. Confirm `pane-create`, `pane-rename`, and `workspace-select` are the event names `app.ts` actually listens for; if not, use the real ones.

**Step 5: Run the build gate**

Run: `cd web && npm run check:fast && cd ..`
Expected: PASS.

**Step 6: Commit**

`git add web/src/types.ts web/src/components/mux-dock.ts web/src/app.ts && git commit -m "feat: implement layout-command dockview operations"`

---

## Phase 3 completion checklist

After all six tasks:

- [ ] `go build ./...` — clean
- [ ] `go test ./internal/...` — green
- [ ] `cd web && npm run check:fast` — green
- [ ] `git log --oneline -6` shows six conventional commits (one per task)
- [ ] Agent SW registered at `/p/sw.js` scope `/p/`; root `/sw.js` untouched
- [ ] Injected shim contains `mux-shim-ready`, `snapshot`, all interaction verbs, and all navigation verbs
- [ ] `browser-action-result` round-trips: browser → ws.go → daemon → broadcast (no more `"unknown action"` rejection)
- [ ] `handleLayoutCommand` performs real dockview create/rename/close/switch operations

### Browser validation (manual / E2E — recommended before declaring done)

The Go and TS unit gates do **not** exercise the shim in a real browser. Before merging, run a browser-driven check (mirror Phase 1's validation and the `playwright-cli` harness in `web/e2e/`): load a `/p/` page, postMessage a `{type:'mux-snapshot', action:'snapshot', cid:1}`, and confirm a `mux-snapshot-result` with a non-empty `snapshot` comes back; then exercise one `click` and one `go-back`. See the `/muxterm-verify` skill for the house verification workflow.
