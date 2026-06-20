# Browser CDP Pane — Phase 2: Frontend Implementation

> **For execution:** Use `/execute-plan` mode or the subagent-driven-development recipe.

**Goal:** Build the TypeScript/Lit frontend for the browser CDP pane: a dedicated `/ws/browser` WebSocket client, a browser pane registry, and the complete `<mux-browser-pane>` Lit component with canvas rendering, a Chrome-like toolbar, and full mouse/keyboard relay.

**Architecture:** A dedicated `BrowserSocket` singleton connects to `/ws/browser` (separate from the main `/ws` to prevent JPEG frames from delaying keystrokes). A `browserRegistry` module-level singleton routes incoming frames and events to the correct `<mux-browser-pane>` Lit element. `mux-dock.ts` registers a `BrowserRenderer` dockview component factory that mounts `<mux-browser-pane>` for `surfaceKind: "browser-cdp"` panes. `app.ts` wires the registry into the composition handler and sync loop.

**Tech Stack:** TypeScript (strict), Lit v3 (`@customElement`, `@property`, `@state`, `@query`), CSS custom properties (zero hardcoded colors), WebSocket binary framing (4-byte LE pane ID + JPEG), dockview-core `IContentRenderer`.

**Verification:** Per-task: `cd web && npm run check:fast` (0 errors — tsgo + oxlint). Final task: agent-driven browser E2E using playwright-cli with semantic acceptance criteria.

**No unit tests.** This project uses verification-driven development: write code → `npm run check:fast` → commit.

**Assumes:** Phase 1 (Go backend) is complete. Task 1 (types.ts changes) is already on `main` as commit `2b0d601`. The worktree at `.worktrees/feat-browser-cdp-pane` needs to be rebased from main before work begins.

---

## Commit footer (every commit)

Every commit in this plan must end with:

```
🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
```

---

## Per-task verification command

After every code change, run:

```bash
cd web && npm run check:fast
```

Expected: `0 errors` from tsgo, warnings from oxlint are OK. Any error = fix before committing.

---

## Codebase patterns (read before writing tasks)

- **Import style:** use `.js` extensions on ALL relative imports (e.g. `'../lib/browser-registry.js'`, not `.ts`)
- **Lit v3:** `@customElement`, `@property`, `@state`, `@query`, `html\`\``, `css\`\``
- **Singleton pattern:** see `web/src/lib/terminal-registry.ts` — module-level `const _map` + exported singleton object
- **WebSocket client pattern:** see `web/src/ws.ts` — `MuxSocket` class with `connect()`/`disconnect()`, exponential backoff reconnect, `sendSessiond()` private method
- **IContentRenderer pattern:** see `TerminalRenderer` class in `web/src/components/mux-dock.ts`
- **Action button pattern:** see `mux-dock-bar.ts` — `@customElement('mux-dock-bar')`, `store.subscribe()` for reactive state
- **No `any` types** unless absolutely unavoidable (use `unknown` + type narrowing)

---

## Task 1: Rebase worktree from main (types.ts for free)

**Context:** Task 1 from the original plan (types.ts changes) is already committed on `main` as `2b0d601`. The worktree just needs to rebase. No new code to write.

**Files:** None to create or modify.

**Step 1: Navigate to the worktree and rebase**

```bash
cd .worktrees/feat-browser-cdp-pane
git rebase main
```

If there are no conflicts, the rebase applies cleanly. If there are conflicts (unexpected), resolve them following standard git conflict resolution.

**Step 2: Verify**

```bash
cd web && npm run check:fast
```

Expected: `0 errors`. The types.ts changes from `2b0d601` are now in the worktree.

**No commit needed** — the rebase brings existing commits from main.

---

## Task 2: Create `web/src/lib/ws-browser.ts`

**Files:**
- Create: `web/src/lib/ws-browser.ts`

**Step 1: Write the file**

```typescript
/**
 * ws-browser — dedicated WebSocket client for /ws/browser.
 *
 * Separate from the main /ws connection so JPEG frame bursts never delay
 * terminal keystrokes (WebSocket over TCP is an ordered stream).
 *
 * Wire protocol (server → client):
 *   Binary: [4-byte LE paneId][raw JPEG bytes] — screencast frame
 *   JSON:   {type: "browser-url", paneId, url}
 *           {type: "browser-download-progress", paneId, percent}
 *           {type: "browser-error", paneId, error}
 *           {type: "browser-status", paneId, text}
 *
 * Wire protocol (client → server):
 *   JSON:   {type: "browser-input", paneId, event: {...}}
 */

const BACKOFF_BASE = 1000;
const BACKOFF_CAP = 30000;
const JITTER_MAX = 500;

export class BrowserSocket {
  private _ws: WebSocket | null = null;
  private _url: string;
  private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private _reconnectAttempts = 0;
  private _intentionalClose = false;

  /** Called when a JPEG frame arrives. paneId identifies the browser pane. */
  onFrame: ((paneId: number, jpegBytes: Uint8Array) => void) | null = null;
  /** Called when the browser navigates to a new URL. */
  onBrowserUrl: ((paneId: number, url: string) => void) | null = null;
  /** Called during Chromium download with 0–100 progress. */
  onDownloadProgress: ((paneId: number, percent: number) => void) | null = null;
  /** Called when the browser pane encounters an error. */
  onBrowserError: ((paneId: number, error: string) => void) | null = null;
  /** Called with the URL of the link currently under the cursor (empty = no link). */
  onBrowserStatus: ((paneId: number, text: string) => void) | null = null;

  onDisconnect: (() => void) | null = null;
  onReconnect: (() => void) | null = null;

  constructor(url: string) {
    this._url = url;
  }

  connect(): void {
    this._intentionalClose = false;
    this._reconnectAttempts = 0;
    this._open();
  }

  disconnect(): void {
    this._intentionalClose = true;
    if (this._reconnectTimer !== undefined) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
    if (this._ws) {
      this._ws.close(1000);
      this._ws = null;
    }
  }

  /** Send a browser-input JSON message upstream. No-op when not connected. */
  send(msg: object): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }

  get connected(): boolean {
    return this._ws?.readyState === WebSocket.OPEN;
  }

  private _scheduleReconnect(): void {
    const delay = Math.min(BACKOFF_BASE * 2 ** this._reconnectAttempts, BACKOFF_CAP);
    const jitter = Math.random() * JITTER_MAX;
    this._reconnectAttempts++;
    this._reconnectTimer = setTimeout(() => this._open(), delay + jitter);
  }

  private _open(): void {
    const ws = new WebSocket(this._url);
    ws.binaryType = 'arraybuffer';
    this._ws = ws;

    ws.onopen = () => {
      this._reconnectAttempts = 0;
      this.onReconnect?.();
    };

    ws.onmessage = (ev: MessageEvent) => {
      // Binary frame: [4-byte LE paneId][raw JPEG bytes]
      if (ev.data instanceof ArrayBuffer) {
        if (ev.data.byteLength >= 4) {
          const view = new DataView(ev.data);
          const paneId = view.getUint32(0, /* littleEndian */ true);
          const jpegBytes = new Uint8Array(ev.data, 4);
          this.onFrame?.(paneId, jpegBytes);
        }
        return;
      }
      // JSON text frame
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data) as Record<string, unknown>;
          const type = msg['type'];
          const paneId = typeof msg['paneId'] === 'number' ? msg['paneId'] : 0;
          if (type === 'browser-url' && typeof msg['url'] === 'string') {
            this.onBrowserUrl?.(paneId, msg['url']);
          } else if (type === 'browser-download-progress' && typeof msg['percent'] === 'number') {
            this.onDownloadProgress?.(paneId, msg['percent']);
          } else if (type === 'browser-error' && typeof msg['error'] === 'string') {
            this.onBrowserError?.(paneId, msg['error']);
          } else if (type === 'browser-status' && typeof msg['text'] === 'string') {
            this.onBrowserStatus?.(paneId, msg['text']);
          }
        } catch {
          // Malformed JSON — ignore silently
        }
      }
    };

    ws.onclose = (ev: CloseEvent) => {
      if (ev.code === 1000 || this._intentionalClose) return;
      this.onDisconnect?.();
      this._scheduleReconnect();
    };

    ws.onerror = () => {
      // no-op — onclose fires after onerror
    };
  }
}

/** Build the /ws/browser WebSocket URL from the current page origin. */
export function buildWsBrowserUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/browser`;
}

