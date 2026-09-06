import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { parseHostRef } from '../lib/host-ref.js';
import { remotesStore, type HostConnState } from '../lib/remotes-store.js';
import { muxLog } from '../lib/mux-log.js';
import { store } from '../state.js';

/**
 * mux-connect-dialog — "Connect machine" (plan U3, wireframe screen 4).
 *
 * Three things live here and nothing else does:
 *
 *   1. the candidate list, one row per host the transport DISCOVERED
 *      (GET /api/remotes?probe=1 → `discovered`);
 *   2. a manual `user@host` field that is ALWAYS present — not a fallback,
 *      not revealed by a "can't find it?" link. Design D7: discovery is
 *      per-transport and a transport with no discovery at all is a legal
 *      transport, so manual entry is the one entry point that can never go
 *      away;
 *   3. a probe trace of EXACTLY THREE LINES.
 *
 * The three-line budget is a decision, not an accident. The first draft had
 * five — protocol check, latency, binary path — and the ux doc's YAGNI pass
 * threw two out as "invisible successes": steps that only ever say yes, and
 * that a user is not being asked to act on. Do not add a fourth line here.
 * If something new must be said, one of these three has to go.
 *
 * One deliberate deviation from the wireframe, and it is recorded in the plan:
 * the wireframe's second line reads `✓ muxterm 0.9.2`, but NOTHING ON THE WIRE
 * REPORTS THE REMOTE VERSION — `ProbeReport` carries a path, a user and a
 * state, and that is all. So the line reports the resolved path, which is
 * real. Inventing a version string is exactly the trap the YAGNI pass already
 * threw out, and it would be a lie the moment the far side is upgraded.
 *
 * The dialog chrome (`.dialog.cdialog` in the wireframe) is app.ts's
 * `.overlay-backdrop > .overlay-dialog.cdialog`, shared with Settings. This
 * component is the contents: header, body, footer.
 *
 * Events:
 *   close — Cancel, ×, or a completed attach. app.ts closes the overlay.
 */

// ── Wire types ───────────────────────────────────────────────────────────────
// Field names and tokens are the contract in internal/server/remotes_api.go
// (hostRow, remotesListResponse, remoteConnectResponse). Do not widen them
// here without changing that file: the browser and the server are shipped in
// the same binary, so there is no version skew to tolerate, and a tolerant
// parse would only hide a rename.

/** The four probe tokens the server puts on the wire. */
type ProbeState = 'present' | 'login-shell-only' | 'absent' | 'unknown';

const PROBE_STATES: readonly string[] = ['present', 'login-shell-only', 'absent', 'unknown'];

/** One candidate row from GET /api/remotes. Only the fields this dialog reads. */
interface HostRow {
  /** HostRef.ID — the key every other route takes, e.g. "ssh:gpu-01". */
  id: string;
  /** Display label. DISPLAY ONLY: names are mutable, ids are not (D7). */
  name: string;
  /** The dial target, e.g. "ken@10.4.2.19" — the `.cand-sub` line. */
  target: string;
  probe: ProbeState;
}

/**
 * How long the finished trace stays on screen before the dialog closes.
 *
 * The plan asks for both "line 3 becomes ✓ attached · N workspaces, M panes"
 * and "on host-state{connected} the dialog closes". Closing on the same tick
 * would make the first of those unobservable, so the last line gets one beat
 * to be read. Short enough that nobody waits on it.
 */
const ATTACH_LINGER_MS = 1200;

/** One rendered trace line. `run` is the in-progress step, at most one. */
interface TraceLine {
  kind: 'ok' | 'fail' | 'run';
  text: string;
}

/**
 * The trace, as three named slots rather than a list, so the ORDER is a
 * property of the type and the fourth line is unrepresentable.
 */
