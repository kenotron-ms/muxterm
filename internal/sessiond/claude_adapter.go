package sessiond

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Claude Code adapter: a POLLER that turns `claude agents --json` into
// session-state snapshots.
//
// Why a poller and not a hook: Amplifier has an in-process module system, so
// its producer can be an event handler that declares state as it changes.
// Claude Code has no equivalent extension point, but it does have a documented
// scripting output -- `claude agents --json`, "Print active sessions
// (interactive and background) as a JSON array and exit (for scripting; does
// not require a TTY)". Polling that is the whole integration.
//
// It writes to the SAME spool every other producer writes to, so nothing
// downstream learns that Claude Code exists: sessionstore.go reads files,
// the protocol carries rows, the browser renders them. This file is the only
// place in muxterm that knows the shape of another vendor's JSON.
//
// OPT-IN, ALWAYS. The daemon must never execute another vendor's binary
// because it happened to be on PATH -- an operator gets to decide that a
// long-lived background service may spawn subprocesses. See claudeAdapterEnv.
//
// DEGRADES SILENTLY. A missing `claude`, a non-zero exit, a timeout, or JSON
// that does not parse costs one log line and then nothing. None of them may
// disturb the daemon: a decorative sidebar feature has no business affecting a
// process that owns people's terminals.

// claudeAdapterEnv is the operator's switch. Set it to 1/true/yes in the
// environment sessiond is started with.
//
// An environment variable rather than a config-file key on purpose: the config
// file is the BROWSER's config (theme, fonts, keybindings), reloaded live and
// editable from the UI, and "may this daemon execute a subprocess" is not a
// preference a web page should be able to flip. It is a property of how the
// operator launched the service.
const claudeAdapterEnv = "MUXTERM_CLAUDE_ADAPTER"

// claudeSnapshotPrefix namespaces every snapshot this adapter writes.
//
// Load-bearing, not cosmetic: the adapter reconciles by DELETING snapshots for
// sessions Claude Code no longer reports, and it must be structurally incapable
// of deleting another producer's file. Owning a filename prefix is what makes
// "only remove what I wrote" checkable rather than merely intended. It also
// removes any question about two producers colliding on a session id.
const claudeSnapshotPrefix = "claude-"

// claudeAdapterTick is how often `claude agents --json` is run.
//
// Deliberately slower than sessionStateTick (1s). That tick is a directory
// read; this one forks a process. Measured at ~0.2s per call on the
// development host, so 5s is well under 5% of one core and still far faster
// than a human notices a row appearing.
const claudeAdapterTick = 5 * time.Second

// claudeAdapterTimeout bounds one invocation, so a wedged `claude` cannot pin
// this goroutine forever and leak a process per tick.
const claudeAdapterTimeout = 10 * time.Second

// claudeAgent is one element of `claude agents --json`.
//
// VERIFIED against Claude Code 2.1.233/2.1.260 by running the command against
// live sessions -- not inferred from documentation. The important discovery is
// that the two kinds carry DIFFERENT field sets, so neither a single required
// field list nor a straight field rename would have worked:
//
//	interactive: {pid, cwd, kind, startedAt, sessionId, name, status}
//	background:  {id,  cwd, kind, startedAt, sessionId, name, state}
//
// Observed values: status ∈ {idle, busy}; state ∈ {done, stopped}. Both lists
// are what was OBSERVED, not what is possible, which is exactly why every
// mapping below has a defined fallback instead of a closed switch.
//
// `pid` appears only on interactive records. That is the load-bearing
// limitation of this whole adapter: muxterm places a row by walking up the
// process tree from a pid, so a record without one cannot be located and is
// dropped. See claudeRowFor.
type claudeAgent struct {
	SessionID  string `json:"sessionId"`
	ID         string `json:"id"`
	Name       string `json:"name"`
	CWD        string `json:"cwd"`
	Kind       string `json:"kind"`
	PID        int    `json:"pid"`
	Status     string `json:"status"`
	State      string `json:"state"`
	WaitingFor string `json:"waitingFor"`
}

// claudeAdapterEnabled reports the operator's opt-in.
func claudeAdapterEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(claudeAdapterEnv))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// claudeAdapter owns the poll loop and the set of snapshots it has written.
type claudeAdapter struct {
	// written is the ids (already prefixed) this adapter published on the last
	// successful poll, so the next one can remove what has gone away. Touched
	// only from the adapter goroutine.
	written map[string]bool
	// warnOnce keeps a persistent failure -- claude not installed, a binary
	// that always errors -- to one log line rather than one every five seconds
	// for the life of the daemon.
	warnOnce sync.Once
}