/**
 * Module-level singleton. Call wsBrowser.connect() from app.ts connectedCallback
 * (alongside the main socket) and wsBrowser.disconnect() from disconnectedCallback.
 */
export const wsBrowser = new BrowserSocket(buildWsBrowserUrl());
```

**Step 2: Verify**

```bash
cd web && npm run check:fast
```

Expected: `0 errors`.

**Step 3: Commit**

```bash
cd .worktrees/feat-browser-cdp-pane
git add web/src/lib/ws-browser.ts
git commit -m "feat: add BrowserSocket — dedicated /ws/browser WebSocket client

Separate connection from main /ws prevents JPEG frames from queuing
behind terminal keystrokes. Auto-reconnects with exponential backoff
(same policy as MuxSocket). Parses binary [paneId][JPEG] frames and
browser-url/browser-download-progress/browser-error/browser-status
JSON messages.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 3: Create `web/src/lib/browser-registry.ts`

**Files:**
- Create: `web/src/lib/browser-registry.ts`

**Step 1: Write the file**

```typescript
/**
 * browser-registry — per-pane callback routing for browser CDP panes.
 *
 * Module-level singleton that mirrors the terminal-registry pattern but
 * is much simpler: no xterm.js, no settle/drain complexity, no scrollback.
 * Each <mux-browser-pane> element registers callbacks here; the BrowserSocket
 * calls write() / dispatchUrl() / etc. to fan out events.
 */

export interface BrowserPaneCallbacks {
  /** Called when a new JPEG frame arrives for this pane. */
  onFrame: ((jpegBytes: Uint8Array) => void) | null;
  /** Called when the browser navigates to a new URL. */
  onUrl: ((url: string) => void) | null;
  /** Called when a browser error occurs. */
  onError: ((error: string) => void) | null;
  /** Called with download progress (0–100) while Chromium downloads. */
  onDownload: ((percent: number) => void) | null;
  /** Called with the URL of the link currently under the cursor (empty string = no link). */
  onStatus: ((statusText: string) => void) | null;
}

const _map = new Map<number, BrowserPaneCallbacks>();

export const browserRegistry = {
  /**
   * Idempotent: creates a callback slot for paneId if one doesn't exist.
   * Call for every browser-cdp pane in the composition (from app.ts).
   */
  ensure(paneId: number): void {
    if (_map.has(paneId)) return;
    _map.set(paneId, { onFrame: null, onUrl: null, onError: null, onDownload: null, onStatus: null });
  },

  /**
   * Register callbacks for a pane. Called by <mux-browser-pane> in
   * connectedCallback. Passing null for a callback clears it.
   */
  setCallbacks(paneId: number, cbs: Partial<BrowserPaneCallbacks>): void {
    let entry = _map.get(paneId);
    if (!entry) {
      entry = { onFrame: null, onUrl: null, onError: null, onDownload: null, onStatus: null };
      _map.set(paneId, entry);
    }
    if (cbs.onFrame !== undefined) entry.onFrame = cbs.onFrame;
    if (cbs.onUrl !== undefined) entry.onUrl = cbs.onUrl;
    if (cbs.onError !== undefined) entry.onError = cbs.onError;
    if (cbs.onDownload !== undefined) entry.onDownload = cbs.onDownload;
    if (cbs.onStatus !== undefined) entry.onStatus = cbs.onStatus;
  },

  /** Route an incoming JPEG frame to the registered pane element. */
  write(paneId: number, jpegBytes: Uint8Array): void {
    _map.get(paneId)?.onFrame?.(jpegBytes);
  },

  /** Route a browser-url message to the registered pane element. */
  dispatchUrl(paneId: number, url: string): void {
    _map.get(paneId)?.onUrl?.(url);
  },

  /** Route a browser-error message to the registered pane element. */
  dispatchError(paneId: number, error: string): void {
    _map.get(paneId)?.onError?.(error);
  },

  /** Route a browser-download-progress message to the registered pane. */
  dispatchDownload(paneId: number, percent: number): void {
    _map.get(paneId)?.onDownload?.(percent);
  },

  /** Route a browser-status message to the registered pane element. */
  dispatchStatus(paneId: number, statusText: string): void {
    _map.get(paneId)?.onStatus?.(statusText);
  },

  /**
   * Remove entries for pane IDs no longer in the live composition.
   * Call after terminalRegistry.prune() with the same liveIds set.
   */
  prune(liveIds: Set<number>): void {
    for (const paneId of _map.keys()) {
      if (!liveIds.has(paneId)) {
        // Clear callbacks before deleting so any in-flight async frame
        // dispatch from BrowserSocket is a no-op rather than a stale call.
        const entry = _map.get(paneId);
        if (entry) {
          entry.onFrame = null;
          entry.onUrl = null;
          entry.onError = null;
          entry.onDownload = null;
          entry.onStatus = null;
        }
        _map.delete(paneId);
      }
    }
  },

  /** Whether a callback slot exists for paneId. */
  has(paneId: number): boolean {
    return _map.has(paneId);
  },
};
```

