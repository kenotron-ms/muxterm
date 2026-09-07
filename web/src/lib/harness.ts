/**
 * harness.ts — turning a first prompt into the argv that starts a session.
 *
 * The home view's composer starts a SESSION in a coding-agent CLI. It does not
 * open a shell and type at one. Those are different things, and the difference
 * is not cosmetic:
 *
 *   - A shell would try to EXECUTE the prompt. "add resize_pane to the MCP
 *     server" is not a command, so the pane would answer with
 *     "command not found" and the session would never exist.
 *   - Typing into a program that has not finished starting loses the
 *     keystrokes. Passing the prompt as argv removes that race completely,
 *     because there is no window between spawn and first input -- there is no
 *     first input.
 *
 * sessiond already accepts argv on create-pane (`cmd` in protocol.go, empty
 * meaning the default $SHELL), so none of this needs new protocol.
 *
 * The names here are the same ones `internal/sessiond/agent_catalog.go` matches
 * by argv basename, so a session started from this composer is recognised by
 * the daemon as the harness it actually is.
 */

/** Harnesses the composer can start. */
export const LAUNCHABLE_HARNESSES = ['amplifier', 'claude'] as const;

export type HarnessName = (typeof LAUNCHABLE_HARNESSES)[number];

/** Human label for the composer's harness control. */
export function harnessLabel(h: HarnessName): string {
  return h === 'amplifier' ? 'Amplifier' : 'Claude Code';
}

/**
 * The argv that starts `harness` with `prompt` as its opening turn.
 *
 * Both of these take the first prompt as a positional argument and then stay
 * interactive, which is exactly the shape the composer needs: one atomic spawn
 * that is already mid-conversation when the pane appears.
 *
 * TWIN: `HarnessArgv` in internal/mcp/tools_lane.go is the Go version, used by
 * the MCP `spawn_lane` tool and the `muxterm spawn-lane` CLI. This one is
 * deliberately PARTIAL and the asymmetry is not drift: the Go side also builds
 * a GOAL lane (`amplifier run "/goal <condition>"`, no `--mode chat`), which
 * the composer cannot ask for because it has no goal control. Everything the
 * two both build is identical.
 *
 * If a goal control is ever added to the composer, copy that branch WHOLE. Its
 * argv is not this one plus a prefix -- `/goal` is only honoured on amplifier's
 * headless path, so `--mode chat` would turn the stop condition into ordinary
 * prompt text and the loop would never arm. The Go comment carries the full
 * reasoning; do not re-derive it here.
 */
export function harnessArgv(harness: HarnessName, prompt: string): string[] {
  switch (harness) {
    case 'claude':
      return ['claude', prompt];
    case 'amplifier':
    default:
      // `--mode chat` keeps this INTERACTIVE session alive after the first
      // turn. Without it the run is single-shot and the pane dies the moment it
      // answers, which would put a Completed row on the home view for something
      // the user intended to keep talking to. (It is exactly wrong for a goal
      // lane -- see the twin note above.)
      return ['amplifier', 'run', prompt, '--mode', 'chat'];
  }
}
