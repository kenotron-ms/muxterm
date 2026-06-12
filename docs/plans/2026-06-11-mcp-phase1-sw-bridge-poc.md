# MCP Phase 1 — SW Bridge POC Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Validate the highest-uncertainty component of the muxterm MCP agent workbench — the Service Worker (SW) bridge — with a completely standalone Go HTTP server before investing in the full MCP server.

**Architecture:** A single self-contained `cmd/bridge-poc/main.go` serves a parent HTML page, an embedded iframe test page, a second navigation page, and a service worker — all as inline strings. The Go server injects a SW-registration snippet and a postMessage "page shim" into every HTML response under `/p/`. Manual browser testing proves three things: (1) the SW registers under scope `/p/`, (2) a `postMessage` round-trip from parent → shim → DOM action → result works, and (3) `history.back()` driven from inside the shim navigates correctly and the SW's `fetch` event records the URL.

**Tech Stack:** Go (`net/http` + `strings` only — no external deps, no muxterm internal imports), plain HTML/JS served inline. Verification is **manual browser testing** (no automated tests for this POC).

---

## READ THIS FIRST — Orientation for the implementer

You know nothing about this codebase. That is fine — this POC is deliberately isolated from it. Here is everything you need.

### What this POC is (and is not)

This is a **throwaway validation harness**, not production code. Its only job is to de-risk the SW bridge design described in `docs/designs/2026-06-11-muxterm-mcp-agent-workbench-design.md` (read its "Testing Strategy" and "Data Flow → Browser Pane SW Bridge" sections before starting). If this POC works, the full MCP server build proceeds. If it fails, the design pivots to a "hidden iframe persistence" fallback.

The full MCP design routes browser commands like this:

```
MCP → WS → HTTP server → browser WS client
  → iframe.contentWindow.postMessage(command)
  → page shim receives, executes (click, fill, query...)
  → window.parent.postMessage(result)
  → browser WS client → HTTP server → WS → MCP
```

This POC strips out the MCP server, the WebSocket layer, and muxterm entirely. It keeps **only the uncertain middle**: parent page ↔ iframe shim postMessage relay, plus the SW under scope `/p/`. The parent page's buttons stand in for "MCP commands"; the `<pre id="result">` stands in for "result flows back to MCP".

### The single file you will create

- `cmd/bridge-poc/main.go` — a Go `package main` with a `main()` that starts an `http.Server` on `:9099` and registers four handlers. **All HTML/JS is inline Go string literals.** No static file serving, no templates, no embed. No imports beyond the standard library (`net/http`, `strings`, `log`).

### Facts that will save you time

1. **Module path is `github.com/user/muxterm`** (from `go.mod`), but this POC imports **nothing** from it. It is standalone. The build command `go build ./cmd/bridge-poc` works because `cmd/` already exists as a sibling to `cmd/muxterm`.
2. **Service workers require a secure context.** `http://localhost` and `http://127.0.0.1` count as secure contexts in all modern browsers, so SW registration works over plain HTTP on localhost — no TLS needed. Use `http://localhost:9099`, NOT the LAN IP.
3. **SW scope is enforced by the script's served path AND the `scope` option.** Serving the SW at `/p/sw.js` lets it claim scope `/p/`. If the SW were served from `/sw.js` it could not claim `/p/` without a `Service-Worker-Allowed` header. We serve it at `/p/sw.js` precisely to avoid that.
4. **The shim and SW registration are INJECTED by Go**, not written into the page HTML. This mirrors the production design where the Go proxy injects them into every HTML response under `/p/`. The injection is plain string replacement (insert before `</head>` and before `</body>`).
5. **`Content-Type` matters.** The SW must be served as `application/javascript` or the browser refuses to register it. HTML pages must be served as `text/html`.

### Build gate (replaces `npm run check:fast` for Go code)

After every code task, run:
```
go build ./cmd/bridge-poc
```
Expected: no output, exit 0. This is the Go equivalent of the type/lint gate. There is no `go test` for this POC.

