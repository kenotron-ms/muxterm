package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// paneCreateJSON is the --json output shape for `muxterm pane create`.
type paneCreateJSON struct {
	PaneID      int    `json:"paneId"`
	WorkspaceID string `json:"workspaceId"`
}

func runPane(args []string) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(os.Stdout, "Usage: muxterm pane <command>")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Commands:")
		fmt.Fprintln(os.Stdout, "  create [--workspace ID] [--cmd ARG]...   Spawn a terminal pane")
		fmt.Fprintln(os.Stdout, "  close <pane-id> [--workspace ID]         Kill a pane")
		fmt.Fprintln(os.Stdout, "  resize <pane-id> --cols N --rows N       Resize a pane's PTY")
		return nil
	}
	switch args[0] {
	case "create":
		return runPaneCreate(args[1:])
	case "close":
		return runPaneClose(args[1:])
	case "resize":
		return runPaneResize(args[1:])
	default:
		return fmt.Errorf("unknown pane command %q\n\nRun 'muxterm pane --help' for usage.", args[0])
	}
}

func runPaneCreate(args []string) error {
	fs := flag.NewFlagSet("pane create", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	workspace := fs.String("workspace", "", "workspace id to create the pane in (default: first workspace)")
	asJSON := fs.Bool("json", false, "print machine-readable JSON")
	var cmd stringSliceFlag
	fs.Var(&cmd, "cmd", "argv element for the pane's command; repeat once per element (default: $SHELL)")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm pane create [--workspace ID] [--cmd ARG]... [--json]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Spawn a terminal pane and print its workspace-local pane id.")
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

		wsID, err := attachDefaultWorkspace(c, *workspace)
		if err != nil {
			return err
		}
		paneID, err := c.CreatePane(cmd, "", 0)
		if err != nil {
			return err
		}
		if *asJSON {
			return printJSON(paneCreateJSON{PaneID: paneID, WorkspaceID: wsID})
		}
		fmt.Printf("created pane %d in workspace %s\n", paneID, wsID)
		return nil
	})
}

func runPaneClose(args []string) error {
	fs := flag.NewFlagSet("pane close", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	workspace := fs.String("workspace", "", "workspace id owning the pane (default: search all workspaces)")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm pane close <pane-id> [--workspace ID]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Kill a pane and remove it from its workspace.")
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
		return fmt.Errorf("pane close requires a pane id")
	}
	paneID, err := strconv.Atoi(fs.Arg(0))
	if err != nil {
		return fmt.Errorf("invalid pane id %q: %v", fs.Arg(0), err)
	}

	return withDeadline(func() error {
		c, err := dialDaemon()
		if err != nil {
			return err
		}
		defer func() { _ = c.Close() }()

		wsID, err := attachForPane(c, *workspace, paneID)
		if err != nil {
			return err
		}
		if err := c.ClosePane(paneID); err != nil {
			return err
		}
		fmt.Printf("closed pane %d in workspace %s\n", paneID, wsID)
		return nil
	})
}

// runPaneResize implements `muxterm pane resize <pane-id> --cols N --rows N`.
//
// DELIBERATE DEVIATION: server.go drops a resize request from any connection
// whose kind is not "interactive", so a resize sent as "cli" would be a silent
// no-op. This subcommand therefore re-attaches as ClientKindInteractive, which
// means it claims PTY-size authority for the pane — which is what a caller
// explicitly asking to change the PTY size is asking for. Every read path
// (read-screen, session, layout) stays "cli" and never contends for authority.
func runPaneResize(args []string) error {
	fs := flag.NewFlagSet("pane resize", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	workspace := fs.String("workspace", "", "workspace id owning the pane (default: search all workspaces)")
	cols := fs.Int("cols", 0, "new column count (required)")
	rows := fs.Int("rows", 0, "new row count (required)")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm pane resize <pane-id> --cols N --rows N [--workspace ID]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Resize a pane's PTY. This claims PTY-size authority for the pane, so a")
		fmt.Fprintln(os.Stdout, "browser client viewing it will be told to match the new size.")
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
		return fmt.Errorf("pane resize requires a pane id")
	}
	paneID, err := strconv.Atoi(fs.Arg(0))
	if err != nil {
		return fmt.Errorf("invalid pane id %q: %v", fs.Arg(0), err)
	}
	if *cols <= 0 || *rows <= 0 {
		fs.Usage()
		return fmt.Errorf("pane resize requires positive --cols and --rows")
	}

	return withDeadline(func() error {
		c, err := dialDaemon()
		if err != nil {
			return err
		}
		defer func() { _ = c.Close() }()

		wsID, err := attachForPane(c, *workspace, paneID)
		if err != nil {
			return err
		}
		if _, err := c.Attach(wsID, "wide", sessiond.ClientKindInteractive); err != nil {
			return err
		}
		if err := c.Resize(paneID, *cols, *rows); err != nil {
			return err
		}
		comp, err := c.Attach(wsID, "wide", sessiond.ClientKindCLI)
		if err != nil {
			return err
		}
		for _, p := range comp.Panes {
			if p.PaneID == paneID {
				fmt.Printf("pane %d in workspace %s is now %dx%d\n", paneID, wsID, p.Cols, p.Rows)
				return nil
			}
		}
		return fmt.Errorf("pane %d disappeared from workspace %s during resize", paneID, wsID)
	})
}
