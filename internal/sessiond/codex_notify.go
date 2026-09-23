package sessiond

// Codex adapter: a HOOK, not a poller.
//
// Why this is shaped differently from Claude's rich native hook translator.
// Legacy Codex offered one completion notifier rather than Claude's lifecycle
// and tool event surface. It still has
// a real, documented, external-program hook. `~/.codex/config.toml` accepts
//
//	notify = ["/path/to/program", "arg", ...]
//
// and Codex runs that program with ONE additional argument -- a JSON document
// describing what just happened -- after each completed agent turn. That is an
// event, declared by the session about itself, which is the same category of
// signal the Amplifier hook produces and a strictly better one than a poll.
//
// So muxterm does not poll Codex and does not run `codex` as a subprocess at
// all. It asks Codex to call muxterm.
//
// HOW THE HOOK GETS CONFIGURED, AND WHY IT IS NOT A DOCUMENTED SETUP STEP.
// Codex accepts `-c key=value` on the command line, overriding config.toml for
// that invocation only. muxterm builds the lane's argv (lane_argv.go), so it
// injects its own notifier there:
//
//	codex -c notify=["<muxterm>","session","codex-notify"] <prompt>
//
// A lane therefore reports itself with NO user configuration whatsoever, on a
// machine where ~/.codex/config.toml has never been edited. The alternative --
// a README paragraph asking people to add a notify line by hand -- is the
// default-off bridge that silently omits every Codex session: the
// practical effect is a fleet view that silently omits every Codex session on
// every machine nobody remembered to configure, which reads as "muxterm cannot
// see Codex" rather than "muxterm was not switched on".
//
// WHAT THIS COSTS, STATED PLAINLY. `-c notify=...` REPLACES the user's own
// notify program for the lifetime of that lane, because `-c` overrides
// config.toml rather than appending to it. Somebody who has wired notify to a
// desktop notification will not get one from a lane muxterm started. That is a
// real loss, it has an off switch (codexNotifyEnv), and it is not hidden.
//
// VERIFIED against codex-cli 0.155.1 on this machine: the shipped binary
// contains one agent-turn-complete event with the six fields below and no
// sibling notify event. The original live capture on 0.149.0 was:
//
//	{"type":"agent-turn-complete",
//	 "thread-id":"01a0b630-01a4-71b0-b9e3-c1cda6e4a713",
//	 "turn-id":"01a0b630-01c5-7800-b1aa-861869bdb99a",
//	 "cwd":"/tmp/codex-probe",
//	 "client":"codex_exec",
//	 "input-messages":["Reply with exactly the word: ok"],
//	 "last-assistant-message":"ok"}
//
// Two facts from that run are load-bearing and neither is guessable from the
// documentation. First, the keys are KEBAB-case, not snake_case. Second, the
// notify program is spawned as a DIRECT CHILD of the codex process -- the
// captured ancestry was [notify script] -> [codex] -> [pane shell] -- which is
// what makes muxterm's ordinary pid-to-pane attribution work here with no
// special case at all. Had Codex dispatched it from the shared app-server
// daemon instead, the row could never have been placed in a pane.
//
// THE THREE THINGS THIS CANNOT SAY. They are limits of the hook, not of the
// mapping below, and they are why a Codex row is coarser than an Amplifier one:
//
//   - `working` is never observable. The only event Codex emits here is
//     agent-turn-complete; there is no turn-STARTED counterpart. A Codex lane
//     is therefore visible as "resting" or not visible at all.
//   - A lane has NO ROW AT ALL until its first turn finishes. Nothing is
//     written at launch, because the thread id that identifies the session does
//     not exist until Codex creates it and does not reach muxterm until the
//     first notify fires.
//   - `blocked` is never observable. A Codex session sitting on an approval
//     prompt has not completed a turn, so it looks exactly like one resting.
//     This is the limit that costs the most: the fleet's single most valuable
//     signal is "a human is needed here", and for Codex it cannot be given.
//
// A turn that FAILS does not fire the hook either -- confirmed on the same host
// by a turn that died on a 401, which produced a rollout file and no notify
// call. A Codex lane that breaks mid-turn is therefore silent until its pane
// exits, at which point the harness-agnostic exit path writes the completion
// record (completion.go) and the failure becomes visible that way.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// codexNotifyEnv is the operator's OPT-OUT, in the same spelling and with the
// same explicit opt-out spelling as the other integrations. Leave it unset for the default (enabled);
// set it to 0/false/no/off in the environment the lane is built in to launch
// Codex lanes with no notify override at all -- which keeps whatever notify
// program the user configured for themselves, at the cost of the lane never
// appearing as a fleet row.
//
// An environment variable rather than a config-file key for the reason
// integration contract gives: config.toml is the BROWSER's config, reloaded live
// and editable from the UI, and "what argv may this daemon build" is not a
// preference a web page should be able to flip.
const codexNotifyEnv = "MUXTERM_CODEX_NOTIFY"