### How to manually verify (you will do this in Task 5)

1. Run `go run ./cmd/bridge-poc` in one terminal. It prints `bridge-poc listening on http://localhost:9099`.
2. Open `http://localhost:9099` in Chrome (or any Chromium browser).
3. Open DevTools → Application → Service Workers, and the Console tab.
4. Exercise the three buttons and check the four success criteria (detailed in Task 5).

### Commit style

Conventional commits. There is exactly **one** commit for this POC, at the end of Task 5, after manual verification passes:
```
feat: add SW bridge POC for MCP agent workbench validation
```
(Tasks 1–4 build up `main.go` incrementally; do not commit until the POC is verified working in Task 5. This keeps a throwaway POC to a single clean commit.)

---

## Task 1: Create the Go server scaffold with four route handlers

**Files:**
- Create: `cmd/bridge-poc/main.go`

**Step 1: Create the file with the server skeleton and the parent page.**

This step stands up the HTTP server, the `/` parent page (complete and final — it does not change in later tasks), and **placeholder** handlers for `/p/`, `/p/page2`, and `/p/sw.js` that we flesh out in Tasks 2–4. The parent page's buttons target the iframe's `contentWindow` via `postMessage`, and a `message` listener renders whatever comes back into `<pre id="result">`.

Create `cmd/bridge-poc/main.go` with exactly this content:

```go
// Command bridge-poc is a standalone validation harness for the muxterm MCP
// agent workbench SW bridge. It depends on NOTHING in muxterm — just the Go
// standard library. Run it with `go run ./cmd/bridge-poc` and open
// http://localhost:9099 to manually verify the three SW-bridge behaviors
// described in docs/designs/2026-06-11-muxterm-mcp-agent-workbench-design.md.
//
// THROWAWAY POC. Not production code. All HTML/JS is inline below.
package main

import (
	"log"
	"net/http"
	"strings"
)

const addr = "localhost:9099"

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/", handleParent)
	mux.HandleFunc("/p/", handleProxied) // matches /p/ and /p/page2
	mux.HandleFunc("/p/sw.js", handleServiceWorker)

	log.Printf("bridge-poc listening on http://%s", addr)
	// nosec: localhost-only throwaway POC, no timeouts needed.
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("bridge-poc: %v", err)
	}
}

// handleParent serves the top-level page at "/". It hosts the iframe pointed at
// /p/ and three buttons that postMessage commands into the iframe, plus a
// result area that renders messages received back from the iframe. This stands
// in for the MCP server issuing commands and reading results.
func handleParent(w http.ResponseWriter, r *http.Request) {
	// "/" is registered as a catch-all; reject anything we did not expect so a
	// stray request does not silently get the parent page.
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(parentHTML))
}

const parentHTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>bridge-poc parent</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 20px; }
    iframe { width: 600px; height: 200px; border: 2px solid #888; }
    button { font-size: 14px; padding: 6px 12px; margin-right: 8px; }
    pre { background: #1a1b26; color: #c0caf5; padding: 12px; border-radius: 6px; min-height: 60px; }
    .controls { margin: 12px 0; }
  </style>
</head>
<body>
  <h2>SW Bridge POC — parent page</h2>
  <iframe name="bridge-frame" id="bridge-frame" src="/p/"></iframe>
  <div class="controls">
    <button id="btn-query">Query H1</button>
    <button id="btn-goto">Go to page2</button>
    <button id="btn-back">History Back</button>
  </div>
  <p>Result received from iframe:</p>
  <pre id="result">(no message yet)</pre>

  <script>
    var frame = document.getElementById('bridge-frame');

    function send(msg) {
      frame.contentWindow.postMessage(msg, '*');
    }

    document.getElementById('btn-query').addEventListener('click', function () {
      send({ type: 'query', selector: 'h1' });
    });
    document.getElementById('btn-goto').addEventListener('click', function () {
      send({ type: 'goto', url: '/p/page2' });
    });
    document.getElementById('btn-back').addEventListener('click', function () {
      send({ type: 'history-back' });
    });

    // Render whatever the iframe posts back. This is the "result flows back to
    // MCP" leg of the round-trip.
    window.addEventListener('message', function (e) {
      document.getElementById('result').textContent = JSON.stringify(e.data, null, 2);
    });
  </script>
</body>
</html>`

