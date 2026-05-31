/**
 * Pop-out window lifecycle manager.
 *
 * Ownership model: the popped window OWNS ITS OWN control client — it loads
 * the same app URL with `?popout=<regionId>` and opens its own WebSocket to
 * the same Go backend.  The main document tracks the handle and fires
 * `onClose` so the region can be remounted in-page.
 *
 * One-window-one-surface invariant: `popOut` MOVES the surface — never
 * duplicates.
 */

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Minimal interface for a popup window.  A subset of the DOM `Window` type,
 * narrow enough for test injection while compatible with actual `Window`
 * instances.
 */
export interface PopoutWindowLike {
  /** True once the window has been closed. */
  closed: boolean;
  /** Close the window. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Options supplied when requesting a pop-out. */
export interface PopoutOptions {
  /** Identifies the region being popped out. */
  regionId: string;
  /** URL to load in the popup.  Defaults to `<origin>/?popout=<regionId>`. */
  url?: string;
  /** `window.open` features string, e.g. `"width=1200,height=800"`. */
  features?: string;
  /** Called exactly once when the popup window is closed (by the user or via `close()`). */
  onClose: () => void;
}

/** A handle to a currently popped-out window. */
export interface PopoutHandle {
  /** The region identifier. */
  regionId: string;
  /** Programmatically close the popup.  The poll will fire `onClose`. */
  close(): void;
  /** The underlying popup window. */
  readonly open: PopoutWindowLike;
}

/** Constructor options for `PopoutManager`. */
export interface PopoutManagerOptions {
  /**
   * Injectable replacement for `window.open` — use in tests to avoid real
   * browser popups.  Defaults to the global `window.open`.
   */
  open?: (url: string, target: string, features?: string) => PopoutWindowLike | null;
  /**
   * How often (in ms) to poll each popup window for closure.
   * Defaults to 400 ms.
   */
  pollIntervalMs?: number;
  /** Origin used when building the default popup URL.  Defaults to `window.location.origin`. */
  origin?: string;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface PopoutEntry {
  win: PopoutWindowLike;
  onClose: () => void;
  intervalId: ReturnType<typeof setInterval>;
  /** Guard to ensure `onClose` fires at most once. */
  fired: boolean;
}

// ---------------------------------------------------------------------------
// PopoutManager
// ---------------------------------------------------------------------------

/**
 * Manages pop-out windows: one window per region, with `setInterval`-based
 * close detection and idempotent open semantics.
 */
export class PopoutManager {
  private readonly entries = new Map<string, PopoutEntry>();
  private readonly openFn: (url: string, target: string, features?: string) => PopoutWindowLike | null;
  private readonly pollIntervalMs: number;
  private readonly origin: string;

  constructor(options: PopoutManagerOptions = {}) {
    this.openFn =
      options.open ??
      ((url, target, features) =>
        // eslint-disable-next-line no-restricted-globals
        window.open(url, target, features ?? '') as PopoutWindowLike | null);
    this.pollIntervalMs = options.pollIntervalMs ?? 400;
    this.origin =
      options.origin ??
      (typeof window !== 'undefined' ? window.location.origin : '');
  }

  /** Returns `true` if the given region is currently popped out. */
  isPoppedOut(regionId: string): boolean {
    return this.entries.has(regionId);
  }

  /**
   * Opens a popup for the given region, or returns the existing handle if
   * the region is already popped out (idempotent).
   *
   * @throws `Error('popout-blocked')` if the browser blocks the popup.
   */
  popOut(options: PopoutOptions): PopoutHandle {
    const { regionId, url, features, onClose } = options;

    // Idempotent: return existing handle without opening a second window.
    if (this.entries.has(regionId)) {
      return this._makeHandle(regionId);
    }

    const targetUrl =
      url ?? `${this.origin}/?popout=${encodeURIComponent(regionId)}`;

    const win = this.openFn(targetUrl, `popout-${regionId}`, features);
    if (win === null) {
      throw new Error('popout-blocked');
    }

    const entry: PopoutEntry = {
      win,
      onClose,
      fired: false,
      // Interval ID filled in just below — TypeScript requires an initial value.
      intervalId: 0 as unknown as ReturnType<typeof setInterval>,
    };

    entry.intervalId = setInterval(() => {
      const e = this.entries.get(regionId);
      if (!e || e.fired) return;

      if (e.win.closed) {
        e.fired = true;
        clearInterval(e.intervalId);
        this.entries.delete(regionId);
        e.onClose();
      }
    }, this.pollIntervalMs);

    this.entries.set(regionId, entry);

    return this._makeHandle(regionId);
  }

  /**
   * Programmatically close a popped-out window.
   * The existing poll will detect `win.closed` and fire `onClose`.
   * No-op if the region is not currently popped out.
   */
  close(regionId: string): void {
    const entry = this.entries.get(regionId);
    if (!entry) return;
    entry.win.close();
  }

  /**
   * Clears all intervals and drops all tracked entries.
   * Does NOT fire `onClose` for any remaining windows.
   */
  dispose(): void {
    for (const entry of this.entries.values()) {
      clearInterval(entry.intervalId);
    }
    this.entries.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _makeHandle(regionId: string): PopoutHandle {
    const manager = this;
    return {
      regionId,
      close(): void {
        manager.close(regionId);
      },
      get open(): PopoutWindowLike {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return manager.entries.get(regionId)!.win;
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/** Default singleton instance for application-wide pop-out management. */
export const popoutManager = new PopoutManager();
