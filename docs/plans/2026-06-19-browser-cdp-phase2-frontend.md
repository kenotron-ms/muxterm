# Browser CDP Pane — Phase 2: TypeScript/Lit Frontend

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Build the TypeScript/Lit frontend for the browser CDP pane: a dedicated `/ws/browser` WebSocket client, a browser pane registry, and the `<mux-browser-pane>` Lit component with canvas rendering, a Chrome-like toolbar, and full mouse/keyboard relay.

**Architecture:** A dedicated `BrowserSocket` singleton connects to `/ws/browser` (separate from the main `/ws` to prevent JPEG frames from delaying keystrokes). A `browserRegistry` module-level singleton routes incoming frames to the correct `<mux-browser-pane>` Lit element. `mux-dock.ts` registers a `BrowserRenderer` dockview component factory that mounts `<mux-browser-pane>` for `surfaceKind: "browser-cdp"` panes. `app.ts` wires the registry into the composition handler and `_syncTerminals()` loop.

**Tech Stack:** TypeScript (strict), Lit v3 (`@customElement`, `@property`, `@state`, `@query`), CSS custom properties (zero hardcoded colors), WebSocket binary framing (4-byte LE pane ID + JPEG), dockview-core `IContentRenderer`.

**Assumes:** Phase 1 (Go backend) is complete. The Go server emits binary JPEG frames on `/ws/browser`, broadcasts `browser-url`/`browser-download-progress`/`browser-error` JSON, and handles `browser-input` JSON messages. Browser panes appear in the composition with `surfaceKind: "browser-cdp"`. `BrowserPort`/`BrowserPath` are removed from all Go types.

---

## Verification command (every task)

```
cd web && npm run check:fast
```

Expected output: `0 errors` from tsgo, warnings from oxlint are OK. Any error = fix before committing.

## Commit footer (every commit)

```
🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
```

---

## Task 1: Update `types.ts` — add browser CDP types, clean up old browser fields

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/state.ts` (remove `browserPort`/`browserPath` from pane creation)
- Fix: `web/src/__tests__/protocol.types.test.ts` (update broken browser tests)

### Step 1: Edit `web/src/types.ts`

**Add 6 new entries to `SessiondType`** (after `BrowserActionResult:`):

```typescript
// Browser CDP pane lifecycle (client -> server, over /ws)
CreateBrowserPane: 'create-browser-pane',
CloseBrowserPane: 'close-browser-pane',
// Browser input relay (client -> server, over /ws/browser)
BrowserInput: 'browser-input',
// Browser notifications (server -> client, over /ws/browser)
BrowserURL: 'browser-url',
BrowserDownloadProgress: 'browser-download-progress',
BrowserError: 'browser-error',
```

**Replace the `SurfaceKind` type** (line 7):

Old:
```typescript
export type SurfaceKind = 'terminal' | 'driver' | 'browser' | 'settings';
```

New:
```typescript
export type SurfaceKind = 'terminal' | 'driver' | 'browser-cdp' | 'settings';
```

**Replace the `SessiondPaneInfo` interface** — remove old browser proxy fields and update the comment:

Old (lines 89–108):
```typescript
export interface SessiondPaneInfo {
  paneId: number;
  cols: number;
  rows: number;
  title?: string;
  clientRef?: string;
  /** Absolute byte sequence of the first replayed byte for this pane.
   *  Omitted (undefined) when 0. Set by the server on each composition reply
   *  so the client can anchor its delta-replay offset tracking. */
  seq?: number;
  /** Total bytes ever written to this pane's buffer.
   *  expectedReplayBytes = totalSeq - seq. Used by the client settle barrier
   *  (RC-1) to defer ready=true until all replay data has arrived. */
  totalSeq?: number;
  // Browser-only fields (present when surfaceKind === 'browser')
  surfaceKind?: SurfaceKind;
  browserPort?: number;
  browserPath?: string;
  proxyHeaders?: Record<string, string>;
}
```

New:
```typescript
export interface SessiondPaneInfo {
  paneId: number;
  cols: number;
  rows: number;
  title?: string;
  clientRef?: string;
  /** Absolute byte sequence of the first replayed byte for this pane.
   *  Omitted (undefined) when 0. Set by the server on each composition reply
   *  so the client can anchor its delta-replay offset tracking. */
  seq?: number;
  /** Total bytes ever written to this pane's buffer.
   *  expectedReplayBytes = totalSeq - seq. Used by the client settle barrier
   *  (RC-1) to defer ready=true until all replay data has arrived. */
  totalSeq?: number;
  /** Present for non-terminal panes; 'browser-cdp' uses canvas+CDP streaming. */
  surfaceKind?: SurfaceKind;
}
```

**In `SessiondMessage`** — remove the three browser proxy fields (find and delete):
```typescript
  surfaceKind?: SurfaceKind;
  browserPort?: number;
  browserPath?: string;
  proxyHeaders?: Record<string, string>;