// handleProxied serves the embedded test pages under /p/. In the real design
// this is a reverse proxy that injects the SW registration + page shim into
// every HTML response. Here we serve fixed page bodies and inject the same way.
// Fleshed out in Tasks 2 and 3.
func handleProxied(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte("<!DOCTYPE html><html><head></head><body>placeholder</body></html>"))
}

// handleServiceWorker serves the bridge service worker at /p/sw.js so it can
// claim scope /p/. Fleshed out in Task 4.
func handleServiceWorker(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	_, _ = w.Write([]byte("// placeholder\n"))
}

// inject inserts headSnippet before </head> and bodySnippet before </body>.
// If the markers are missing it appends, so injection never silently no-ops.
// Used by handleProxied to add the SW registration and page shim to page HTML.
func inject(pageHTML, headSnippet, bodySnippet string) string {
	if strings.Contains(pageHTML, "</head>") {
		pageHTML = strings.Replace(pageHTML, "</head>", headSnippet+"\n</head>", 1)
	} else {
		pageHTML = headSnippet + pageHTML
	}
	if strings.Contains(pageHTML, "</body>") {
		pageHTML = strings.Replace(pageHTML, "</body>", bodySnippet+"\n</body>", 1)
	} else {
		pageHTML = pageHTML + bodySnippet
	}
	return pageHTML
}
```

**Step 2: Run the build gate.**

Run: `go build ./cmd/bridge-poc`
Expected: no output, exit 0.

> Note: `inject` is defined but not yet called — Go will NOT complain about an unused *function* (only unused imports and unused local variables error out). The build passes. `inject` gets wired up in Task 2.

**Step 3: Smoke-check the server starts and serves the parent page.**

Run (in background or a second shell):
```
go run ./cmd/bridge-poc &
sleep 1
curl -s http://localhost:9099/ | grep -c "SW Bridge POC"
```
Expected: prints `1` (the parent page HTML is served). Then stop the server:
```
kill %1 2>/dev/null || pkill -f bridge-poc
```

Do NOT commit yet — Task 5 holds the single commit for this POC.

---

## Task 2: Inject the SW registration snippet into /p/ HTML responses

**Files:**
- Modify: `cmd/bridge-poc/main.go`

**Step 1: Add the page-content constants and the SW-registration head snippet.**

Add these constants directly after the `parentHTML` const block (before `handleProxied`):

```go
// pageBodyP is the raw body of the /p/ test page, BEFORE injection. The Go
// server injects the SW registration (head) and the page shim (body) into it.
const pageBodyP = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>bridge-poc /p/</title>
</head>
<body>
  <h1>Test Page</h1>
  <p>This is the embedded test page.</p>
  <a href="/p/page2">Go to page 2</a>
</body>
</html>`

// pageBodyPage2 is the raw body of the /p/page2 test page, BEFORE injection.
// Used by the history.back() test: navigate here from /p/, then go back.
const pageBodyPage2 = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>bridge-poc /p/page2</title>
</head>
<body>
  <h1>Page 2</h1>
  <p>You navigated here. Use History Back to go back.</p>
</body>
</html>`

