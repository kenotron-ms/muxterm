/**
 * remotes-store.ts — the ONE place the browser keeps per-host connection state.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  THE ZERO-REMOTE GATE                                               │
 * │                                                                     │
 * │  Every consumer starts with:                                        │
 * │                                                                     │
 * │      if (!remotesStore.any) return <today's render>;                │
 * │                                                                     │
 * │  A user with no remotes receives ZERO host-state frames (the local  │
 * │  daemon never emits one — local is unmarked), so this store stays   │
 * │  empty, `any` stays false, and every surface short-circuits to the  │
 * │  exact DOM it produces on main. That single early return is the     │
 * │  enforcement mechanism, and it is meant to be readable and          │
 * │  diffable at a glance.                                             │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Deliberately NOT folded into state.ts's MuxStore, and shaped instead like
 * home-sessions.ts / preview-store.ts (class + subscribe + module singleton):
 * MuxStore is the frozen projection of the sessiond control protocol, and
 * host-state is a RELAY-LEVEL message that never travels on a daemon socket at
 * all. Keeping them apart is what keeps `protocol.go` untouched.
 */

import { parseHostRef } from './host-ref.js';

/**
 * The relay-level message type. Deliberately NOT a SessiondType: it exists
 * only between the local server and this browser, server → browser, and never
 * reaches a daemon. There is no browser → server direction — a retry travels
 * as POST /api/remotes/{id}/connect, which is one door, already idempotent and
 * already authenticated.
 */
export const HOST_STATE = 'host-state' as const;

/** The four states one host's connection can be in, as the server names them. */
export type HostConnState = 'connected' | 'reconnecting' | 'unreachable' | 'never-connected';

const HOST_CONN_STATES: readonly string[] = [
  'connected',
  'reconnecting',
  'unreachable',
  'never-connected',
];

/** One host's current connection state, as this browser last heard it. */
export interface HostEntry {
  /** HostRef.ID — the key everything else joins on, e.g. "ssh:boxb". */
  id: string;
  /** Display label, e.g. "boxb". Never empty: falls back to the id. */
  name: string;
  /** Dial target, e.g. "azureuser@20.230.240.43". May be ''. */
  target: string;
  state: HostConnState;
  /** ms epoch the current state began → "Disconnected 12s ago". */
  since: number;
  /** Reconnect attempt number. Present while reconnecting. */
  attempt?: number;
  /**
   * ms epoch of the next dial, computed HERE as Date.now() + retryInMs on
   * receipt. The wire carries a duration, not a deadline, precisely so the
   * server never has to tick a frame per second; the countdown is local.
   */
  retryAt?: number;
  /** The dial failure, verbatim. Present when unreachable. */
  error?: string;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function hostConnState(value: unknown): HostConnState | null {
  return typeof value === 'string' && HOST_CONN_STATES.includes(value)
    ? (value as HostConnState)
    : null;
}

/**
 * Code-unit order, not locale order: host ids are machine identifiers, and the
 * group order a user sees must not depend on which locale their browser is in.
 */
function byId(a: HostEntry, b: HostEntry): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

class RemotesStore {
  private _hosts = new Map<string, HostEntry>();
  /**
   * Sorted view of _hosts, rebuilt only when the map changes. Consumers
   * re-render on every notification, so handing back the same array identity
   * between changes is what keeps a host group from churning for free.
   */
  private _sorted: readonly HostEntry[] | null = [];
  private _listeners = new Set<() => void>();

  /** Every known host, sorted by id. Stable identity between changes. */
  get hosts(): readonly HostEntry[] {
    if (this._sorted === null) {
      this._sorted = [...this._hosts.values()].sort(byId);
    }
    return this._sorted;
  }

  /**
   * THE ZERO-REMOTE GATE. False until the first host-state frame arrives, and
   * a browser with no remotes configured never receives one.
   *
   * Read it as the first statement of every remote-aware render and return
   * today's markup when it is false.
   */
  get any(): boolean {
    return this._hosts.size > 0;
  }

  /** One host by HostRef.ID, or undefined if this browser has never heard of it. */
  get(id: string): HostEntry | undefined {
    return this._hosts.get(id);
  }

  /**
   * The connection state behind a (possibly namespaced) workspace id.
   *
   * `null` means LOCAL — the workspace lives on the daemon in this process,
   * which has no connection state because it is not a remote (ux D2: local is
   * unmarked). Callers gating behaviour must test `state !== null && state !==
   * 'connected'` so the local path is untouched.
   *
   * A namespaced id whose host this browser has no frame for reports
   * 'never-connected' rather than null: unknown is not local, and a caller
   * deciding whether it is safe to act must fail closed.
   */
  stateOf(workspaceId: string): HostConnState | null {
    const { host } = parseHostRef(workspaceId);
    if (host === '') return null;
    return this._hosts.get(host)?.state ?? 'never-connected';
  }

  /**
   * Feed one host-state frame.
   *
   * The frame is a COMPLETE statement of that host's current state, emitted
   * once per transition, so the entry is replaced rather than merged: a
   * `connected` frame must clear the `error` a previous `unreachable` left
   * behind, or the UI keeps explaining a failure that is over.
   *
   * Malformed frames are dropped whole. Strictness is safe here — the web
   * bundle is embedded in the server binary that sends these, so there is no
   * version skew to tolerate — and it is what stops a garbage frame from
   * conjuring a phantom host that flips `any` to true and changes the render
   * for a user who has no remotes at all.
   */
  applyHostState(msg: Record<string, unknown>): void {
    const id = str(msg.host);
    // The local daemon is never a remote and never emits one of these. An
    // empty host is either that or corruption; either way it is not a host.
    if (id === '') return;
    const state = hostConnState(msg.state);
    if (state === null) return;

    const prev = this._hosts.get(id);
    // Name and Target are `omitempty` on the Go side, so a frame for a host
    // whose session has already been torn down can arrive without them. Keep
    // the last label we knew rather than blanking the group header.
    const name = str(msg.name) || prev?.name || id;
    const target = str(msg.target) || prev?.target || '';

    const entry: HostEntry = {
      id,
      name,
      target,
      state,
      since: finite(msg.since) ?? Date.now(),
    };

    const attempt = finite(msg.attempt);
    if (attempt !== undefined && attempt > 0) entry.attempt = attempt;

    const retryInMs = finite(msg.retryInMs);
    if (retryInMs !== undefined && retryInMs >= 0) entry.retryAt = Date.now() + retryInMs;

    const error = str(msg.error);
    if (error !== '') entry.error = error;

    this._hosts.set(id, entry);
    this._sorted = null;
    this._notify();
  }

  /**
   * Drop a host entirely — an explicit removal, not a disconnect. A host that
   * merely lost its connection keeps its entry (that is what `unreachable` is
   * for); forgetting one is how it leaves the sidebar.
   */
  forget(id: string): void {
    if (!this._hosts.delete(id)) return;
    this._sorted = null;
    this._notify();
  }

  /** Notified whenever any host's state changes. */
  subscribe(cb: () => void): () => void {
    this._listeners.add(cb);
    return () => {
      this._listeners.delete(cb);
    };
  }

  private _notify(): void {
    for (const cb of this._listeners) cb();
  }
}

export const remotesStore = new RemotesStore();
