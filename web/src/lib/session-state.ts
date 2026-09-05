/**
 * Session state contract for the muxterm "home" view.
 *
 * This file is the browser-side mirror of internal/sessiond/sessionstate.go.
 * It is committed to the base commit ahead of implementation so the backend and
 * frontend can be built independently without either guessing the other's
 * shape. If you change a field here, change it there in the same commit.
 *
 * This contract is HARNESS-AGNOSTIC. Nothing here names a specific
 * coding-agent CLI: an Amplifier lane, a Claude Code session, and a shell
 * script that shelled out to `muxterm session report` are all just rows. The
 * producer contract lives in docs/session-state-protocol.md.
 *
 * Vocabulary note: the six nouns in play are workspace, pane, terminal,
 * session, project, and artifact. A "task" is not an object -- it is the
 * session's first prompt. Do not introduce new nouns.
 */

/**
 * Session lifecycle states, adopted verbatim from Claude Code's agent view so
 * the vocabulary matches what users already know.
 */
export type SessionRunState = 'working' | 'blocked' | 'done' | 'failed' | 'stopped';

/** Reasons a session is blocked. Only meaningful when state === 'blocked'. */
export type WaitingFor =
  | 'permission prompt'
  | 'input needed'
  | 'sandbox request'
  | 'worker request'
  | 'dialog open';

/**
 * Session run modes. This distinction is load-bearing for the whole feature,
 * and it answers exactly one question:
 *
 *     Does going quiet mean "broke" or "resting"?
 *
 * - `interactive`: the session ends its turn and waits for a human. That is its
 *   CONTRACT, not a fault. A quiet interactive session must NEVER surface as an
 *   alarm.
 * - `autonomous`: the session runs a loop toward a stop condition of its own. A
 *   quiet autonomous session means the loop BROKE, and that IS the alarm.
 *
 * These names are deliberately harness-neutral. They were once spelled
 * `goal|plain`, after Amplifier's /goal command, which only names the
 * distinction correctly if you already know what /goal is. Claude Code has
 * background and foreground sessions; a job CLI has batch runs. The distinction
 * is universal; the Amplifier spelling was not.
 *
 * Getting this wrong makes every idle session look like an emergency, users
 * learn to ignore the indicator, and the home view becomes worthless.
 */
export type SessionMode = 'interactive' | 'autonomous';

/**
 * Coding-agent CLIs muxterm recognizes by name, mirroring the Harness*
 * constants in internal/sessiond/sessionstate.go (which are in turn the agent
 * catalog's names -- one vocabulary, not two).
 */
export const KNOWN_HARNESSES = ['amplifier', 'claude', 'codex', 'opencode'] as const;

export type KnownHarness = (typeof KNOWN_HARNESSES)[number];

/**
 * Which agent CLI is running a session.
 *
 * Deliberately OPEN, not a closed union: any producer may declare any harness
 * string (see docs/session-state-protocol.md). `KnownHarness | (string & {})`
 * keeps editor autocomplete for the four muxterm knows about while still
 * accepting a fifth nobody has written yet. A value not in KNOWN_HARNESSES gets
 * a neutral badge and is NEVER dropped -- refusing to show a session because
 * muxterm has not heard of its runner would make the fleet view lie about the
 * fleet.
 */
export type Harness = KnownHarness | (string & {});

/** Whether a declared harness is one muxterm has a name for. */
export function isKnownHarness(h: string | undefined): h is KnownHarness {
  return !!h && (KNOWN_HARNESSES as readonly string[]).includes(h);
}

/**
 * One row of the home view: everything known about a single agent session
 * running in a muxterm pane.
 *
 * Every field is DECLARED by that session's own producer. Nothing here is
 * inferred from PTY state -- the daemon's activity classifier cannot
 * distinguish "thinking" from "waiting for you", which is why this declared
 * channel exists.
 */