// swRegistrationSnippet registers the bridge SW under scope /p/. Injected into
// the <head> of every /p/ HTML response. Serving the SW from /p/sw.js lets it
// claim the /p/ scope without a Service-Worker-Allowed header.
const swRegistrationSnippet = `<script>
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/p/sw.js', { scope: '/p/' })
    .then(function (r) { console.log('[bridge-poc] SW registered', r.scope); })
    .catch(function (e) { console.error('[bridge-poc] SW registration failed', e); });
}
</script>`
```

**Step 2: Wire `handleProxied` to select the page body and inject the SW snippet.**

Replace the entire `handleProxied` function with:

```go
// handleProxied serves the embedded test pages under /p/, injecting the SW
// registration (head) and the page shim (body) into the HTML — mirroring the
// production proxy that injects both into every HTML response under /p/.
func handleProxied(w http.ResponseWriter, r *http.Request) {
	var body string
	switch r.URL.Path {
	case "/p/", "/p":
		body = pageBodyP
	case "/p/page2":
		body = pageBodyPage2
	default:
		http.NotFound(w, r)
		return
	}
	// Body snippet (the page shim) is added in Task 3; pass "" for now.
	out := inject(body, swRegistrationSnippet, "")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(out))
}
```

**Step 3: Run the build gate.**

Run: `go build ./cmd/bridge-poc`
Expected: no output, exit 0.

**Step 4: Verify the SW snippet is injected.**

Run:
```
go run ./cmd/bridge-poc &
sleep 1
curl -s http://localhost:9099/p/ | grep -c "serviceWorker.register"
kill %1 2>/dev/null || pkill -f bridge-poc
```
Expected: prints `1` — the SW registration script is now present in the `/p/` response, injected before `</head>`.

Do NOT commit yet.

---

## Task 3: Inject the page shim into /p/ HTML responses

**Files:**
- Modify: `cmd/bridge-poc/main.go`

**Step 1: Add the page-shim body snippet constant.**

Add this constant directly after `swRegistrationSnippet`:

```go
// pageShimSnippet is the postMessage bridge injected into the <body> of every
// /p/ HTML response. On load it announces 'shim-ready' to the parent, then
// listens for commands and executes them inside the frame's browsing context:
//   - {type:'query', selector}  -> reads textContent, posts 'query-result' back
//   - {type:'goto', url}        -> navigates the frame (drives the SW fetch event)
//   - {type:'history-back'}     -> window.history.back() (same-origin from here,
//                                  so NO allow-same-origin sandbox flag needed)
// This is the exact mechanism the production browser tools route through.
const pageShimSnippet = `<script>
(function () {
  window.addEventListener('message', function (e) {
    var cmd = e.data;
    if (!cmd || !cmd.type) return;

    if (cmd.type === 'query') {
      var el = document.querySelector(cmd.selector);
      window.parent.postMessage(
        { type: 'query-result', selector: cmd.selector, text: el ? el.textContent : null },
        '*'
      );
    }
    if (cmd.type === 'goto') {
      window.location.href = cmd.url;
    }
    if (cmd.type === 'history-back') {
      window.history.back();
      window.parent.postMessage({ type: 'history-back-called' }, '*');
    }
  });
  // Announce readiness so the parent knows the bridge is live for this page.
  window.parent.postMessage({ type: 'shim-ready', url: window.location.href }, '*');
})();
</script>`
```

**Step 2: Pass the shim snippet into the injection call.**

In `handleProxied`, replace this line:

```go
	out := inject(body, swRegistrationSnippet, "")
```

with:

```go
	out := inject(body, swRegistrationSnippet, pageShimSnippet)