**Step 2: Verify**

```bash
cd web && npm run check:fast
```

Expected: `0 errors`.

**Step 3: Commit**

```bash
cd .worktrees/feat-browser-cdp-pane
git add web/src/lib/browser-registry.ts
git commit -m "feat: add browserRegistry — per-pane callback routing for CDP panes

Module-level singleton (mirrors terminal-registry pattern). Routes
incoming JPEG frames, URL updates, errors, download progress, and
status text from BrowserSocket to the correct <mux-browser-pane>
element via registered callbacks. Simpler than terminalRegistry:
no xterm, no settle/drain, no scrollback.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 4: Create complete `web/src/components/mux-browser-pane.ts`

Write the ENTIRE component in one task. This synthesizes what was previously Tasks 4–11. Do not split into multiple files or incremental patches.

**Files:**
- Create: `web/src/components/mux-browser-pane.ts`

**Step 1: Write the complete file**

```typescript
import { LitElement, html, css } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { browserRegistry } from '../lib/browser-registry.js';
import { wsBrowser } from '../lib/ws-browser.js';
import { SessiondType } from '../types.js';

/**
 * <mux-browser-pane> — canvas-based browser pane using CDP screen capture.
 *
 * Receives JPEG frames from the BrowserSocket via browserRegistry callbacks,
 * renders them onto a <canvas>, and relays mouse/keyboard events back as
 * browser-input JSON messages. One instance per browser-cdp pane in dockview.
 *
 * Lifecycle:
 *   - Mounted by BrowserRenderer (mux-dock.ts) when a browser-cdp pane appears
 *   - pane-id attribute is set by BrowserRenderer to the numeric pane ID
 *   - connectedCallback registers frame/url/error/download/status callbacks
 *   - disconnectedCallback clears those callbacks and cleans up timers
 */
