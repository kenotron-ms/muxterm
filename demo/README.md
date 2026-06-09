# muxterm browser tab demo — live status board

A self-contained demo that exercises the muxterm browser-tab proxy end-to-end:
HTTP proxying, WebSocket bridging, HMR, pane persistence, and multi-client sync.

## What this is

**Backend** (`demo/backend/`) runs on port **9002** using **Express + ws**.  
It exposes two endpoints:

- `GET /api/items` — returns the current status-board items as JSON
- `/ws` — WebSocket feed; sends a snapshot on connect, then pushes a new status item every 3 seconds

**Frontend** (`demo/frontend/`) is a Vite + TypeScript SPA served on port **5173**.  
It deliberately uses **absolute `localhost` URLs** (`http://localhost:9002/api/items`,
`ws://localhost:9002/ws`) so the muxterm proxy must rewrite them — this validates
that the proxy shim correctly intercepts `fetch`, `XHR`, and `WebSocket` calls and
routes them through `/p/9002/`.

The two-service split is intentional: a real developer's app almost never serves
its API and frontend from the same origin.

## Start the demo

```bash
# 1. Start the backend
cd demo/backend && npm start
# → [demo backend] listening on http://localhost:9002

# 2. Start the frontend dev server
cd demo/frontend && npm run dev
# → Local: http://localhost:5173/

# 3. Start muxterm (sessiond + frontend)
muxterm local

# 4. Open a browser pane pointed at the frontend
muxterm open-browser 5173
```

After step 4 you should see a new Browser tab appear inside muxterm with the
live status board loaded via the proxy.

## What to verify

| Scenario | What it proves |
|---|---|
| Page loads without errors | HTTP proxy correctly forwards requests from `/p/5173/` to `localhost:5173` |
| New items appear every 3 s | WebSocket proxy bridges `ws://localhost:9002/ws` through muxterm's `/p/9002/ws` |
| Edit a source file and save → UI updates instantly | HMR WebSocket survives proxy round-trip; shim does not break Vite's hot-reload channel |
| Close the browser pane, reopen muxterm, pane is back | Browser pane state is stored server-side like terminal panes — survives client disconnect |
| Open a second browser window/tab → both show the same board in sync | sessiond broadcasts state; two clients see identical pane composition |

## Running backend tests

```bash
cd demo/backend && npm test
```

Tests use a dynamically-allocated free port so they pass even when port 9002 is
occupied by a running demo server.

## Agent-driven workflow

Agents running in muxterm terminals can automate the open-browser step by watching
`npm run dev` stdout:

```
$ npm run dev
  VITE v5.x  ready in 312 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
```

The agent detects the port (`5173`) from that output and calls:

```bash
muxterm open-browser 5173
```

No hardcoded port required — the agent reads the actual port Vite chose.

## Sharp edges

**SPA pushState refresh 404**  
If the user navigates to a client-side route (e.g. `/settings`) and then
reloads the page, the proxy forwards `GET /p/5173/settings` to
`localhost:5173/settings`, which returns 404 because Vite only serves `index.html`
at the root.  
*Workaround*: use hash routing (`/#/settings`) in the demo app so deep-link
refreshes always hit `GET /p/5173/` → `index.html`.

**`document.cookie` isolation**  
Cookies set by the proxied app live on the muxterm origin, not `localhost:5173`.
This means `document.cookie` reads in the app's JS see muxterm cookies, not
app-specific ones.  Any demo code that relies on cookies for state (e.g. a
session cookie) will not work as expected through the proxy.  Use `localStorage`
or `sessionStorage` instead for demo-only state.

---

Full design: [`docs/plans/2026-06-08-browser-tab-implementation-design.md`](../docs/plans/2026-06-08-browser-tab-implementation-design.md)
