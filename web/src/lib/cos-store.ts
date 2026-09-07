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

class CosStore {
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
        message: 'muxterm could not be reached, so nothing was answered',
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
        message: 'muxterm could not be reached, so nothing was cleared',
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

  /** Re-assert after a reconnect; ws.ts replays the subscribe frame itself. */
  markReconnected(): void {
    if (this._status === 'idle') return;
    this._subscribed = true;
    // ws.ts replays the subscribe frame, so a replay is on its way and the
    // window it covers starts now.
    this._replayRequestedAt = Date.now();
    this._setStatus('starting');
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
        this._fault = { code: 'subscribe_failed', message: str(frame.error) || 'muxterm could not be reached', fatal: true };
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
    this._event(ev as Record<string, unknown>, frame.replay === true);
    this._notify();
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
        const message = str(ev.message) || code || 'muxterm reported an error';
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
   * Turns still IN FLIGHT in this browser are always carried across. They are
   * not in the server's transcript yet -- it is written at turn end -- so
   * dropping them would erase a question whose answer is still streaming.
   * Replayed ids are `h-*` and live ids are `t-*`, so the two sets can never
   * collide.
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
    const replayedPrompts = new Set(replayed.map((t) => t.prompt).filter((p) => p !== ''));
    const carried = this._turns.filter((t) => {
      if (t.status === 'pending' || t.status === 'streaming') return true;
      if (authoritative) return false;
      if (t.endedAt < this._replayRequestedAt) return false;
      return !(t.prompt !== '' && replayedPrompts.has(t.prompt));
    });
    this._turns = [...replayed, ...carried];
    this._byId = new Map(this._turns.map((t) => [t.id, t]));
  }

  /** One replayed turn, or null when the frame carried something unusable. */
  private _fromHistory(raw: unknown): CosTurn | null {
    if (!raw || typeof raw !== 'object') return null;
    const rec = raw as Record<string, unknown>;
    const id = str(rec.id);
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
      status: 'done',
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

  private _notify(): void {
    for (const cb of this._listeners) cb();
  }
}

export const cosStore = new CosStore();