@customElement('mux-browser-pane')
export class MuxBrowserPane extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: var(--chrome-body);
      overflow: hidden;
      position: relative;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 13px;
    }

    /* ── Toolbar ─────────────────────────────────────────────────────────── */

    .browser-toolbar {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 8px;
      height: 40px;
      background: var(--chrome-bar);
      border-bottom: 1px solid var(--chrome-border);
    }

    /* Circular ghost nav buttons */
    .nav-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      flex-shrink: 0;
      background: transparent;
      border: none;
      border-radius: 50%;
      color: var(--chrome-text-bright);
      cursor: pointer;
      padding: 0;
      transition: background 0.12s;
    }

    .nav-btn:hover { background: var(--chrome-hover); }
    .nav-btn:active { background: color-mix(in srgb, var(--chrome-hover) 150%, transparent); }

    .nav-btn svg {
      width: 16px;
      height: 16px;
      pointer-events: none;
    }

    /* Pill omnibox */
    .omnibox {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 6px;
      height: 28px;
      padding: 0 8px;
      background: var(--chrome-body);
      border: 1px solid var(--chrome-border);
      border-radius: 20px;
      overflow: hidden;
      cursor: text;
      transition: border-color 0.12s, box-shadow 0.12s;
    }

    .omnibox.editing {
      border-color: var(--chrome-accent);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--chrome-accent) 20%, transparent);
    }

    .lock-icon {
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }

    .lock-icon svg {
      width: 12px;
      height: 14px;
    }

    .lock-icon.https { color: var(--mux-ok); }
    .lock-icon.http  { color: var(--chrome-text-dim); }

    .url-host {
      color: var(--chrome-text-bright);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 240px;
      cursor: text;
    }

    .url-path {
      color: var(--chrome-text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      cursor: text;
    }

    .omni-gap { flex: 1; }

    /* Reload button — circular, sits INSIDE the pill on the right */
    .reload-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      flex-shrink: 0;
      background: transparent;
      border: none;
      border-radius: 50%;
      color: var(--chrome-text-dim);
      cursor: pointer;
      padding: 0;
      transition: color 0.12s, background 0.12s;
    }

    .reload-btn:hover {
      color: var(--chrome-text-bright);
      background: var(--chrome-hover);
    }

    .reload-btn svg {
      width: 14px;
      height: 14px;
      pointer-events: none;
    }

    /* URL input (edit mode) — fills the omnibox */
    .url-input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: var(--chrome-text-bright);
      font: inherit;
      font-size: 13px;
      min-width: 0;
    }

    /* FPS badge */
    .fps-badge {
      flex-shrink: 0;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-family: 'JetBrainsMonoNerdFont', 'SF Mono', monospace;
      background: color-mix(in srgb, var(--mux-ok) 15%, transparent);
      color: var(--mux-ok);
    }

    /* Live dot with glow */
    .live-dot {
      flex-shrink: 0;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--mux-ok);
      box-shadow: 0 0 4px var(--mux-ok);
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    /* ── Canvas area ──────────────────────────────────────────────────────── */

    .canvas-wrap {
      flex: 1;
      position: relative;
      overflow: hidden;
      background: var(--chrome-body);
    }

    canvas {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
      cursor: default;
      outline: none;
    }

    /* Status bar: link hover preview, Chrome-style */
    .status-bar {
      position: absolute;
      bottom: 0;
      left: 0;
      max-width: 60%;
      padding: 2px 10px;
      border-top-right-radius: 4px;
      background: var(--chrome-bar);
      border: 1px solid var(--chrome-border);
      border-bottom: none;
      border-left: none;
      color: var(--chrome-text-dim);
      font-size: 11px;
      opacity: 0;
      transition: opacity 0.15s;
      pointer-events: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-bar.visible { opacity: 1; }

    /* ── Overlays ─────────────────────────────────────────────────────────── */

    .download-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      background: color-mix(in srgb, var(--chrome-body) 90%, transparent);
      color: var(--chrome-text-dim);
      font-size: 14px;
    }

    .download-bar {
      width: 200px;
      height: 4px;
      background: var(--chrome-border);
      border-radius: 2px;
      overflow: hidden;
    }

    .download-fill {
      height: 100%;
      background: var(--mux-ok);
      border-radius: 2px;
      transition: width 0.3s ease;
    }

    .error-banner {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 8px 16px;
      background: color-mix(in srgb, var(--mux-error) 20%, var(--chrome-bar));
      border-top: 1px solid var(--mux-error);
      color: var(--mux-error);
      font-size: 12px;
    }
  `;

  /** Numeric pane ID — set by BrowserRenderer via the pane-id attribute. */
  @property({ type: Number, attribute: 'pane-id' }) paneId = 0;

  /** Current page URL (updated via browser-url messages). */
  @state() private _url = '';

  /** Frames-per-second counter (updated every 1 second). */
  @state() private _fps = 0;

  /** Whether the URL omnibox is in edit mode. */
  @state() private _editingUrl = false;

  /** URL being typed in the omnibox (mirrors _url when not editing). */
  @state() private _urlInput = '';

  /** Status bar text (hovered link URL). */
  @state() private _statusText = '';

  /** True while a Chromium download is in progress. */
  @state() private _downloading = false;

  /** Download progress 0–100. */
  @state() private _downloadPercent = 0;

  /** Error message, displayed if non-empty. */
  @state() private _errorText = '';

  @query('#viewport') private _canvas!: HTMLCanvasElement;

  private _ctx: CanvasRenderingContext2D | null = null;
  /** Latest frame waiting to be drawn — latest-frame-wins pattern. */
  private _pendingFrame: Uint8Array | null = null;
  private _renderScheduled = false;

  // FPS counter
  private _fpsFrameCount = 0;
  private _fpsTimer: ReturnType<typeof setInterval> | undefined;

  private _resizeObserver: ResizeObserver | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    // Ensure registry slot exists even if app.ts ensure() hasn't run yet.
    browserRegistry.ensure(this.paneId);
    browserRegistry.setCallbacks(this.paneId, {
      onFrame: this._onFrame,
      onUrl: this._onUrl,
      onError: this._onError,
      onDownload: this._onDownload,
      onStatus: this._onStatus,
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    browserRegistry.setCallbacks(this.paneId, {
      onFrame: null,
      onUrl: null,
      onError: null,
      onDownload: null,
      onStatus: null,
    });
    if (this._fpsTimer !== undefined) {
      clearInterval(this._fpsTimer);
      this._fpsTimer = undefined;
    }
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._ctx = null;
    this._pendingFrame = null;
  }

  override firstUpdated(): void {
    this._ctx = this._canvas.getContext('2d');

    // FPS counter: sample over 1-second windows.
    this._fpsTimer = setInterval(() => {
      this._fps = this._fpsFrameCount;
      this._fpsFrameCount = 0;
    }, 1000);

    // ResizeObserver: notify Chromium when the canvas viewport changes size.
    this._resizeObserver = new ResizeObserver(() => {
      const rect = this._canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        wsBrowser.send({
          type: SessiondType.BrowserInput,
          paneId: this.paneId,
          event: { type: 'resize', width: Math.round(rect.width), height: Math.round(rect.height) },
        });
      }
    });
    this._resizeObserver.observe(this._canvas);

    // Mouse events on the canvas — passive:false for wheel so we can preventDefault.
    const cv = this._canvas;
    cv.addEventListener('mousemove', (e) => this._onMouseMove(e));
    cv.addEventListener('mousedown', (e) => this._onMouseDown(e));
    cv.addEventListener('mouseup', (e) => this._onMouseUp(e));
    cv.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    cv.addEventListener('mouseleave', () => { this._statusText = ''; });
    // Keyboard events — canvas must have tabindex="0" to receive these.
    cv.addEventListener('keydown', (e) => this._onKeyDown(e));
    cv.addEventListener('keyup', (e) => this._onKeyUp(e));
  }

  // ── Registry callbacks ────────────────────────────────────────────────────

  private _onFrame = (jpegBytes: Uint8Array): void => {
    // Latest-frame-wins: discard any pending frame that hasn't rendered yet.
    this._pendingFrame = jpegBytes;
    if (!this._renderScheduled) {
      this._renderScheduled = true;
      requestAnimationFrame(() => this._flushFrame());
    }
  };

  private _flushFrame(): void {
    this._renderScheduled = false;
    const bytes = this._pendingFrame;
    this._pendingFrame = null;
    if (!bytes || !this._ctx) return;

    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = this._canvas;
      if (!canvas) { URL.revokeObjectURL(url); return; }
      // Resize canvas to match the incoming frame dimensions (only when changed).
      if (canvas.width !== img.naturalWidth) canvas.width = img.naturalWidth;
      if (canvas.height !== img.naturalHeight) canvas.height = img.naturalHeight;
      this._ctx?.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      this._fpsFrameCount++;
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  private _onUrl = (url: string): void => {
    this._url = url;
    // Always exit edit mode when the page reports a new URL — navigation succeeded.
    this._editingUrl = false;
    this._urlInput = url;
  };

  private _onError = (error: string): void => {
    this._errorText = error;
    this._downloading = false;
  };

  private _onDownload = (percent: number): void => {
    this._downloading = percent < 100;
    this._downloadPercent = percent;
    if (percent >= 100) this._downloading = false;
  };

  private _onStatus = (statusText: string): void => {
    this._statusText = statusText;
  };

  // ── Coordinate mapping ────────────────────────────────────────────────────

  /** Map a MouseEvent's client coordinates to Chromium viewport coordinates. */
  private _toViewport(e: MouseEvent): { x: number; y: number } {
    const canvas = this._canvas;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    };
  }

  // ── Mouse event relay ─────────────────────────────────────────────────────

  private _onMouseMove(e: MouseEvent): void {
    const { x, y } = this._toViewport(e);
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'mousemove', x, y },
    });
  }

  private _onMouseDown(e: MouseEvent): void {
    e.preventDefault();
    (e.currentTarget as HTMLElement).focus();
    const { x, y } = this._toViewport(e);
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'mousedown', button: e.button, x, y },
    });
  }

  private _onMouseUp(e: MouseEvent): void {
    const { x, y } = this._toViewport(e);
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'mouseup', button: e.button, x, y },
    });
  }

  private _onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { x, y } = this._toViewport(e);
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'wheel', x, y, deltaX: e.deltaX, deltaY: e.deltaY },
    });
  }

  // ── Keyboard event relay ──────────────────────────────────────────────────

  /**
   * Returns true for single printable characters (not modifier, arrow, function,
   * or control keys). Used to decide whether to send an additional 'type' event.
   */
  private _isPrintable(key: string): boolean {
    return key.length === 1;
  }

  private _onKeyDown(e: KeyboardEvent): void {
    // Don't relay keystrokes that belong to browser chrome / omnibox editing.
    if (this._editingUrl) return;

    // Prevent default for keys Chromium should handle (arrows, tab, backspace, etc.)
    // but NOT for Cmd/Ctrl shortcuts that belong to the OS or muxterm.
    const isModifier = e.metaKey || e.ctrlKey;
    if (!isModifier) e.preventDefault();

    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'keydown', key: e.key },
    });

    // Send a 'type' event for printable characters so Chromium processes text input.
    // Don't send for modifier combos (Ctrl+C, etc.) — those are handled by keydown.
    if (!isModifier && this._isPrintable(e.key)) {
      wsBrowser.send({
        type: SessiondType.BrowserInput,
        paneId: this.paneId,
        event: { type: 'type', text: e.key },
      });
    }
  }

  private _onKeyUp(e: KeyboardEvent): void {
    if (this._editingUrl) return;
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'keyup', key: e.key },
    });
  }

  // ── URL bar ───────────────────────────────────────────────────────────────

  private _parseUrl(url: string): { host: string; path: string; isHttps: boolean } {
    if (!url) return { host: '', path: '', isHttps: false };
    try {
      const u = new URL(url);
      return {
        host: u.hostname,
        path: u.pathname + u.search + u.hash,
        isHttps: u.protocol === 'https:',
      };
    } catch {
      return { host: url, path: '', isHttps: false };
    }
  }

  private _goBack(): void {
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'navigate', url: 'history:back' },
    });
  }

  private _goForward(): void {
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'navigate', url: 'history:forward' },
    });
  }

  private _reload(): void {
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'navigate', url: 'history:reload' },
    });
  }

  private _startEditUrl(): void {
    this._urlInput = this._url;
    this._editingUrl = true;
    // Focus the input on the next render cycle.
    requestAnimationFrame(() => {
      this.shadowRoot?.querySelector<HTMLInputElement>('.url-input')?.select();
    });
  }

  private _cancelEditUrl(): void {
    this._editingUrl = false;
    this._urlInput = this._url;
  }

  private _onUrlInput(e: Event): void {
    this._urlInput = (e.target as HTMLInputElement).value;
  }

  private _onUrlKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      this._navigate(this._urlInput.trim());
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this._cancelEditUrl();
    }
  }

  private _navigate(url: string): void {
    if (!url) return;
    this._editingUrl = false;
    // Auto-prefix https:// if no scheme is provided (mirrors Go's auto-prefix logic).
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'navigate', url: normalized },
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  override render() {
    const urlObj = this._parseUrl(this._url);

    return html`
      <div class="browser-toolbar">
        <button
          class="nav-btn"
          title="Back"
          @click=${this._goBack}
        >
          <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button
          class="nav-btn"
          title="Forward"
          @click=${this._goForward}
        >
          <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M6 12l4-4-4-4" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>

        <div class="omnibox ${this._editingUrl ? 'editing' : ''}">
          ${!this._editingUrl ? html`
            <span class="lock-icon ${urlObj.isHttps ? 'https' : 'http'}">
              ${urlObj.isHttps
                ? html`<svg viewBox="0 0 12 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect x="1.5" y="5.5" width="9" height="8" rx="1"
                      stroke="currentColor" stroke-width="1.2"/>
                    <path d="M4 5.5V4a2 2 0 1 1 4 0v1.5"
                      stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
                  </svg>`
                : html`<svg viewBox="0 0 12 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect x="1.5" y="5.5" width="9" height="8" rx="1"
                      stroke="currentColor" stroke-width="1.2"/>
                    <path d="M4 5.5V4a2 2 0 0 1 3.5-1.3"
                      stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
                  </svg>`}
            </span>
            <span class="url-host" @click=${this._startEditUrl}>${urlObj.host}</span>
            <span class="url-path" @click=${this._startEditUrl}>${urlObj.path}</span>
            <span class="omni-gap"></span>
            <button class="reload-btn" title="Reload" @click=${this._reload}>
              <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3 8a5 5 0 1 0 1-3M3 5V2M3 5H6"
                  stroke="currentColor" stroke-width="1.4"
                  stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          ` : html`
            <input
              class="url-input"
              type="text"
              .value=${this._urlInput}
              @input=${this._onUrlInput}
              @keydown=${this._onUrlKeyDown}
              @blur=${this._cancelEditUrl}
            />
          `}
        </div>

        <span class="fps-badge" title="Frames per second">${this._fps.toFixed(0)} fps</span>
        <div class="live-dot" title="Live"></div>
      </div>

      <div class="canvas-wrap">
        <canvas id="viewport" tabindex="0"></canvas>
        <div class="status-bar ${this._statusText ? 'visible' : ''}">${this._statusText}</div>
      </div>

      ${this._downloading ? html`
        <div class="download-overlay">
          <div>Downloading Chromium… ${this._downloadPercent}%</div>
          <div class="download-bar">
            <div class="download-fill" style="width:${this._downloadPercent}%"></div>
          </div>
        </div>
      ` : ''}
      ${this._errorText ? html`
        <div class="error-banner">${this._errorText}</div>
      ` : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-browser-pane': MuxBrowserPane;
  }
}
```

**Step 2: Verify**

```bash
cd web && npm run check:fast
```

Expected: `0 errors`. If oxlint warns about unused imports or anything else that is a lint warning (not an error), it is OK — do not suppress lint warnings with `eslint-disable` unless the warning is a false positive that cannot be fixed.

**Step 3: Commit**

```bash
cd .worktrees/feat-browser-cdp-pane
git add web/src/components/mux-browser-pane.ts
git commit -m "feat: add complete mux-browser-pane Lit element

