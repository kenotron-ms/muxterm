package mcp

import (
	"fmt"
	"log"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// The coding-agent CLIs a lane can be launched into. These names are the ones
// internal/sessiond/agent_catalog.go matches by argv basename, so a pane
// started here is recognised by the daemon as the harness it actually is.
const (
	HarnessAmplifier = sessiond.HarnessAmplifier
	HarnessClaude    = sessiond.HarnessClaude
)

// Launchable lists the harnesses HarnessArgv can start, in schema order.
//
// The daemon's agent catalog also RECOGNISES codex and opencode, but neither
// is launchable from here: recognising a process that is already running is
// not the same as knowing the argv that starts one mid-conversation.
var Launchable = sessiond.LaunchableHarnesses

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
// A GOAL LANE AND AN INTERACTIVE LANE ARE NOT THE SAME COMMAND: the goal branch
// carries no `--mode chat` and must never be "tidied" into one that does. The
// reason is spelled out at the two returns below; read it before merging them.
// The goal branch is now a two-phase command (headless loop, then an
// interactive resume of that same session in the same pane -- goallane.go),
// which is what keeps the finished lane's context reachable. It still contains
// no `--mode chat`, and adding one would still destroy the loop.
//
// This is the ONE place lane argv is built. The MCP spawn_lane tool below and
// the `muxterm spawn-lane` CLI subcommand (cmd/muxterm/spawn_lane_cmd.go) both
// call it, so a lane started by an agent and a lane started from a shell cannot
// drift apart. The duplicated key table in cmd/muxterm/pane_cmd.go is what that
// drift looks like when it is allowed to happen.
//
// TWIN: harnessArgv in web/src/lib/harness.ts is the TypeScript version of
// this, used by the browser's composer, and the two MUST agree on every lane
// they both build -- a lane started from the UI and a lane started by the chief
// of staff have to be the same kind of thing. The twin is deliberately PARTIAL:
// it builds the interactive lane only, because the composer has no goal control
// to build the other one from, and its `amplifier run <prompt> --mode chat`
// matches this function's goal-unset branch exactly. If a goal control is ever
// added there, do NOT re-describe the goal argv in TypeScript: it is a shell
// wrapper now (sessiond.GoalLaneArgv), and half of it -- the "/goal " prefix,
// the absence of `--mode chat`, the session-id join, the resume -- is not
// guessable from the outside. Call spawn_lane with a goal instead.
func HarnessArgv(harness, prompt, goal string) ([]string, error) {
	// THE BODY MOVED, THE REASONING DID NOT. Everything above is still the
	// documentation for this argv; sessiond.LaneArgv is the implementation, and
	// it repeats the load-bearing facts in short form at each branch.
	//
	// It moved because a TRIGGER fires inside the daemon at a moment when
	// nobody is attached and no MCP connection exists, and package mcp imports
	// sessiond so the call cannot go the other way. See
	// internal/sessiond/lane_argv.go for why freezing an argv into each trigger
	// was rejected instead. This is still the ONE place lane argv is built --
	// it is simply built one package down.
	return sessiond.LaneArgv(harness, prompt, goal)
}

// checkPromptIsNotCommand rejects a prompt that a harness would read as a
// slash command rather than as work. See the note in HarnessArgv.
func checkPromptIsNotCommand(prompt string) error {
	return sessiond.CheckPromptIsNotCommand(prompt)
}

// checkWorkspaceName rejects a name that is not a single short line of text.
//
// The argv built above is a SLICE, passed to the daemon and exec'd without a
// shell, so nothing here is defending against quoting. What it defends is
// everything that DISPLAYS the name: a newline in a workspace name splits a
// log line in two and can forge a second one, and a control character walks
// the cursor around any terminal that renders the list. The daemon registry
// keeps this name forever, so the check belongs before it is created, not at
// each place it is later printed.
func checkWorkspaceName(name string) error {
	return sessiond.CheckWorkspaceName(name)
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
	// Validated HERE rather than in each caller: this is the one door through
	// which both the MCP tool and the `muxterm spawn-lane` CLI reach
	// CreateWorkspace, so it is the only place a bad name can be stopped once.
	if err := checkWorkspaceName(name); err != nil {
		return "", false, err
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
// that actually works is neither obvious nor singular: an interactive lane
// needs `--mode chat` or the pane dies after one turn, and a goal lane needs it
// ABSENT or "/goal <condition>" is delivered to the model as literal prompt
// text and the loop never arms. Both failures leave a plausible-looking pane
// behind. Here the harness catalog is knowledge the tool holds (HarnessArgv,
// above), not a string the caller assembles.
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

	// S1, and this is the clause that matters most: a lane is a full coding
	// agent WITH a shell. Delegating the edit is the obvious way around a
	// block that only covered this session's own tools, so the lane's opening
	// turn and its stop condition are inspected before one is launched.
	if err := guardCosConfig(prompt, goal); err != nil {
		return "", err
	}

	// Build argv FIRST: an unlaunchable harness, or a goal on a harness with no
	// goal mode, must fail before a workspace is created for it, or a rejected
	// delegation would still leave an empty workspace behind.
	argv, err := HarnessArgv(harness, prompt, goal)
	if err != nil {
		return "", err
	}

	previous := lt.c.Workspace()

	wsID, created, err := ResolveOrCreateWorkspace(lt.c.conn, workspace)
	if err != nil {
		return "", err
	}

	// A FAILED DELEGATION LEAVES NOTHING BEHIND. That invariant is stated
	// above and was enforced only for argv errors; everything past this point
	// can also fail, and until now each of those failures left the empty
	// workspace this call had just created sitting in the dock (and the MCP
	// session re-attached away from wherever it was). Only a workspace THIS
	// call created is removed -- an existing one belongs to somebody else and
	// a failed spawn is no reason to close it.
	//
	// Best-effort by necessity: if the daemon cannot be reached to create a
	// pane, it may not be reachable to close the workspace either. The
	// original error is the one returned; a cleanup failure is logged, because
	// the alternative is reporting a plumbing problem in place of the reason
	// the delegation failed.
	abandon := func(cause error) (string, error) {
		if created {
			if cerr := lt.c.conn.CloseWorkspace(wsID); cerr != nil {
				log.Printf("spawn_lane: failed to remove the workspace %q (%s) this call created: %v",
					workspace, wsID, cerr)
			}
		}
		// Put the session back where it was. The attach is a side effect of
		// spawning, so a spawn that did not happen should not have moved it.
		if previous != "" && previous != lt.c.Workspace() {
			if aerr := lt.c.AttachWorkspace(previous); aerr != nil {
				log.Printf("spawn_lane: failed to re-attach to workspace %s after a failed spawn: %v",
					previous, aerr)
			}
		}
		return "", cause
	}

	if err := lt.c.AttachWorkspace(wsID); err != nil {
		return abandon(fmt.Errorf("attaching to workspace %q: %w", workspace, err))
	}

	// The pane id comes back synchronously on the pane-created ack, so no
	// clientRef correlation is needed -- that is for optimistic-create clients
	// building a pane from the broadcast, which an agent is not. referencePane
	// is 0 ("use the active pane"); placement is advisory and the split itself
	// is executed browser-side.
	paneID, err := lt.c.conn.CreatePane(argv, placement, 0, "")
	if err != nil {
		return abandon(fmt.Errorf("spawning %s lane in workspace %q: %w", harness, workspace, err))
	}

	return jsonText(map[string]any{
		"workspace_id":      wsID,
		"pane_id":           paneID,
		"harness":           harness,
		"workspace_created": created,
		"machine":           lt.c.Machine(),
	}), nil
}