interface Trace {
  /** The host this trace is about; host-state for anything else is not ours. */
  hostId: string;
  /** 1. Did ssh get in, and as whom. */
  reach: TraceLine;
  /**
   * 2. Is muxterm over there, and where.
   *
   * Null when the answer is genuinely unknown — a cached connect to an
   * already-connected host can come back with no probe at all, and "muxterm
   * found" would be a claim this dialog cannot make.
   */
  binary: TraceLine | null;
  /** 3. The dial. Null when the server did not start one. */
  attach: TraceLine | null;
}

/** What the last confirm press did, and what it learned. */
interface Attempt {
  hostId: string;
  probe: ProbeState;
  /** True once a terminal host-state has been folded into line 3. */
  settled: boolean;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function probeOf(value: unknown): ProbeState {
  return typeof value === 'string' && PROBE_STATES.includes(value)
    ? (value as ProbeState)
    : 'unknown';
}

function rowOf(value: unknown): HostRow | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  const id = str(r['id']);
  if (id === '') return null;
  return {
    id,
    name: str(r['name']) || id,
    target: str(r['target']),
    probe: probeOf(r['probe']),
  };
}

function rowsOf(value: unknown): HostRow[] {
  if (!Array.isArray(value)) return [];
  const out: HostRow[] = [];
  for (const item of value) {
    const row = rowOf(item);
    if (row) out.push(row);
  }
  return out;
}

/**
 * The error text for a failed request: the server's own words when it sent
 * any, because internal/server writes them for a human and ssh's own "No
 * route to host" beats anything this file could paraphrase.
 */
function errorOf(body: unknown, res: Response): string {
  const e = typeof body === 'object' && body !== null
    ? str((body as Record<string, unknown>)['error'])
    : '';
  return e !== '' ? e : `HTTP ${res.status}`;
}