```

**Step 3: Run the build gate.**

Run: `go build ./cmd/bridge-poc`
Expected: no output, exit 0.

**Step 4: Verify the shim is injected into both pages.**

Run:
```
go run ./cmd/bridge-poc &
sleep 1
echo "p/:      $(curl -s http://localhost:9099/p/ | grep -c shim-ready)"
echo "p/page2: $(curl -s http://localhost:9099/p/page2 | grep -c shim-ready)"
kill %1 2>/dev/null || pkill -f bridge-poc
```
Expected: both lines print `1` — the shim is injected before `</body>` in both `/p/` and `/p/page2`.

Do NOT commit yet.

---

## Task 4: Implement the service worker script

**Files:**
- Modify: `cmd/bridge-poc/main.go`

**Step 1: Add the service worker source constant.**

Add this constant directly after `pageShimSnippet`:

```go
// serviceWorkerJS is the bridge SW served at /p/sw.js (scope /p/). It records
// every navigation URL via the fetch event so the MCP server can know the
// current URL per pane without polling. skipWaiting + clients.claim make it
// take control immediately on first load (no second refresh needed). It does
// NOT intercept responses — it observes and lets requests pass through.
const serviceWorkerJS = `// Bridge SW — scope: /p/
var navigations = [];

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function (e) {
  if (e.request.mode === 'navigate') {
    navigations.push(e.request.url);
    console.log('[bridge-poc sw] navigate', e.request.url, 'total:', navigations.length);
  }
  // Do not intercept — let requests through untouched.
});`
```

**Step 2: Wire `handleServiceWorker` to serve it.**

Replace the entire `handleServiceWorker` function with:

```go
// handleServiceWorker serves the bridge SW at /p/sw.js so it can claim scope
// /p/. The application/javascript content type is required or the browser
// refuses to register the worker.
func handleServiceWorker(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	// No-cache so re-runs during POC iteration always serve the latest SW.
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write([]byte(serviceWorkerJS))
}
```

> Route precedence note: `mux.HandleFunc("/p/sw.js", ...)` is a more specific pattern than `"/p/"`, so Go's `ServeMux` routes `/p/sw.js` to `handleServiceWorker` and everything else under `/p/` to `handleProxied`. No change to `main()` is needed.

**Step 3: Run the build gate.**

Run: `go build ./cmd/bridge-poc`
Expected: no output, exit 0.

**Step 4: Verify the SW is served with the correct content type.**

Run:
```
go run ./cmd/bridge-poc &
sleep 1
curl -s -D - http://localhost:9099/p/sw.js -o /tmp/sw.js | grep -i "content-type"
grep -c "addEventListener('fetch'" /tmp/sw.js
kill %1 2>/dev/null || pkill -f bridge-poc
```
Expected: the header line shows `Content-Type: application/javascript; charset=utf-8`, and the grep prints `1` (the fetch listener is present).

Do NOT commit yet — proceed to manual verification in Task 5.

---

## Task 5: Manual browser verification + commit

**Files:** none (verification + the single commit for this POC).

This POC's correctness can only be confirmed in a real browser — the SW registration, postMessage relay, and `history.back()` behaviors do not show up in `curl`. Follow these steps exactly.

**Step 1: Start the server.**

In one terminal:
```
go run ./cmd/bridge-poc
```
Expected: prints `bridge-poc listening on http://localhost:9099`. Leave it running.

**Step 2: Open the page and DevTools.**

Open `http://localhost:9099` in Chrome (or any Chromium browser). Open DevTools (F12). Keep two panels handy:
- **Application → Service Workers**
- **Console**

> Use `localhost`, NOT a LAN IP — service workers require a secure context, and `localhost` qualifies while a bare IP does not.

**Step 3: Success Criterion 1 — SW registers under scope `/p/`.**

After the iframe loads, look at DevTools → Application → Service Workers.
- **Expected:** an entry for `sw.js` with **Scope** `http://localhost:9099/p/` and status "activated and is running".
- **Expected (Console):** a log line `[bridge-poc] SW registered http://localhost:9099/p/`.
- The `<pre id="result">` may already show a `shim-ready` message — that confirms the shim announced itself on load.

**Step 4: Success Criterion 2 — postMessage round-trip (query → DOM action → result).**

Click the **"Query H1"** button.
- **Expected:** `<pre id="result">` shows:
  ```json
  {
    "type": "query-result",
    "selector": "h1",
    "text": "Test Page"
  }
  ```
This proves: parent → `postMessage` → shim received it → shim read the DOM (`querySelector('h1').textContent`) → posted the result back → parent rendered it. This is the full bridge round-trip.

**Step 5: Success Criterion 3 — `history.back()` from the shim + SW fetch recording.**

