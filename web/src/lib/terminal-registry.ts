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
import xtermCss from '@xterm/xterm/css/xterm.css?inline';
import { resolvePalette } from './theme.js';
import { muxLog } from './mux-log.js';

/**
 * Ensure xterm.js's stylesheet is present in the root node that actually
 * contains the terminal element. xterm renders inside whatever shadow root
 * (or document) hosts the dockview panel; WITHOUT its stylesheet, xterm's
 * internal helper elements (.xterm-helpers, .xterm-char-measure-element,
 * .xterm-helper-textarea) are not position/visibility-hidden and leak into
 * view as garbled runs of $ and ~.
 *
 * Injecting at attach time using the host element's OWN getRootNode()
 * guarantees the stylesheet lands in the exact root where the terminal lives —
 * no reliance on a parent component's render-root timing.
 */
const XTERM_STYLE_ID = 'xterm-base-css';
function ensureXtermCss(node: Node): void {
  const root = node.getRootNode();
  const target: ShadowRoot | Document =
    root instanceof ShadowRoot ? root : document;
  // For a Document target, styles live in <head>.
  const host: ParentNode = target instanceof ShadowRoot ? target : document.head;
  if ((host as ParentNode).querySelector(`#${XTERM_STYLE_ID}`)) return;
  const style = document.createElement('style');
  style.id = XTERM_STYLE_ID;
  style.textContent = xtermCss;
  (host as Node).appendChild(style);
}
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
    lineHeight: 1.0, // non-overridable; matches Zellij's web client. A
    // non-integer line height makes each row a fractional pixel tall, and the
    // rounding leaves 1px gaps that show as thin lines between rows.
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
  /** True once the initial replay has been flushed at a settled layout size; gates direct writes. */
  ready: boolean;
  /**
   * Timestamp (performance.now()) when _settleAndDrain first passed visibility
   * and plausibility checks and entered the RC-1 wait. Used to enforce a
   * timeout escape so a byte-count mismatch can never permanently block the
   * terminal from becoming usable.
   */
  _settleWaitStart: number;
  /**
   * True while a _settleAndDrain drain sequence is in progress (write callbacks
   * in-flight). Prevents a second concurrent _settleAndDrain call (from
   * ResizeObserver or a second rAF kick) from splicing pendingData again and
   * setting ready=true prematurely. (RC-2)
   */
  draining: boolean;
  /**
   * Monotonically-incrementing generation counter. Captured in write-callback
   * closures at drain time. If the counter has been incremented (pane closed,
   * reset, or workspace-switched) by the time a callback fires, the callback
   * is silently dropped. (RC-3, RC-5)
   */
  generation: number;
  /**
   * Number of replay bytes the client expects to receive for this attach.
   * Set from composition.pane.totalSeq (exact byte length of the replay data).
   * _settleAndDrain refuses to set ready=true until seqBytes >= expectedReplayBytes,
   * closing the settle-before-replay race window (RC-1).
   * 0 for fresh panes (no replay expected).
   */
  expectedReplayBytes: number;
  /** Data buffered before first attach (before term.open). */
  pendingData: (Uint8Array | string)[];
  resizeObserver: ResizeObserver | null;
  resizeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Log throttle: count of direct writes already logged. */
  _directWriteLog: number;
  /**
   * Bytes received since the last attach cycle (replay + live).
   * Incremented by write() for every incoming frame.
   * Used by the RC-1 barrier: seqBytes >= expectedReplayBytes means all
   * replay data has arrived and draining can proceed.
   */
  seqBytes: number;
}

// Module-level state — never re-created between tab switches.
// Keys are composite "${workspaceId}:${paneId}" so paneId reuse across
// workspaces never causes cross-workspace scrollback bleed. Switching the
// attached workspace changes _currentWorkspaceId without disposing old
// workspace terminals, so scrollback is preserved when switching back.
const _map = new Map<string, PaneEntry>();
// Data written for a pane before ensure() was called for that workspace.
// Keyed by paneId ONLY (not workspace) to survive the race where binary
// replay frames arrive before the Composition text frame has been processed
// (concurrent WebSocket writes from different Go goroutines mean the binary
// frame can arrive first, when _currentWorkspaceId is still '').
// When ensure() creates an entry it drains this buffer into the entry.
const _preEnsureBuffer = new Map<number, (Uint8Array | string)[]>();
// Containers registered via setContainer() before ensure() was called.
// When ensure() later creates the entry, it immediately calls attach().
const _pendingContainers = new Map<string, { container: HTMLElement; focus: boolean }>();
const _encoder = new TextEncoder();

