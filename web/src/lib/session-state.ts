/**
 * Session state contract for the muxterm "home" view.
 *
 * This file is the browser-side mirror of internal/sessiond/sessionstate.go.
 * It is committed to the base commit ahead of implementation so the backend and
 * frontend can be built independently without either guessing the other's
 * shape. If you change a field here, change it there in the same commit.
 *
 * Vocabulary note: the six nouns in play are workspace, pane, terminal,
 * session, project, and artifact. A "task" is not an object -- it is the
 * session's first prompt:submit event. Do not introduce new nouns.
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
 * Session run modes. This distinction is load-bearing for the whole feature.
 *
 * - `plain`: the session ends its turn and waits for the user. That is its
 *   CONTRACT, not a fault. A quiet plain session must NEVER surface as needing
 *   input.
 * - `goal`: the session runs an autonomous /goal loop toward a stop condition.
 *   A quiet goal session means the loop BROKE, and that IS the alarm.
 *
 * Mode is known at kickoff. Getting this wrong makes every idle session look
 * like an emergency, users learn to ignore the indicator, and the home view
 * becomes worthless.
 */
export type SessionMode = 'plain' | 'goal';

/**
 * One row of the home view: everything known about a single Amplifier session
 * running in a muxterm pane.
 *
 * Every field is a projection of that session's own events.jsonl, forwarded by
 * the Amplifier hook in modules/hooks-muxterm-session. Nothing here is inferred
 * from PTY state -- the daemon's activity classifier cannot distinguish
 * "thinking" from "waiting for you", which is why this declared channel exists.
 */
export interface SessionState {
  /** Amplifier session id. */
  sessionId: string;
  /** muxterm pane holding this session's terminal. */
  paneId: number;
  /** muxterm workspace containing that pane. */
  workspaceId: string;
  /** Working directory -- an Amplifier "project" is a folder. Absolute path. */
  project?: string;
  /** Derived from the session's FIRST prompt:submit event, trimmed. */
  name: string;
  mode: SessionMode;
  state: SessionRunState;
  /** Present only when state === 'blocked'. */
  waitingFor?: WaitingFor;
  /** Short line describing current activity, refreshed cheaply. */
  doing?: string;
  /** The /goal stop condition. Present only when mode === 'goal'. */
  doneMeans?: string;
  /** Distinct artifact:read paths this session has consumed. */
  knows?: string[];
  /** Associated PR number; non-zero promotes into "Ready for review". */
  pr?: number;
  /** Unix timestamp (seconds) of the last state change. */
  updatedAt: number;
}

/**
 * Home view groups, in display order. Names and ordering are taken from Claude
 * Code's agent view.
 *
 * These deliberately do NOT map 1:1 onto states: "Ready for review" is derived
 * (the session has an open PR) and "Completed" merges done, failed, and
 * stopped. Those merges serve triage over taxonomy, and that editorial choice
 * is inherited on purpose along with the words.
 */
export const HOME_GROUPS = [
  'Needs input',
  'Working',
  'Ready for review',
  'Completed',
] as const;

export type HomeGroup = (typeof HOME_GROUPS)[number];

/**
 * Place a session into its home-view group.
 *
 * Note the ordering: an open PR wins over a terminal state, because once
 * something is reviewable that is the action it wants from you.
 */
export function groupFor(s: SessionState): HomeGroup {
  if (s.state === 'blocked') return 'Needs input';
  if (s.pr && s.pr > 0) return 'Ready for review';
  if (s.state === 'working') return 'Working';
  return 'Completed';
}

/**
 * Whether a session belongs in "Needs input".
 *
 * A plain session that has ended its turn is resting, which is its normal
 * condition -- it does not need input in the sense this view means. Only a
 * blocked session genuinely wants a human.
 */
export function needsInput(s: SessionState): boolean {
  return s.state === 'blocked';
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
 */
export const FIXTURE_SESSIONS: SessionState[] = [
  {
    sessionId: 'fx-extract-muxops',
    paneId: 1,
    workspaceId: 'parity',
    project: '/home/ken/workspace/muxterm',
    name: 'extract-muxops',
    mode: 'goal',
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
    project: '/home/ken/workspace/muxterm',
    name: 'pr-412-rebase',
    mode: 'goal',
    state: 'blocked',
    waitingFor: 'permission prompt',
    doing: 'force-push rewrites 4 commits',
    updatedAt: 0,
  },
  {
    sessionId: 'fx-pane-send-cli',
    paneId: 2,
    workspaceId: 'parity',
    project: '/home/ken/workspace/muxterm',
    name: 'pane-send-cli',
    mode: 'goal',
    state: 'working',
    doing: 'writing keys to bytes translation',
    updatedAt: 0,
  },
  {
    sessionId: 'fx-scrollback-parity',
    paneId: 3,
    workspaceId: 'parity',
    project: '/home/ken/workspace/muxterm',
    name: 'scrollback-parity',
    mode: 'goal',
    state: 'done',
    doing: 'MCP get_screen pages history now',
    pr: 51,
    updatedAt: 0,
  },
  {
    sessionId: 'fx-design-notes',
    paneId: 7,
    workspaceId: 'cos',
    project: '/home/ken/workspace/muxterm',
    name: 'design-notes',
    mode: 'plain',
    state: 'stopped',
    doing: 'turn ended, waiting for you -- normal, not an alarm',
    updatedAt: 0,
  },
];