// codexSnapshotPrefix namespaces every snapshot written from a Codex notify
// payload. The namespace ensures a
// producer that can only ever touch files carrying its own prefix is
// structurally incapable of overwriting another one's session, and two
// harnesses cannot collide on an id.
const codexSnapshotPrefix = "codex-"

// codexNotifyType is the only event Codex serializes into the legacy notify
// slot on 0.155.1. It is checked rather than assumed, so that a future release
// adding a second event type does not get silently mapped as if it were a
// completed turn -- an unknown event is dropped and said out loud, which is the
// safe direction when the whole meaning of the row is "this turn ended".
const codexNotifyType = "agent-turn-complete"

// codexDoingBytes bounds the `doing` line taken from the model's last message.
// A final assistant message can be several kilobytes; the fleet row shows one
// line, and maxSessionSnapshotBytes caps the whole document anyway.
const codexDoingBytes = 240

// codexNameBytes bounds the row title taken from the turn's input message.
const codexNameBytes = 120

// CodexNotify is one `agent-turn-complete` payload.
//
// The JSON tags are KEBAB-case because that is what Codex actually emits;
// see the captured payload in this file's opening comment. Getting this wrong
// does not fail loudly -- every field would simply decode as empty and the row
// would be a nameless, projectless ghost -- which is why the spelling is
// recorded here with its provenance rather than left to look like a typo.
type CodexNotify struct {
	Type     string `json:"type"`
	ThreadID string `json:"thread-id"`
	TurnID   string `json:"turn-id"`
	CWD      string `json:"cwd"`
	// Client is which Codex front-end ran the turn ("codex_exec" for
	// `codex exec`, and the TUI's own spelling for an interactive session).
	// Carried because it is the one field that distinguishes a lane muxterm
	// launched from a one-shot script that happens to share the notify
	// program; nothing branches on it today.
	Client string `json:"client"`
	// InputMessages is every user message in the THREAD so far, not just the
	// one that opened this turn -- so its first element is the session's
	// opening prompt and stays that way for the life of the session.
	//
	// VERIFIED rather than assumed, because the name reads like a per-turn
	// field and the difference decides whether a row can have a stable title:
	// a two-turn thread on 0.149.0 emitted ["Remember the word ALPHA...",
	// "Now reply with just: BETA"] on its SECOND notify, having emitted only
	// the first element on its first. See codexName.
	InputMessages []string `json:"input-messages"`
	// LastAssistantMessage is the model's final message, or null when the turn
	// produced none -- so it is a pointer-free string that may legitimately be
	// empty rather than a missing field.
	LastAssistantMessage string `json:"last-assistant-message"`
}

// ParseCodexNotify decodes one notify argument.
func ParseCodexNotify(raw string) (CodexNotify, error) {
	var n CodexNotify
	if err := json.Unmarshal([]byte(raw), &n); err != nil {
		return CodexNotify{}, fmt.Errorf("codex notify payload is not JSON: %w", err)
	}
	return n, nil
}

