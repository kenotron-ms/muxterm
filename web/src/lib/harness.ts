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
export const LAUNCHABLE_HARNESSES = ["amplifier", "claude", "codex"] as const;

export type HarnessName = (typeof LAUNCHABLE_HARNESSES)[number];

/** Human label for the composer's harness control. */
export function harnessLabel(h: HarnessName): string {
  switch (h) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    default:
      return "Amplifier";
  }
}

/**
 * The argv element that points Codex's turn-complete hook back at muxterm.
 *
 * TWIN, WITH ONE DELIBERATE DIFFERENCE: `CodexNotifyOverride` in
 * internal/sessiond/codex_notify.go builds the same override with the ABSOLUTE
 * path of the running muxterm binary (os.Executable()), because a Go caller
 * knows it. A browser cannot know it, so this spells the program by name and
 * lets the pane's PATH resolve it.
 *
 * That asymmetry is not drift and must not be "fixed" by weakening the Go side.
 * It has one visible consequence, stated so nobody has to discover it: on a
 * machine running a second muxterm build (`make dev-local`), a Codex lane
 * started from THIS composer reports through whichever `muxterm` is first on
 * PATH, while one started by spawn_lane reports through the exact build that
 * will read the snapshot. Both write to the spool named by the pane's own
 * XDG_RUNTIME_DIR, so both land in the right instance either way.
 *
 * There is no opt-out here to match MUXTERM_CODEX_NOTIFY: that variable is read
 * in the process that BUILDS the argv, and this one runs in a browser with no
 * environment to read. An operator who wants no override starts lanes from the
 * agent or the CLI.
 */
const CODEX_NOTIFY_OVERRIDE = [
  "-c",
  'notify=["muxterm","session","codex-notify"]',
];

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
 * The codex branch has its own, smaller asymmetry -- the notify program is
 * named rather than given as an absolute path; see CODEX_NOTIFY_OVERRIDE.
 *
 * If a goal control is ever added to the composer, copy that branch WHOLE. Its
 * argv is not this one plus a prefix -- `/goal` is only honoured on amplifier's
 * headless path, so `--mode chat` would turn the stop condition into ordinary
 * prompt text and the loop would never arm. The Go comment carries the full
 * reasoning; do not re-derive it here.
 */
export function harnessArgv(harness: HarnessName, prompt: string): string[] {
  switch (harness) {
    case "claude":
      return ["claude", prompt];
    case "codex":
      // `--` is load-bearing and is why this branch is not just
      // ['codex', prompt]: Codex parses its command line with clap, so a
      // prompt starting with '-' is read as an unknown FLAG and the pane dies
      // with a usage message instead of starting a session. The separator ends
      // option parsing, so everything after it is the prompt whatever it
      // begins with. The Go twin carries the same separator and the same note.
      return ["codex", ...CODEX_NOTIFY_OVERRIDE, "--", prompt];
    case "amplifier":
    default:
      // `--mode chat` keeps this INTERACTIVE session alive after the first
      // turn. Without it the run is single-shot and the pane dies the moment it
      // answers, which would put a Completed row on the home view for something
      // the user intended to keep talking to. (It is exactly wrong for a goal
      // lane -- see the twin note above.)
      return ["amplifier", "run", prompt, "--mode", "chat"];
  }
}
