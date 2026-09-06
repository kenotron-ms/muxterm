package mcp

import (
	"fmt"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// The coding-agent CLIs a lane can be launched into. These names are the ones
// internal/sessiond/agent_catalog.go matches by argv basename, so a pane
// started here is recognised by the daemon as the harness it actually is.
const (
	HarnessAmplifier = "amplifier"
	HarnessClaude    = "claude"
)

// Launchable lists the harnesses HarnessArgv can start, in schema order.
//
// The daemon's agent catalog also RECOGNISES codex and opencode, but neither
// is launchable from here: recognising a process that is already running is
// not the same as knowing the argv that starts one mid-conversation.
var Launchable = []string{HarnessAmplifier, HarnessClaude}

// HarnessArgv returns the argv that starts harness with its opening turn
// already in hand. There is no window between spawn and first input because
// there is no first input -- the prompt is a positional argument, so no
// keystroke can be lost typing into a program that has not finished starting.
//
// When goal is non-empty the amplifier prompt becomes "/goal <goal>" and the
// caller's prompt is dropped: a /goal run takes the stop condition AS its
// prompt. That is the point of delegating with a goal -- the lane then carries
// its own declared intent, which is what makes drift detectable later
// (docs/designs/2026-09-06-cos-delegation-model.md section 4).
//
// This is the ONE place lane argv is built. The MCP spawn_lane tool below and
// the `muxterm spawn-lane` CLI subcommand (cmd/muxterm/spawn_lane_cmd.go) both
// call it, so a lane started by an agent and a lane started from a shell cannot
// drift apart. The duplicated key table in cmd/muxterm/pane_cmd.go is what that
// drift looks like when it is allowed to happen.
//
// TWIN: web/src/lib/harness.ts:41 is the TypeScript version of this, used by
// the browser's composer, and the two MUST stay in sync -- a lane started from
// the UI and a lane started by the chief of staff have to be the same kind of
// thing. harness.ts has no goal branch today; if one is added there, mirror the
// "/goal " prefix exactly.
func HarnessArgv(harness, prompt, goal string) ([]string, error) {
	switch harness {
	case HarnessClaude:
		// Claude Code has no goal mode. Silently dropping the condition would
		// hand back a lane that looks delegated but declares no intent, and
		// the caller would only discover it when drift detection never fired.
		if goal != "" {
			return nil, fmt.Errorf("harness %q has no goal mode: only %q can run /goal loops (drop goal, or switch harness)",
				HarnessClaude, HarnessAmplifier)
		}
		if prompt == "" {
			return nil, fmt.Errorf("prompt is required for harness %q", HarnessClaude)
		}
		return []string{"claude", prompt}, nil

	case HarnessAmplifier:
		first := prompt
		if goal != "" {
			first = "/goal " + goal
		}
		if first == "" {
			return nil, fmt.Errorf("prompt is required for harness %q (or pass a goal)", HarnessAmplifier)
		}
		// `--mode chat` is load-bearing: without it the run is single-shot and
		// the pane dies the moment it answers its first turn, leaving a
		// Completed row on the home view for a lane that never did the work.
		return []string{"amplifier", "run", first, "--mode", "chat"}, nil

	case "":
		return nil, fmt.Errorf("harness is required (launchable: %s)", strings.Join(Launchable, ", "))

	default:
		return nil, fmt.Errorf("unknown harness %q (launchable: %s)", harness, strings.Join(Launchable, ", "))
	}
}

// ResolveOrCreateWorkspace returns the id of the workspace called name,
// creating an empty one when no workspace carries that exact name. created
// reports which of the two happened, so a caller can tell a delegation that
// joined existing work from one that opened a new front.
//
// The match is case-sensitive and exact: workspace names are chosen by a human
// or by the chief of staff, and quietly folding "Backend" into "backend" would
// drop a lane somewhere its author did not ask for. Duplicate names are
// possible in the daemon's registry; the first match in list order wins.
func ResolveOrCreateWorkspace(c *sessiond.Client, name string) (id string, created bool, err error) {
	if name == "" {
		return "", false, fmt.Errorf("workspace name is required")
	}

	workspaces, err := c.ListWorkspaces()
	if err != nil {
		return "", false, fmt.Errorf("listing workspaces: %w", err)
	}
	for _, ws := range workspaces {
		if ws.Name == name {
			return ws.WorkspaceID, false, nil
		}
	}

	id, err = c.CreateWorkspace(name)
	if err != nil {
		return "", false, fmt.Errorf("creating workspace %q: %w", name, err)
	}
	return id, true, nil
}

// laneTools groups the MCP delegation tool handlers and holds a reference to
// the Client so handlers can invoke sessiond operations.
type laneTools struct {
	c *Client
}

// newLaneTools creates a laneTools instance backed by c.
func newLaneTools(c *Client) *laneTools {
	return &laneTools{c: c}
}

// spawnLane launches a coding-agent session in a pane of a named workspace,
// creating the workspace if it does not exist yet. It is the whole delegation
// in one call: resolve-or-create workspace, attach, create the pane WITH argv,
// return the ids.
//
// It exists instead of an argv passthrough on create_pane because a
// purpose-built tool makes correct delegation the only expressible delegation.
// Handing an agent a raw cmd array invites it to hand-build argv, and the argv
// that actually works is not obvious: drop `--mode chat` and the pane dies
// after one turn. Here the harness catalog is knowledge the tool holds, not a
// string the caller assembles.
//
// A lane is deliberately CREATE-ONLY. There is no closeLane beside this and
// there must not be one -- see the registration comment in run.go.
//
// SERIALIZATION: an MCP client is attached to exactly one workspace at a time
// (AttachWorkspace in client.go), and conn.CreatePane is connection-scoped --
// it carries no workspace id and targets whatever the connection is attached
// to. Spawning into a named workspace therefore REQUIRES switching the whole
// session's attachment first, exactly as switch_workspace does. Cross-workspace
// delegation serializes as a result: two spawn_lane calls into two different
// workspaces cannot overlap, and every tool called afterwards targets the
// workspace of the most recent spawn.
//
// KNOWN HAZARD (pre-existing, shared with switch_workspace): the attach both
// (a) discards this connection's accumulated output buffers and armed prompt
// channels for the workspace it is leaving (client.go:109-110), so any
// in-flight run_command output is lost, and (b) replays the full retained
// output buffer of every pane in the workspace it is joining. Drain what you
// care about BEFORE calling this. Spawning into a brand-new workspace is
// unaffected by (b) -- there is nothing to replay -- but (a) applies either way.
func (lt *laneTools) spawnLane(args map[string]any) (string, error) {
	workspace, err := argString(args, "workspace")
	if err != nil {
		return "", err
	}
	harness, err := argString(args, "harness")
	if err != nil {
		return "", err
	}
	prompt, err := argString(args, "prompt")
	if err != nil {
		return "", err
	}
	goal, _, err := argStringOptional(args, "goal")
	if err != nil {
		return "", err
	}
	placement, _, err := argStringOptional(args, "placement")
	if err != nil {
		return "", err
	}

	// Build argv FIRST: an unlaunchable harness, or a goal on a harness with no
	// goal mode, must fail before a workspace is created for it, or a rejected
	// delegation would still leave an empty workspace behind.
	argv, err := HarnessArgv(harness, prompt, goal)
	if err != nil {
		return "", err
	}

	wsID, created, err := ResolveOrCreateWorkspace(lt.c.conn, workspace)
	if err != nil {
		return "", err
	}

	if err := lt.c.AttachWorkspace(wsID); err != nil {
		return "", fmt.Errorf("attaching to workspace %q: %w", workspace, err)
	}

	// The pane id comes back synchronously on the pane-created ack, so no
	// clientRef correlation is needed -- that is for optimistic-create clients
	// building a pane from the broadcast, which an agent is not. referencePane
	// is 0 ("use the active pane"); placement is advisory and the split itself
	// is executed browser-side.
	paneID, err := lt.c.conn.CreatePane(argv, placement, 0, "")
	if err != nil {
		return "", fmt.Errorf("spawning %s lane in workspace %q: %w", harness, workspace, err)
	}

	return jsonText(map[string]any{
		"workspace_id":      wsID,
		"pane_id":           paneID,
		"harness":           harness,
		"workspace_created": created,
	}), nil
}