// Current workspace — set by setWorkspace() on every composition update.
let _currentWorkspaceId = '';

/** Compute the composite registry key for the current workspace. */
function _key(paneId: number): string {
  return `${_currentWorkspaceId}:${paneId}`;
}

// Minimum container pixels below which a fit is treated as a transient layout
// artifact (dockview settle/teardown), not a real terminal size. The observed
// transients measured ~10x4 cells (a few tens of px); a real pane is hundreds.
// 120x60px ≈ a tiny-but-plausible terminal floor, comfortably above the churn.
const _MIN_FIT_WIDTH = 120;
const _MIN_FIT_HEIGHT = 60;

/**
 * Fit the terminal ONLY when the container has a plausible (non-degenerate)
 * size. Returns true if a fit was applied. During dockview settle/teardown the
 * container briefly measures tiny (e.g. 10x4 cells); fitting then would push
 * that bogus size through term.onResize to the server, triggering a SIGWINCH
 * prompt redraw that accumulates a stray prompt fragment in the scrollback on
 * every refresh. Suppressing the fit keeps the PTY size stable across reloads.
 */
function _fitIfPlausible(entry: PaneEntry): boolean {
  const w = entry.hostEl.offsetWidth;
  const h = entry.hostEl.offsetHeight;
  if (w < _MIN_FIT_WIDTH || h < _MIN_FIT_HEIGHT) return false;
  entry.fitAddon.fit();
  return true;
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
    // touch-action:none tells the browser we handle all touch gestures ourselves,
    // preventing it from firing default pan/zoom behaviors that would fight our
    // manual touch-scroll handler below.
    hostEl.style.cssText = 'width:100%;height:100%;touch-action:none;';

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
      ready: false,
      draining: false,
      generation: 0,
      expectedReplayBytes: 0,
      pendingData: [],
      resizeObserver: null,
      resizeTimer: undefined,
      seqBytes: 0,
      _directWriteLog: 0,
      _settleWaitStart: 0,
    };

    muxLog('registry ensure', `created pane=${paneId}`, { key });

    // Forward text input (keystrokes + SGR mouse) as UTF-8 bytes.
    // Gate on entry.ready: xterm.js processes writes asynchronously, so when
    // _settleAndDrain flushes the replay queue, capability queries embedded in
    // the PTY stream (CPR ESC[6n, DA1/DA2, DECRQSS, OSC 10/11, DECRPM, …) are
    // processed by xterm.js AFTER ready is set. Without this gate those query
    // responses fire through onData → sendPaneInput → PTY master. bash/readline
    // has already timed out by then; the PTY echoes the unexpected bytes back as
    // visible output, the charmbracelet emulator renders them as literal
    // characters (DCS body after stripping ESC P, etc.), and the garble gets
    // baked into the VTBuffer replay — compounding on every subsequent reload.
    term.onData((data: string) => {
      if (!entry.ready) {
        // Escape sequences in data → log first 40 chars for diagnosis
        if (/\x1b/.test(data)) {
          muxLog('registry onData', `SUPPRESSED (not ready) pane=${paneId}`,
            { preview: JSON.stringify(data.slice(0, 60)) });
        }
        return;
      }
      if (/\x1b/.test(data)) {
        muxLog('registry onData', `FORWARDED (ready) pane=${paneId}`,
          { preview: JSON.stringify(data.slice(0, 60)) });
      }
      entry.handlers.onInput(_encoder.encode(data));
    });

    // Forward legacy binary mouse reports (X10/UTF-8 encoding).
    // onBinary is part of the xterm.js public API but may not exist on all
    // mock implementations — guard defensively. Same ready gate as onData.
    if (typeof (term as any).onBinary === 'function') {
      (term as any).onBinary((data: string) => {
        if (!entry.ready) return;
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

    // Touch scroll — xterm.js v6 regressed native touch-scroll support
    // (upstream issue #5489). Wire it manually: track finger Y delta and
    // convert to term.scrollLines() calls. We accumulate sub-line fractions
    // so a slow drag still scrolls smoothly rather than only firing at whole-
    // line boundaries.
    //
    // Cell height = fontSize * lineHeight. lineHeight is hardcoded 1.0 (see
    // buildTerminalConfig), so cell height ≈ fontSize pixels.
    {
      let _touchY = 0;
      let _accumulated = 0;
      hostEl.addEventListener('touchstart', (e: TouchEvent) => {
        _touchY = e.touches[0].clientY;
        _accumulated = 0;
        e.preventDefault();
      }, { passive: false });
      hostEl.addEventListener('touchmove', (e: TouchEvent) => {
        const y = e.touches[0].clientY;
        // Positive delta = finger moved up = scroll down (content moves up).
        _accumulated += _touchY - y;
        _touchY = y;
        const cellH = term.options.fontSize ?? 13;
        const lines = Math.trunc(_accumulated / cellH);
        if (lines !== 0) {
          term.scrollLines(lines);
          _accumulated -= lines * cellH;
        }
        e.preventDefault();
      }, { passive: false });
    }

    _map.set(key, entry);

    // Drain any data that arrived before ensure() was called.
    // Pre-ensure buffer is keyed by paneId only (not workspace) so data
    // written before _currentWorkspaceId was set (binary frames racing ahead
    // of the Composition text frame) is still found here.
    // Accumulate byte lengths into seqBytes so the RC-1 barrier counts
    // any pre-ensure replay bytes correctly.
    const preBuffer = _preEnsureBuffer.get(paneId);
    if (preBuffer) {
      for (const chunk of preBuffer) {
        entry.pendingData.push(chunk);
        entry.seqBytes += typeof chunk === 'string' ? chunk.length : (chunk as Uint8Array).byteLength;
      }
      _preEnsureBuffer.delete(paneId);
    }

    // If a container was registered via setContainer() before ensure() was
    // called, attach now that the terminal entry exists. Use rAF so that all
    // synchronous composition-message setup (setExpectedReplayBytes etc.) has
    // run before we open the terminal — this keeps the same ordering guarantee
    // as the layout()-based path.
    const pendingContainer = _pendingContainers.get(key);
    if (pendingContainer) {
      _pendingContainers.delete(key);
      const { container, focus } = pendingContainer;
      requestAnimationFrame(() => terminalRegistry.attach(paneId, container, focus));
    }
  },

  /**
   * Attach the terminal's host element into the given container.
   * On first call: opens the terminal (term.open). On subsequent calls
   * (re-attach after tab switch): re-parents the existing host element,
   * preserving all scrollback.
   *
   * `focus` defaults to false. Pass true ONLY for the active pane: focusing a
   * terminal makes dockview activate its group (onDidFocus), so focusing every
   * pane during a multi-group layout restore would clobber the restored active
   * group. The active pane is focused explicitly by the caller.
   */
  attach(paneId: number, container: HTMLElement, focus = false): void {
    const key = _key(paneId);
    const entry = _map.get(key);
    if (!entry) return;

    if (!entry.opened) {
      // Open terminal in the stable host element — only ever called once.
      muxLog('registry attach', `term.open pane=${paneId} focus=${focus}`,
        { pending: entry.pendingData.length, seqBytes: entry.seqBytes });
      entry.term.open(entry.hostEl);
      entry.opened = true;
    } else {
      muxLog('registry attach', `re-attach pane=${paneId} focus=${focus}`,
        { pending: entry.pendingData.length, ready: entry.ready });
    }

    // NOTE: xterm.js's stylesheet is injected deterministically into mux-app's
    // ShadowRoot by mux-dock at connect time (before any terminal attaches), so
    // it is already present in the root where this terminal renders. We no
    // longer inject it lazily here — doing so via the container's getRootNode()
    // raced with dockview's fromJSON restore and could land in document.head.

    // Move (or insert) the host element into the new container.
    container.appendChild(entry.hostEl);

    // ResizeObserver: 50ms debounce. On each tick, drive settle-or-fit:
    // before the layout has stabilised (_settleAndDrain not yet run), attempt
    // to settle; once ready, just refit on container resizes.
    // Reconnect on each attach (was disconnected in detach()).
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (entry.resizeTimer !== undefined) clearTimeout(entry.resizeTimer);
        entry.resizeTimer = setTimeout(() => {
          requestAnimationFrame(() => {
            if (!entry.ready) terminalRegistry._settleAndDrain(paneId);
            else terminalRegistry.fitIfVisible(paneId);
          });
        }, 50);
      });
      ro.observe(entry.hostEl);
      entry.resizeObserver = ro;
    }
    // Defensive kick: if the element is already at its final size and the
    // observer's initial callback is delayed, still attempt to settle.
    requestAnimationFrame(() => {
      if (!entry.ready) terminalRegistry._settleAndDrain(paneId);
      else terminalRegistry.fitIfVisible(paneId);
    });
    // Only focus when explicitly requested (i.e. this is the active pane). On a
    // multi-group layout restore EVERY pane attaches; if each one grabbed focus,
    // dockview's onDidFocus would activate that pane's group, and the last
    // attach would clobber the restored active-group selection. Focusing only
    // the active pane keeps the restored cross-group selection intact.
    if (focus) entry.term.focus();
  },

  /**
   * Register the DOM container for a pane's terminal.
   *
   * This is the primary attachment API for TerminalRenderer. It is
   * INDEPENDENT of render order: if the terminal entry already exists
   * (ensure() ran first), attach() is called immediately. If ensure()
   * hasn't run yet, the container is stored and attach() is called when
   * ensure() later creates the entry.
   *
   * This decouples terminal initialization from Lit/dockview lifecycle
   * callbacks — the registry manages the pairing, not the component.
   */
  setContainer(paneId: number, container: HTMLElement, focus = false): void {
    const key = _key(paneId);
    const entry = _map.get(key);
    if (entry) {
      // Entry already exists — attach immediately.
      terminalRegistry.attach(paneId, container, focus);
    } else {
      // Entry not yet created — store and attach when ensure() runs.
      muxLog('registry setContainer', `deferred pane=${paneId}`, { key });
      _pendingContainers.set(key, { container, focus });
    }
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
   * Render the initial replay ONCE, at the settled layout size. Called from the
   * debounced ResizeObserver (after the panel size has stopped changing for the
   * debounce window) and a defensive rAF kick. No-ops until the terminal is
   * opened, visible, has a real (non-zero) size, and the custom font is loaded —
   * so fitAddon.fit() computes correct cols/rows and the PTY replay never renders
   * at a transient tiny size (which caused wrapped garble + repeated prompts on
   * rapid refresh). Flushes pendingData in arrival order, then flips `ready` so
   * subsequent writes go direct.
   */
  _settleAndDrain(paneId: number): void {
    const entry = _map.get(_key(paneId));
    if (!entry || !entry.opened || entry.ready) return;

    // Guard RC-2: only one drain sequence at a time.
    if (entry.draining) return;

    if (!_isVisible(entry.hostEl)) return;
    if (entry.hostEl.offsetWidth <= 0 || entry.hostEl.offsetHeight <= 0) return;

    const fontsReady =
      typeof document === 'undefined' ||
      !document.fonts ||
      document.fonts.status === 'loaded';
    if (!fontsReady) {
      void document.fonts.ready.then(() =>
        requestAnimationFrame(() => terminalRegistry._settleAndDrain(paneId)),
      );
      return;
    }

    if (!_fitIfPlausible(entry)) {
      muxLog('registry settle', `pane=${paneId} NOT plausible size yet`,
        { w: entry.hostEl.offsetWidth, h: entry.hostEl.offsetHeight });
      // Retry on the next frame — the ResizeObserver debounce also retries,
      // but an extra rAF costs nothing and catches the case where the container
      // grows to its final size before the observer's first callback fires.
      requestAnimationFrame(() => terminalRegistry._settleAndDrain(paneId));
      return;
    }

    // Guard RC-1: BARRIER — don't settle until all expected replay bytes have
    // arrived. expectedReplayBytes = composition.pane.totalSeq (exact replay
    // byte count set by the server). If seqBytes < expectedReplayBytes, replay
    // is still in-flight; reschedule.
    //
    // Timeout escape: if we have been waiting longer than 3 s since the first
    // settle attempt we drain whatever data has arrived rather than blocking
    // the terminal permanently. A byte-count mismatch (server/client encoding
    // discrepancy, packet loss on reconnect, etc.) should never make the
    // terminal permanently unusable.
    if (entry.seqBytes < entry.expectedReplayBytes) {
      const now = performance.now();
      if (entry._settleWaitStart === 0) entry._settleWaitStart = now;
      const waited = now - entry._settleWaitStart;
      if (waited < 3000) {
        muxLog('registry settle', `pane=${paneId} waiting for replay`,
          { seqBytes: entry.seqBytes, expectedReplayBytes: entry.expectedReplayBytes,
            waitedMs: Math.round(waited) });
        requestAnimationFrame(() => terminalRegistry._settleAndDrain(paneId));
        return;
      }
      muxLog('registry settle', `pane=${paneId} RC-1 TIMEOUT — draining with partial replay`,
        { seqBytes: entry.seqBytes, expectedReplayBytes: entry.expectedReplayBytes });
    }

    const pending = entry.pendingData.splice(0);
    muxLog('registry settle', `pane=${paneId} settling`,
      { pendingChunks: pending.length,
        pendingBytes: pending.reduce((s, c) => s + (typeof c === 'string' ? c.length : c.byteLength), 0),
        seqBytes: entry.seqBytes, expected: entry.expectedReplayBytes,
        w: entry.hostEl.offsetWidth, h: entry.hostEl.offsetHeight });

    if (pending.length === 0) {
      // All replay bytes received (seqBytes >= expectedReplayBytes) but nothing
      // in pendingData — happens for fresh panes with zero expectedReplayBytes,
      // or panes where all replay data arrived before open() was called (opened
      // straight from pendingData queue via ensure pre-buffer path). Safe to
      // mark ready immediately.
      muxLog('registry ready', `pane=${paneId} READY (no pending — fresh or pre-buffered)`,
        { seqBytes: entry.seqBytes });
      entry.ready = true;
      return;
    }

    // Mark draining: prevents RC-2 concurrent _settleAndDrain calls.
    entry.draining = true;
    // Capture generation: write callbacks check this to detect cancellation
    // from prune/resetForReattach (RC-3, RC-6).
    const myGeneration = entry.generation;
    let remaining = pending.length;
    const onWriteDone = () => {
      // Stale callback — pane was closed or reset while writes were in-flight.
      if (entry.generation !== myGeneration) return;
      if (--remaining !== 0) return;
      muxLog('registry ready', `pane=${paneId} READY (after drain)`,
        { seqBytes: entry.seqBytes });
      entry.ready = true;
      entry.draining = false;
      // Drain any live PTY data that arrived during the drain window.
      const live = entry.pendingData.splice(0);
      if (live.length > 0) {
        muxLog('registry settle', `pane=${paneId} draining live data after replay`,
          { chunks: live.length });
      }
      for (const chunk of live) entry.term.write(chunk);
    };
    for (const chunk of pending) {
      entry.term.write(chunk, onWriteDone);
    }
  },

  /**
   * Fit the terminal to its container — only when the host element is visible.
   * No-op if the terminal has never been opened or is not in the DOM.
   */
  fitIfVisible(paneId: number): void {
    const entry = _map.get(_key(paneId));
    if (!entry || !entry.opened) return;
    if (!_isVisible(entry.hostEl)) return;
    _fitIfPlausible(entry);
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
   *
   * Every incoming frame increments the entry's seqBytes (replay + live).
   * Pre-ensure bytes are counted when ensure() drains the pre-ensure buffer.
   */
  write(paneId: number, data: Uint8Array | string): void {
    const key = _key(paneId);
    const entry = _map.get(key);
    if (entry) {
      const bytes = typeof data === 'string' ? data.length : data.byteLength;
      // Count every incoming byte so the RC-1 barrier knows when replay is complete.
      entry.seqBytes += bytes;
      if (entry.ready) {
        // Log only the first few direct writes so we can see if replay arrives post-ready
        if (entry._directWriteLog < 5) {
          entry._directWriteLog++;
          muxLog('registry write', `DIRECT #${entry._directWriteLog} pane=${paneId} bytes=${bytes}`,
            { seqBytes: entry.seqBytes });
        }
        entry.term.write(data);
      } else {
        // Queued until the layout settles + initial drain.
        // Only log first 5 buffered writes to avoid spam
        if (entry.pendingData.length < 5) {
          muxLog('registry write', `BUFFERED pane=${paneId} bytes=${bytes} pending=${entry.pendingData.length}`,
            { opened: entry.opened, seqBytes: entry.seqBytes });
        }
        entry.pendingData.push(data);
      }
    } else {
      // Pre-ensure buffer: ensure() hasn't been called yet for this pane in the
      // current workspace. Keyed by paneId only so data survives the race where
      // binary replay frames arrive before _currentWorkspaceId is set (i.e.
      // before the Composition text frame is processed).
      if (!_preEnsureBuffer.has(paneId)) _preEnsureBuffer.set(paneId, []);
      _preEnsureBuffer.get(paneId)!.push(data);
    }
  },

  /**
   * Anchor a pane's absolute byte sequence to the server-reported start
  /**
   * Set how many replay bytes to expect for this pane.
   * Called when a composition arrives, BEFORE any replay frames are processed.
   * replayLen = composition.pane.totalSeq (exact byte length of replay data).
   *
   * Ordering: ensure() must be called first. The composition handler calls
   * ensure() → setExpectedReplayBytes() synchronously before any binary replay
   * frames are delivered as macrotasks.
   */
  setExpectedReplayBytes(paneId: number, replayLen: number): void {
    const entry = _map.get(_key(paneId));
    if (!entry) return;
    // Do NOT reset seqBytes here. If binary replay frames arrived before the
    // Composition text frame (concurrent Go goroutine write race), ensure() has
    // already drained them into pendingData and incremented seqBytes. Resetting
    // seqBytes to 0 would make the RC-1 barrier wait forever for data that has
    // already arrived. Keep seqBytes as-is so the barrier correctly detects
    // "all replay received" when seqBytes >= expectedReplayBytes.
    muxLog('registry anchor', `pane=${paneId} expectedReplayBytes=${replayLen}`,
      { pendingData: entry.pendingData.length, seqBytes: entry.seqBytes, ready: entry.ready });
    entry.expectedReplayBytes = replayLen;
  },

  /**
   * Reset a pane's settle state for re-attachment (reconnect).
   * Called from the composition handler when an entry already exists (reconnect),
   * BEFORE any replay frames can arrive. Increments generation to cancel any
   * in-flight write callbacks from the previous session. (RC-6)
   */
  resetForReattach(paneId: number): void {
    const entry = _map.get(_key(paneId));
    if (!entry) return;
    muxLog('registry reset', `pane=${paneId} resetting for reattach`,
      { ready: entry.ready, draining: entry.draining, generation: entry.generation });
    entry.ready = false;
    entry.draining = false;
    entry.pendingData = [];
    entry.generation++;          // cancel in-flight write callbacks
    entry.seqBytes = 0;
    entry.expectedReplayBytes = 0;
    entry._directWriteLog = 0;
    entry._settleWaitStart = 0;  // reset timeout so fresh reconnect gets a full 3s window
  },

  /** Whether term.open() has been called for paneId. Used by mux-dock BUG-C fix. */
  isOpened(paneId: number): boolean {
    return _map.get(_key(paneId))?.opened ?? false;
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
        entry.generation++;          // cancel any in-flight write callbacks
        entry.resizeObserver?.disconnect();
        if (entry.resizeTimer !== undefined) clearTimeout(entry.resizeTimer);
        entry.term.dispose();
        _map.delete(key);
      }
    }
    // Also clear pre-ensure buffer for panes that will never exist.
    for (const paneId of _preEnsureBuffer.keys()) {
      if (!liveIds.has(paneId)) _preEnsureBuffer.delete(paneId);
    }
    // Clear pending containers for pruned panes.
    for (const key of _pendingContainers.keys()) {
      if (!key.startsWith(prefix)) continue;
      const paneId = parseInt(key.slice(prefix.length), 10);
      if (!liveIds.has(paneId)) _pendingContainers.delete(key);
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
    _pendingContainers.clear();
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