// CodexNotifyEnabled reports whether lane argv should carry muxterm's notify
// override: true unless the operator explicitly opted out.
//
// Any other value -- including an unparseable one -- means enabled, which is
// the deliberate direction for a default-on switch: a typo in an opt-out must
// not silently disable a feature the operator believes is running.
func CodexNotifyEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(codexNotifyEnv))) {
	case "0", "false", "no", "off":
		return false
	}
	return true
}

// muxtermExecutable returns the path to THIS muxterm binary, for Codex to call
// back into.
//
// os.Executable() rather than the bare name "muxterm", and the difference is
// not cosmetic. The snapshot a notify call writes has a schema version and
// lands in an XDG-derived spool; the binary that writes it must be the same
// build as the daemon that reads it. A `make dev-local` instance running
// bin/muxterm-dev would otherwise ask the PRODUCTION muxterm on PATH to write
// its lanes' snapshots -- the exact cross-instance contamination the dev-local
// isolation exists to prevent.
//
// The fallback is the bare name, for the case where the executable path cannot
// be determined at all: PATH resolution is a worse answer than the real path
// but a much better one than an argv with an empty program in it.
func muxtermExecutable() string {
	exe, err := os.Executable()
	if err != nil || exe == "" {
		return "muxterm"
	}
	return exe
}

// CodexNotifyOverride returns the `-c notify=[...]` argument pair that points
// Codex's turn-complete hook at this muxterm binary, or nil when the operator
// has opted out.
//
// Returned as a SLICE to be spliced into argv rather than as a string, because
// the argv built here is exec'd directly with no shell (see the daemon's
// CreatePane): there is no word splitting to defend against, and pretending
// there is by adding quotes would put literal quote characters into the value
// Codex parses.
func CodexNotifyOverride() []string {
	if !CodexNotifyEnabled() {
		return nil
	}
	return []string{"-c", "notify=" + tomlStringArray(
		muxtermExecutable(), "session", "codex-notify",
	)}
}

// tomlStringArray renders elems as a TOML array of basic strings.
//
// The VALUE of `-c key=value` is parsed as TOML by Codex, so this has to be
// real TOML and not a plausible-looking approximation. It matters because the
// first element is a filesystem path that muxterm did not choose -- it is
// wherever the binary happens to be installed -- and a path containing a
// backslash or a quote would otherwise produce either a parse error (the lane
// starts with no reporting and nobody knows why) or, worse, a value that parses
// into something other than the intended path.
func tomlStringArray(elems ...string) string {
	var b strings.Builder
	b.WriteByte('[')
	for i, e := range elems {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(tomlBasicString(e))
	}
	b.WriteByte(']')
	return b.String()
}

// tomlBasicString quotes s as a TOML basic string.
//
// The escape set is TOML's own: backslash and quote take their short escapes,
// the four control characters with short forms take those, and every other
// character below 0x20 (plus DEL) takes the \u form. Anything else is passed
// through as UTF-8, which TOML basic strings accept.
func tomlBasicString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '\\':
			b.WriteString(`\\`)
		case '"':
			b.WriteString(`\"`)
		case '\b':
			b.WriteString(`\b`)
		case '\t':
			b.WriteString(`\t`)
		case '\n':
			b.WriteString(`\n`)
		case '\f':
			b.WriteString(`\f`)
		case '\r':
			b.WriteString(`\r`)
		default:
			if r < 0x20 || r == 0x7f {
				fmt.Fprintf(&b, `\u%04X`, r)
				continue
			}
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// CodexRowFor maps one notify payload onto a muxterm session row.
//
// ok=false means the payload named nothing muxterm can publish -- an event type
// this version does not understand, a missing thread id, or an internal thread
// with no persisted rollout. Dropping it is the
// honest outcome: a row keyed on an id muxterm invented would be a row that
// never updates again and never reconciles with the session it claims to be.
func CodexRowFor(n CodexNotify) (SessionState, bool) {
	if n.Type != codexNotifyType || n.ThreadID == "" {
		return SessionState{}, false
	}
	id := codexSnapshotPrefix + n.ThreadID
	if !ValidSessionID(id) || !codexHasRollout(n.ThreadID) {
		return SessionState{}, false
	}

	row := SessionState{
		SessionID: id,
		Harness:   HarnessCodex,
		Project:   n.CWD,
		Name:      codexName(n),
		// ALWAYS INTERACTIVE, and this is a claim about muxterm rather than
		// about Codex. Mode answers one question -- does this session going
		// quiet mean it broke, or that it is resting? -- and muxterm has no way
		// to launch a Codex session that runs unattended toward a stop
		// condition of its own (see lane_argv.go, which refuses a goal). Every
		// Codex session muxterm can start ends its turn and waits for a human,
		// which is the definition of interactive. Declaring autonomous would
		// make every resting lane an alarm.
		Mode: ModeInteractive,
		// STOPPED, not done. The hook fires when a turn ENDS, which is the
		// session arriving at its prompt with nothing further to do until
		// somebody types -- exactly what the native harness hooks publish for
		// the same condition.
		// `done` would be a verdict, and no verdict was given: Codex does not
		// tell muxterm whether the work is finished or merely paused.
		State:     SessionStateStopped,
		Doing:     truncateRunes(firstMeaningfulLine(n.LastAssistantMessage), codexDoingBytes),
		UpdatedAt: time.Now().Unix(),
	}
	return row, true
}