Canvas JPEG rendering with latest-frame-wins rAF scheduling (Blob URL +
Image + ctx.drawImage, proven in spike). Full Chrome-like toolbar:
circular ghost nav buttons (back/forward SVG chevrons), pill omnibox
with lock icon + host + path + reload-inside-pill, FPS badge, pulsing
live dot. Zero hardcoded colors — all var(--chrome-*) and var(--mux-*).
Mouse relay: mousemove/down/up/wheel with getBoundingClientRect scale
factors. Keyboard relay: keydown + type for printable chars, editingUrl
guard. URL bar: click to edit, Enter navigates with https:// auto-prefix,
Escape cancels. ResizeObserver relays viewport size changes to Chromium.
Status bar fades in for link hover previews.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 5: Add `createBrowserPane()` and `closeBrowserPane()` to `web/src/ws.ts`

**Files:**
- Modify: `web/src/ws.ts`

**Step 1: Read `web/src/ws.ts`** to find the location of `listTunnels()` — add the new methods immediately after it.

**Step 2: Add two methods to `MuxSocket`**

After the `listTunnels()` method (around line 148 in the current file), add:

```typescript
  /** Request the server to open a new browser CDP pane. */
  createBrowserPane(): void {
    this.sendSessiond({ type: SessiondType.CreateBrowserPane });
  }

  /** Close the browser CDP pane (server kills the Chromium page). */
  closeBrowserPane(): void {
    this.sendSessiond({ type: SessiondType.CloseBrowserPane });
  }
```

