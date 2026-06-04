/**
 * terminal-registry — persistent per-pane Terminal owner.
 *
 * Module-level singleton that owns one xterm.js Terminal per pane ID.
 * Terminals are created once (in ensure()) and survive tab/window switches
 * (detach() only removes the DOM host element; the Terminal and its
 * scrollback buffer remain alive). The terminal is only disposed when the
 * pane closes in tmux (via prune()).
 *
 * This is the iTerm2 model: the client owns scrollback, and background
 * windows stay fed via write() even while their host element is detached.
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { resolvePalette } from './theme.js';
import { serializeSnapshot } from './snapshot.js';
import type { StructuredSnapshot, SnapshotSource } from './snapshot.js';
import type { ResolvedConfig } from './config.js';
import { DEFAULT_RESOLVED_CONFIG } from './config.js';

/**
 * Build an xterm.js Terminal options object from a ResolvedConfig.
 * lineHeight, allowTransparency, and convertEol are hardcoded and non-overridable.
 */
export function buildTerminalConfig(cfg: ResolvedConfig) {
  return {
    theme: resolvePalette(cfg.theme.palette),
    fontFamily: cfg.font.family,
    fontSize: cfg.font.size,
    lineHeight: 1.2, // non-overridable
    cursorBlink: cfg.terminal.cursorBlink,
    cursorStyle: cfg.terminal.cursorStyle,
    scrollback: cfg.terminal.scrollback,
    allowTransparency: false, // non-overridable
    convertEol: false, // tmux sends \r\n — don't double-convert; non-overridable
  };
}

let TERMINAL_CONFIG = buildTerminalConfig(DEFAULT_RESOLVED_CONFIG);

/**
 * Reconfigure the terminal defaults from a ResolvedConfig.
 * NOTE: No hot-reload in v1 — existing Terminals keep current options;
 * only Terminals created after this call pick up the new config.
 */
export function configureTerminals(cfg: ResolvedConfig): void {
  TERMINAL_CONFIG = buildTerminalConfig(cfg);
}

export interface PaneHandlers {
  /** Called when the user types / pastes / SGR mouse events arrive. */
  onInput: (data: Uint8Array) => void;
  /** Called (idempotently) when the terminal cols/rows change. */
  onResize: (cols: number, rows: number) => void;
}

interface PaneEntry {
  term: Terminal;
  fitAddon: FitAddon;
  /** Stable host element that moves between containers on attach/detach. */
  hostEl: HTMLElement;
  handlers: PaneHandlers;
  /** Last dimensions reported to the server — gate for idempotent resize. */
  lastCols: number;
  lastRows: number;
  /** True once term.open(hostEl) has been called (on first attach). */
  opened: boolean;
  /** Data buffered before first attach (before term.open). */
  pendingData: (Uint8Array | string)[];
  resizeObserver: ResizeObserver | null;
  resizeTimer: ReturnType<typeof setTimeout> | undefined;
}

// Module-level state — never re-created between tab switches.
// Keys are composite "${workspaceId}:${paneId}" so paneId reuse across
// workspaces never causes cross-workspace scrollback bleed. Switching the
// attached workspace changes _currentWorkspaceId without disposing old
// workspace terminals, so scrollback is preserved when switching back.
const _map = new Map<string, PaneEntry>();
// Data written for a (workspace, pane) before ensure() was called.
const _preEnsureBuffer = new Map<string, (Uint8Array | string)[]>();
const _encoder = new TextEncoder();

// Current workspace — set by setWorkspace() on every composition update.
let _currentWorkspaceId = '';

/** Compute the composite registry key for the current workspace. */
function _key(paneId: number): string {
  return `${_currentWorkspaceId}:${paneId}`;
}

function _isVisible(el: HTMLElement): boolean {
  // offsetParent is null when element is display:none or disconnected.
  return el.isConnected && el.offsetParent !== null;
}