// codexHasRollout admits persisted threads only. Codex's internal title thread
// also fires notify in the same process, but has no rollout. Its prompt and
// final JSON are not user activity and must never become a second fleet row.
// Use the durable rollout rather than session_index.jsonl's title projection;
// no prompt wording, assistant content, or shared pid is an identity test.
func codexHasRollout(threadID string) bool {
	root := os.Getenv("CODEX_HOME")
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return false
		}
		root = filepath.Join(home, ".codex")
	}
	// Enumerate the date directories, then match literal filenames so even a
	// CODEX_HOME containing glob metacharacters works. Search all dates: a
	// resumed thread can be older than the transcript reader's seven-day window.
	// The hook runs at turn completion; allow one second for first-turn
	// persistence to become visible before declining to publish.
	for attempt := 0; attempt < 6; attempt++ {
		if attempt > 0 {
			time.Sleep(200 * time.Millisecond)
		}
		if codexRolloutIn(filepath.Join(root, "sessions"), "-"+threadID+".jsonl", 3) {
			return true
		}
	}
	return false
}

func codexRolloutIn(dir, suffix string, depth int) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if depth > 0 {
			if entry.IsDir() && codexRolloutIn(filepath.Join(dir, entry.Name()), suffix, depth-1) {
				return true
			}
		} else if entry.Type().IsRegular() && strings.HasPrefix(entry.Name(), "rollout-") && strings.HasSuffix(entry.Name(), suffix) {
			return true
		}
	}
	return false
}

// codexName picks the row title: the session's FIRST user message, which is
// exactly the convention SessionState.Name documents.
//
// Stable across turns, and that is a property of the payload rather than of
// this function being careful. Because input-messages accumulates (see the
// field comment), the first element does not change no matter how long the
// conversation runs -- so a stateless hook that always reads element zero
// re-declares the same title every time, and the row does not rename itself
// under a user who keeps talking to it. Verified on a two-turn thread.
//
// Label is deliberately left empty: its own contract says an empty value means
// "this producer offered nothing better than the label the daemon derived from
// the launch argv", which is true here -- autolabel.go already reduced the
// opening prompt to a tab-sized phrase, and this would only re-derive a worse
// one from the same text.
func codexName(n CodexNotify) string {
	for _, m := range n.InputMessages {
		if line := firstMeaningfulLine(m); line != "" {
			return truncateRunes(line, codexNameBytes)
		}
	}
	// Prefer something a human can match to a terminal over a blank cell --
	// the same fallback ladder the native-hook translators use.
	if n.CWD != "" {
		return filepath.Base(n.CWD)
	}
	return n.ThreadID
}