```
Replace with (keep surfaceKind, drop the others):
```typescript
  surfaceKind?: SurfaceKind;
```

**In `LayoutCommand`** — update the `kind` field type (line ~186):

Old:
```typescript
  kind?: 'terminal' | 'browser';
```

New:
```typescript
  kind?: 'terminal' | 'browser-cdp';
```

### Step 2: Edit `web/src/state.ts`

Find the block around line 266–268 that reads:
```typescript
          surfaceKind: msg.surfaceKind,
          browserPort: msg.browserPort,
          browserPath: msg.browserPath,
```

Replace with:
```typescript
          surfaceKind: msg.surfaceKind,
```

(Remove the `browserPort` and `browserPath` lines — they no longer exist on `SessiondMessage`.)

### Step 3: Fix `web/src/__tests__/protocol.types.test.ts`

The `describe('browser pane fields', ...)` block tests the old `'browser'` surface kind and `browserPort`/`browserPath`. Replace the entire `describe('browser pane fields', ...)` block with:

```typescript
describe('browser CDP pane fields', () => {
  it('SessiondPaneInfo accepts browser-cdp surfaceKind', () => {
    const kind: SurfaceKind = 'browser-cdp';
    const pane: SessiondPaneInfo = {
      paneId: 42,
      cols: 0,
      rows: 0,
      surfaceKind: kind,
    };
    expect(pane.surfaceKind).toBe('browser-cdp');
  });

  it('SessiondPaneInfo surfaceKind is optional', () => {
    const pane: SessiondPaneInfo = { paneId: 1, cols: 80, rows: 24 };
    expect(pane.surfaceKind).toBeUndefined();
  });

  it('SessiondMessage accepts browser-cdp surfaceKind', () => {
    const msg: SessiondMessage = {
      type: SessiondType.PaneAdded,
      paneId: 5,
      surfaceKind: 'browser-cdp',
    };
    expect(msg.surfaceKind).toBe('browser-cdp');
  });

  it('SessiondMessage surfaceKind is optional', () => {
    const msg: SessiondMessage = { type: SessiondType.CreatePane };
    expect(msg.surfaceKind).toBeUndefined();
  });
});
```

Also add the new `SessiondType` keys to any assertion in the file that checks the full set of keys (search for a test that enumerates `SessiondType` values and add the 6 new ones).

### Step 4: Verify

```bash
cd web && npm run check:fast
```

Expected: `0 errors`. Warnings from oxlint (if any) are OK.

### Step 5: Commit

```bash
git add web/src/types.ts web/src/state.ts web/src/__tests__/protocol.types.test.ts
git commit -m "feat: add browser-cdp type constants, remove legacy browser proxy fields

- Add CreateBrowserPane/CloseBrowserPane/BrowserInput/BrowserURL/
  BrowserDownloadProgress/BrowserError to SessiondType
- Replace SurfaceKind 'browser' with 'browser-cdp'
- Remove browserPort/browserPath/proxyHeaders from SessiondPaneInfo and
  SessiondMessage (Phase 1 already removed them from Go)
- Update state.ts pane creation to match new shape
- Fix protocol.types.test.ts to use 'browser-cdp'

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 2: Create `web/src/lib/ws-browser.ts` — dedicated `/ws/browser` WebSocket client

**Files:**
- Create: `web/src/lib/ws-browser.ts`

### Step 1: Write the file

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

### Step 2: Verify

```bash
cd web && npm run check:fast
```

Expected: `0 errors`.

### Step 3: Commit

```bash
git add web/src/lib/ws-browser.ts
git commit -m "feat: add BrowserSocket — dedicated /ws/browser WebSocket client

Separate connection from main /ws prevents JPEG frames from queuing
behind terminal keystrokes. Auto-reconnects with exponential backoff
(same policy as MuxSocket). Parses binary [paneId][JPEG] frames and
browser-url/browser-download-progress/browser-error JSON messages.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 3: Create `web/src/lib/browser-registry.ts` — browser pane state manager

**Files:**
- Create: `web/src/lib/browser-registry.ts`

### Step 1: Write the file

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
}

const _map = new Map<number, BrowserPaneCallbacks>();

export const browserRegistry = {
  /**
   * Idempotent: creates a callback slot for paneId if one doesn't exist.
   * Call for every browser-cdp pane in the composition (from app.ts).
   */
  ensure(paneId: number): void {
    if (_map.has(paneId)) return;
    _map.set(paneId, { onFrame: null, onUrl: null, onError: null, onDownload: null });
  },

  /**
   * Register callbacks for a pane. Called by <mux-browser-pane> in
   * connectedCallback. Passing null for a callback clears it.
   */
  setCallbacks(paneId: number, cbs: Partial<BrowserPaneCallbacks>): void {
    let entry = _map.get(paneId);
    if (!entry) {
      entry = { onFrame: null, onUrl: null, onError: null, onDownload: null };
      _map.set(paneId, entry);
    }
    if (cbs.onFrame !== undefined) entry.onFrame = cbs.onFrame;
    if (cbs.onUrl !== undefined) entry.onUrl = cbs.onUrl;
    if (cbs.onError !== undefined) entry.onError = cbs.onError;
    if (cbs.onDownload !== undefined) entry.onDownload = cbs.onDownload;
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

### Step 2: Verify

```bash
cd web && npm run check:fast
```

Expected: `0 errors`.

### Step 3: Commit

```bash
git add web/src/lib/browser-registry.ts
git commit -m "feat: add browserRegistry — per-pane callback routing for CDP panes

