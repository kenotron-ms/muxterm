/**
 * cos-store.ts — the ONE seam between the chief-of-staff chat and its data.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  Everything that renders the chief of staff (<mux-cos>, and the    │
 * │  entry control's readiness dot) reads from this store and nothing   │
 * │  else. app.ts calls cosStore.attach(socket) once; the component     │
 * │  subscribes and reads. No component parses a wire frame.            │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Shaped after home-sessions.ts: an observable store with a subscribe/notify
 * pair, deliberately NOT folded into state.ts's MuxStore. That store is the
 * frozen projection of the sessiond control protocol; this conversation
 * arrives on a different channel (serve-local cos-* frames from the muxterm
 * server's own sidecar supervisor, never from a daemon) with a different
 * lifetime — one per install, shared by every browser tab.
 *
 * The wire contract is docs/designs/2026-09-06-cos-sidecar-spec.md §2. Three
 * of its laws shape this file:
 *
 *   - Unknown ev / unknown fields are IGNORED, never fatal (2.4 law 5). A
 *     newer sidecar must never break an older browser, so every branch below
 *     is additive and the default case is a no-op.
 *   - `delta` is ADVISORY (2.4 law 4): turn_end.response is authoritative and
 *     the stream may have been dropped by a slow subscriber. _reconcile()
 *     folds the two together at turn end.
 *   - Events may arrive TWICE — once in the reconnect replay, once live — and
 *     out of order relative to the synthetic turn_submitted. Everything here
 *     upserts by turn_id and treats a repeated terminal event as idempotent.
 */

import type { MuxSocket } from '../ws.js';
import { ASSISTANT_NAME } from './assistant-identity.js';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * What the header dot says.
 *
 *   idle      the overlay has never been opened; no sidecar has been asked for
 *   starting  subscribed, waiting on the ~2s amplifier boot
 *   ready     the session is alive and will take a turn
 *   down      the sidecar could not start, died fatally, or the socket is gone
 */
export type CosStatus = 'idle' | 'starting' | 'ready' | 'down';

/** One assistant text run. Deltas append to the tail of the newest one. */
export interface CosTextBlock {
  kind: 'text';
  text: string;
}

/** A thinking block. Dimmed and collapsed by default in the view. */
export interface CosThinkingBlock {
  kind: 'thinking';
  text: string;
}

/** One tool call, from tool_start to tool_end. `done` is false in between. */
export interface CosToolBlock {
  kind: 'tool';
  callId: string;
  name: string;
  args: string;
  done: boolean;
  ok: boolean;
  summary: string;
  ms: number;
}

export type CosBlock = CosTextBlock | CosThinkingBlock | CosToolBlock;

/**
 * A live approval prompt.
 *
 * `deadline` is computed HERE, from the event's `timeout` and the moment the
 * event was received, rather than counted down on the server: the countdown is
 * a rendering of the sidecar's own timer, and the sidecar resolves a timeout to
 * DENIED (2.4 law 3). A browser clock that runs slow therefore over-reports the
 * time left, which is the safe direction — it never invites a decision the
 * sidecar will no longer accept as an approval.
 */
export interface CosApproval {
  requestId: string;
  turnId: string;
  tool: string;
  detail: string;
  timeout: number;
  deadline: number;
  /** Set the moment this browser answers, so the buttons cannot be double-hit. */
  answered: '' | 'approved' | 'denied';
}

export type CosTurnStatus = 'pending' | 'streaming' | 'done' | 'failed' | 'cancelled';

export interface CosTurn {
  id: string;
  prompt: string;
  clientRef: string;
  blocks: CosBlock[];
  status: CosTurnStatus;
  /** Advisory, non-fatal errors reported mid-turn. Shown, never alarming. */
  notices: string[];
  costUsd: string;
  ms: number;
  error: string;
  /**
   * When this browser FIRST SAW the turn, in ms since the epoch.
   *
   * Local rather than from the wire on purpose: the sidecar's events carry no
   * timestamp, and the only thing this field is used for is the housekeeping
   * menu's "older than N days" cut. A clock this browser owns is honest about
   * that -- it dates what this browser has been shown, which is exactly the
   * transcript the menu is offering to clear.
   */
  createdAt: number;
  /**
   * When this browser saw the turn REACH a terminal state, or 0 while it is
   * still live.
   *
   * Read by _replaceHistory and nothing else. It is what separates "this turn
   * finished after the server took its snapshot" from "this turn is gone",
   * which are the same thing on the wire -- both are simply absent from the
   * replay -- and mean opposite things.
   */
  endedAt: number;
}

/** Anything that went wrong outside a turn. Cleared on the next good news. */
export interface CosFault {
  code: string;
  message: string;
  fatal: boolean;
}

/**
 * A text-thread event after the Mission Control transport has attributed it.
 *
 * The existing COS renderer still consumes the raw COS event payload, but the
 * threaded transport never hands that payload around without its originating
 * thread, runtime generation, sequence fence, and immutable event id.
 */
export interface ThreadedCosEvent {
  readonly thread_id: string;
  readonly runtime_generation: number;
  readonly thread_seq: number;
  readonly event_id: string;
  readonly event: Readonly<Record<string, unknown>>;
}

