/**
 * browser-registry — per-pane callback routing for browser CDP panes.
 *
 * Module-level singleton that mirrors the terminal-registry pattern but is
 * much simpler: no xterm.js, no settle/drain complexity, no scrollback.
 *
 * Each <mux-browser-pane> element registers callbacks here; the BrowserSocket
 * calls write()/dispatchUrl()/etc. to fan out events to the relevant pane.
 */

/** Callbacks registered by a <mux-browser-pane> element. */
export interface BrowserPaneCallbacks {
  /** Invoked with a new JPEG frame from the CDP browser. */
  onFrame: ((jpegBytes: Uint8Array) => void) | null;
  /** Invoked when the browser navigates to a new URL. */
  onUrl: ((url: string) => void) | null;
  /** Invoked when the browser emits a navigation/render error. */
  onError: ((error: string) => void) | null;
  /** Invoked with download progress (0–100). */
  onDownload: ((percent: number) => void) | null;
  /** Invoked with a status text update (e.g. "Loading…"). */
  onStatus: ((statusText: string) => void) | null;
}

// Module-level singleton map: paneId → callbacks.
const _map = new Map<number, BrowserPaneCallbacks>();

/** Create a blank callbacks entry with all fields null. */
function _blankEntry(): BrowserPaneCallbacks {
  return {
    onFrame: null,
    onUrl: null,
    onError: null,
    onDownload: null,
    onStatus: null,
  };
}

/**
 * Per-pane callback routing registry for browser CDP panes.
 *
 * Usage:
 *   - Call ensure(paneId) for every browser-cdp pane in composition from app.ts.
 *   - Call setCallbacks(paneId, cbs) from <mux-browser-pane>.connectedCallback().
 *   - BrowserSocket calls write()/dispatchUrl()/etc. to fan out incoming events.
 */
export const browserRegistry = {
  /**
   * Idempotent: creates a callback slot for paneId if one does not exist.
   * Call this for every browser-cdp pane in the composition from app.ts.
   */
  ensure(paneId: number): void {
    if (!_map.has(paneId)) {
      _map.set(paneId, _blankEntry());
    }
  },

  /**
   * Register callbacks for a pane. Called by <mux-browser-pane> in connectedCallback.
   * Merges provided callbacks into the existing entry. Passing null for a field clears it.
   * No-op if the pane has not been ensured.
   */
  setCallbacks(paneId: number, cbs: Partial<BrowserPaneCallbacks>): void {
    const entry = _map.get(paneId);
    if (!entry) return;
    if ('onFrame' in cbs) entry.onFrame = cbs.onFrame ?? null;
    if ('onUrl' in cbs) entry.onUrl = cbs.onUrl ?? null;
    if ('onError' in cbs) entry.onError = cbs.onError ?? null;
    if ('onDownload' in cbs) entry.onDownload = cbs.onDownload ?? null;
    if ('onStatus' in cbs) entry.onStatus = cbs.onStatus ?? null;
  },

  /**
   * Route a JPEG frame to the registered onFrame callback for this pane.
   * No-op if pane is unknown or callback is not registered.
   */
  write(paneId: number, jpegBytes: Uint8Array): void {
    _map.get(paneId)?.onFrame?.(jpegBytes);
  },

  /**
   * Dispatch a URL navigation event to the registered onUrl callback.
   * No-op if pane is unknown or callback is not registered.
   */
  dispatchUrl(paneId: number, url: string): void {
    _map.get(paneId)?.onUrl?.(url);
  },

  /**
   * Dispatch an error event to the registered onError callback.
   * No-op if pane is unknown or callback is not registered.
   */
  dispatchError(paneId: number, error: string): void {
    _map.get(paneId)?.onError?.(error);
  },

  /**
   * Dispatch a download progress event to the registered onDownload callback.
   * No-op if pane is unknown or callback is not registered.
   */
  dispatchDownload(paneId: number, percent: number): void {
    _map.get(paneId)?.onDownload?.(percent);
  },

  /**
   * Dispatch a status text update to the registered onStatus callback.
   * No-op if pane is unknown or callback is not registered.
   */
  dispatchStatus(paneId: number, statusText: string): void {
    _map.get(paneId)?.onStatus?.(statusText);
  },

  /**
   * Remove entries for pane IDs no longer in the live composition.
   * Clears all callbacks before deleting so any in-flight async frame
   * dispatch becomes a no-op rather than a stale call.
   */
  prune(liveIds: Set<number>): void {
    for (const [paneId, entry] of _map.entries()) {
      if (!liveIds.has(paneId)) {
        // Null out callbacks first — in-flight dispatches become no-ops.
        entry.onFrame = null;
        entry.onUrl = null;
        entry.onError = null;
        entry.onDownload = null;
        entry.onStatus = null;
        _map.delete(paneId);
      }
    }
  },

  /**
   * Returns true if a callback slot exists for paneId.
   */
  has(paneId: number): boolean {
    return _map.has(paneId);
  },
};