1. Click **"Go to page2"**.
   - **Expected:** the iframe content changes to "Page 2 / You navigated here...".
   - **Expected (Console):** a SW log `[bridge-poc sw] navigate http://localhost:9099/p/page2 total: N`.
2. Click **"History Back"**.
   - **Expected:** the iframe returns to the original "Test Page" content.
   - **Expected (`result`):** shows `{ "type": "history-back-called" }`.
   - **Expected (Console):** another SW `navigate` log line for the back navigation to `http://localhost:9099/p/`.

This proves: `window.history.back()` called from inside the shim navigates correctly (no `allow-same-origin` sandbox flag was needed), AND the SW's `fetch` event fires on navigations and records the URL — exactly what the production design relies on to track the current URL per pane.

**Step 6: Success Criterion 4 — no errors.**

Scan the Console.
- **Expected:** no red error entries. Only the `[bridge-poc]` and `[bridge-poc sw]` info logs.
- A benign note: after the very first load you may need ONE refresh for the SW to be "activated and running" if your browser shows it as "waiting" — but `skipWaiting()` + `clients.claim()` should make it active on first load. If criteria 2–3 pass, the SW is working regardless.

**Step 7: If any criterion fails, debug — do not commit a broken POC.**

- **SW does not register / wrong scope** → confirm `/p/sw.js` is served with `Content-Type: application/javascript` (Task 4, Step 4) and that the registration `scope` is `/p/`. Check the Console for the `SW registration failed` line and read the error.
- **"Query H1" does nothing / result stays "(no message yet)"** → confirm the shim is injected (`curl -s http://localhost:9099/p/ | grep shim-ready` prints a match). Check the Console for a postMessage or cross-origin error. Confirm the iframe `src` is `/p/` (same origin as the parent — it must be, since both are served from `:9099`).
- **"History Back" does not navigate** → confirm page2 actually loaded first (Criterion 3 step 1). Confirm the shim's `history-back` branch calls `window.history.back()`.
- **No SW `navigate` logs** → the SW may not be controlling the frame yet; do one hard refresh (Cmd/Ctrl+Shift+R) and retry. If logs still never appear, the `fetch` listener or `clients.claim()` is the suspect.

Fix the Go source and re-run `go build ./cmd/bridge-poc`, restart the server, and re-verify. Do not weaken a criterion to make it "pass."

**Step 8: Commit the working POC (single commit).**

Once all four criteria pass:
```
go build ./cmd/bridge-poc
git add cmd/bridge-poc/main.go
git commit -m "feat: add SW bridge POC for MCP agent workbench validation"
```

**Step 9: Report the outcome.**

Summarize the four criteria (pass/fail) and the verdict:
- **All pass →** the SW bridge design is validated. Per the parent instruction, proceed directly to the Phase 2 plan (server-side foundations) without pausing for approval.
- **Any fail that cannot be fixed →** the SW bridge approach is not viable as designed. Stop, report which criterion failed and the observed behavior, and flag that the design should pivot to the "hidden iframe persistence" fallback (see the design doc's "Open Questions" section) before Phase 2.

---

## Done criteria

- [ ] `cmd/bridge-poc/main.go` exists, is standalone (no muxterm imports, stdlib only), and `go build ./cmd/bridge-poc` passes.
- [ ] The Go server serves `/`, `/p/`, `/p/page2`, and `/p/sw.js` with correct content types.
- [ ] The SW registration snippet and the page shim are injected into every `/p/` HTML response.
- [ ] **Criterion 1:** SW registers under scope `http://localhost:9099/p/`.
- [ ] **Criterion 2:** "Query H1" round-trips and shows `{type:"query-result", selector:"h1", text:"Test Page"}`.
- [ ] **Criterion 3:** "Go to page2" then "History Back" navigate correctly and the SW logs both `navigate` events.
- [ ] **Criterion 4:** no console errors.
- [ ] Single commit `feat: add SW bridge POC for MCP agent workbench validation` lands only after all criteria pass.
- [ ] Outcome reported with the proceed-to-Phase-2 vs. pivot-to-fallback verdict.
```