**Step 3: Verify**

```bash
cd web && npm run check:fast
```

Expected: `0 errors`. (`SessiondType.CreateBrowserPane` and `SessiondType.CloseBrowserPane` were added to `types.ts` in commit `2b0d601`.)

**Step 4: Commit**

```bash
cd .worktrees/feat-browser-cdp-pane
git add web/src/ws.ts
git commit -m "feat: add createBrowserPane/closeBrowserPane to MuxSocket

Uses SessiondType.CreateBrowserPane and CloseBrowserPane added in the
types.ts update (2b0d601). Methods follow the existing sendSessiond
pattern — no-op when socket is not open.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 6: Add globe button to `web/src/components/mux-dock-bar.ts`

**Files:**
- Modify: `web/src/components/mux-dock-bar.ts`

**Step 1: Read `web/src/components/mux-dock-bar.ts`** fully to understand the existing CSS, `@state` fields, and `render()` template.

**Step 2: Add CSS for the globe action button**

Inside `static styles = css\`...\``, add before the `.conn-dot` rule:

```css
    .action-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      background: transparent;
      border: none;
      border-radius: 50%;
      color: inherit;
      cursor: pointer;
      transition: background 0.12s, color 0.12s;
      flex-shrink: 0;
    }

    .action-btn:hover { background: color-mix(in srgb, currentColor 15%, transparent); }
    .action-btn.browser-live { color: var(--mux-ok, #9ece6a); }

    .action-btn svg {
      width: 16px;
      height: 16px;
      pointer-events: none;
    }
```

**Step 3: Add the click handler method**

Add this method to the `MuxDockBar` class (after `_onWsClick`):

```typescript
  private _onGlobeClick(): void {
    const existing = store.panes.find((p) => p.surfaceKind === 'browser-cdp');
    if (existing) {
      // Activate the existing pane — app.ts listens for this window event.
      window.dispatchEvent(
        new CustomEvent('browser-pane-focus', { detail: { paneId: existing.paneId } }),
      );
    } else {
      // Request a new browser pane — app.ts calls socket.createBrowserPane().
      window.dispatchEvent(new CustomEvent('create-browser-pane'));
    }
  }
```

**Step 4: Add the globe button to `render()`**

Find the `conn-dot` div in the `render()` method. Add the globe button immediately BEFORE it (so it appears to the left of the connection dot):

```typescript
        <button
          class="action-btn ${store.panes.some(p => p.surfaceKind === 'browser-cdp') ? 'browser-live' : ''}"
          title="Open browser"
          @click=${this._onGlobeClick}
        >
          <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3"/>
            <path d="M8 1.5C6.5 3.5 5.5 5.6 5.5 8s1 4.5 2.5 6.5M8 1.5C9.5 3.5 10.5 5.6 10.5 8s-1 4.5-2.5 6.5M1.5 8h13"
              stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
            <path d="M2.5 5.5h11M2.5 10.5h11"
              stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
          </svg>
        </button>
```

**Step 5: Verify**

```bash
cd web && npm run check:fast
```

Expected: `0 errors`.

**Step 6: Commit**

```bash
cd .worktrees/feat-browser-cdp-pane
git add web/src/components/mux-dock-bar.ts
git commit -m "feat: add globe browser button to mux-dock-bar

Globe button in right action cluster:
- Green tint (--mux-ok) while any browser-cdp pane is live in store
- First click: dispatches window 'create-browser-pane' CustomEvent
- Second click (pane live): dispatches window 'browser-pane-focus'
  with paneId so app.ts can focus the existing panel
Button uses window events so mux-dock-bar stays decoupled from app.ts.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 7: Register `BrowserRenderer` in `web/src/components/mux-dock.ts`

**Files:**
- Modify: `web/src/components/mux-dock.ts`

**Step 1: Read `web/src/components/mux-dock.ts`** fully, specifically:
- The `TerminalRenderer` class (understand the `IContentRenderer` interface: `element`, `init()`, `layout()`, `focus()`, `dispose()`)
- The `createComponent` factory inside `connectedCallback` / `new DockviewComponent()`
- The `_panels` Map (used by the `activatePane()` method you'll add)

**Step 2: Add the side-effect import for `mux-browser-pane.ts`**

After the existing imports at the top of the file, add:

```typescript
// Side-effect import: registers <mux-browser-pane> custom element
import './mux-browser-pane.js';
```

**Step 3: Add `BrowserRenderer` class**

Add this class immediately after `TerminalRenderer` (before the `HeaderButton` class or whatever comes next):

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// BrowserRenderer
// Bridges the dockview panel lifecycle to <mux-browser-pane>.
// Much simpler than TerminalRenderer: no terminal attach/detach logic.
// ─────────────────────────────────────────────────────────────────────────────

class BrowserRenderer implements IContentRenderer {
  readonly element: HTMLElement;

  constructor(id: string) {
    const container = document.createElement('div');
    container.style.cssText = 'width:100%;height:100%;overflow:hidden;display:flex;';

    const pane = document.createElement('mux-browser-pane');
    pane.setAttribute('pane-id', id);
    pane.style.cssText = 'flex:1;min-width:0;';

    container.appendChild(pane);
    this.element = container;
  }

  init(): void { /* no-op: <mux-browser-pane> self-initializes in connectedCallback */ }
  layout(): void { /* no-op: CSS handles sizing */ }
  focus(): void { /* no-op: canvas focuses via tabindex="0" */ }
  dispose(): void { /* no-op: Lit handles teardown in disconnectedCallback */ }
}
```

**Step 4: Update the `createComponent` factory**

Find the `createComponent` callback inside `new DockviewComponent(this, {...})` in `connectedCallback`. It currently looks like:

```typescript
      createComponent: (opts) => {
        return new TerminalRenderer(opts.id, (paneId) => paneId === this.activePaneId);
      },
```

Replace with:

