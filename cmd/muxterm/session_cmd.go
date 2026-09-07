package main

import (
	"errors"
	"flag"
	"fmt"
	"os"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// sessionAttachJSON is the --json output shape for `muxterm session attach`.
type sessionAttachJSON struct {
	WorkspaceID string              `json:"workspaceId"`
	Panes       []sessiond.PaneInfo `json:"panes"`
	HasLayout   bool                `json:"hasLayout"`
}

func runSession(args []string) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(os.Stdout, "Usage: muxterm session <command>")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Commands:")
		fmt.Fprintln(os.Stdout, "  list                    Alias for 'muxterm workspace list'")
		fmt.Fprintln(os.Stdout, "  attach <workspace-id>   Print a workspace's composition (panes + layout)")
		fmt.Fprintln(os.Stdout, "  read <session-id>       Print the tail of an agent session's transcript")
		fmt.Fprintln(os.Stdout, "  report [flags]          Publish a session-state snapshot to the home view")
		return nil
	}
	switch args[0] {
	case "list":
		// One implementation, two spellings: see runWorkspace's NAMING note.
		// The pointer goes to stderr so that "muxterm session list --json"
		// still pipes clean JSON into jq.
		fmt.Fprintln(os.Stderr, "note: 'muxterm session list' is now spelled 'muxterm workspace list'; both work.")
		return runWorkspaceList(args[1:], "muxterm session list")
	case "attach":
		return runSessionAttach(args[1:])
	case "read":
		// The consumer side of the same feed `report` produces: report writes
		// a session's declared state, fleet lists it, read shows what the
		// session actually said. See session_read_cmd.go.
		return runSessionRead(args[1:])
	case "report":
		// The universal producer; see session_report_cmd.go. Unlike list and
		// attach it never dials the daemon -- it writes a file.
		return runSessionReport(args[1:])
	default:
		return fmt.Errorf("unknown session command %q\n\nRun 'muxterm session --help' for usage.", args[0])
	}
}

func runSessionAttach(args []string) error {
	fs := flag.NewFlagSet("session attach", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	asJSON := fs.Bool("json", false, "print machine-readable JSON")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm session attach <workspace-id> [--json]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Print the composition (panes and whether a layout is saved) of a workspace.")
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
		return fmt.Errorf("session attach requires a workspace id")
	}
	wsID := fs.Arg(0)

	return withDeadline(func() error {
		c, err := dialDaemon()
		if err != nil {
			return err
		}
		defer func() { _ = c.Close() }()

		comp, err := c.Attach(wsID, "wide", sessiond.ClientKindCLI)
		if err != nil {
			return err
		}
		if *asJSON {
			panes := comp.Panes
			if panes == nil {
				panes = []sessiond.PaneInfo{}
			}
			return printJSON(sessionAttachJSON{
				WorkspaceID: comp.WorkspaceID,
				Panes:       panes,
				HasLayout:   comp.Layout != "",
			})
		}
		fmt.Printf("workspace %s (%d panes, layout saved: %t)\n", comp.WorkspaceID, len(comp.Panes), comp.Layout != "")
		fmt.Printf("%-8s %-10s %-8s %s\n", "PANE-ID", "SURFACE", "SIZE", "TITLE")
		for _, p := range comp.Panes {
			fmt.Printf("%-8d %-10s %-8s %s\n", p.PaneID, "terminal", fmt.Sprintf("%dx%d", p.Cols, p.Rows), p.Title)
		}
		return nil
	})
}