func newClaudeAdapter() *claudeAdapter {
	return &claudeAdapter{written: map[string]bool{}}
}

// claudeAdapterLoop polls Claude Code and publishes what it finds.
//
// Started by ListenAndServe only when the operator has opted in, and stopped by
// the same ctx cancellation that closes the listener.
func (s *Server) claudeAdapterLoop(ctx context.Context) {
	a := newClaudeAdapter()
	ticker := time.NewTicker(claudeAdapterTick)
	defer ticker.Stop()
	log.Printf("sessiond: claude adapter enabled (%s set); polling `claude agents --json` every %s", claudeAdapterEnv, claudeAdapterTick)
	for {
		select {
		case <-ctx.Done():
			a.removeAll()
			return
		case <-ticker.C:
			// Same bargain the session-state ticker makes: no subscriber, no
			// work. Without this the daemon would fork a process every five
			// seconds forever on a machine where nobody has opened the home
			// view, which is not a cost a background service gets to impose.
			if !s.sessionStateWanted() {
				continue
			}
			a.poll(ctx)
		}
	}
}

// poll runs one `claude agents --json` and reconciles the spool with it.
func (a *claudeAdapter) poll(ctx context.Context) {
	agents, ok := a.queryAgents(ctx)
	if !ok {
		// Could not ask. Leave the previous snapshots in place: they are
		// whole-state documents that are still the best available answer, and
		// the daemon reaps them anyway once their processes die. Asserting
		// "no Claude sessions" from a failed query would blink rows out over a
		// transient hiccup.
		return
	}
	seen := make(map[string]bool, len(agents))
	for _, ag := range agents {
		row, pid, ok := claudeRowFor(ag)
		if !ok {
			continue
		}
		if _, err := WriteSessionSnapshot(row, pid); err != nil {
			// One bad record must not cost the others. This is the adapter's
			// own bug if it fires, so it is worth a line -- but not a retry.
			log.Printf("sessiond: claude adapter: skipping session %s: %v", row.SessionID, err)
			continue
		}
		seen[row.SessionID] = true
	}
	for id := range a.written {
		if !seen[id] {
			// Claude Code has stopped reporting this session while its process
			// may well still be alive (a completed background agent drops off
			// `--json` without `--all`). Nothing else would ever remove it, so
			// the row would sit there claiming to be working forever.
			_ = RemoveSessionSnapshot(id)
		}
	}
	a.written = seen
}

// removeAll drops every snapshot this adapter published, on shutdown.
//
// A snapshot outliving its writer is normally fine -- the daemon reaps by
// process liveness. These are the exception: they are attributed to processes
// the adapter does not own, which keep running after sessiond stops, so
// nothing would reap them and a restarted daemon would publish stale rows for
// sessions it is no longer tracking.
func (a *claudeAdapter) removeAll() {
	for id := range a.written {
		_ = RemoveSessionSnapshot(id)
	}
	a.written = nil
}

// queryAgents runs the CLI and decodes its array.
//
// Every failure path returns ok=false and is survivable by design; see the
// package comment at the top of this file.
func (a *claudeAdapter) queryAgents(ctx context.Context) ([]claudeAgent, bool) {
	bin, err := exec.LookPath("claude")
	if err != nil {
		a.warn("claude not found on PATH; adapter idle until it is installed")
		return nil, false
	}
	cctx, cancel := context.WithTimeout(ctx, claudeAdapterTimeout)
	defer cancel()
	// `agents --json` is documented as not requiring a TTY, which is what makes
	// this safe to run from a daemon. stdin is closed so a version that decides
	// to prompt anyway blocks on EOF immediately rather than hanging until the
	// timeout.
	cmd := exec.CommandContext(cctx, bin, "agents", "--json")
	cmd.Stdin = nil
	out, err := cmd.Output()
	if err != nil {
		a.warn("`claude agents --json` failed: " + err.Error())
		return nil, false
	}
	var agents []claudeAgent
	if err := json.Unmarshal(out, &agents); err != nil {
		a.warn("`claude agents --json` returned unparseable output: " + err.Error())
		return nil, false
	}
	return agents, true
}

