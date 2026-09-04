package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// `muxterm session report` -- the universal session-state producer.
//
// This is the escape hatch that makes "the home view is a fleet view for any
// coding-agent CLI" actually true rather than aspirational. Amplifier has an
// in-process hook and Claude Code has an adapter, but neither of those helps a
// Makefile, a nightly shell script, a CI step, or somebody's Rust binary. This
// verb is the answer for all of them: one command, no library, no language
// binding, no daemon connection. It writes one snapshot to the spool and exits.
//
// It deliberately does NOT talk to sessiond. The spool is a directory of files;
// writing one requires no socket, no protocol, and no running daemon, so a
// producer can report before the daemon starts, while it is restarting, or on a
// machine where nobody has opened a browser yet. The snapshot simply waits.

// sessionReportJSON is the --json output shape. Small on purpose: the useful
// facts are where it landed and which process it was attributed to, because
// those are the two things that go wrong.
type sessionReportJSON struct {
	Path      string `json:"path"`
	SessionID string `json:"sessionId"`
	PID       int    `json:"pid"`
	Spool     string `json:"spool"`
}

func runSessionReport(args []string) error {
	fs := flag.NewFlagSet("session report", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)

	sessionID := fs.String("session-id", "", "stable id for this session (becomes the snapshot filename)")
	state := fs.String("state", "", "working | blocked | done | failed | stopped")
	harness := fs.String("harness", "", "which agent CLI is running this (any string; amplifier/claude/codex/opencode are badged)")
	mode := fs.String("mode", sessiond.ModeInteractive, "autonomous (quiet means broken) | interactive (quiet means resting)")
	waitingFor := fs.String("waiting-for", "", "why it is blocked: permission prompt | input needed | sandbox request | worker request | dialog open")
	doing := fs.String("doing", "", "one short line describing current activity")
	doneMeans := fs.String("done-means", "", "this session's own definition of finished")
	name := fs.String("name", "", "short title for the row (default: the session id)")
	project := fs.String("project", "", "working directory (default: the current directory)")
	pr := fs.Int("pr", 0, "associated pull request number; non-zero promotes the row to 'Ready for review'")
	pid := fs.Int("pid", 0, "process to attribute this session to (default: the calling process's parent)")
	asJSON := fs.Bool("json", false, "print machine-readable JSON")
	var knows stringSliceFlag
	fs.Var(&knows, "knows", "a path this session has read; repeat for each")

	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm session report --session-id <id> --state <state> [flags]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Publish one session-state snapshot to muxterm's home view and exit.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Snapshots are idempotent whole-state documents: report as often or as")
		fmt.Fprintln(os.Stdout, "rarely as you like, and a missed report is repaired by the next one.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "WHICH PROCESS: muxterm locates a row by walking up the process tree from")
		fmt.Fprintln(os.Stdout, "--pid until it reaches a pane. This command exits immediately, so its own")
		fmt.Fprintln(os.Stdout, "pid would be dead before the daemon looked; --pid therefore defaults to the")
		fmt.Fprintln(os.Stdout, "CALLING process (your script or shell), which is the thing actually living")
		fmt.Fprintln(os.Stdout, "in the pane. A report from a process outside any muxterm pane is written")
		fmt.Fprintln(os.Stdout, "successfully and then not shown -- there is no terminal to attach it to.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "MODE is the most important flag here. It answers: does this session going")
		fmt.Fprintln(os.Stdout, "quiet mean it BROKE, or that it is RESTING? An autonomous run that stops")
		fmt.Fprintln(os.Stdout, "reporting is an alarm; an interactive one waiting for a human is not, ever.")
		fmt.Fprintln(os.Stdout, "It defaults to interactive because a false alarm teaches people to ignore")
		fmt.Fprintln(os.Stdout, "the indicator, which costs more than a missed one. Set it explicitly.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Flags:")
		fs.PrintDefaults()
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Example (a shell script reporting its own progress):")
		fmt.Fprintln(os.Stdout, "  muxterm session report --session-id nightly-smoke --harness ci-runner \\")
		fmt.Fprintln(os.Stdout, "      --mode autonomous --state working --name 'nightly smoke' \\")
		fmt.Fprintln(os.Stdout, "      --doing 'stage 3 of 6' --done-means 'all six stages green'")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Full producer contract: docs/session-state-protocol.md")
	}
	if err := fs.Parse(reorderFlagsFirst(fs, args)); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}

	// Required flags are checked here rather than defaulted, because both are
	// answers only the producer has. Guessing an id would collide across
	// sessions; guessing a state would publish a claim nobody made.
	if *sessionID == "" {
		fs.Usage()
		return fmt.Errorf("session report requires --session-id")
	}
	if *state == "" {
		fs.Usage()
		return fmt.Errorf("session report requires --state (working | blocked | done | failed | stopped)")
	}

	row := sessiond.SessionState{
		SessionID:  *sessionID,
		Harness:    *harness,
		Project:    *project,
		Name:       *name,
		Mode:       *mode,
		State:      *state,
		WaitingFor: *waitingFor,
		Doing:      *doing,
		DoneMeans:  *doneMeans,
		Knows:      knows,
		PR:         *pr,
		UpdatedAt:  time.Now().Unix(),
	}
	if row.Name == "" {
		// A nameless row is an unreadable row. The id is a poor title but it is
		// a true one, and it is better than a blank line the user cannot match
		// to anything.
		row.Name = *sessionID
	}
	if row.Project == "" {
		if cwd, err := os.Getwd(); err == nil {
			row.Project = cwd
		}
	}

	reportPID := *pid
	if reportPID == 0 {
		// See the --pid note in Usage: this process is about to exit, so
		// attributing the row to it would produce a snapshot the daemon
		// reclaims on its very next tick.
		reportPID = os.Getppid()
	}

	path, err := sessiond.WriteSessionSnapshot(row, reportPID)
	if err != nil {
		// Loud, and specific about which value was rejected. A producer that
		// silently writes garbage is worse than one that errors: the garbage is
		// skipped by the reader without explanation, and whoever is integrating
		// is left staring at a home view that is missing a row for no reason.
		return fmt.Errorf("session report: %w", err)
	}

	if *asJSON {
		return printJSON(sessionReportJSON{
			Path:      path,
			SessionID: row.SessionID,
			PID:       reportPID,
			Spool:     sessiond.SessionStateDir(),
		})
	}
	fmt.Printf("reported %s (%s, %s) pid %d -> %s\n", row.SessionID, row.State, row.Mode, reportPID, path)
	return nil
}
