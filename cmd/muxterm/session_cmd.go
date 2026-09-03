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
		fmt.Fprintln(os.Stdout, "  list                    List workspaces known to the daemon")
		fmt.Fprintln(os.Stdout, "  attach <workspace-id>   Print a workspace's composition (panes + layout)")
		return nil
	}
	switch args[0] {
	case "list":
		return runSessionList(args[1:])
	case "attach":
		return runSessionAttach(args[1:])
	default:
		return fmt.Errorf("unknown session command %q\n\nRun 'muxterm session --help' for usage.", args[0])
	}
}

func runSessionList(args []string) error {
	fs := flag.NewFlagSet("session list", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	asJSON := fs.Bool("json", false, "print machine-readable JSON")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm session list [--json]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "List the workspaces the muxterm daemon currently holds.")
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

	return withDeadline(func() error {
		c, err := dialDaemon()
		if err != nil {
			return err
		}
		defer func() { _ = c.Close() }()

		wss, err := c.ListWorkspaces()
		if err != nil {
			return err
		}
		if *asJSON {
			if wss == nil {
				wss = []sessiond.WorkspaceInfo{}
			}
			return printJSON(wss)
		}
		fmt.Printf("%-24s %-24s %s\n", "WORKSPACE-ID", "NAME", "PANES")
		for _, ws := range wss {
			fmt.Printf("%-24s %-24s %d\n", ws.WorkspaceID, ws.Name, ws.PaneCount)
		}
		return nil
	})
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
