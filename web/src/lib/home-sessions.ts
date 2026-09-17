/**
 * home-sessions.ts — the ONE seam between the home view and its data.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  WIRING POINT FOR LANE B                                            │
 * │                                                                     │
 * │  Everything that renders session state (mux-home, mux-start-card,   │
 * │  the sidebar badges, the dock tab dots) reads from this store and    │
 * │  nothing else. To go live, call:                                     │
 * │                                                                     │
 * │      homeSessions.set(sessionsFromWire, 'live');                     │
 * │                                                                     │
 * │  from wherever the daemon's session-state frame is handled, and      │
 * │  delete the `homeSessions.seedFixture()` call in app.ts. No          │
 * │  component changes. That is the whole job.                           │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Deliberately NOT folded into state.ts's MuxStore: that store is the frozen
 * projection of the sessiond control protocol, and session state arrives on a
 * different channel -- a spool of files written by any producer that follows
 * docs/session-state-protocol.md -- with a different lifetime. Keeping them
 * apart is what lets the standalone demo render the real components with no
 * socket at all.
 */

import { FIXTURE_SESSIONS, type SessionState } from './session-state.js';

/**
 * Where the current rows came from. Surfaced so the UI can be honest — a
 * fixture-populated home must never be mistaken for a live one.
 */
export type HomeSource = 'fixture' | 'live';

/**
 * Whether this browser has a current whole-Fleet document.
 *
 * A partial snapshot is useful -- it can keep a remote's last known rows on
 * screen -- but it must not make an empty set claim that every source is
 * empty. `unavailable` is the local daemon's explicit subscription refusal.
 */
export type HomeSnapshotStatus = 'loading' | 'partial' | 'ready' | 'unavailable';

class HomeSessionStore {
  private _sessions: readonly SessionState[] = [];
  private _source: HomeSource = 'live';
  private _snapshotStatus: HomeSnapshotStatus = 'loading';
  // Assigned by the server relay while it holds its aggregate lock. A delayed
  // partial write must never overwrite a newer whole Fleet document.
  private _lastRevision = 0;
  private _listeners = new Set<() => void>();

  get sessions(): readonly SessionState[] {
    return this._sessions;
  }

  get source(): HomeSource {
    return this._source;
  }

  get snapshotStatus(): HomeSnapshotStatus {
    return this._snapshotStatus;
  }

  /**
   * Replace the whole set. The producer is authoritative; there is no merge.
   *
   * `sessions` accepts null/undefined and normalizes to the EMPTY SET, and
   * that signature is the entire point of this method rather than an oversight.
   *
   * The wire type carries `Sessions []SessionState` with `omitempty`, because
   * Message is one flat envelope shared by every message type and the
   * alternative is `"sessions":null` on every control frame of every kind. The
   * consequence is that the most important transition in the whole feature --
   * N sessions going to ZERO -- arrives as a bare `{"type":"session-state"}`
   * with no field at all. Confirmed empirically against a live daemon: a
   * subscriber with nothing to show receives a frame whose `sessions` is
   * absent, not `[]`.
   *
   * So the ARRIVAL of the message is the signal and a missing field means
   * "none", never "no news". A caller writing `if (msg.sessions) set(...)`
   * would freeze the view on its last non-zero set: the Start card badge would
   * stick forever at a count of sessions that have all finished, which is worse
   * than showing no badge because it is confidently wrong. Normalizing here
   * rather than trusting each call site to remember `?? []` makes that bug
   * unwritable.
   */
  set(
    sessions: readonly SessionState[] | null | undefined,
    source: HomeSource = 'live',
    snapshotStatus: Extract<HomeSnapshotStatus, 'partial' | 'ready' | 'unavailable'> = 'ready',
    revision?: number,
  ): void {
    if (typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0) {
      if (revision <= this._lastRevision) return;
      this._lastRevision = revision;
    }
    this._sessions = sessions ?? [];
    this._source = source;
    this._snapshotStatus = snapshotStatus;
    this._notify();
  }

  /**
   * A socket closed, so its last Fleet set is no longer current. Rows remain as
   * a useful fallback while the connection recovers; the next whole-state frame
   * makes them authoritative again. This is deliberately idempotent because
   * several close paths can report the same outage.
   */
  markStale(): void {
    // A new WebSocket gets a new server-side revision sequence. Preserve a
    // non-empty last set as visibly partial; a prior empty set goes back to
    // loading rather than claiming to know this connection's Fleet is empty.
    const next: HomeSnapshotStatus = this._sessions.length === 0 ? 'loading' : 'partial';
    const changed = this._snapshotStatus !== next;
    this._lastRevision = 0;
    this._snapshotStatus = next;
    if (changed) this._notify();
  }

  /** The local daemon explicitly cannot supply the subscribed Fleet feed. */
  markUnavailable(): void {
    if (this._snapshotStatus === 'unavailable') return;
    this._snapshotStatus = 'unavailable';
    this._notify();
  }

  /**
   * Seed from the committed development fixture.
   *
   * Temporary: exists only so the view can be built and looked at before the
   * daemon-side producer lands. Delete this method and its one call site the
   * moment `set(..., 'live')` has a caller.
   */
  seedFixture(): void {
    this.set(FIXTURE_SESSIONS, 'fixture');
  }

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

export const homeSessions = new HomeSessionStore();
