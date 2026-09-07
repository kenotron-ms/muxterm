package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/mcp"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// fleetJSON is the --json output shape for `muxterm fleet`.
//
// The rows are sessiond.SessionState verbatim, so the keys are its own
// camelCase tags (sessionId, paneId, doneMeans, ...). That matches every other
// muxterm CLI --json payload and deliberately does NOT match the MCP
// fleet_status tool's snake_case; the two conventions belong to two different
// consumers and unifying them would break one of them for the sake of tidiness.
type fleetJSON struct {
	Sessions []sessiond.SessionState `json:"sessions"`
}

// runFleet implements `muxterm fleet [--state S] [--workspace W] [--json]`, the
// CLI half of MCP's fleet_status.
//
// It exists so the fleet is inspectable from a shell -- and so the tool an
// agent calls and the command a human types cannot drift, since both go through
// mcp.FleetOnce / mcp.FilterFleet / mcp.ResolveWorkspaceName.
//
// GLOBAL by nature: the daemon's session-state push carries every workspace, so
// unlike `muxterm pane` this command never attaches to anything.
func runFleet(args []string) error {
	fs := flag.NewFlagSet("fleet", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	state := fs.String("state", "", "filter by lifecycle state: working | blocked | done | failed | stopped")
	workspace := fs.String("workspace", "", "filter by workspace NAME (must already exist; never creates one)")
	asJSON := fs.Bool("json", false, "print machine-readable JSON")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm fleet [--state S] [--workspace W] [--json]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Print every agent session the daemon knows about, across ALL workspaces,")
		fmt.Fprintln(os.Stdout, "with the state each one declared for itself \u2014 the same rows the browser's")
		fmt.Fprintln(os.Stdout, "home view renders.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "  muxterm fleet")
		fmt.Fprintln(os.Stdout, "  muxterm fleet --state blocked")
		fmt.Fprintln(os.Stdout, "  muxterm fleet --workspace backend --json | jq '.sessions[].doneMeans'")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "An empty list means no agent sessions are running. That is an answer, not")
		fmt.Fprintln(os.Stdout, "an error, and the exit status is 0.")
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
	if fs.NArg() > 0 {
		fs.Usage()
		return fmt.Errorf("fleet takes no positional arguments (got %q)", fs.Arg(0))
	}
	// Checked before dialing: a typo'd state must not look like a quiet fleet.
	if err := mcp.CheckStateFilter(*state); err != nil {
		return err
	}

	return withDeadline(func() error {
		c, err := dialDaemon()
		if err != nil {
			return err
		}
		defer func() { _ = c.Close() }()

		workspaceID := ""
		if *workspace != "" {
			workspaceID, err = mcp.ResolveWorkspaceName(c, *workspace)
			if err != nil {
				return err
			}
		}

		rows, err := mcp.FleetOnce(c)
		if err != nil {
			return err
		}
		rows = mcp.FilterFleet(rows, *state, workspaceID)

		if *asJSON {
			if rows == nil {
				rows = []sessiond.SessionState{}
			}
			return printJSON(fleetJSON{Sessions: rows})
		}
		if len(rows) == 0 {
			fmt.Println("no agent sessions")
			return nil
		}
		fmt.Printf("%-12s %-11s %-13s %-6s %-5s %s\n",
			"HARNESS", "STATE", "MODE", "PANE", "PR", "NAME")
		for _, r := range rows {
			pr := ""
			if r.PR != 0 {
				pr = fmt.Sprintf("#%d", r.PR)
			}
			fmt.Printf("%-12s %-11s %-13s %-6d %-5s %s\n",
				dash(r.Harness), dash(r.State), dash(r.Mode), r.PaneID, dash(pr), dash(r.Name))
			fmt.Printf("  session   %s  workspace %s\n", r.SessionID, r.WorkspaceID)
			if r.WaitingFor != "" {
				fmt.Printf("  waiting   %s\n", r.WaitingFor)
			}
			if r.Doing != "" {
				fmt.Printf("  doing     %s\n", r.Doing)
			}
			// Printed only when present, and its absence is meaningful: an
			// interactive session has no stop condition to declare, so a blank
			// line here would assert that an autonomous one lost its.
			if r.DoneMeans != "" {
				fmt.Printf("  done when %s\n", r.DoneMeans)
			}
			// Summarised here, complete in --json. A long-running lane
			// accumulates dozens of paths, and printing all of them turns one
			// row into a wall that hides every other row -- which defeats a
			// view whose whole job is showing you the fleet at a glance. The
			// full list is never dropped, only relocated to the machine-
			// readable output that can hold it.
			if len(r.Knows) > 0 {
				fmt.Printf("  knows     %s\n", summariseKnows(r.Knows))
			}
		}
		return nil
	})
}

// knowsPreview is how many file names the human table shows before falling
// back to a count.
const knowsPreview = 4

// summariseKnows renders a read-file list as "N file(s): a.go b.go +M more".
// Base names only: the paths share a long prefix, and the leaf is the part
// that distinguishes them.
func summariseKnows(paths []string) string {
	names := make([]string, 0, knowsPreview)
	for _, p := range paths {
		if len(names) == knowsPreview {
			break
		}
		names = append(names, filepath.Base(p))
	}
	out := fmt.Sprintf("%d file(s): %s", len(paths), strings.Join(names, " "))
	if extra := len(paths) - len(names); extra > 0 {
		out += fmt.Sprintf(" +%d more (--json for all)", extra)
	}
	return out
}

// dash renders an empty field as "-" so a column never collapses into
// whitespace that reads as a missing column rather than a missing value.
func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}