/** "1 pane" / "5 panes" — the count is the whole message. */
function countLabel(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? '' : 's'}`;
}

@customElement('mux-connect-dialog')
export class MuxConnectDialog extends LitElement {
  static styles = css`
    /* Tokens the wireframe assumes. --ink-3 is defined the same way
       mux-home.ts defines it: a mix of the CHROME text tokens, never of the
       terminal palette, so it holds its contrast in every theme. */
    :host {
      --ink-3: color-mix(in srgb, var(--chrome-text-dim) 55%, var(--chrome-text-bright));
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: var(--chrome-body);
      color: var(--chrome-text-bright);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      box-sizing: border-box;
      overflow: hidden;
    }

    /* ── Header ── */
    .d-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px 14px;
      border-bottom: 1px solid var(--chrome-border);
      flex-shrink: 0;
    }

    .d-header h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
    }

    .close-btn {
      background: transparent;
      border: none;
      color: var(--chrome-text-dim);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 3px 7px;
      border-radius: 4px;
      transition: color 0.1s, background 0.1s;
    }

    .close-btn:hover {
      color: var(--chrome-text-bright);
      background: var(--chrome-hover);
    }

    /* ── Body ── */
    .cd-body {
      flex: 1;
      min-height: 0;
      padding: 18px 20px;
      overflow-y: auto;
    }

    .cand {
      display: flex;
      align-items: center;
      gap: 11px;
      padding: 9px 11px;
      border: 1px solid transparent;
      border-radius: 6px;
      cursor: pointer;
    }

    .cand:hover { background: var(--chrome-hover); }

    .cand.sel {
      background: var(--chrome-hover);
      border-color: var(--chrome-accent);
    }

    .cand:focus-visible {
      outline: none;
      border-color: var(--chrome-accent);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--chrome-accent) 25%, transparent);
    }

    .cand-radio {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      border: 1px solid var(--chrome-text-dim);
      flex-shrink: 0;
      position: relative;
    }

    .cand.sel .cand-radio { border-color: var(--chrome-accent); }

    .cand.sel .cand-radio::after {
      content: '';
      position: absolute;
      inset: 3px;
      border-radius: 50%;
      background: var(--chrome-accent);
    }

    .cand-main { flex: 1; min-width: 0; }

    .cand-name {
      font-size: 13px;
      color: var(--chrome-text-bright);
      font-weight: 500;
    }

    .cand-sub {
      font-family: var(--mono);
      font-size: 10.5px;
      color: var(--chrome-text-dim);
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Amber, and ONLY for probe === "absent". login-shell-only gets no tag:
       Dial goes through a login shell precisely so that install works, so a
       tag there would be a warning about a non-problem. */
    .cand-tag {
      font-family: var(--mono);
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      flex-shrink: 0;
      color: var(--mux-warn);
      border: 1px solid color-mix(in srgb, var(--mux-warn) 45%, transparent);
      background: color-mix(in srgb, var(--mux-warn) 12%, transparent);
    }

    .divider {
      height: 1px;
      background: var(--chrome-border);
      margin: 14px 0 12px;
    }

    .ai-input {
      padding: 6px 8px;
      background: var(--chrome-body);
      border: 1px solid var(--chrome-border);
      border-radius: 4px;
      color: var(--chrome-text-bright);
      font: inherit;
      font-size: 12px;
      width: 100%;
      box-sizing: border-box;
    }

    .ai-input:focus {
      outline: none;
      border-color: var(--chrome-accent);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--chrome-accent) 25%, transparent);
    }

    /* ── The three-line trace ── */
    .probe {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--ink-3);
      line-height: 1.8;
      background: var(--chrome-bar);
      border: 1px solid var(--chrome-border);
      border-radius: 6px;
      padding: 10px 12px;
      margin-top: 14px;
      white-space: pre-wrap;
    }

    .probe .ok { color: var(--mux-ok); }
    .probe .run { color: var(--mux-ansi-6); }
    /* Not in the wireframe, which only drew the happy path. A ✗ that renders
       in the same ink as a ✓ is a failure the eye slides past. */
    .probe .fail { color: var(--mux-error); }

    /* ── Footer ── */
    .cd-foot {
      display: flex;
      justify-content: flex-end;
      gap: 9px;
      padding: 14px 20px 16px;
      border-top: 1px solid var(--chrome-border);
      flex-shrink: 0;
    }

    .b-cancel {
      padding: 10px 18px;
      background: transparent;
      color: var(--chrome-text-dim);
      border: 1px solid var(--chrome-border);
      border-radius: 7px;
      font: inherit;
      font-size: 14px;
      cursor: pointer;
    }

    .b-cancel:hover {
      background: var(--chrome-hover);
      color: var(--chrome-text-bright);
    }

    .b-confirm {
      padding: 10px 22px;
      background: var(--chrome-accent);
      color: var(--chrome-body);
      border: none;
      border-radius: 7px;
      font: inherit;
      font-size: 14px;
      font-weight: 600;
      min-width: 96px;
      cursor: pointer;
    }

    .b-confirm:disabled { opacity: 0.45; cursor: not-allowed; }
    .b-confirm:not(:disabled):hover { opacity: 0.85; }
  `;

  /** Discovered candidates. Empty is a legal, complete state (D7). */
  @state() private _candidates: HostRow[] = [];
  /** Selected candidate id; '' means the manual field is the target. */
  @state() private _selectedId = '';
  /** The manual `user@host` field. */
  @state() private _manual = '';
  @state() private _trace: Trace | null = null;
  @state() private _busy = false;

  /**
   * The last confirm press. Not @state: every write to it is paired with a
   * write to _trace, which is.
   */
  private _attempt: Attempt | null = null;
  private _unsubHosts: (() => void) | null = null;
  private _closeTimer: ReturnType<typeof setTimeout> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    // The dialog is only in the DOM while it is open (app.ts renders it under
    // `_overlayPanel === 'connect'`), so "on open" is exactly here. ?probe=1
    // is what fills in the `not installed` tags — a bare GET spends no ssh
    // round trips and would leave every probe "unknown".
    void this._load();
    // Line 3 is the only part of this dialog that cannot be answered by an
    // HTTP reply: the dial belongs to the browser's own session and its
    // outcome arrives as a host-state frame.
    this._unsubHosts = remotesStore.subscribe(this._onHostState);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsubHosts?.();
    this._unsubHosts = null;
    if (this._closeTimer !== null) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
  }

  override render() {
    const probe = this._effectiveProbe();
    return html`
      <div class="d-header">
        <h2>Connect machine</h2>
        <button class="close-btn" title="Close" @click="${this._close}">×</button>
      </div>
      <div class="cd-body">
        ${this._candidates.map((row) => this._renderCandidate(row))}
        ${this._candidates.length > 0 ? html`<div class="divider"></div>` : ''}
        <input
          class="ai-input"
          type="text"
          placeholder="user@host"
          .value="${this._manual}"
          ?disabled="${this._busy}"
          @input="${this._onManualInput}"
          @keydown="${this._onManualKeyDown}"
        />
        ${this._renderProbe()}
      </div>
      <div class="cd-foot">
        <button class="b-cancel" @click="${this._close}">Cancel</button>
        <button
          class="b-confirm"
          ?disabled="${this._busy || !this._hasTarget}"
          @click="${this._onConfirm}"
        >${this._confirmLabel(probe)}</button>
      </div>
    `;
  }

  private _renderCandidate(row: HostRow) {
    const selected = row.id === this._selectedId;
    return html`
      <div
        class="cand ${selected ? 'sel' : ''}"
        role="radio"
        aria-checked="${selected ? 'true' : 'false'}"
        tabindex="0"
        @click="${() => this._select(row.id)}"
        @keydown="${(e: KeyboardEvent) => this._onCandidateKeyDown(e, row.id)}"
      >
        <span class="cand-radio"></span>
        <div class="cand-main">
          <div class="cand-name">${row.name}</div>
          <div class="cand-sub">${row.target}</div>
        </div>
        ${row.probe === 'absent' ? html`<span class="cand-tag">not installed</span>` : ''}
      </div>
    `;
  }

  /**
   * The trace. Three slots, rendered in order, each one omitted when there is
   * nothing TRUE to put in it — an omitted line says less than a line that
   * guesses.
   */
  private _renderProbe() {
    const t = this._trace;
    if (!t) return '';
    const lines: TraceLine[] = [t.reach];
    if (t.binary) lines.push(t.binary);
    if (t.attach) lines.push(t.attach);
    return html`<div class="probe">${lines.map((line, i) => html`${i > 0 ? '\n' : ''}<span
      class="${line.kind}"
    >${line.kind === 'ok' ? '✓' : line.kind === 'fail' ? '✗' : '▸'}</span> ${line.text}`)}</div>`;
  }

  // ── Target selection ───────────────────────────────────────────────────────

  /** True when there is something to connect TO. */
  private get _hasTarget(): boolean {
    return this._selectedId !== '' || this._manual.trim() !== '';
  }

  /**
   * The probe state of the current target, best known.
   *
   * The attempt wins when there is one, because it came from a probe run
   * seconds ago; otherwise the list's own ?probe=1 answer.
   */
  private _effectiveProbe(): ProbeState {
    if (this._attempt) return this._attempt.probe;
    const row = this._candidates.find((c) => c.id === this._selectedId);
    return row ? row.probe : 'unknown';
  }

  /**
   * The confirm verb.
   *
   * "Install & connect" for a host we KNOW has no muxterm, whether that came
   * from the list or from the trace. Offering plain "Connect" there would
   * start a session that can only fail — internal/server says as much where
   * it admits the host anyway ("the UI should have offered Install & connect
   * instead"), and one doomed round trip is not a better user experience than
   * naming the verb correctly the first time.
   */
  private _confirmLabel(probe: ProbeState): string {
    if (this._busy) return probe === 'absent' ? 'Installing…' : 'Connecting…';
    if (probe === 'absent') return 'Install & connect';
    if (this._failed()) return 'Retry';
    return 'Connect';
  }

  private _failed(): boolean {
    const t = this._trace;
    if (!t) return false;
    return t.reach.kind === 'fail' || t.attach?.kind === 'fail';
  }

  /**
   * Pick a candidate. Re-clicking the selected one deselects it, which is how
   * you get back to the manual field without deleting your selection by
   * typing over it.
   *
   * Any change of target drops the trace: it described a DIFFERENT machine,
   * and leaving it up would attach last machine's answers to this one's name.
   */
  private _select(id: string): void {
    const next = this._selectedId === id ? '' : id;
    if (next === this._selectedId) return;
    this._selectedId = next;
    this._resetAttempt();
  }

  private _onCandidateKeyDown(e: KeyboardEvent, id: string): void {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    this._select(id);
  }

  private _onManualInput = (e: Event): void => {
    this._manual = (e.target as HTMLInputElement).value;
    // Typing is choosing: a filled manual field and a selected radio would be
    // two answers to one question.
    this._selectedId = '';
    this._resetAttempt();
  };

  private _onManualKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void this._onConfirm();
  };

  private _resetAttempt(): void {
    this._attempt = null;
    this._trace = null;
    if (this._closeTimer !== null) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
  }

  // ── Server round trips ─────────────────────────────────────────────────────

  /**
   * GET /api/remotes?probe=1 → the `discovered` array.
   *
   * `connected` and `errors` are deliberately not offered here: a connected
   * host is not a thing to connect to, and a host that failed belongs to the
   * settings pane, which has room to show the error and a Retry next to it.
   */
  private async _load(): Promise<void> {
    try {
      const res = await fetch(apiPath('/api/remotes?probe=1'));
      if (!res.ok) {
        muxLog('connect', `remotes list failed: HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as Record<string, unknown>;
      this._candidates = rowsOf(body['discovered']);
    } catch (err) {
      // A list this dialog could not fetch is not a reason to refuse the
      // manual field, which is the entry point that always works (D7).
      muxLog('connect', `remotes list failed: ${String(err)}`);
    }
  }

  private _onConfirm = async (): Promise<void> => {
    if (this._busy || !this._hasTarget) return;
    const install = this._effectiveProbe() === 'absent';
    this._busy = true;
    try {
      let id = this._selectedId;
      if (id === '') {
        // Manual entry: write the ssh config entry first, then connect it.
        // Two calls because they are two decisions server-side — adding does
        // not dial (a typo would otherwise both edit ~/.ssh/config and start
        // a background reconnect loop).
        const added = await this._add(this._manual.trim());
        if (added === null) return;
        id = added;
      }
      await this._connect(id, install);
    } finally {
      this._busy = false;
    }
  };

  /** POST /api/remotes {target} → the new host's id, or null (trace carries why). */
  private async _add(target: string): Promise<string | null> {
    try {
      const res = await fetch(apiPath('/api/remotes'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        this._fail('', errorOf(body, res));
        return null;
      }
      const id = str(body['id']);
      if (id === '') {
        this._fail('', 'the server accepted the host but returned no id');
        return null;
      }
      return id;
    } catch (err) {
      this._fail('', String(err));
      return null;
    }
  }

  /**
   * POST /api/remotes/{id}/connect — or /provision for "Install & connect",
   * which installs and then connects.
   *
   * The probe on the far end of this call is SYNCHRONOUS, which is the whole
   * reason lines 1 and 2 can be rendered from real data instead of guesses.
   * The dial is not: line 3 waits for host-state.
   */
  private async _connect(id: string, install: boolean): Promise<void> {
    const route = `/api/remotes/${encodeURIComponent(id)}/${install ? 'provision' : 'connect'}`;
    let res: Response;
    let body: Record<string, unknown>;
    try {
      res = await fetch(apiPath(route), { method: 'POST' });
      body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    } catch (err) {
      this._fail(id, String(err));
      return;
    }
    if (!res.ok) {
      this._fail(id, errorOf(body, res));
      return;
    }

    const probe = probeOf(body['probe']);
    const user = str(body['user']);
    const path = str(body['path']);

    this._attempt = { hostId: id, probe, settled: false };
    this._trace = {
      hostId: id,
      // 1 — the login the probe authenticated as. Empty when the target names
      // no user (an ssh alias resolved by ~/.ssh/config), and the server is
      // deliberately not guessing $USER there, so neither does this line.
      reach: { kind: 'ok', text: user !== '' ? `reachable as ${user}` : 'reachable' },
      // 2 — the PATH, not a version. See the header comment.
      binary: probe === 'absent'
        ? { kind: 'fail', text: 'muxterm not installed' }
        : path !== ''
          ? { kind: 'ok', text: `muxterm at ${path}` }
          : null,
      // 3 — only when the server actually started a dial. /provision answers
      // never-connected when the install ran but muxterm still is not there,
      // and "attaching…" would be a claim nobody made.
      attach: str(body['state']) === 'connecting'
        ? { kind: 'run', text: 'attaching…' }
        : null,
    };

    // Connecting an already-connected host is a no-op server-side and emits
    // no new host-state, so nothing would ever arrive to settle line 3.
    this._onHostState();
  }

  /** Put a raw failure on line 1 and drop the rest: nothing else is known. */
  private _fail(hostId: string, message: string): void {
    this._attempt = hostId !== '' ? { hostId, probe: 'unknown', settled: true } : null;
    this._trace = {
      hostId,
      reach: { kind: 'fail', text: message },
      binary: null,
      attach: null,
    };
  }

  // ── host-state → line 3 ────────────────────────────────────────────────────

  /**
   * Fold the attempt's host state into line 3, once.
   *
   * Only the FIRST terminal state counts: a host that connects, drops and
   * reconnects an hour later must not reopen a dialog that closed, and
   * `settled` is what stops the subscription from writing to a trace whose
   * story is over.
   */
  private _onHostState = (): void => {
    const attempt = this._attempt;
    const trace = this._trace;
    if (!attempt || !trace || attempt.settled) return;
    if (trace.attach === null) return;

    const state: HostConnState | undefined = remotesStore.get(attempt.hostId)?.state;
    if (state === 'connected') {
      attempt.settled = true;
      this._trace = { ...trace, attach: { kind: 'ok', text: this._attachedLine(attempt.hostId) } };
      // Read, then gone.
      this._closeTimer = setTimeout(() => {
        this._closeTimer = null;
        this._close();
      }, ATTACH_LINGER_MS);
      return;
    }
    if (state === 'unreachable') {
      attempt.settled = true;
      const error = remotesStore.get(attempt.hostId)?.error ?? '';
      this._trace = {
        ...trace,
        attach: { kind: 'fail', text: error !== '' ? error : 'unreachable' },
      };
    }
  };

  /**
   * "attached · 2 workspaces, 5 panes" — counted from the merged workspace
   * list filtered to this host, which is the same list the sidebar is about
   * to draw. Nothing is fetched for it: if the numbers were not already in
   * the browser, the sidebar behind this dialog would be wrong too.
   */
  private _attachedLine(hostId: string): string {
    const mine = store.workspaces.filter((w) => parseHostRef(w.workspaceId).host === hostId);
    const panes = mine.reduce((sum, w) => sum + (w.paneCount ?? 0), 0);
    return `attached · ${countLabel(mine.length, 'workspace')}, ${countLabel(panes, 'pane')}`;
  }

  private _close = (): void => {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-connect-dialog': MuxConnectDialog;
  }
}
