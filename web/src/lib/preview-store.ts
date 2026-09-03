/**
 * preview-store.ts — the single API the sidebar consumes for live workspace
 * preview tiles.
 *
 * Its whole job is to hide an asymmetry that the sidebar should not have to
 * know about (design D2): the workspace this connection is ATTACHED to has its
 * terminals live in this browser, with full per-cell colour, at whatever rate
 * we care to sample; every OTHER workspace has no data in the browser at all
 * and is fed by a low-rate monochrome push from the daemon. Callers ask for
 * `get(workspaceId, cols, rows)` and get back a tile plus a `live` flag; which
 * source it came from is this module's problem.
 */

import { store } from '../state.js';
import { terminalRegistry } from './terminal-registry.js';
import { tileFromLines, tileHash } from './preview-tile.js';
import type { PreviewTile } from './preview-tile.js';
import type { SessiondMessage } from '../types.js';
import type { MuxSocket } from '../ws.js';

export interface PreviewEntry {
  paneId: number;
  title: string;
  /** true when this came from the local xterm buffer (attached ws, full colour). */
  live: boolean;
  tile: PreviewTile;
}

export type PreviewMode = 'full' | 'compact' | 'off';

/** Tile height per density mode. `off` is 0 — no tile, no frames on the wire. */
const MODE_ROWS: Record<PreviewMode, number> = { full: 13, compact: 6, off: 0 };

/**
 * ~6 Hz. Fast enough that a scrolling build log reads as motion, slow enough
 * that the crop + hash cost stays invisible next to the terminal itself.
 */
const LIVE_TICK_MS = 166;

/** One workspace's most recent pushed tile, exactly as it came off the wire. */
interface ServerTile {
  paneId: number;
  title: string;
  cols: number;
  rows: number;
  lines: string[];
  /** Bumped on every push; invalidates the derived-tile cache below. */
  generation: number;
  /**
   * tileFromLines() results keyed by `${cols}x${rows}`. Different clients (and
   * the same client at different sidebar widths) want different geometry out of
   * one canonical 80x24 push, so the crop is done on demand — and then cached,
   * because a re-render asking for the same size must not redo it.
   */
  derived: Map<string, { generation: number; tile: PreviewTile }>;
}