/** Explicit runtime state accompanying an ordered Mission Control snapshot. */
export interface ThreadedSnapshotState {
  readonly coveredTurnIds: readonly string[];
  /**
   * Persisted terminal turns at the snapshot's event cut which canonical
   * history already represents but cannot safely identity-bind (for example
   * duplicate structural transcript groups). This is render-only suppression;
   * the transport still consumes their event ids and sequences.
   */
  readonly replaySuppressedTurnIds: readonly string[];
  readonly activeTurnId: string;
  readonly pendingTurnIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * cost_usd is "a JSON number or a numeric string" (2.4 law 6). Rendered, never
 * arithmetic, so it is normalized to a short display string and left alone.
 */
function cost(v: unknown): string {
  const raw = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  if (!Number.isFinite(raw) || raw <= 0) {
    // Not a number this build understands: show it verbatim rather than
    // dropping the one field that says what a turn cost.
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : '';
  }
  // The sidecar sends a full-precision decimal string ("0.94244000"). Four
  // places is more than a footer needs; a sub-cent turn keeps enough to not
  // round to "$0.00", which would read as free.
  const places = raw < 0.01 ? 4 : 2;
  return raw.toFixed(places).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/** Compact one-line rendering of a tool's arguments, for the activity line. */
function argsLine(v: unknown): string {
  if (v === undefined || v === null) return '';
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return '';
  }
  if (!s || s === '{}' || s === 'null') return '';
  s = s.replace(/\s+/g, ' ');
  return s.length > 96 ? `${s.slice(0, 96)}…` : s;
}

/** Everything after the mcp_muxterm_ / mcp_ prefix, which is noise in a line. */
export function shortToolName(name: string): string {
  return name.replace(/^mcp_muxterm_/, '').replace(/^mcp_/, '');
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class CosStore {
  private _socket: MuxSocket | null = null;
  private _listeners = new Set<() => void>();

  private _status: CosStatus = 'idle';
  private _sessionId = '';
  private _turns: CosTurn[] = [];
  private _byId = new Map<string, CosTurn>();
  private _approvals: CosApproval[] = [];
  private _fault: CosFault | null = null;
  private _subscribed = false;
  /**
   * When this browser last ASKED for a replay, in ms since the epoch.
   *
   * The server snapshots the transcript some time after this -- after the ~2s
   * amplifier boot, on a cold server -- so a turn that ended before this line
   * is certainly in the snapshot, and one that ended after it may not be.
   * _replaceHistory needs that line to know which local turns a replay is
   * entitled to erase.
   */
  private _replayRequestedAt = 0;
  /**
   * Immutable runtime turn ids represented by the latest threaded snapshot.
   * The v2 coordinator consumes a late event's sequence fence regardless, but
   * this renderer must never materialize a second copy of a covered turn.
   */
  private _threadCoveredTurnIds = new Set<string>();
  /** See ThreadedSnapshotState.replaySuppressedTurnIds. */
  private _threadReplaySuppressedTurnIds = new Set<string>();

  get status(): CosStatus {
    return this._status;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get turns(): readonly CosTurn[] {
    return this._turns;
  }

  /** Every unanswered approval, oldest first. Usually zero or one. */
  get approvals(): readonly CosApproval[] {
    return this._approvals;
  }

  get fault(): CosFault | null {
    return this._fault;
  }

  /** True while a turn is in flight, so the composer can offer Stop. */
  get busy(): boolean {
    return this._turns.some((t) => t.status === 'pending' || t.status === 'streaming');
  }

  /**
   * Whether there is anything the housekeeping menu could clear.
   *
   * A BOOLEAN, not a count, and that is a design constraint rather than
   * laziness: the Dashboard shows no counts anywhere -- not of sessions, not
   * of groups, not of messages -- so the menu can only ever ask "is this
   * item worth offering?", never "how many?".
   */
  get hasMessages(): boolean {
    return this._turns.length > 0;
  }

  // -- transport ------------------------------------------------------------

  /** Called once by app.ts, the same way previewStore.attach is. */
  attach(socket: MuxSocket): void {
    this._socket = socket;
    socket.onCosFrame = (frame) => this.handleFrame(frame);
  }

  /**
   * Turn the shared stream on for this connection. Idempotent: a repeat
   * subscribe from a second overlay open would otherwise replay the whole
   * transcript on top of the one already rendered.
   */
  open(): void {
    if (this._subscribed) return;
    this._subscribed = true;
    this._replayRequestedAt = Date.now();
    if (this._status === 'idle') this._setStatus('starting');
    this._socket?.cosSubscribe(true);
    this._notify();
  }

  /**
   * Send one turn.
   *
   * The prompt is NOT echoed locally. The server answers with a synthesized
   * turn_submitted addressed to every subscriber, so the tab that asked and
   * the tab that did not render the question through the exact same path —
   * which is what makes one shared conversation actually look shared.
   */
  send(prompt: string): boolean {
    const text = prompt.trim();
    if (!text) return false;
    if (!this._socket) return false;
    return this._socket.cosTurn(text, `cos-${Date.now().toString(36)}`);
  }

  /**
   * Answer an approval.
   *
   * THE SEND IS CHECKED FIRST, and this is the one place in the store where
   * that ordering is a security property rather than tidiness. Marking the
   * card answered is a claim that the sidecar has the decision; on a dead
   * socket it does not, and it will time the request out to DENIED (2.4 law
   * 3). Showing a green \"approved\" for a request that is about to be denied
   * is worse than showing nothing -- so on a failed send nothing is marked,
   * the card stays live, and the notice says why.
   *
   * Returns whether the decision actually went out.
   */
  answer(requestId: string, approved: boolean): boolean {
    if (!this._socket?.cosApproval(requestId, approved)) {
      this._fault = {
        code: 'approval_failed',
        message: `${ASSISTANT_NAME} could not be reached, so nothing was answered`,
        fatal: false,
      };
      this._notify();
      return false;
    }
    const a = this._approvals.find((x) => x.requestId === requestId);
    if (a) a.answered = approved ? 'approved' : 'denied';
    // Held for a beat so the card can show the decision rather than vanishing
    // out from under the click that made it.
    setTimeout(() => {
      this._approvals = this._approvals.filter((x) => x.requestId !== requestId);
      this._notify();
    }, 900);
    this._notify();
    return true;
  }

  cancel(turnId: string): void {
    this._socket?.cosCancel(turnId);
  }

  /**
   * Forget old conversation.
   *
   * `olderThanDays` is a cut-off in days, or 'all' for the whole transcript.
   *
   * THIS IS A REQUEST, NOT AN EDIT. The authoritative transcript is the
   * amplifier session the sidecar owns; a browser-local prune would look
   * right until the next reload put everything back. So the cut is sent, and
   * the answer arrives in two frames:
   *
   *   cos-clear-result   did it happen, and how much went
   *   cos-history        what is left, authoritatively
   *
   * TWO THINGS ARE PROMISED IN THE CONFIRM DIALOG and both are kept, but by
   * the SERVER side now, which is the only side that can:
   *
   *   1. "Running lanes are unaffected." Trivially true -- this is a
   *      CONVERSATION. It has never owned a pane, a session or a workspace.
   *
   *   2. "It will not drop a message about a still-alive lane." The sidecar
   *      reads the live fleet roster and keeps any message mentioning one.
   *      A browser can only see its own in-flight turns; it cannot match a
   *      finished message against a lane that is still running.
   */
  clear(olderThanDays: number | 'all'): void {
    const days = olderThanDays === 'all' ? 0 : olderThanDays;
    if (!this._socket || !this._socket.cosClear(days)) {
      // Answer the confirm dialog rather than leaving it hanging on a socket
      // that is not there.
      this._fault = {
        code: 'clear_failed',
        message: `${ASSISTANT_NAME} could not be reached, so nothing was cleared`,
        fatal: false,
      };
    }
    this._notify();
  }

  /** The socket went away. The transcript survives; the readiness claim cannot. */
  markDisconnected(): void {
    this._subscribed = false;
    if (this._status !== 'idle') this._setStatus('down');
    this._notify();
  }

  /** Re-assert after a reconnect once capability negotiation chose legacy COS. */
  markReconnected(): void {
    if (this._status === 'idle') return;
    this._subscribed = true;
    // The socket deliberately does not replay raw COS on open: the
    // conversation coordinator must negotiate v2 capability before allowing
    // unscoped legacy traffic. Once it has explicitly selected legacy, this is
    // the one safe place to re-subscribe.
    this._replayRequestedAt = Date.now();
    this._setStatus('starting');
    this._socket?.cosSubscribe(true);
    this._notify();
  }

  /**
   * Adopt one authoritative Mission Control selection result.
   *
   * This deliberately reuses the exact history renderer used by the legacy
   * stream. The transport owns thread attribution and generation fencing;
   * CosStore remains the single turn/block projection.
   */
  adoptThreadSnapshot(
    sessionId: string,
    history: readonly unknown[],
    snapshot: ThreadedSnapshotState,
  ): void {
    this._sessionId = sessionId;
    this._fault = null;
    this._approvals = [];
    this._threadCoveredTurnIds = new Set(snapshot.coveredTurnIds);
    this._threadReplaySuppressedTurnIds = new Set(snapshot.replaySuppressedTurnIds);
    this._replayRequestedAt = Date.now();
    this._replaceThreadHistoryCanonical(history, snapshot);
    this._setStatus('ready');
    this._notify();
  }

  /**
   * Adopt an authoritative history repair for an already-selected thread.
   * Unlike a selection, this does not alter connection-scoped readiness data.
   */
  adoptThreadHistory(history: readonly unknown[], snapshot: ThreadedSnapshotState): void {
    this._fault = null;
    this._approvals = [];
    this._threadCoveredTurnIds = new Set(snapshot.coveredTurnIds);
    this._threadReplaySuppressedTurnIds = new Set(snapshot.replaySuppressedTurnIds);
    this._replayRequestedAt = Date.now();
    this._replaceThreadHistoryCanonical(history, snapshot);
    this._notify();
  }

  /**
   * Render one event that was already fenced and attributed by the threaded
   * transport. It intentionally does not emit through `onEvent`: that raw
   * event stream belongs to the legacy global voice bridge, which threaded
   * text preview must never drive.
   */
  receiveThreadEvent(envelope: ThreadedCosEvent): void {
    // No content/prompt heuristic is permitted here. The immutable identity
    // sets are supplied with this snapshot. Suppressing at the adapter also
    // keeps these events off the raw voice stream (receiveThreadEvent never
    // emits through onEvent).
    const turnId = str(envelope.event.turn_id);
    if (
      this._threadCoveredTurnIds.has(turnId) ||
      this._threadReplaySuppressedTurnIds.has(turnId)
    ) {
      this._notify();
      return;
    }
    this._event(envelope.event, false);
    this._notify();
  }

  /**
   * The v2 transport received a scoped approval receipt. This remains a
   * renderer-local state change; unlike the legacy answer path it never emits
   * a global COS command or guesses a terminal turn result.
   */
  settleThreadApproval(approvalId: string, approved: boolean): void {
    const approval = this._approvals.find((item) => item.requestId === approvalId);
    if (!approval) return;
    approval.answered = approved ? 'approved' : 'denied';
    setTimeout(() => {
      this._approvals = this._approvals.filter((item) => item.requestId !== approvalId);
      this._notify();
    }, 900);
    this._notify();
  }

  /**
   * Replace this threaded renderer with exactly one canonical server history,
   * then materialize the separately authoritative active/queued identities.
   * These are queue-local ids, never inferred from prompts or prose.
   */
  private _replaceThreadHistoryCanonical(
    raw: readonly unknown[],
    snapshot: ThreadedSnapshotState,
  ): void {
    const turns: CosTurn[] = [];
    const byId = new Map<string, CosTurn>();
    for (let index = 0; index < raw.length; index++) {
      const item = raw[index];
      const turn = this._fromHistory(item);
      if (!turn || byId.has(turn.id)) continue;
      const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
      // The sidecar's ordered snapshot reads the live transcript before it
      // reports its sole active queue-local id. A currently active turn is the
      // final un-attributed transcript group; adopt that *structural* identity
      // instead of matching its prompt or response content.
      if (
        snapshot.activeTurnId &&
        index === raw.length - 1 &&
        str(record?.turn_id) === ''
      ) {
        turn.id = snapshot.activeTurnId;
        turn.status = 'streaming';
        turn.endedAt = 0;
      }
      turns.push(turn);
      byId.set(turn.id, turn);
    }
    this._ensureThreadSnapshotTurn(turns, byId, snapshot.activeTurnId, 'streaming');
    for (const turnId of snapshot.pendingTurnIds) {
      this._ensureThreadSnapshotTurn(turns, byId, turnId, 'pending');
    }
    this._turns = turns;
    this._byId = byId;
  }

  private _ensureThreadSnapshotTurn(
    turns: CosTurn[],
    byId: Map<string, CosTurn>,
    turnId: string,
    status: 'pending' | 'streaming',
  ): void {
    if (!turnId) return;
    const existing = byId.get(turnId);
    if (existing) {
      existing.status = status;
      existing.endedAt = 0;
      return;
    }
    const turn: CosTurn = {
      id: turnId,
      prompt: '',
      clientRef: '',
      blocks: [],
      status,
      notices: [],
      costUsd: '',
      ms: 0,
      error: '',
      createdAt: Date.now(),
      endedAt: 0,
    };
    turns.push(turn);
    byId.set(turnId, turn);
  }

  /** Surface a transport refusal without pretending it was a COS event. */
  setThreadFault(code: string, message: string, fatal = false): void {
    this._fault = { code, message, fatal };
    this._notify();
  }

  // -- inbound --------------------------------------------------------------

  /** Route one serve-local cos-* frame. Unknown types are ignored. */
  handleFrame(frame: Record<string, unknown>): void {
    const type = str(frame.type);
    if (type === 'cos-subscribe-result') {
      const ok = frame.ok === true;
      this._sessionId = str(frame.session_id);
      if (!ok) {
        this._setStatus('down');
        this._fault = { code: 'subscribe_failed', message: str(frame.error) || `${ASSISTANT_NAME} could not be reached`, fatal: true };
      } else {
        this._fault = null;
        this._setStatus(frame.ready === true ? 'ready' : 'starting');
      }
      this._notify();
      return;
    }
    if (type === 'cos-history') {
      // A replay sent because the transcript was PRUNED is authoritative about
      // what is gone; a replay sent because this tab subscribed is only a
      // snapshot, and may be older than what this browser has already seen.
      // An older server sends no reason, and the stricter reading is the one
      // it already gets today.
      this._replaceHistory(
        Array.isArray(frame.turns) ? frame.turns : [],
        str(frame.reason) !== 'subscribe',
      );
      this._notify();
      return;
    }
    if (type === 'cos-clear-result') {
      if (frame.ok !== true) {
        this._fault = {
          code: 'clear_failed',
          message: str(frame.error) || 'nothing was cleared',
          fatal: false,
        };
        this._notify();
        return;
      }
      // Drop what this browser is not still waiting on, and let the
      // cos-history frame that follows say what actually survived. Doing it
      // in this order means the transcript never briefly shows messages the
      // server has already deleted.
      this._fault = null;
      const inFlight = this._turns.filter(
        (t) => t.status === 'pending' || t.status === 'streaming',
      );
      this._turns = inFlight;
      this._byId = new Map(inFlight.map((t) => [t.id, t]));
      this._notify();
      return;
    }
    if (type !== 'cos-event') return;
    const ev = frame.event;
    if (!ev || typeof ev !== 'object') return;
    const replay = frame.replay === true;
    this._event(ev as Record<string, unknown>, replay);
    // Fan the RAW event out to anything that needs the stream itself rather
    // than the store's digest of it. The voice session is the one consumer
    // today: tool_start/tool_end/thinking are already exactly the "what am I
    // doing right now" narration a spoken channel needs, so it subscribes
    // here rather than inventing its own progress signal.
    //
    // Replays are EXCLUDED. A replayed event is history being re-rendered,
    // not something happening now -- narrating one would have the assistant
    // announce a tool call it made an hour ago the moment a second tab
    // opens.
    if (!replay) this._emitEvent(ev as Record<string, unknown>);
    this._notify();
  }

  /**
   * Subscribe to the raw sidecar event stream. Returns an unsubscribe.
   *
   * Separate from subscribe(), which is the render notification: that one is
   * coalesced to at most once per animation frame and says only "something
   * changed". A narrator needs the individual events, in order, with their
   * fields.
   *
   * A listener that throws must not break the store, so each is called
   * defensively.
   */
  onEvent(cb: (ev: Record<string, unknown>) => void): () => void {
    this._eventListeners.add(cb);
    return () => {
      this._eventListeners.delete(cb);
    };
  }

  private _eventListeners = new Set<(ev: Record<string, unknown>) => void>();

  private _emitEvent(ev: Record<string, unknown>): void {
    for (const cb of this._eventListeners) {
      try {
        cb(ev);
      } catch {
        /* a bad listener is not the store's problem */
      }
    }
  }

  private _event(ev: Record<string, unknown>, replay: boolean): void {
    const kind = str(ev.ev);
    const turnId = str(ev.turn_id);

    switch (kind) {
      case 'ready':
        this._sessionId = str(ev.session_id) || this._sessionId;
        this._fault = null;
        this._setStatus('ready');
        return;

      // Synthesized by the relay, not the sidecar: the sidecar's own
      // turn_start carries no prompt, so without this a second tab would watch
      // a reply stream in with no question above it.
      case 'turn_submitted': {
        const t = this._ensure(turnId);
        if (!t) return;
        t.prompt = str(ev.prompt) || t.prompt;
        t.clientRef = str(ev.client_ref) || t.clientRef;
        return;
      }

      case 'turn_start': {
        const t = this._ensure(turnId);
        if (!t) return;
        // The relay DECORATES turn_start with the prompt and the client_ref
        // (internal/server/cos.go decorateTurn). The sidecar's own
        // turn_start carries neither, so without this a reply streams in with
        // no question above it -- including in the tab that asked.
        //
        // Adopted here rather than depended on: an undecorated turn_start
        // from a plain sidecar leaves whatever is already known intact, which
        // is what makes this additive rather than a second contract.
        t.prompt = str(ev.prompt) || t.prompt;
        t.clientRef = str(ev.client_ref) || t.clientRef;
        // A replayed turn is already finished; do not re-open it.
        if (!replay && t.status === 'pending') t.status = 'streaming';
        this._setStatus('ready');
        return;
      }

      case 'delta': {
        const text = str(ev.text);
        if (!text) return;
        const t = this._ensure(turnId);
        if (!t) return;
        if (t.status === 'pending') t.status = 'streaming';
        const tail = t.blocks[t.blocks.length - 1];
        if (tail && tail.kind === 'text') tail.text += text;
        else t.blocks.push({ kind: 'text', text });
        return;
      }

      case 'thinking': {
        const text = str(ev.text);
        if (!text) return;
        const t = this._ensure(turnId);
        if (!t) return;
        const tail = t.blocks[t.blocks.length - 1];
        if (tail && tail.kind === 'thinking') tail.text += text;
        else t.blocks.push({ kind: 'thinking', text });
        return;
      }

      case 'tool_start': {
        const t = this._ensure(turnId);
        if (!t) return;
        const callId = str(ev.call_id);
        if (t.blocks.some((b) => b.kind === 'tool' && b.callId === callId && callId !== '')) return;
        t.blocks.push({
          kind: 'tool',
          callId,
          name: str(ev.name),
          args: argsLine(ev.args),
          done: false,
          ok: false,
          summary: '',
          ms: 0,
        });
        return;
      }

      case 'tool_end': {
        const t = this._ensure(turnId);
        if (!t) return;
        const callId = str(ev.call_id);
        // Newest-first: a call id may repeat across turns, and the one being
        // closed is always the most recent open one.
        for (let i = t.blocks.length - 1; i >= 0; i--) {
          const b = t.blocks[i];
          if (b && b.kind === 'tool' && (b.callId === callId || callId === '') && !b.done) {
            b.done = true;
            b.ok = ev.ok === true;
            b.summary = str(ev.summary);
            b.ms = num(ev.ms);
            // tool_end may be the first thing seen for a replayed turn.
            if (!b.name) b.name = str(ev.name);
            return;
          }
        }
        // No matching start (dropped by a slow subscriber): show the end
        // rather than swallow the fact that a tool ran.
        t.blocks.push({
          kind: 'tool',
          callId,
          name: str(ev.name),
          args: '',
          done: true,
          ok: ev.ok === true,
          summary: str(ev.summary),
          ms: num(ev.ms),
        });
        return;
      }

      case 'approval_request': {
        // Never replayed by the relay — a resolved approval re-rendered as a
        // live prompt would ask the user to decide something they already
        // decided — but guarded here too, because this store must be safe
        // against any frame it is handed.
        if (replay) return;
        const requestId = str(ev.request_id);
        if (!requestId || this._approvals.some((a) => a.requestId === requestId)) return;
        const timeout = num(ev.timeout) || 300;
        this._approvals.push({
          requestId,
          turnId,
          tool: str(ev.tool),
          detail: str(ev.detail),
          timeout,
          deadline: Date.now() + timeout * 1000,
          answered: '',
        });
        return;
      }

      case 'turn_end': {
        const t = this._ensure(turnId);
        if (!t) return;
        this._reconcile(t, str(ev.response));
        t.costUsd = cost(ev.cost_usd);
        t.ms = num(ev.ms);
        t.error = str(ev.error);
        this._finish(t, t.error ? 'failed' : 'done');
        this._clearApprovalsFor(turnId);
        return;
      }

      case 'cancelled':
      case 'turn_cancelled': {
        const t = this._ensure(turnId);
        if (!t) return;
        this._reconcile(t, str(ev.response));
        t.ms = num(ev.ms);
        this._finish(t, 'cancelled');
        this._clearApprovalsFor(turnId);
        return;
      }

      case 'error': {
        const fatal = ev.fatal === true;
        const code = str(ev.code);
        const message = str(ev.message) || code || `${ASSISTANT_NAME} reported an error`;
        // `busy` is marked fatal:false by the spec but IS terminal for its turn
        // (2.4 law 2): a refused turn will never run, so leaving it "streaming"
        // would spin a cursor forever.
        const terminal = fatal || code === 'busy' || code === 'cancelled';
        const t = turnId ? this._ensure(turnId) : null;
        if (t) {
          // A turn that failed AT DISPATCH never produced a turn_start, so
          // this is the only frame that will ever carry its question. The
          // relay decorates it for exactly that case (decorateTurn); an
          // undecorated error leaves whatever is already known intact.
          t.prompt = str(ev.prompt) || t.prompt;
          t.clientRef = str(ev.client_ref) || t.clientRef;
          t.notices.push(message);
          if (terminal) {
            t.error = message;
            this._finish(t, code === 'cancelled' ? 'cancelled' : 'failed');
            this._clearApprovalsFor(turnId);
          }
        }
        if (fatal) {
          this._setStatus('down');
          this._fault = { code, message, fatal: true };
          // Nothing is coming back for anything still in flight.
          for (const t of this._turns) {
            if (t.status === 'pending' || t.status === 'streaming') {
              t.error = message;
              this._finish(t, 'failed');
            }
          }
          this._approvals = [];
        } else if (!turnId) {
          this._fault = { code, message, fatal: false };
        }
        return;
      }

      default:
        // 2.4 law 5. A newer sidecar's event is not an error.
        return;
    }
  }

  /**
   * Fold turn_end.response over what actually streamed.
   *
   * turn_end.response is authoritative (2.4 law 4) but the deltas are what the
   * user WATCHED, and they are interleaved with tool lines that the response
   * string knows nothing about. So: if the streamed text is a prefix of the
   * response, only the tail is appended (the ordinary case, and the case where
   * a slow browser dropped the last few deltas). If it diverged, the response
   * replaces it, because the authoritative text is the one to keep.
   */
  private _reconcile(t: CosTurn, response: string): void {
    if (!response) return;
    const streamed = t.blocks
      .filter((b): b is CosTextBlock => b.kind === 'text')
      .map((b) => b.text)
      .join('');
    if (streamed === response) return;
    if (response.startsWith(streamed)) {
      const tail = response.slice(streamed.length);
      const last = t.blocks[t.blocks.length - 1];
      if (last && last.kind === 'text') last.text += tail;
      else t.blocks.push({ kind: 'text', text: tail });
      return;
    }
    t.blocks = t.blocks.filter((b) => b.kind !== 'text');
    t.blocks.push({ kind: 'text', text: response });
  }

  /**
   * Move a turn to a terminal state and stamp when.
   *
   * The one door every terminal branch goes through, so that endedAt cannot be
   * forgotten by whichever branch is added next.
   */
  private _finish(t: CosTurn, status: CosTurnStatus): void {
    t.status = status;
    t.endedAt = Date.now();
  }

  private _clearApprovalsFor(turnId: string): void {
    this._approvals = this._approvals.filter((a) => a.turnId !== turnId);
  }

  // -- replay ---------------------------------------------------------------

  /**
   * Adopt a server replay as the conversation so far.
   *
   * REPLACES rather than merges, and that is what makes it idempotent: a
   * reconnect re-subscribes and a clear pushes a fresh replay, so this frame
   * arrives more than once per page and appending would double the visible
   * transcript every time.
   *
   * A turn still IN FLIGHT in this browser is RECONCILED against the replay
   * rather than carried past it. Replayed ids are `h-*` and live ids are
   * `t-*`, so the two can never be matched by id -- the prompt is the only
   * key both sides carry.
   *
   * The reconciliation is not optional, because a turn is only live ON THE
   * CONNECTION STREAMING IT. When that socket dies mid-answer -- a phone's
   * radio sleeping, a NAT dropping an idle flow, the heartbeat giving up on a
   * page Blink froze in the background -- `turn_end` is delivered to a
   * connection that is gone, and this browser is left holding a turn stuck in
   * `streaming` that nothing can ever finish. #94 then reconnects the moment
   * the tab becomes visible again, the replay arrives with that same turn in
   * it complete, and carrying the local copy unconditionally rendered BOTH:
   * the finished answer from the transcript, and below it a second copy of
   * the question under a "working..." that spins forever. The reader sees
   * their last question unanswered at the bottom of the conversation with the
   * real answer scrolled off above it -- reported as "the last line gets lost
   * when I switch back to this app after it going to the background".
   *
   * WHICH COPY WINS IS DECIDED BY WHICH ONE HAS THE ANSWER, and that is a
   * question about the replay, not about the local status. The sidecar builds
   * its history from the LIVE transcript (sidecar/main.py _handle_history),
   * and the user message is in that transcript from the moment the turn is
   * submitted -- so a replay taken mid-turn contains the turn ALREADY, as a
   * prompt with no reply under it. Assuming the transcript only gains a turn
   * at turn end is what made the first version of this fix drop a turn that
   * was genuinely still running.
   *
   *   replayed copy HAS reply text   it finished while we were disconnected.
   *                                  Keep it, drop the local one: the local
   *                                  one is the orphan that can never finish.
   *   replayed copy has NO reply     it is the transcript's placeholder for a
   *                                  turn still running. Keep the LOCAL one,
   *                                  which holds what has streamed so far and
   *                                  is the only copy the remaining events can
   *                                  still reach; drop the placeholder, which
   *                                  would otherwise render as a second copy
   *                                  of the question reading "ended without a
   *                                  reply".
   *
   * A FINISHED turn missing from the replay is the hard case, because absence
   * has two opposite meanings and the frame's reason is the only thing that
   * distinguishes them:
   *
   *   authoritative (a clear)  it was pruned. Drop it; putting it back is the
   *                            "clear that only emptied browser memory" bug.
   *   a subscribe replay       it may simply have finished AFTER the server
   *                            took its snapshot. The server subscribes and
   *                            snapshots on independent goroutines, and the
   *                            snapshot waits out the ~2s amplifier boot while
   *                            live events keep arriving, so a turn can start
   *                            and finish entirely inside that gap. It was in
   *                            neither list, and vanished in front of the user.
   *
   * Hence the endedAt cut: only turns this browser saw finish AFTER it asked
   * for the replay are kept, and a turn that finished inside the gap but
   * before the snapshot -- so present in BOTH -- is recognised by its prompt
   * and left to the replay, rather than rendered twice.
   *
   * Prompts are claimed from a QUEUE per prompt, oldest-first, not looked up
   * in a set. The same question asked twice is two turns in the replay and
   * must account for two local turns, not one: with a plain set, a reconnect
   * landing while a repeated question was in flight would match the live turn
   * against the OLDER answer. Claiming in order gives each replayed copy to
   * the oldest local turn that can explain it, so a live turn is only ever
   * matched by a replayed turn that nothing else accounts for.
   *
   * Replayed turns are ordinary CosTurns: same fields, same blocks, same
   * render path. Nothing downstream can tell a replayed turn from a live one,
   * which is the point -- a reloaded tab has to look like the tab it replaced.
   */
  private _replaceHistory(raw: readonly unknown[], authoritative: boolean): void {
    const replayed: CosTurn[] = [];
    for (const item of raw) {
      const turn = this._fromHistory(item);
      if (turn) replayed.push(turn);
    }
    const unclaimed = new Map<string, CosTurn[]>();
    for (const t of replayed) {
      if (t.prompt === '') continue;
      const queue = unclaimed.get(t.prompt);
      if (queue) queue.push(t);
      else unclaimed.set(t.prompt, [t]);
    }
    const claim = (prompt: string): CosTurn | null => {
      if (prompt === '') return null;
      const queue = unclaimed.get(prompt);
      return queue && queue.length > 0 ? (queue.shift() as CosTurn) : null;
    };
    /** Does this turn actually carry a reply, as opposed to a bare prompt? */
    const answered = (t: CosTurn): boolean => t.blocks.some((b) => b.kind === 'text');

    // Placeholders the local copy supersedes. Held by identity, so a repeated
    // prompt only ever removes the one replayed copy that was claimed.
    const superseded = new Set<CosTurn>();
    // _turns is oldest-first and filter walks it in that order, which is what
    // makes the claim oldest-first.
    const carried = this._turns.filter((t) => {
      const live = t.status === 'pending' || t.status === 'streaming';
      const match = claim(t.prompt);
      if (match) {
        if (!live || answered(match)) return false;
        superseded.add(match);
        return true;
      }
      if (live) return true;
      if (authoritative) return false;
      return t.endedAt >= this._replayRequestedAt;
    });
    this._turns = [...replayed.filter((t) => !superseded.has(t)), ...carried];
    this._byId = new Map(this._turns.map((t) => [t.id, t]));
  }

  /** One replayed turn, or null when the frame carried something unusable. */
  private _fromHistory(raw: unknown): CosTurn | null {
    if (!raw || typeof raw !== 'object') return null;
    const rec = raw as Record<string, unknown>;
    // Threaded snapshots add `turn_id` once the per-root attribution journal
    // has durably recorded it. Legacy summaries retain their display-only
    // `id`, so accept that as the compatibility fallback.
    const id = str(rec.turn_id) || str(rec.id);
    if (!id) return null;

    const blocks: CosBlock[] = [];
    const list = Array.isArray(rec.blocks) ? rec.blocks : [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const b = item as Record<string, unknown>;
      const kind = str(b.kind);
      const text = str(b.text);
      if (kind === 'text') {
        if (text) blocks.push({ kind: 'text', text });
      } else if (kind === 'thinking') {
        if (text) blocks.push({ kind: 'thinking', text });
      } else if (kind === 'tool') {
        blocks.push({
          kind: 'tool',
          callId: str(b.call_id),
          name: str(b.name),
          args: str(b.args),
          // A replayed tool call is finished by construction: it is being read
          // out of a transcript the turn already ended in.
          done: true,
          ok: b.ok === true,
          summary: str(b.summary),
          ms: num(b.ms),
        });
      }
      // 2.4 law 5: an unknown block kind is skipped, never fatal.
    }

    // createdAt comes from the TRANSCRIPT here, unlike a live turn where this
    // browser stamps it. That is strictly better -- it is when the turn
    // actually happened -- and it is only ever read for display.
    const stamped = Date.parse(str(rec.ts));
    return {
      id,
      prompt: str(rec.prompt),
      clientRef: '',
      blocks,
      status:
        str(rec.status) === 'active'
          ? 'streaming'
          : str(rec.status) === 'queued'
            ? 'pending'
            : str(rec.status) === 'failed'
              ? 'failed'
              : str(rec.status) === 'cancelled'
                ? 'cancelled'
                : 'done',
      notices: [],
      // No cost: the transcript does not record one per turn, and the footer
      // is built to omit what it was not given rather than show "$0.00",
      // which would read as free. `ms` IS carried -- the sidecar derives it
      // from the turn's own timestamps -- so a replayed turn keeps its "2.7s".
      costUsd: '',
      ms: num(rec.ms),
      error: '',
      createdAt: Number.isFinite(stamped) ? stamped : Date.now(),
      // Zero, not `stamped`: endedAt answers "did THIS browser watch it
      // finish, since it last asked for a replay?", and the answer for a turn
      // read out of the server's transcript is no. Any later replay is
      // entitled to replace it.
      endedAt: 0,
    };
  }

  /**
   * Upsert by turn id — the ordering guarantee this whole store rests on.
   *
   * NULL when the event named no turn, and the caller must then drop the
   * event. The alternative this replaced was a shared '(unknown)' bucket, and
   * it was a trap: no real event ever carries that id, so nothing could ever
   * terminate the turn it created. It stayed `pending` for the life of the
   * page — `busy` true forever, the stop button lit, the phantom carried
   * across every replay, its blocks growing without bound. Ignoring an event
   * that cannot be placed is what the file header promises anyway (2.4 law 5).
   */
  private _ensure(turnId: string): CosTurn | null {
    const id = turnId;
    if (!id) return null;
    const found = this._byId.get(id);
    if (found) return found;
    const t: CosTurn = {
      id,
      prompt: '',
      clientRef: '',
      blocks: [],
      status: 'pending',
      notices: [],
      costUsd: '',
      ms: 0,
      error: '',
      createdAt: Date.now(),
      endedAt: 0,
    };
    this._byId.set(id, t);
    this._turns = [...this._turns, t];
    return t;
  }

  private _setStatus(s: CosStatus): void {
    this._status = s;
  }

  subscribe(cb: () => void): () => void {
    this._listeners.add(cb);
    return () => {
      this._listeners.delete(cb);
    };
  }

  /**
   * Tell every reader that something changed, AT MOST ONCE PER FRAME.
   *
   * The coalescing is not a micro-optimisation; it is the backpressure this
   * store had none of. A delta is a few dozen bytes, but the view re-binds the
   * WHOLE accumulated reply on every notify (mux-cos.ts _renderBlock), so
   * notifying per event costs O(reply so far) per event and O(reply^2) per
   * turn. Measured on a 1 MB reply streamed as 5,243 deltas: the server
   * finished at 30s and the browser was still rendering at 271s, the gap
   * between deltas growing linearly with the text already on screen.
   *
   * That lag is what turns into LOSS. A browser that cannot drain its socket
   * stops draining it; the relay's per-subscriber queue fills; the broker
   * drops events into it -- and the reply is left truncated mid-sentence with
   * nothing on screen to say so. Same run at 4 MB: 2,895 events dropped, and
   * the transcript stopped at 26% of the answer.
   *
   * requestAnimationFrame is the right primitive because it is SELF-LIMITING:
   * the next callback is only scheduled once the previous frame has been
   * painted, so a browser that is struggling renders less often instead of
   * falling further behind. A hidden tab schedules no frames at all, which is
   * correct -- the store keeps accumulating and the whole turn is painted in
   * one pass when the tab comes back.
   *
   * The setTimeout fallback is for environments with no rAF (tests, SSR),
   * where the coalescing still holds but the cadence is the task queue's.
   */
  private _notifyPending = false;

  private _notify(): void {
    if (this._notifyPending) return;
    this._notifyPending = true;
    const flush = () => {
      this._notifyPending = false;
      for (const cb of this._listeners) cb();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 0);
  }
}

export const cosStore = new CosStore();
