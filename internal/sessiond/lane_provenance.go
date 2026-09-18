package sessiond

// Lane provenance: which goal a lane is running, and which door it came
// through.
//
// THE GAP THIS FILLS. A fleet row says what a session is doing and, for an
// autonomous one, what it thinks finished means (doneMeans). It has never said
// which GOAL that is -- two lanes running the same condition in two workspaces
// are unrelated rows -- and it has never said who started it. A lane a human
// spawned from the composer and a lane a trigger fired at 3am are, on the wire,
// the same row. "Which of these did I ask for?" has been unanswerable from
// fleet_status since triggers shipped.
//
// WHY THE GOAL ID IS A DIGEST AND NOT A MINTED TOKEN. A minted id would have to
// travel: into the goal-lane argv, through a fixed-shape shell wrapper whose
// every field is load-bearing and recognised positionally (goallane.go), and
// back out of a `ps` line. A digest travels by not needing to -- anyone holding
// the condition can recompute it, including the daemon reading a pane's argv
// months later, and a trigger and a hand-spawned lane running the same
// condition get the same id for free, which is the correlation somebody
// actually wants. The cost is stated plainly: it identifies the CONDITION, not
// the run. Two runs of one condition share an id; that is the point, and it is
// why the field is called goalId rather than runId.
//
// WHY ORIGIN IS THE CONNECTION KIND. The daemon already knows which kind of
// client asked for a pane (conn.kind, set at attach) and it creates a trigger's
// pane itself. So origin is derived from facts already on hand -- no new wire
// field, nothing for a caller to get wrong or to forge. What it reports is the
// door, not the author: "agent" means an MCP client asked, which is as much as
// the daemon honestly knows.

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// Lane origins: which door a pane came through. Reported on the fleet row as
// `origin`, and empty when the daemon has nothing honest to say -- a pane
// restored from a snapshot after a restart, or one created by a connection
// that attached without declaring a kind.
const (
	LaneOriginBrowser = "browser"
	LaneOriginAgent   = "agent"
	LaneOriginCLI     = "cli"
	// LaneOriginTrigger is a PREFIX: the full value is "trigger:<trigger id>",
	// because "an automation started this" is half the answer and "which one"
	// is the half a human needs to go turn it off.
	LaneOriginTrigger = "trigger"
)

// goalIDBytes is how much of the digest the id carries. Five bytes is ten hex
// characters -- short enough to read in a table and to type, wide enough that
// two conditions colliding is not a thing that happens to anybody.
const goalIDBytes = 5

// GoalID returns the stable identifier of a stop condition.
//
// Content-addressed, so the same condition yields the same id wherever it is
// computed: at spawn_lane, at create_trigger, and at publish time from the
// pane's own argv. Whitespace is trimmed first and nothing else is normalised
// -- two conditions differing by a word are different conditions, and pretending
// otherwise would merge two lanes that are not doing the same thing.
//
// The empty string maps to the empty id, never to a digest of nothing: a lane
// with no goal has no goal id, and a row carrying one would be a lie.
func GoalID(goal string) string {
	trimmed := strings.TrimSpace(goal)
	if trimmed == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(trimmed))
	return "goal-" + hex.EncodeToString(sum[:goalIDBytes])
}

// LaneOriginForClientKind maps a connection kind to the origin recorded on the
// panes it creates.
//
// An unrecognised or absent kind maps to the EMPTY string rather than to a
// default. "browser" is the most consequential value on this row -- it is the
// one that means a human did this personally -- and guessing it for a
// connection that never said so would put the wrong answer on exactly the
// question this field exists to answer.
func LaneOriginForClientKind(kind string) string {
	switch kind {
	case ClientKindInteractive:
		return LaneOriginBrowser
	case ClientKindAgent:
		return LaneOriginAgent
	case ClientKindCLI:
		return LaneOriginCLI
	}
	return ""
}

// LaneOriginForTrigger names the trigger that fired a lane.
func LaneOriginForTrigger(triggerID string) string {
	if triggerID == "" {
		return LaneOriginTrigger
	}
	return LaneOriginTrigger + ":" + triggerID
}