export interface SessionState {
  /** The producer's own session id. */
  sessionId: string;
  /** muxterm pane holding this session's terminal. */
  paneId: number;
  /** muxterm workspace containing that pane. */
  workspaceId: string;
  /** Which agent CLI is running this. Absent means nothing was declared. */
  harness?: Harness;
  /** Working directory. Absolute path. */
  project?: string;
  /** Short title, conventionally the session's first prompt, trimmed. */
  name: string;
  mode: SessionMode;
  state: SessionRunState;
  /** Present only when state === 'blocked'. */
  waitingFor?: WaitingFor;
  /** Short line describing current activity, refreshed cheaply. */
  doing?: string;
  /** The session's declared stop condition. Normally only when autonomous. */
  doneMeans?: string;
  /** Distinct artifact paths this session has read. */
  knows?: string[];
  /**
   * Associated PR number. Shown on the row; it does NOT change the row's
   * group. Having a PR says nothing about whether the session wants you,
   * which is the only question the groups answer.
   */
  pr?: number;
  /** Unix timestamp (seconds) of the last state change. */
  updatedAt: number;
}

/**
 * Home view groups, in display order.
 *
 * A lifecycle, not a taxonomy. Anything you launch enters `Running`, and
 * leaves it in exactly one of two directions: it wants you (`Needs input`) or
 * it is over (`Completed`). There is no third exit and no state that sits
 * outside the story, which is what makes the set readable at a glance.
 *
 * `Completed` merges done, failed and stopped on purpose. How a session ended
 * is a property of the row -- and the row's summary line says which -- not a
 * reason to sit somewhere else. Splitting them would mean scanning three
 * groups to answer "is anything still going?".
 */
export const HOME_GROUPS = ['Needs input', 'Running', 'Completed'] as const;

export type HomeGroup = (typeof HOME_GROUPS)[number];

/**
 * Place a session into its home-view group.
 *
 * Three groups, and the shape is a lifecycle rather than a taxonomy: anything
 * you launch enters `Running`, and leaves it in exactly one of two directions
 * -- it wants you (`Needs input`) or it is over (`Completed`). There is no
 * fourth place to land and no state that sits outside the story.
 *
 * `Ready for review` used to be a group of its own, promoted by an open PR.
 * It is gone: having a PR is a PROPERTY of a finished session, not a stage in
 * its life, and giving it a group meant one finished session outranked another
 * for a reason that had nothing to do with whether it needed you. The PR still
 * shows on the row, where a property belongs.
 *
 * The rule for the first group lives in needsInput() and is called from here
 * rather than repeated, so the group a row lands in and the number on the
 * Start card can never disagree about what "needs input" means.
 */
export function groupFor(s: SessionState): HomeGroup {
  if (needsInput(s)) return 'Needs input';
  if (s.state === 'working') return 'Running';
  return 'Completed';
}

/**
 * Whether a session belongs in "Needs input".
 *
 * Two ways in, and the second is the entire reason `mode` exists on the wire.
 *
 * 1. `blocked` -- it is sitting at a permission prompt or has asked something.
 *    Explicit, any mode.
 *
 * 2. An AUTONOMOUS session that is `stopped`. This is the load-bearing half of
 *    the mode contract: going quiet means "resting" for an interactive session
 *    and "the loop broke" for an autonomous one. An interactive session ending
 *    its turn rests at `stopped` and must NEVER surface here -- that is its
 *    contract, not a fault. An autonomous session reaching `stopped` did not
 *    reach its own stop condition: it hit a turn cap or was cancelled, and it
 *    is standing there with no verdict, waiting for somebody to decide whether
 *    to resume it, re-scope it, or let it go. Same state word, opposite
 *    meaning, and `mode` is the only thing that can tell them apart.
 *
 * `failed` is deliberately NOT here, even though an autonomous lane can only
 * reach it from its own goal evaluator. `failed` is a VERDICT -- the lane
 * finished and the answer was no. `stopped` is the ABSENCE of one. The row
 * that wants a human decision is the one nobody has decided yet; a verdict can
 * be read at leisure in "Completed", which is where the triage grouping
 * deliberately merges every ending.
 *
 * Known transient: a goal lane that is about to report `achieved` passes
 * through `autonomous` + `stopped` for the seconds its summary call takes, so
 * it can flash here before settling into "Completed". That is the direction
 * chosen on purpose -- the alternative is a lane that broke reading as a quiet
 * resting session, which HIDES a failure, and hiding is the one direction this
 * view must never fail in.
 */
export function needsInput(s: SessionState): boolean {
  if (s.state === 'blocked') return true;
  return s.mode === 'autonomous' && s.state === 'stopped';
}