```typescript
      createComponent: (opts) => {
        // opts.name === the component type string from addPanel({ component: surfaceKind ?? 'terminal' })
        if (opts.name === 'browser-cdp') {
          return new BrowserRenderer(opts.id);
        }
        return new TerminalRenderer(opts.id, (paneId) => paneId === this.activePaneId);
      },
```

**Step 5: Add `activatePane()` public method to `MuxDock`**

Find the end of the `MuxDock` class body (before the `declare global` block). Add:

```typescript
  /**
   * Programmatically activate a pane by ID.
   * Used by app.ts to focus an existing browser pane when the globe is clicked.
   */
  activatePane(paneId: number): void {
    const panel = this._panels.get(paneId);
    if (panel && !panel.api.isActive) {
      panel.api.setActive();
    }
  }
```

**Step 6: Verify**

```bash
cd web && npm run check:fast
```

Expected: `0 errors`.

**Step 7: Commit**

```bash
cd .worktrees/feat-browser-cdp-pane
git add web/src/components/mux-dock.ts
git commit -m "feat: register BrowserRenderer in mux-dock for browser-cdp surface kind

BrowserRenderer implements IContentRenderer: creates a container div
with a <mux-browser-pane pane-id=N> child. createComponent() factory
checks opts.name for 'browser-cdp' and returns BrowserRenderer; all
other kinds fall back to TerminalRenderer as before.

Also adds MuxDock.activatePane(paneId) for programmatic panel focus —
used by app.ts when the globe button is clicked on an existing pane.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 8: Wire `browserRegistry` + `wsBrowser` into `web/src/app.ts`

**Files:**
- Modify: `web/src/app.ts`

**Step 1: Read `web/src/app.ts`** fully before editing. Key things to find:
- The import block at the top
- `connectedCallback()` — where `this._socket.connect()` is called
- `disconnectedCallback()` — where socket cleanup happens
- `onSessiondMessage` handler — the `SessiondType.Composition` branch with the `for (const pane of ...)` loop
- `_syncTerminals()` — the `for (const pane of store.panes)` loop

**Step 2: Add imports at the top of `app.ts`**

After the existing imports, add:

```typescript
import { browserRegistry } from './lib/browser-registry.js';
import { wsBrowser } from './lib/ws-browser.js';
```

**Step 3: Add window event handler class fields**

Find the existing private field declarations (near `_onViewportResize` or similar). Add:

```typescript
  /** Handle globe button's create-browser-pane window event. */
  private _onCreateBrowserPane = (): void => {
    this._socket?.createBrowserPane();
  };

  /** Handle globe button's browser-pane-focus window event (pane already live). */
  private _onBrowserPaneFocus = (e: Event): void => {
    const paneId = (e as CustomEvent<{ paneId: number }>).detail?.paneId;
    if (paneId !== undefined) {
      store.setActivePane(paneId);
      this._dock?.activatePane(paneId);
    }
  };
```

**Step 4: Wire `wsBrowser` in `connectedCallback()`**

After the line `this._socket.connect()` (or wherever the main socket connects), add:

```typescript
    // Connect the dedicated browser WebSocket and wire frame/url/error routing.
    wsBrowser.onFrame = (paneId, jpegBytes) => browserRegistry.write(paneId, jpegBytes);
    wsBrowser.onBrowserUrl = (paneId, url) => browserRegistry.dispatchUrl(paneId, url);
    wsBrowser.onBrowserError = (paneId, error) => browserRegistry.dispatchError(paneId, error);
    wsBrowser.onDownloadProgress = (paneId, percent) => browserRegistry.dispatchDownload(paneId, percent);
    wsBrowser.onBrowserStatus = (paneId, text) => browserRegistry.dispatchStatus(paneId, text);
    wsBrowser.connect();

    // Globe button window events
    window.addEventListener('create-browser-pane', this._onCreateBrowserPane);
    window.addEventListener('browser-pane-focus', this._onBrowserPaneFocus);
```

**Step 5: Clean up in `disconnectedCallback()`**

After the existing socket disconnect/cleanup, add:

```typescript
    wsBrowser.disconnect();
    window.removeEventListener('create-browser-pane', this._onCreateBrowserPane);
    window.removeEventListener('browser-pane-focus', this._onBrowserPaneFocus);
```

**Step 6: Update the `SessiondType.Composition` handler**

Find the `if (msg.type === SessiondType.Composition)` branch. Inside the `for (const pane of (msg.panes ?? []))` loop, add a guard at the top so browser-cdp panes skip terminal setup and go to `browserRegistry` instead:

```typescript
        for (const pane of (msg.panes ?? [])) {
          const paneId = pane.paneId;
          if (paneId < 0) continue;
          // Browser CDP panes use browserRegistry, not terminalRegistry.
          if (pane.surfaceKind === 'browser-cdp') {
            browserRegistry.ensure(paneId);
            continue;
          }
          // On reconnect an entry already exists with ready=true from the prior
          // session. Reset it before replay frames arrive so the barrier gate
          // works correctly (RC-6).
          if (terminalRegistry.isOpened(paneId)) {
            terminalRegistry.resetForReattach(paneId);
          }
          terminalRegistry.ensure(paneId, {
            onInput: (data) => this._socket?.sendPaneInput(paneId, data),
            onResize: (cols, rows) => this._controller?.reportResize(paneId, cols, rows),
          });
          terminalRegistry.setExpectedReplayBytes(paneId, pane.totalSeq ?? 0);
        }
```

**Step 7: Update `_syncTerminals()`**

Find the `_syncTerminals()` method and the `for (const pane of store.panes)` loop inside it. Add the browser-cdp guard so browser panes go to `browserRegistry`, and add `browserRegistry.prune()` alongside `terminalRegistry.prune()`:

```typescript
  private _syncTerminals(): void {
    terminalRegistry.setWorkspace(store.attached ?? '');
    const liveIds = new Set<number>();
    for (const pane of store.panes) {
      const paneId = pane.paneId;
      if (paneId < 0) continue;
      if (this._closingPanes.has(paneId)) continue;
      // Browser CDP panes use browserRegistry, not terminalRegistry.
      if (pane.surfaceKind === 'browser-cdp') {
        browserRegistry.ensure(paneId);
        liveIds.add(paneId);
        continue;
      }
      terminalRegistry.ensure(paneId, {
        onInput: (data) => this._socket?.sendPaneInput(paneId, data),
        onResize: (cols, rows) => this._controller?.reportResize(paneId, cols, rows),
      });
      liveIds.add(paneId);
    }
    terminalRegistry.prune(liveIds);
    browserRegistry.prune(liveIds);
    // Clean up _closingPanes entries the server has now removed from store.panes.
    const toDelete = new Set<number>();
    for (const id of this._closingPanes) {
      if (!store.panes.some((p) => p.paneId === id)) toDelete.add(id);
    }
    for (const id of toDelete) this._closingPanes.delete(id);
  }
