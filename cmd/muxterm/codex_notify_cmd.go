package main

import (
	"errors"
	"flag"
	"fmt"
	"os"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// `muxterm session codex-notify` -- the program Codex's turn-complete hook runs.
//
// This is the Codex half of what `session report` is for everything else, and
// it exists as its own verb for one reason: Codex chooses the argument, not the
// caller. It appends a single JSON document to whatever argv the `notify`
// setting names, so the producer on the other end has to be something that
// accepts exactly that -- one positional blob in Codex's own vocabulary -- and
// translates it. Asking a user to write that translator in shell would mean
// asking for `jq` in the notify slot, which is how a lane stops reporting on a
// machine that does not have it.
//
// It does not talk to sessiond, for session_report_cmd.go's reason: the spool
// is a directory of files, so a turn can be reported before the daemon starts,
// while it is restarting, or on a machine where nobody has opened a browser.
//
// IT NEVER FAILS THE HOOK. Codex runs this synchronously at the end of a turn;
// a non-zero exit or a wall of output there is a defect in the user's session,
// not a useful diagnostic. Every expected failure -- a payload that is not
// JSON, an event type this version does not understand, a report from a process
// that is not inside a muxterm pane -- exits 0 after saying one line on stderr,
// where Codex's own logging will keep it without putting it in front of anyone.
// --verbose is for the person integrating this deliberately.
func runCodexNotify(args []string) error {
	fs := flag.NewFlagSet("session codex-notify", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	verbose := fs.Bool("verbose", false, "print the snapshot path on success")
	pid := fs.Int("pid", 0, "process to attribute this session to (default: the calling process, i.e. codex)")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm session codex-notify [flags] <json>")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Translate one Codex `agent-turn-complete` notification into a muxterm")
		fmt.Fprintln(os.Stdout, "session-state snapshot, so the Codex session appears in the fleet.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "YOU DO NOT NORMALLY RUN THIS. A Codex lane started by muxterm (spawn_lane,")
		fmt.Fprintln(os.Stdout, "`muxterm spawn-lane --harness codex`, or the browser composer) already")
		fmt.Fprintln(os.Stdout, "carries `-c notify=[...]` pointing here. This is the verb Codex invokes.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "To report Codex sessions you start YOURSELF, put it in ~/.codex/config.toml:")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, `  notify = ["muxterm", "session", "codex-notify"]`)
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "WHICH PROCESS: the row is placed by walking up the process tree from --pid")
		fmt.Fprintln(os.Stdout, "until a muxterm pane is reached. Codex spawns this program as its own")
		fmt.Fprintln(os.Stdout, "direct child, so --pid defaults to the parent -- the codex process living")
		fmt.Fprintln(os.Stdout, "in the pane. A report from outside any pane is written and then not shown.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "WHAT A CODEX ROW CANNOT SAY: Codex emits only turn-COMPLETE, so a lane has")
		fmt.Fprintln(os.Stdout, "no row until its first turn ends, is never seen as 'working', and is never")
		fmt.Fprintln(os.Stdout, "seen as 'blocked' on an approval prompt. See docs/session-state-protocol.md.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Flags:")
		fs.PrintDefaults()
	}
	if err := fs.Parse(reorderFlagsFirst(fs, args)); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() < 1 {
		// The only invocation with no payload is a human typing it, so this is
		// the one path that is allowed to be an error rather than a shrug.
		fs.Usage()
		return fmt.Errorf("session codex-notify requires the JSON payload Codex passes as its final argument")
	}

	notice, err := sessiond.ParseCodexNotify(fs.Arg(0))
	if err != nil {
		return codexNotifySkip("%v", err)
	}
	row, ok := sessiond.CodexRowFor(notice)
	if !ok {
		return codexNotifySkip("ignoring codex event %q (no session row to publish)", notice.Type)
	}

	reportPID := *pid
	if reportPID == 0 {
		// The codex process itself: this program is its direct child and is
		// about to exit, so attributing the row to this pid would produce a
		// snapshot the daemon reclaims on its very next tick.
		reportPID = os.Getppid()
	}

	path, err := sessiond.WriteSessionSnapshot(row, reportPID)
	if err != nil {
		return codexNotifySkip("could not publish %s: %v", row.SessionID, err)
	}
	if *verbose {
		fmt.Printf("reported %s (%s, %s) pid %d -> %s\n", row.SessionID, row.State, row.Mode, reportPID, path)
	}
	return nil
}

// codexNotifySkip says why nothing was published and still succeeds. See the
// "it never fails the hook" note above.
func codexNotifySkip(format string, a ...any) error {
	fmt.Fprintf(os.Stderr, "muxterm session codex-notify: "+format+"\n", a...)
	return nil
}