/** Count of sessions needing input, for the sidebar Start card. */
export function needsInputCount(sessions: readonly SessionState[]): number {
  return sessions.reduce((n, s) => (needsInput(s) ? n + 1 : n), 0);
}

/**
 * Per-workspace needs-input counts, for the sidebar workspace card badges.
 * The Start card total is the sum of these, so the two can never disagree.
 */
export function needsInputByWorkspace(
  sessions: readonly SessionState[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sessions) {
    if (!needsInput(s)) continue;
    out.set(s.workspaceId, (out.get(s.workspaceId) ?? 0) + 1);
  }
  return out;
}

/** Shorten an absolute project path for display, e.g. "~/workspace/muxterm". */
export function shortProject(project: string | undefined): string {
  if (!project) return '';
  const parts = project.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] ?? '';
}

/**
 * Development fixture. Lets the home view be built and viewed before the
 * daemon-side producer exists; delete the import once live data flows.
 *
 * Deliberately a MIXED FLEET: four harnesses, one of them a made-up name no
 * version of muxterm will ever recognize. The home view is a fleet view for
 * any coding-agent CLI, and a fixture that showed only Amplifier rows would let
 * a harness-specific assumption creep back in unnoticed. The `ci-runner` row is
 * the neutral-badge case, and it is here on purpose.
 */
export const FIXTURE_SESSIONS: SessionState[] = [
  {
    sessionId: 'fx-extract-muxops',
    paneId: 1,
    workspaceId: 'parity',
    harness: 'amplifier',
    project: '/home/ken/workspace/muxterm',
    name: 'extract-muxops',
    mode: 'autonomous',
    state: 'blocked',
    waitingFor: 'input needed',
    doing: 'loop stopped, awaiting a decision',
    doneMeans: 'CLI and MCP dispatch through one layer; go build clean',
    knows: [
      '/home/ken/workspace/muxterm/internal/mcp/run.go',
      '/home/ken/workspace/muxterm/cmd/muxterm/pane_cmd.go',
      '/home/ken/workspace/muxterm/AGENTS.md',
    ],
    updatedAt: 0,
  },
  {
    sessionId: 'fx-pr-412-rebase',
    paneId: 9,
    workspaceId: 'infra',
    harness: 'claude',
    project: '/home/ken/workspace/muxterm',
    name: 'pr-412-rebase',
    mode: 'autonomous',
    state: 'blocked',
    waitingFor: 'permission prompt',
    doing: 'force-push rewrites 4 commits',
    updatedAt: 0,
  },
  {
    sessionId: 'fx-pane-send-cli',
    paneId: 2,
    workspaceId: 'parity',
    harness: 'amplifier',
    project: '/home/ken/workspace/muxterm',
    name: 'pane-send-cli',
    mode: 'autonomous',
    state: 'working',
    doing: 'writing keys to bytes translation',
    updatedAt: 0,
  },
  {
    sessionId: 'fx-scrollback-parity',
    paneId: 3,
    workspaceId: 'parity',
    harness: 'codex',
    project: '/home/ken/workspace/muxterm',
    name: 'scrollback-parity',
    mode: 'autonomous',
    state: 'done',
    doing: 'MCP get_screen pages history now',
    pr: 51,
    updatedAt: 0,
  },
  {
    sessionId: 'fx-nightly-smoke',
    paneId: 4,
    workspaceId: 'infra',
    // Not a harness muxterm has ever heard of -- a shell script reporting via
    // `muxterm session report --harness ci-runner`. Neutral badge, real row.
    harness: 'ci-runner',
    project: '/home/ken/workspace/muxterm',
    name: 'nightly-smoke',
    mode: 'autonomous',
    state: 'working',
    doing: 'stage 3 of 6 — reconnect matrix',
    doneMeans: 'all six stages green',
    updatedAt: 0,
  },
  {
    sessionId: 'fx-design-notes',
    paneId: 7,
    workspaceId: 'cos',
    harness: 'claude',
    project: '/home/ken/workspace/muxterm',
    name: 'design-notes',
    mode: 'interactive',
    state: 'stopped',
    doing: 'turn ended, waiting for you -- normal, not an alarm',
    updatedAt: 0,
  },
];