function toCount(n: number): number {
  const v = Math.floor(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function normalizeMode(mode: string): PreviewMode {
  return mode === 'compact' || mode === 'off' ? mode : 'full';
}

class PreviewStore {
  private _socket: MuxSocket | null = null;
  private _mode: PreviewMode = 'off';
  /** What we last told the daemon. Starts false: a fresh connection is opted out. */
  private _sent = false;
  private _tiles = new Map<string, ServerTile>();
  private _generation = 0;
  private _subscribers = new Set<() => void>();

  // --- live-sampling state -------------------------------------------------
  private _rafId: number | null = null;
  private _lastTick = 0;
  /**
   * Geometry the attached card last asked for. The ticker has no opinion about
   * card size, so it samples at whatever the sidebar most recently requested;
   * until something asks, there is nothing to sample and the probe idles.
   */
  private _liveGeom: { cols: number; rows: number } | null = null;
  /** Hash of the last live tile, and the pane it came from. */
  private _liveHash = -1;
  private _liveKey = '';

  private _onVisibility = (): void => {
    this._syncTicker();
  };

  constructor() {
    // Design note: "the redraw must be gated on document.visibilityState".
    // rAF is already throttled in a hidden tab, but a hidden tab should do
    // exactly zero preview work, not merely less of it.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibility);
    }
  }

  /** Wire the socket. Called once from app.ts after the socket exists. */
  attach(socket: MuxSocket): void {
    this._socket = socket;
    this._applySubscription(true);
  }

  /** Enable/disable the whole feature; sends preview-subscribe when it changes. */
  setMode(mode: PreviewMode): void {
    const next = normalizeMode(mode);
    if (next === this._mode) return;
    this._mode = next;
    this._applySubscription(false);
    if (next === 'off') {
      // Drop everything: with previews off the daemon stops rendering, so held
      // tiles would freeze at whatever was on screen when the user opted out.
      this._tiles.clear();
      this._liveHash = -1;
    }
    this._syncTicker();
    this._notify();
  }

  get mode(): PreviewMode {
    return this._mode;
  }

  /** Tile height for the current mode: full -> 13, compact -> 6, off -> 0. */
  get rows(): number {
    return MODE_ROWS[this._mode];
  }

  /**
   * Re-send the opt-in. The flag lives on the daemon connection, so a daemon
   * restart or a socket reconnect silently loses it and tiles would just stop
   * arriving; app.ts calls this from its reconnect hook.
   */
  resubscribe(): void {
    this._applySubscription(true);
  }

  /** Feed one `workspace-preview` frame from the socket. */
  handleWorkspacePreview(msg: SessiondMessage): void {
    // Frames already in flight when the user switched previews off.
    if (this._mode === 'off') return;
    const wsId = msg.workspaceId;
    if (typeof wsId !== 'string' || wsId === '') return;

    const lines = Array.isArray(msg.lines)
      ? msg.lines.filter((l): l is string => typeof l === 'string')
      : [];

    const existing = this._tiles.get(wsId);
    const generation = ++this._generation;
    this._tiles.set(wsId, {
      paneId: msg.paneId ?? 0,
      title: msg.title ?? '',
      cols: msg.cols ?? 0,
      rows: msg.rows ?? 0,
      lines,
      generation,
      derived: existing?.derived ?? new Map(),
    });

    // D7: the workspace bell finally gets a producer. It has existed with zero
    // production callers for a structural reason — the browser never receives
    // output for a workspace it is not attached to, so it could never know
    // anything happened there. This push is that missing signal.
    // Guarded on the bell not already being lit: ringWorkspace() notifies every
    // store subscriber, and re-ringing an already-ringing workspace twice a
    // second would re-render the whole app for no state change.
    if (wsId !== store.attached && !store.workspaceBellActive(wsId)) {
      store.ringWorkspace(wsId);
    }

    this._notify();
  }

  /** Latest tile for a workspace cropped to cols x rows, or null. */
  get(workspaceId: string, cols: number, rows: number): PreviewEntry | null {
    if (this._mode === 'off') return null;
    const c = toCount(cols);
    const r = toCount(rows);
    if (c === 0 || r === 0) return null;

    // Attached workspace: read the live xterm buffer. This is not a fallback
    // ordering, it is the visual hierarchy — the workspace you are in is live
    // and vivid, the others are ghosted.
    if (workspaceId === store.attached) {
      // Record the geometry even when there is no terminal yet, so the ticker
      // starts sampling the moment one opens.
      this._liveGeom = { cols: c, rows: r };
      const paneId = store.activePaneId;
      const tile = terminalRegistry.previewRegion(paneId, c, r);
      if (tile) {
        return { paneId, title: this._paneTitle(paneId), live: true, tile };
      }
      // No local terminal (browser pane, not yet opened) — fall through to the
      // daemon's push, which covers the attached workspace too.
    }

    const raw = this._tiles.get(workspaceId);
    if (!raw) return null;

    const key = `${c}x${r}`;
    let derived = raw.derived.get(key);
    if (!derived || derived.generation !== raw.generation) {
      derived = { generation: raw.generation, tile: tileFromLines(raw.lines, c, r) };
      raw.derived.set(key, derived);
    }
    return { paneId: raw.paneId, title: raw.title, live: false, tile: derived.tile };
  }

  /** Notified when any workspace's tile changes. */
  subscribe(fn: () => void): () => void {
    this._subscribers.add(fn);
    this._syncTicker();
    return () => {
      this._subscribers.delete(fn);
      this._syncTicker();
    };
  }

  // --- internals -----------------------------------------------------------

  private _paneTitle(paneId: number): string {
    return store.panes.find((p) => p.paneId === paneId)?.title ?? '';
  }

  private _applySubscription(force: boolean): void {
    const want = this._mode !== 'off';
    if (!force && want === this._sent) return;
    // Sending is best-effort: a closed socket drops it, and the reconnect hook
    // re-sends. Recording _sent regardless keeps setMode's change detection
    // honest about intent rather than about delivery.
    this._socket?.previewSubscribe(want);
    this._sent = want;
  }

  /**
   * Start or stop the live sampler. Off, unwatched, or hidden all mean the
   * same thing: do nothing at all.
   */
  private _syncTicker(): void {
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
    const want = this._mode !== 'off' && this._subscribers.size > 0 && visible;
    if (want === (this._rafId !== null)) return;
    if (want) {
      this._lastTick = 0;
      this._rafId = requestAnimationFrame(this._frame);
    } else if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  private _frame = (now: number): void => {
    this._rafId = requestAnimationFrame(this._frame);
    if (now - this._lastTick < LIVE_TICK_MS) return;
    this._lastTick = now;
    this._probeLive();
  };

  /**
   * Re-crop the attached workspace's tile and notify only if its text actually
   * changed. Without the hash gate an idle prompt would repaint every card at
   * 6 Hz forever.
   */
  private _probeLive(): void {
    const geom = this._liveGeom;
    const wsId = store.attached;
    if (!geom || wsId === null) return;

    const paneId = store.activePaneId;
    const key = `${wsId}:${paneId}`;
    if (key !== this._liveKey) {
      // A different pane's hash says nothing about this one.
      this._liveKey = key;
      this._liveHash = -1;
    }

    const tile = terminalRegistry.previewRegion(paneId, geom.cols, geom.rows);
    if (!tile) return;
    const hash = tileHash(tile);
    if (hash === this._liveHash) return;
    this._liveHash = hash;
    this._notify();
  }

  private _notify(): void {
    for (const fn of this._subscribers) fn();
  }
}

export const previewStore = new PreviewStore();