```

> **Note:** Match the exact surrounding code you find in `app.ts` — the snippet above is the intended shape, but adapt the edits to fit precisely within the existing method rather than wholesale-replacing if there are other lines present.

**Step 8: Verify**

```bash
cd web && npm run check:fast
```

Expected: `0 errors`. If there are type errors about `this._dock?.activatePane` not existing, confirm that `MuxDock` in `mux-dock.ts` has `activatePane()` declared as a public method (Task 7) and that the type import at the top of `app.ts` picks it up.

**Step 9: Commit**

```bash
cd .worktrees/feat-browser-cdp-pane
git add web/src/app.ts
git commit -m "feat: wire browserRegistry + wsBrowser into app.ts composition pipeline

- wsBrowser connects/disconnects with the main socket lifecycle
- Frame/url/error/download/status callbacks route through browserRegistry
- Composition handler: browser-cdp panes use browserRegistry.ensure()
  instead of terminalRegistry setup (no xterm, no replay bytes)
- _syncTerminals: browser-cdp panes call browserRegistry.ensure(), skip
  terminalRegistry; both registries pruned with the same liveIds set
- Window events: 'create-browser-pane' → socket.createBrowserPane();
  'browser-pane-focus' → dock.activatePane(paneId)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 9 (Final): Build verification + agent-driven browser E2E

**Files:** None to create or modify — this is pure verification.

---

### Step 1: Full production build

```bash
cd web && npm run build
```

Expected: Clean build. No errors. Typical success indicator: `✓ built in X.XXs`. Warnings are OK.

If the build fails:
- `tsc --noEmit` errors → TypeScript type errors not caught by tsgo. Fix each one.
- `vite build` errors → bundler import resolution. Check that all relative imports use `.js` extensions.
- Common issue: new file imported with `.ts` extension instead of `.js` — change to `.js`.

If you fix anything, run `npm run check:fast` again first, then rebuild.

---

### Step 2: Build the Go binary

```bash
cd /path/to/worktree   # .worktrees/feat-browser-cdp-pane root
go build -o bin/muxterm ./cmd/muxterm
```

Expected: Binary produced at `bin/muxterm` with no errors.

---

### Step 3: Start muxterm

```bash
./bin/muxterm local
```

Expected: Server starts. You should see log output indicating it's listening on `http://localhost:8080`.

---

### Step 4: Agent-driven browser E2E verification using playwright-cli

Open `http://localhost:8080` using playwright-cli. Then verify each acceptance criterion below — the agent reads snapshots and uses playwright-cli interactively to satisfy them. There is no pre-written script; the agent makes semantic judgments at each step.

**Acceptance criteria (verify all of these):**

1. **Globe button present** — the dock bar's right section contains a globe/world icon button. It has no green tint (no browser pane is open yet).

2. **Click globe → browser pane opens** — after clicking the globe, a new dockview panel appears. The panel contains:
   - Two circular navigation buttons (← back, → forward) on the left side of the toolbar
   - A pill-shaped address bar (omnibox) in the center
   - An FPS counter badge and a small status dot on the right of the toolbar

3. **Canvas visible** — below the toolbar, a `<canvas>` element fills the remaining pane area.

4. **Frames arrive** — wait a few seconds. The FPS badge in the toolbar shows a number greater than 0. (This confirms Chromium is running and streaming frames via CDP.)

5. **URL populates** — the address bar shows a URL. It may be blank initially while Chromium initializes, then populates with the default page URL once loading completes.

6. **Navigate to example.com** — click the address bar. It enters edit mode (shows a text input). Type `example.com` and press Enter. After a moment:
   - The address bar exits edit mode and shows `https://example.com`
   - The canvas renders the Example Domain page

7. **Back button works** — click the ← back button. The address bar URL changes back to the previous URL (whatever was loaded before example.com).

8. **Globe tint** — the globe button in the dock bar now shows a green tint (`--mux-ok` color), indicating a browser pane is live.

9. **Second globe click = focus, not new pane** — click the globe again. It does NOT open a second browser pane. The existing pane is focused/activated. Only one browser pane exists.

10. **Theme cohesion** — the toolbar background, omnibox, nav buttons, FPS badge, and live dot colors match the muxterm dark theme. No jarring mismatches or hardcoded colors that don't fit the palette.

---

### Step 5: Commit after successful verification

```bash
cd .worktrees/feat-browser-cdp-pane
git add -A
git commit -m "test: verify browser CDP pane works end-to-end

Verified via agent-driven playwright-cli session:
- Globe button opens browser pane in dockview
- Canvas renders JPEG frames from Chromium at >0 FPS
- URL bar populates and navigates on Enter (example.com)
- Back button works
- Globe tint turns green when pane is live
- Second globe click focuses existing pane (no duplicate)
- Theme colors match muxterm palette throughout

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Summary

| Task | File(s) | What it does |
|------|---------|--------------|
| 1 | — | Rebase worktree from main; gets types.ts (2b0d601) for free |
| 2 | `lib/ws-browser.ts` (create) | `BrowserSocket` + `wsBrowser` singleton — dedicated `/ws/browser` WebSocket |
| 3 | `lib/browser-registry.ts` (create) | `browserRegistry` per-pane callback routing — frame/url/error/download/status |
| 4 | `components/mux-browser-pane.ts` (create) | Complete Lit element — canvas, toolbar, CSS, mouse/keyboard relay, URL bar, status bar |
| 5 | `ws.ts` (modify) | `createBrowserPane()` / `closeBrowserPane()` on `MuxSocket` |
| 6 | `components/mux-dock-bar.ts` (modify) | Globe button with green tint + window CustomEvent dispatch |
| 7 | `components/mux-dock.ts` (modify) | `BrowserRenderer` + `createComponent` factory + `activatePane()` |
| 8 | `app.ts` (modify) | Full wiring: wsBrowser lifecycle, composition handler, `_syncTerminals`, window events |
| 9 | — | `npm run build` + Go binary build + agent-driven browser E2E via playwright-cli |

**New files:** `web/src/lib/ws-browser.ts`, `web/src/lib/browser-registry.ts`, `web/src/components/mux-browser-pane.ts`

**Modified files:** `web/src/ws.ts`, `web/src/components/mux-dock-bar.ts`, `web/src/components/mux-dock.ts`, `web/src/app.ts`