// warn logs the first persistent failure and nothing after it.
func (a *claudeAdapter) warn(msg string) {
	a.warnOnce.Do(func() { log.Printf("sessiond: claude adapter: %s", msg) })
}

// claudeRowFor maps one Claude Code record onto a muxterm session row.
//
// Returns ok=false for a record muxterm cannot place. That is not a failure to
// report: a row with no pane is a row the home view cannot act on, and inventing
// a location for it would be worse than omitting it.
func claudeRowFor(ag claudeAgent) (SessionState, int, bool) {
	if ag.PID <= 0 || ag.SessionID == "" {
		// No pid means no process tree to walk, which means no pane. Observed
		// for every `background` record on Claude Code 2.1.x.
		return SessionState{}, 0, false
	}
	id := claudeSnapshotPrefix + ag.SessionID
	if !ValidSessionID(id) {
		return SessionState{}, 0, false
	}

	row := SessionState{
		SessionID: id,
		Harness:   HarnessClaude,
		Project:   ag.CWD,
		Name:      ag.Name,
		Mode:      claudeMode(ag),
		UpdatedAt: time.Now().Unix(),
	}
	if row.Name == "" {
		// Prefer something a human can match to a terminal over a blank cell.
		if ag.CWD != "" {
			row.Name = filepath.Base(ag.CWD)
		} else {
			row.Name = ag.SessionID
		}
	}
	row.State, row.WaitingFor, row.Doing = claudeState(ag)
	return row, ag.PID, true
}

// claudeMode answers muxterm's one load-bearing question -- does this session
// going quiet mean it broke, or that it is resting? -- from Claude Code's own
// `kind`.
//
// This is the mapping that justifies renaming mode away from Amplifier's
// goal|plain: Claude Code drew exactly the same line, in its own words, before
// muxterm ever looked. A background agent runs unattended toward its own
// finish, so silence from one is a fault. An interactive session waiting at its
// prompt is doing precisely what it is for.
func claudeMode(ag claudeAgent) string {
	if ag.Kind == "background" {
		return ModeAutonomous
	}
	// Interactive, or a kind nobody has seen yet. Defaulting an unknown kind to
	// interactive is the safe direction: the cost of a missed alarm is one
	// unnoticed stall, and the cost of a false alarm is a user who stops
	// believing the indicator at all.
	return ModeInteractive
}

// claudeState maps Claude Code's lifecycle onto muxterm's, returning the state,
// the blocked reason, and an optional `doing` line.
//
// muxterm's five states were adopted verbatim from Claude Code's agent view, so
// where Claude Code reports `state` this is genuinely a pass-through. `status`
// is the other vocabulary -- it is what interactive records carry -- and it
// needs a real translation.
func claudeState(ag claudeAgent) (state, waitingFor, doing string) {
	// A declared blocked reason outranks everything: "a human is needed here"
	// is the single most valuable thing this view can say, and dropping it in
	// favour of a coarser status would waste the one signal worth an alarm.
	//
	// UNVERIFIED on 2.1.x: no `waitingFor` was observed in any record on this
	// host. Guarded by ValidWaitingFor so an unexpected value cannot smuggle a
	// string outside the contract onto the wire; kept because the failure mode
	// of omitting it (a blocked session that never surfaces) is much worse than
	// the failure mode of carrying dead code.
	if ValidWaitingFor(ag.WaitingFor) && ag.WaitingFor != "" {
		return SessionStateBlocked, ag.WaitingFor, ""
	}

	if ag.State != "" {
		if ValidState(ag.State) {
			return ag.State, "", ""
		}
		// A lifecycle value from a newer Claude Code. Report it as running --
		// the session is on an "active sessions" list, so claiming it finished
		// would be a lie -- and put the raw word in `doing`, where it is
		// visible to whoever has to extend this next.
		return SessionStateWorking, "", "claude: " + ag.State
	}

	switch ag.Status {
	case "busy":
		return SessionStateWorking, "", ""
	case "idle":
		// The turn ended and it is waiting at its prompt. `stopped` is what the
		// Amplifier hook publishes for exactly this condition, and combined
		// with mode=interactive it reads as resting, never as an alarm.
		return SessionStateStopped, "", ""
	case "":
		return SessionStateWorking, "", ""
	default:
		return SessionStateWorking, "", "claude: " + ag.Status
	}
}