Module-level singleton (mirrors terminal-registry pattern). Routes
incoming JPEG frames, URL updates, and errors from BrowserSocket to
the correct <mux-browser-pane> element via registered callbacks.
Simpler than terminalRegistry: no xterm, no settle/drain, no scrollback.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 4: Create `web/src/components/mux-browser-pane.ts` — skeleton Lit element

**Files:**
- Create: `web/src/components/mux-browser-pane.ts`

This task creates the element class with all state properties and lifecycle hooks but **no canvas or toolbar yet** — just enough to type-check and register the custom element.

### Step 1: Write the file

```typescript
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
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
 *   - connectedCallback registers frame/url/error callbacks with browserRegistry
 *   - disconnectedCallback clears those callbacks
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
    }
  `;

  /** Numeric pane ID — set by BrowserRenderer via the pane-id attribute. */
  @property({ type: Number, attribute: 'pane-id' }) paneId = 0;

  /** Current page URL (updated via browser-url messages). */
  @state() private _url = '';

  /** Frames-per-second counter (updated every 60 frames). */
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

  override connectedCallback(): void {
    super.connectedCallback();
    // Ensure registry slot exists even if app.ts ensure() hasn't run yet
    // (component can mount before the composition handler fires).
    browserRegistry.ensure(this.paneId);
    browserRegistry.setCallbacks(this.paneId, {
      onFrame: this._onFrame,
      onUrl: this._onUrl,
      onError: this._onError,
      onDownload: this._onDownload,
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    browserRegistry.setCallbacks(this.paneId, {
      onFrame: null,
      onUrl: null,
      onError: null,
      onDownload: null,
    });
  }

  private _onFrame = (_jpegBytes: Uint8Array): void => {
    // Canvas rendering added in Task 5
  };

  private _onUrl = (url: string): void => {
    this._url = url;
    if (!this._editingUrl) this._urlInput = url;
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

  override render() {
    return html`
      <div class="placeholder" style="
        flex:1;display:flex;align-items:center;justify-content:center;
        color:var(--chrome-text-dim);font-size:13px;
      ">
        Browser pane ${this.paneId}
        ${this._downloading
          ? html` — downloading Chromium ${this._downloadPercent}%`
          : ''}
        ${this._errorText
          ? html` — <span style="color:var(--mux-error)">${this._errorText}</span>`
          : ''}
      </div>
    `;
  }
}

// Expose for BrowserRenderer type import
export type { MuxBrowserPane };

declare global {
  interface HTMLElementTagNameMap {
    'mux-browser-pane': MuxBrowserPane;
  }
}

// Suppress unused import warning — wsBrowser and SessiondType are used in later tasks
void wsBrowser;
void SessiondType;
```

### Step 2: Verify

```bash
cd web && npm run check:fast
```

Expected: `0 errors`.

### Step 3: Commit

```bash
git add web/src/components/mux-browser-pane.ts
git commit -m "feat: add mux-browser-pane skeleton Lit element

Registers custom element, wires paneId property, connectedCallback
registers frame/url/error/download callbacks with browserRegistry.
No canvas or toolbar yet — placeholder div only.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 5: Add canvas rendering to `mux-browser-pane.ts`

**Files:**
- Modify: `web/src/components/mux-browser-pane.ts`

Replace the placeholder render with a real `<canvas>`, add the `_renderFrame()` method, add an FPS counter, and register the frame callback.

### Step 1: Add imports and decorators at the top of the file

Add `query` to the decorator imports:
```typescript
import { customElement, property, state, query } from 'lit/decorators.js';
```

### Step 2: Add canvas fields inside the class (after `_errorText`):

```typescript
  @query('#viewport') private _canvas!: HTMLCanvasElement;

  private _ctx: CanvasRenderingContext2D | null = null;
  /** Last image created for the pending frame (avoids creating two Image objects). */
  private _pendingFrame: Uint8Array | null = null;
  private _renderScheduled = false;

  // FPS counter
  private _fpsFrameCount = 0;
  private _fpsTimer: ReturnType<typeof setInterval> | undefined;
```

### Step 3: Replace `_onFrame` with a real implementation:

```typescript
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
```

### Step 4: Add `firstUpdated` to get the 2D context and start FPS timer:

```typescript
  override firstUpdated(): void {
    this._ctx = this._canvas.getContext('2d');
    // FPS counter: sample over 1-second windows.
    this._fpsTimer = setInterval(() => {
      this._fps = this._fpsFrameCount;
      this._fpsFrameCount = 0;
    }, 1000);
  }
```

### Step 5: Add `disconnectedCallback` cleanup for FPS timer:

Add after `browserRegistry.setCallbacks(...)` in `disconnectedCallback`:
```typescript
    if (this._fpsTimer !== undefined) {
      clearInterval(this._fpsTimer);
      this._fpsTimer = undefined;
    }
    this._ctx = null;
    this._pendingFrame = null;
```

### Step 6: Replace the `render()` method:

```typescript
  override render() {
    return html`
      <div class="browser-toolbar"><!-- toolbar added in Task 6 --></div>
      <div class="canvas-wrap">
        <canvas id="viewport" tabindex="0"></canvas>
        <div class="status-bar">${this._statusText}</div>
      </div>
      ${this._downloading ? html`
        <div class="download-overlay">
          Downloading Chromium… ${this._downloadPercent}%
        </div>
      ` : ''}
      ${this._errorText ? html`
        <div class="error-banner">${this._errorText}</div>
      ` : ''}
    `;
  }
```

### Step 7: Add minimal layout CSS to static styles:

```typescript
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: var(--chrome-body);
      overflow: hidden;
      position: relative;
    }

    .browser-toolbar {
      flex-shrink: 0;
      height: 40px;
      background: var(--chrome-bar);
    }

    .canvas-wrap {
      flex: 1;
      position: relative;
      overflow: hidden;
    }

    canvas {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
      cursor: default;
      outline: none;
    }

    .status-bar {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 2px 8px;
      font-size: 11px;
      background: var(--chrome-bar);
      color: var(--chrome-text-dim);
      opacity: 0;
      transition: opacity 0.15s;
      pointer-events: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-bar.visible { opacity: 1; }

    .download-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: color-mix(in srgb, var(--chrome-body) 85%, transparent);
      color: var(--chrome-text-bright);
      font-size: 14px;
    }

    .error-banner {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 8px 16px;
      background: var(--mux-error);
      color: var(--chrome-body);
      font-size: 13px;
    }
  `;
```

Remove the `void wsBrowser; void SessiondType;` suppression lines from the end — they'll be used in later tasks (they were suppressors for Task 4 only).

### Step 8: Verify

```bash
cd web && npm run check:fast
```

Expected: `0 errors`.

### Step 9: Commit

```bash
git add web/src/components/mux-browser-pane.ts
git commit -m "feat: add canvas JPEG rendering to mux-browser-pane

- renderFrame via Blob URL + Image + ctx.drawImage (proven in spike)
- Latest-frame-wins: rAF-scheduled _flushFrame discards stale frames
- Canvas resizes when incoming frame dimensions change
- 1-second FPS counter updates _fps state for the badge
- Layout: toolbar placeholder + canvas-wrap + status-bar + overlays

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 6: Add browser toolbar to `mux-browser-pane.ts`

**Files:**
- Modify: `web/src/components/mux-browser-pane.ts`

Replace the `<!-- toolbar added in Task 6 -->` placeholder with the real Chrome-like toolbar and wire the ResizeObserver for viewport resize relay.

### Step 1: Add ResizeObserver field inside the class:

```typescript
  private _resizeObserver: ResizeObserver | null = null;
```

### Step 2: Wire ResizeObserver in `firstUpdated()` (after `this._ctx` assignment):

```typescript
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
```

### Step 3: Add cleanup in `disconnectedCallback()`:

```typescript
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
```

### Step 4: Replace the `render()` method with full toolbar HTML:

```typescript
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
          Downloading Chromium… ${this._downloadPercent}%
        </div>
      ` : ''}
      ${this._errorText ? html`
        <div class="error-banner">${this._errorText}</div>
      ` : ''}
    `;
  }
```

### Step 5: Add URL parsing helper and navigation handlers:

```typescript
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
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'navigate', url },
    });
  }
```

### Step 6: Remove suppressor imports if still present, ensure `SessiondType` and `wsBrowser` imports are kept.

### Step 7: Verify

```bash
cd web && npm run check:fast
```

Expected: `0 errors`.

### Step 8: Commit

```bash
git add web/src/components/mux-browser-pane.ts
git commit -m "feat: add browser toolbar to mux-browser-pane

Chrome-like toolbar: circular ghost nav buttons (back/forward SVG),
pill omnibox with lock icon / host / path / reload-inside-pill,
FPS badge and live dot. URL bar enters edit mode on click, navigates
on Enter. ResizeObserver relays viewport size changes to Chromium.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 7: Add complete theme CSS to `mux-browser-pane.ts`

**Files:**
- Modify: `web/src/components/mux-browser-pane.ts`

Replace the minimal `static styles` block with the full zero-hardcoded-color CSS.

### Step 1: Replace `static styles = css\`...\`` with the full block:

```typescript
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

    /* ── Toolbar ──────────────────────────────────────────────────────────── */

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
```

Also update the download overlay in `render()` to use the progress bar:

```typescript
      ${this._downloading ? html`
        <div class="download-overlay">
          <div>Downloading Chromium… ${this._downloadPercent}%</div>
          <div class="download-bar">
            <div class="download-fill" style="width:${this._downloadPercent}%"></div>
          </div>
        </div>
      ` : ''}
```

### Step 2: Verify

```bash
cd web && npm run check:fast
```

Expected: `0 errors`.

### Step 3: Commit

```bash
git add web/src/components/mux-browser-pane.ts
git commit -m "feat: add complete theme CSS to mux-browser-pane

Zero hardcoded colors — all values use var(--chrome-*) and var(--mux-*)
tokens set globally by applyChromeTokens(). Covers: circular ghost nav
buttons, pill omnibox with reload inside, FPS badge, pulsing live dot,
status bar, download progress bar, error banner. Updates across all
8 muxterm palettes (dark + light) automatically.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 8: Add mouse event relay to `mux-browser-pane.ts`

**Files:**
- Modify: `web/src/components/mux-browser-pane.ts`

### Step 1: Add coordinate mapping helper inside the class:

```typescript
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
```

### Step 2: Add mouse event handler methods:

```typescript
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
```

### Step 3: Wire up events in `firstUpdated()` after the ResizeObserver setup:

```typescript
    // Mouse events on the canvas — passive:false for wheel so we can preventDefault.
    const cv = this._canvas;
    cv.addEventListener('mousemove', (e) => this._onMouseMove(e));
    cv.addEventListener('mousedown', (e) => this._onMouseDown(e));
    cv.addEventListener('mouseup', (e) => this._onMouseUp(e));
    cv.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    // Leave pointer when exiting canvas
    cv.addEventListener('mouseleave', () => {
      this._statusText = '';
    });
```

### Step 4: Verify

```bash
cd web && npm run check:fast
```

Expected: `0 errors`.

### Step 5: Commit

```bash
git add web/src/components/mux-browser-pane.ts
git commit -m "feat: add mouse event relay to mux-browser-pane

mousemove/mousedown/mouseup send coordinate-mapped events to Chromium.
wheel uses {passive:false} + preventDefault so page scrolling works.
Coordinates mapped via getBoundingClientRect() scale factors (proven
in the spike). mouseleave clears the status bar.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 9: Add keyboard event relay to `mux-browser-pane.ts`

**Files:**
- Modify: `web/src/components/mux-browser-pane.ts`

### Step 1: Add `_isPrintable` helper:

```typescript
  /**
   * Returns true for single printable characters (not modifier, arrow, function,
   * or control keys). Used to decide whether to send an additional 'type' event.
   */
  private _isPrintable(key: string): boolean {
    return key.length === 1;
  }
```

### Step 2: Add keyboard event handlers:

```typescript
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
```

### Step 3: Wire keyboard events in `firstUpdated()` on the canvas:

```typescript
    cv.addEventListener('keydown', (e) => this._onKeyDown(e));
    cv.addEventListener('keyup', (e) => this._onKeyUp(e));
```

### Step 4: Verify

```bash
cd web && npm run check:fast
```

Expected: `0 errors`.

### Step 5: Commit

```bash
git add web/src/components/mux-browser-pane.ts
git commit -m "feat: add keyboard event relay to mux-browser-pane

keydown sends key name; printable chars also send a 'type' event so
Chromium processes text input (proven in the spike). Modifier combos
(Ctrl/Cmd+*) pass through without preventDefault. editingUrl guard
prevents relaying keystrokes while the omnibox is open.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 10: Add URL input handling to `mux-browser-pane.ts`

**Files:**
- Modify: `web/src/components/mux-browser-pane.ts`

The URL bar and navigation handlers were added in Task 6. This task validates that URL updates from the server flow through correctly and ensures the omnibox edit/navigate cycle is complete and type-safe.

### Step 1: Verify `_onUrl` callback updates both `_url` and `_urlInput`:

Confirm the `_onUrl` handler reads:
```typescript
  private _onUrl = (url: string): void => {
    this._url = url;
    if (!this._editingUrl) this._urlInput = url;
  };
```

If `_editingUrl` is true when a navigation completes (user typed a URL and is now loading), the omnibox should exit edit mode and reflect the actual loaded URL. Update `_onUrl`:

```typescript
  private _onUrl = (url: string): void => {
    this._url = url;
    // Always exit edit mode when the page reports a new URL — the navigation succeeded.
    this._editingUrl = false;
    this._urlInput = url;
  };
```

### Step 2: Add a `_navigateToUrl` method used by both Enter and blur-with-partial-input:

Confirm `_navigate` (added in Task 6) already sends the right message. It should be:

```typescript
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
```

### Step 3: Update `_onUrlKeyDown` to call `_navigate` not the old navigate:

Confirm it reads:
```typescript
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
```

### Step 4: Verify

```bash
cd web && npm run check:fast
```

Expected: `0 errors`.

### Step 5: Commit

```bash
git add web/src/components/mux-browser-pane.ts
git commit -m "feat: complete URL input handling in mux-browser-pane

- _onUrl exits edit mode when navigation completes (page confirms URL)
- _navigate auto-prefixes https:// when scheme is absent (mirrors Go)
- Escape in omnibox cancels edit and restores the current URL
- Enter navigates and exits edit mode

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 11: Add status bar (hover link preview) to `mux-browser-pane.ts`

**Files:**
- Modify: `web/src/components/mux-browser-pane.ts`

The status bar DOM element and CSS were added in Task 7. This task wires the `onStatus` callback from `browserRegistry` so that future `browser-status` server messages (not in Phase 1 but designed into the registry) populate the bar. Also adds a public `setStatus()` method for use by `BrowserRenderer` and tests.

### Step 1: Add `onStatus` to `BrowserPaneCallbacks` in `browser-registry.ts`

Open `web/src/lib/browser-registry.ts` and add to the interface:

```typescript
export interface BrowserPaneCallbacks {
  onFrame: ((jpegBytes: Uint8Array) => void) | null;
  onUrl: ((url: string) => void) | null;
  onError: ((error: string) => void) | null;
  onDownload: ((percent: number) => void) | null;
  /** Called with the URL of the link currently under the cursor (empty string = no link). */
  onStatus: ((statusText: string) => void) | null;
}
```

In `ensure()`, add `onStatus: null` to the initial object:
```typescript
    _map.set(paneId, { onFrame: null, onUrl: null, onError: null, onDownload: null, onStatus: null });
```

Add `dispatchStatus()` to `browserRegistry`:
```typescript
  /** Route a browser-status message to the registered pane element. */
  dispatchStatus(paneId: number, statusText: string): void {
    _map.get(paneId)?.onStatus?.(statusText);
  },
```

### Step 2: Update `ws-browser.ts` to handle `browser-status` messages

In the JSON message handler inside `BrowserSocket._open()`, add after the `browser-error` check:

```typescript
          } else if (type === 'browser-status' && typeof msg['text'] === 'string') {
            this.onBrowserStatus?.(paneId, msg['text']);
          }
```

Add the callback property to `BrowserSocket`:
```typescript
  onBrowserStatus: ((paneId: number, text: string) => void) | null = null;
```

### Step 3: Wire `onStatus` in `mux-browser-pane.ts`

Add `_onStatus` callback and register it:

```typescript
  private _onStatus = (statusText: string): void => {
    this._statusText = statusText;
  };
```

In `connectedCallback`, add to `setCallbacks`:
```typescript
      onStatus: this._onStatus,
```

In `disconnectedCallback`, add:
```typescript
      onStatus: null,
```

### Step 4: Wire `wsBrowser.onBrowserStatus` in `app.ts` (Task 14 will do the full wiring, but add the handler stub here in ws-browser.ts)

In `ws-browser.ts`, the `wsBrowser` singleton already has `onBrowserStatus = null`. The `app.ts` Task 14 will set it to `(paneId, text) => browserRegistry.dispatchStatus(paneId, text)`.

### Step 5: Verify both files

```bash
cd web && npm run check:fast
```

Expected: `0 errors`.

### Step 6: Commit

```bash
git add web/src/lib/browser-registry.ts web/src/lib/ws-browser.ts \
         web/src/components/mux-browser-pane.ts
git commit -m "feat: add status bar with browser-status event pipeline

- browserRegistry gains onStatus callback + dispatchStatus()
- BrowserSocket gains onBrowserStatus handler + browser-status JSON parsing
- mux-browser-pane registers _onStatus callback, updates _statusText state
- Status bar div fades in (via .visible CSS class) when text is non-empty
- Future: Phase 1 Go emits browser-status when CDP reports link hover

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 12: Add globe button to `mux-dock-bar.ts` + `createBrowserPane()` to `ws.ts`

**Files:**
- Modify: `web/src/components/mux-dock-bar.ts`
- Modify: `web/src/ws.ts`

### Step 1: Add `createBrowserPane()` to `MuxSocket` in `ws.ts`

After `closeTunnel()` / `listTunnels()`, add:

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

### Step 2: Add the globe button to `mux-dock-bar.ts`

**Add CSS** for the globe button before `.conn-dot`:

```typescript
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

**Add the button handler**:

```typescript
  private _onGlobeClick(): void {
    const existing = store.panes.find((p) => p.surfaceKind === 'browser-cdp');
    if (existing) {
      // Activate the existing pane via a window event handled by app.ts.
      window.dispatchEvent(
        new CustomEvent('browser-pane-focus', { detail: { paneId: existing.paneId } }),
      );
    } else {
      // Request a new browser pane — app.ts calls socket.createBrowserPane().
      window.dispatchEvent(new CustomEvent('create-browser-pane'));
    }
  }
```

**Add the globe SVG button to `render()`**, immediately before the `conn-dot` div:

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

### Step 3: Verify

```bash
cd web && npm run check:fast
```

Expected: `0 errors`.

### Step 4: Commit

```bash
git add web/src/components/mux-dock-bar.ts web/src/ws.ts
git commit -m "feat: add globe browser button to mux-dock-bar + ws.ts createBrowserPane

- Globe button in mux-dock-bar right cluster:
  - Green tint (--mux-ok) while any browser-cdp pane is live in store
  - First click: dispatches window 'create-browser-pane' event
  - Second click (pane live): dispatches window 'browser-pane-focus'
- MuxSocket.createBrowserPane() / closeBrowserPane() methods added
- Button + handler use window events (mux-dock-bar not yet in app tree)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 13: Register `browser-cdp` surface kind in `mux-dock.ts`

**Files:**
- Modify: `web/src/components/mux-dock.ts`

Add a `BrowserRenderer` class (parallel to `TerminalRenderer`) and update the dockview `createComponent` factory to use it for `browser-cdp` panes.

### Step 1: Add the import for `mux-browser-pane.ts` at the top of `mux-dock.ts`

After the existing imports, add:

```typescript
// Side-effect import: registers <mux-browser-pane> custom element
import './mux-browser-pane.js';
```

### Step 2: Add `BrowserRenderer` class after the `TerminalRenderer` class (before `HeaderButton`):

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

### Step 3: Update the `createComponent` factory in `connectedCallback`

Find (in `connectedCallback`, inside `new DockviewComponent(this, {...})`):

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

### Step 4: Verify

```bash
cd web && npm run check:fast
```

Expected: `0 errors`.

### Step 5: Commit

```bash
git add web/src/components/mux-dock.ts
git commit -m "feat: register browser-cdp surface kind in mux-dock

BrowserRenderer implements IContentRenderer: creates a container div
with a <mux-browser-pane pane-id=N> child. createComponent() factory
checks opts.name for 'browser-cdp' and returns BrowserRenderer;
all other kinds fall back to TerminalRenderer as before.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 14: Wire `browserRegistry` and `wsBrowser` into `app.ts`

**Files:**
- Modify: `web/src/app.ts`

This task wires four things:
1. `wsBrowser.connect()` / `disconnect()` in `connectedCallback` / `disconnectedCallback`
2. `wsBrowser` frame/url/error/download callbacks → `browserRegistry`
3. `_syncTerminals()` skips browser-cdp panes for `terminalRegistry`, calls `browserRegistry.ensure()`
4. Composition handler skips browser-cdp panes for terminal setup
5. Window event listeners for `create-browser-pane` and `browser-pane-focus`

### Step 1: Add imports at the top of `app.ts`

```typescript
import { browserRegistry } from './lib/browser-registry.js';
import { wsBrowser } from './lib/ws-browser.js';
```

### Step 2: Add window event handlers as class fields

After `private _onViewportResize`:

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

### Step 3: Add `activatePane()` to `MuxDock` in `mux-dock.ts`

> **Note:** Add this public method to `MuxDock` at the end of the class body (before the `declare global` block):

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

### Step 4: In `connectedCallback`, after `this._socket.connect()`, add:

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

### Step 5: In `disconnectedCallback`, add cleanup:

```typescript
    wsBrowser.disconnect();
    window.removeEventListener('create-browser-pane', this._onCreateBrowserPane);
    window.removeEventListener('browser-pane-focus', this._onBrowserPaneFocus);
```

### Step 6: Update the composition handler inside `onSessiondMessage`

Find the `if (msg.type === SessiondType.Composition)` block. Inside the `for (const pane of (msg.panes ?? []))` loop, add a guard so browser-cdp panes skip terminal setup:

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

### Step 7: Update `_syncTerminals()` to handle browser-cdp panes

Find the `for (const pane of store.panes)` loop inside `_syncTerminals()` and add the browser-cdp guard:

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

### Step 8: Verify

```bash
cd web && npm run check:fast
```

Expected: `0 errors`.

### Step 9: Commit

```bash
git add web/src/app.ts web/src/components/mux-dock.ts
git commit -m "feat: wire browserRegistry + wsBrowser into app.ts composition pipeline

- wsBrowser connects/disconnects with the main socket lifecycle
- Frame/url/error/download/status callbacks route through browserRegistry
- Composition handler: browser-cdp panes use browserRegistry.ensure()
  instead of terminalRegistry setup (no xterm, no replay bytes)
- _syncTerminals: browser-cdp panes call browserRegistry.ensure(), skip
  terminalRegistry; both registries pruned with the same liveIds set
- Window events: 'create-browser-pane' → socket.createBrowserPane();
  'browser-pane-focus' → dock.activatePane(paneId)
- MuxDock.activatePane() added for programmatic pane activation

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 15: Final production build verification

**Files:** None (verification only)

### Step 1: Run the full production build

```bash
cd web && npm run build
```

This runs `tsc --noEmit` (full type check, not just tsgo) then `vite build`.

Expected output: Build completes with no errors. Warnings are OK. Final output is in `web/dist/`.

Typical success indicators:
```
✓ built in X.XXs
```

### Step 2: If the build fails — diagnose

- `tsc --noEmit` errors: TypeScript type errors not caught by tsgo. Fix each one.
- `vite build` errors: bundler import resolution issues. Check that all `.js` extension imports are correct.
- Common issue: a new file imported with a `.ts` extension instead of `.js` — change to `.js`.

### Step 3: Run the fast check one final time

```bash
cd web && npm run check:fast
```

Expected: `0 errors`.

### Step 4: Commit if any build fixes were needed

If Step 1 required any fixes, commit them:

```bash
git add -A
git commit -m "fix: resolve full tsc build errors from browser CDP phase 2

[describe specific fixes]

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Summary

| Task | File(s) | What it adds |
|------|---------|--------------|
| 1 | `types.ts`, `state.ts`, `protocol.types.test.ts` | Browser CDP type constants, remove old browser proxy types |
| 2 | `lib/ws-browser.ts` | `BrowserSocket` + `wsBrowser` singleton |
| 3 | `lib/browser-registry.ts` | `browserRegistry` per-pane callback routing |
| 4 | `components/mux-browser-pane.ts` | Lit element skeleton, `@property paneId`, registry wiring |
| 5 | `components/mux-browser-pane.ts` | Canvas rendering: `_renderFrame`, FPS counter, layout CSS |
| 6 | `components/mux-browser-pane.ts` | Chrome-like toolbar: nav buttons, omnibox pill, reload inside pill, FPS badge, live dot, ResizeObserver |
| 7 | `components/mux-browser-pane.ts` | Complete theme CSS — zero hardcoded colors, all `var(--chrome-*)` / `var(--mux-*)` |
| 8 | `components/mux-browser-pane.ts` | Mouse event relay: mousemove/down/up/wheel with coordinate mapping |
| 9 | `components/mux-browser-pane.ts` | Keyboard event relay: keydown/keyup/type |
| 10 | `components/mux-browser-pane.ts` | URL input: Enter navigates, https:// auto-prefix, edit mode lifecycle |
| 11 | `lib/browser-registry.ts`, `lib/ws-browser.ts`, `components/mux-browser-pane.ts` | Status bar + `browser-status` event pipeline |
| 12 | `components/mux-dock-bar.ts`, `ws.ts` | Globe button + `createBrowserPane()` / `closeBrowserPane()` |
| 13 | `components/mux-dock.ts` | `BrowserRenderer` + `createComponent` factory update, `activatePane()` |
| 14 | `app.ts`, `components/mux-dock.ts` | Full wiring: connect/disconnect, composition, `_syncTerminals`, window events |
| 15 | — | `npm run build` production verification |

**New files:** `web/src/lib/ws-browser.ts`, `web/src/lib/browser-registry.ts`, `web/src/components/mux-browser-pane.ts`

**Modified files:** `web/src/types.ts`, `web/src/state.ts`, `web/src/__tests__/protocol.types.test.ts`, `web/src/ws.ts`, `web/src/app.ts`, `web/src/components/mux-dock.ts`, `web/src/components/mux-dock-bar.ts`
