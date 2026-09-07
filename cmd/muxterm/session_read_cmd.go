package main

import (
	"errors"
	"flag"
	"fmt"
	"os"

	"github.com/kenotron-ms/muxterm/internal/mcp"
)

// sessionReadJSON is the --json output shape for `muxterm session read`.
// camelCase keys, like every other muxterm CLI --json payload; the MCP
// lane_transcript tool keeps snake_case. See fleetJSON for why the two are not
// unified.
type sessionReadJSON struct {
	Harness   string               `json:"harness"`
	Path      string               `json:"path"`
	Truncated bool                 `json:"truncated"`
	Turns     []mcp.TranscriptTurn `json:"turns"`
}

// runSessionRead implements `muxterm session read <session-id> [--last N]
// [--json]`, the CLI half of MCP's lane_transcript.
//
// The session id is looked up in the daemon's fleet snapshot to learn which
// harness wrote the transcript and where its project lives, so this reads only
// the transcripts of sessions the daemon is currently reporting -- it is not a
// general-purpose file reader that happens to take a path.
func runSessionRead(args []string) error {
	fs := flag.NewFlagSet("session read", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	last := fs.Int("last", 10, "number of turns to print, newest last (max 100)")
	asJSON := fs.Bool("json", false, "print machine-readable JSON")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm session read <session-id> [--last N] [--json]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Print the last few turns a session exchanged, read from its harness's own")
		fmt.Fprintln(os.Stdout, "on-disk transcript (amplifier and claude are understood).")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "THIS IS A TAIL. Only the end of the file is read (a bounded window, at most")
		fmt.Fprintln(os.Stdout, "4 MB however large the file), and each turn's text is clipped to 400")
		fmt.Fprintln(os.Stdout, "characters. 'truncated' reports that earlier turns exist and were not read.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "  muxterm fleet --json | jq -r '.sessions[].sessionId'")
		fmt.Fprintln(os.Stdout, "  muxterm session read 72e5cf02-29bb-4c27-a257-442e54860d9b --last 5")
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
		fs.Usage()
		return fmt.Errorf("session read requires a session id (list them with 'muxterm fleet')")
	}
	sessionID := fs.Arg(0)

	// `session` as a whole is --remote-capable, but this verb is not: the
	// session row would come from the remote daemon and the transcript from
	// THIS machine's ~/.amplifier or ~/.claude. That combination does not fail
	// -- it silently reads somebody else's file, or reports "no transcript"
	// for a session that has one. Refusing is the only honest answer until
	// there is a way to fetch the file from the host that owns it.
	if cliRemote != "" {
		return fmt.Errorf("session read does not work with --remote: the session lives on %s "+
			"but transcripts are read from this machine's filesystem", cliRemote)
	}

	return withDeadline(func() error {
		c, err := dialDaemon()
		if err != nil {
			return err
		}
		defer func() { _ = c.Close() }()

		rows, err := mcp.FleetOnce(c)
		if err != nil {
			return err
		}
		row, ok := mcp.FindSession(rows, sessionID)
		if !ok {
			return fmt.Errorf("no session %q in the current fleet snapshot (list them with 'muxterm fleet')", sessionID)
		}

		tr, err := mcp.ReadTranscript(row, *last)
		if err != nil {
			return err
		}
		if *asJSON {
			turns := tr.Turns
			if turns == nil {
				turns = []mcp.TranscriptTurn{}
			}
			return printJSON(sessionReadJSON{
				Harness:   tr.Harness,
				Path:      tr.Path,
				Truncated: tr.Truncated,
				Turns:     turns,
			})
		}
		fmt.Printf("%s transcript %s (%d turns", tr.Harness, tr.Path, len(tr.Turns))
		if tr.Truncated {
			fmt.Printf(", tail \u2014 earlier turns not read")
		}
		fmt.Printf(")\n")
		for _, t := range tr.Turns {
			tool := ""
			if t.Tool != "" {
				tool = " [" + t.Tool + "]"
			}
			fmt.Printf("\n%-9s %s%s\n", t.Role, t.TS, tool)
			if t.Text != "" {
				fmt.Printf("  %s\n", t.Text)
			}
		}
		return nil
	})
}