export const terminalRegistry = {
  /**
   * Set the current workspace ID. All subsequent calls to ensure(), write(),
   * attach(), etc. will operate on panes within this workspace.
   * Call this whenever the attached workspace changes so that workspace-local
   * paneIds (reused across workspaces) are isolated correctly.
   */
  setWorkspace(workspaceId: string): void {
    _currentWorkspaceId = workspaceId;
  },

  /**
   * Idempotent: creates a Terminal for paneId if one does not exist.
   * Call this for every known pane on every state update so that terminals
   * are ready before their mux-pane shell connects to the DOM.
   */
  ensure(paneId: number, handlers: PaneHandlers): void {
    const key = _key(paneId);
    if (_map.has(key)) {
      // Update handlers so reconnected sockets get fresh callbacks.
      _map.get(key)!.handlers = handlers;
      return;
    }

    // Host element: a plain div that moves between shadow-DOM containers.
    const hostEl = document.createElement('div');
    hostEl.style.cssText = 'width:100%;height:100%;';

    const term = new Terminal(TERMINAL_CONFIG);
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    const entry: PaneEntry = {
      term,
      fitAddon,
      hostEl,
      handlers,
      lastCols: -1,
      lastRows: -1,
      opened: false,
      pendingData: [],
      resizeObserver: null,
      resizeTimer: undefined,
    };

    // Forward text input (keystrokes + SGR mouse) as UTF-8 bytes.
    term.onData((data: string) => {
      entry.handlers.onInput(_encoder.encode(data));
    });

    // Forward legacy binary mouse reports (X10/UTF-8 encoding).
    // onBinary is part of the xterm.js public API but may not exist on all
    // mock implementations — guard defensively.
    if (typeof (term as any).onBinary === 'function') {
      (term as any).onBinary((data: string) => {
        const bytes = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
        entry.handlers.onInput(bytes);
      });
    }

    // Resize: idempotent — only fires handler when dimensions actually change.
    term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      if (cols === entry.lastCols && rows === entry.lastRows) return;
      entry.lastCols = cols;
      entry.lastRows = rows;
      entry.handlers.onResize(cols, rows);
    });

    _map.set(key, entry);

    // Drain any data that arrived before ensure() was called.
    const preBuffer = _preEnsureBuffer.get(key);
    if (preBuffer) {
      for (const chunk of preBuffer) entry.pendingData.push(chunk);
      _preEnsureBuffer.delete(key);
    }
  },

  /**
   * Attach the terminal's host element into the given container.
   * On first call: opens the terminal (term.open). On subsequent calls
   * (re-attach after tab switch): re-parents the existing host element,
   * preserving all scrollback.
   */
  attach(paneId: number, container: HTMLElement): void {
    const key = _key(paneId);
    const entry = _map.get(key);
    if (!entry) return;

    const isFirstOpen = !entry.opened;

    if (!entry.opened) {
      // Open terminal in the stable host element — only ever called once.
      entry.term.open(entry.hostEl);
      entry.opened = true;
    }

    // Move (or insert) the host element into the new container.
    container.appendChild(entry.hostEl);

    // ResizeObserver: 50ms debounce, fit only when visible.
    // Reconnect on each attach (was disconnected in detach()).
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (entry.resizeTimer !== undefined) clearTimeout(entry.resizeTimer);
        entry.resizeTimer = setTimeout(() => {
          requestAnimationFrame(() => terminalRegistry.fitIfVisible(paneId));
        }, 50);
      });
      ro.observe(entry.hostEl);
      entry.resizeObserver = ro;
    }

    // Eager fit — gives the PTY correct dimensions as soon as possible.
    terminalRegistry.fitIfVisible(paneId);

    if (isFirstOpen) {
      // Defer the pendingData drain until after the custom font has loaded.
      // fitAddon.fit() uses character cell pixel dimensions to calculate
      // cols/rows. If SF Mono / JetBrains Mono hasn't loaded yet, it falls
      // back to generic monospace metrics → wrong cols/rows → replay bytes
      // (PTY buffer from sessiond) write ANSI cursor sequences at wrong
      // dimensions → garbled $$$$~~~~~ at the top of the terminal.
      // Draining AFTER fonts.ready guarantees the re-fit uses real metrics
      // before any replay data touches the terminal grid.
      const drainPending = (): void => {
        if (!_map.has(key)) return;
        terminalRegistry.fitIfVisible(paneId); // re-fit with real font metrics
        const pending = entry.pendingData.splice(0);
        for (const chunk of pending) {
          entry.term.write(chunk);
        }
      };
      if (typeof document !== 'undefined' && document.fonts?.ready) {
        document.fonts.ready.then(() => requestAnimationFrame(drainPending));
      } else {
        requestAnimationFrame(drainPending);
      }
    } else {
      // Re-attach after workspace switch: pendingData is typically empty
      // (live data flowed directly while opened=true), so this is a no-op
      // in normal operation. Drain synchronously for correctness.
      for (const chunk of entry.pendingData) {
        entry.term.write(chunk);
      }
      entry.pendingData = [];
    }

    entry.term.focus();
  },

  /**
   * Detach the host element from its current container.
   * Does NOT dispose the Terminal — the registry still owns it and will
   * continue to feed it via write(). The scrollback is fully preserved.
   */
  detach(paneId: number): void {
    const entry = _map.get(_key(paneId));
    if (!entry) return;

    // Stop ResizeObserver so the hidden pane doesn't get spurious resizes.
    entry.resizeObserver?.disconnect();
    entry.resizeObserver = null;
    if (entry.resizeTimer !== undefined) {
      clearTimeout(entry.resizeTimer);
      entry.resizeTimer = undefined;
    }

    // Remove hostEl from its current parent (keeps it alive in JS).
    entry.hostEl.parentNode?.removeChild(entry.hostEl);
  },

  /**
   * Fit the terminal to its container — only when the host element is visible.
   * No-op if the terminal has never been opened or is not in the DOM.
   */
  fitIfVisible(paneId: number): void {
    const entry = _map.get(_key(paneId));
    if (!entry || !entry.opened) return;
    if (!_isVisible(entry.hostEl)) return;
    entry.fitAddon.fit();
  },

  /** Focus the terminal for keyboard input. */
  focus(paneId: number): void {
    _map.get(_key(paneId))?.term.focus();
  },

  /**
   * Write data to the terminal. Works before attach (buffered) and while the
   * terminal is hidden (background window stays current). If ensure() has not
   * yet been called for paneId, the data is buffered in a pre-ensure queue
   * and drained when ensure() is later called.
   */
  write(paneId: number, data: Uint8Array | string): void {
    const key = _key(paneId);
    const entry = _map.get(key);
    if (entry) {
      if (entry.opened) {
        entry.term.write(data);
      } else {
        // Queued until first attach.
        entry.pendingData.push(data);
      }
    } else {
      // Pre-ensure buffer: ensure() hasn't been called yet.
      if (!_preEnsureBuffer.has(key)) _preEnsureBuffer.set(key, []);
      _preEnsureBuffer.get(key)!.push(data);
    }
  },

  /**
   * Reset all terminals (ESC c = RIS).
   * Called on full-sync (reconnect) before new capture-pane content arrives.
   */
  resetAll(): void {
    for (const entry of _map.values()) {
      if (entry.opened) {
        entry.term.write('\x1bc');
      } else {
        // Clear pending data — stale pre-open content has no value after reset.
        entry.pendingData = [];
      }
    }
  },

  /**
   * Dispose terminals for pane IDs that are no longer live in the current
   * workspace. Only affects the current workspace's panes; terminals from
   * other workspaces are left alive so their scrollback is preserved.
   */
  prune(liveIds: Set<number>): void {
    const prefix = `${_currentWorkspaceId}:`;
    for (const [key, entry] of _map.entries()) {
      if (!key.startsWith(prefix)) continue; // preserve other workspaces
      const paneId = parseInt(key.slice(prefix.length), 10);
      if (!liveIds.has(paneId)) {
        entry.resizeObserver?.disconnect();
        if (entry.resizeTimer !== undefined) clearTimeout(entry.resizeTimer);
        entry.term.dispose();
        _map.delete(key);
      }
    }
    // Also clear pre-ensure buffer for panes that will never exist.
    for (const key of _preEnsureBuffer.keys()) {
      if (!key.startsWith(prefix)) continue;
      const paneId = parseInt(key.slice(prefix.length), 10);
      if (!liveIds.has(paneId)) _preEnsureBuffer.delete(key);
    }
  },

  /**
   * Dispose every terminal in the registry (all workspaces).
   * Use for full teardown on disconnect or test cleanup.
   * For workspace switching, prefer setWorkspace() instead — it preserves
   * scrollback by not disposing terminals from the previous workspace.
   */
  disposeAll(): void {
    for (const [, entry] of _map.entries()) {
      entry.resizeObserver?.disconnect();
      if (entry.resizeTimer !== undefined) clearTimeout(entry.resizeTimer);
      entry.term.dispose();
    }
    _map.clear();
    _preEnsureBuffer.clear();
  },

  /**
   * Return the Terminal instance for a pane in the current workspace, or null
   * if not ensured. Used by mux-dock for getTerminalContent().
   */
  getTerminal(paneId: number): Terminal | null {
    return _map.get(_key(paneId))?.term ?? null;
  },

  /**
   * Serialize the visible viewport of a pane's terminal into a StructuredSnapshot.
   * Returns null if the paneId is not known to the registry.
   */
  snapshot(paneId: number): StructuredSnapshot | null {
    const entry = _map.get(_key(paneId));
    if (!entry) return null;
    return serializeSnapshot(entry.term as unknown as SnapshotSource);
  },
};

if (typeof window !== 'undefined') {
  (window as unknown as { __muxterm?: Record<string, unknown> }).__muxterm = {
    ...(window as unknown as { __muxterm?: Record<string, unknown> }).__muxterm,
    snapshot: (paneId: number) => terminalRegistry.snapshot(paneId),
  };
}
