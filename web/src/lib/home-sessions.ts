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
 * different channel (the Amplifier hook in modules/hooks-muxterm-session) with
 * a different lifetime. Keeping them apart is what lets the standalone demo
 * render the real components with no socket at all.
 */

import { FIXTURE_SESSIONS, type SessionState } from './session-state.js';

/**
 * Where the current rows came from. Surfaced so the UI can be honest — a
 * fixture-populated home must never be mistaken for a live one.
 */
export type HomeSource = 'fixture' | 'live';

class HomeSessionStore {
  private _sessions: readonly SessionState[] = [];
  private _source: HomeSource = 'live';
  private _listeners = new Set<() => void>();

  get sessions(): readonly SessionState[] {
    return this._sessions;
  }

  get source(): HomeSource {
    return this._source;
  }

  /** Replace the whole set. The producer is authoritative; there is no merge. */
  set(sessions: readonly SessionState[], source: HomeSource = 'live'): void {
    this._sessions = sessions;
    this._source = source;
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
