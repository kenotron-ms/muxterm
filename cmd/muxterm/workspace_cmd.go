package main

import (
	"errors"
	"flag"
	"fmt"
	"os"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// workspaceCreateJSON is the --json output shape for `muxterm workspace create`.
type workspaceCreateJSON struct {
	WorkspaceID string `json:"workspaceId"`
	Name        string `json:"name"`
}

// workspaceCloseJSON is the --json output shape for `muxterm workspace close`.
type workspaceCloseJSON struct {
	WorkspaceID string `json:"workspaceId"`
	Closed      bool   `json:"closed"`
}

// runWorkspace dispatches the `muxterm workspace` subcommand tree.
//
// NAMING: "workspace" is the canonical noun. It is what the daemon's registry,
// its protocol messages, the browser UI, and the MCP tools all call this thing;
// "session" was tmux vocabulary leaking into one corner of the CLI. `muxterm
// session list` therefore now delegates straight into runWorkspaceList (see
// session_cmd.go) so there is exactly one implementation and the two names can
// never report different things. There is deliberately no `workspace switch`:
// the CLI dials per invocation and has no attachment to switch, which is what
// the --workspace flag is for.
func runWorkspace(args []string) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(os.Stdout, "Usage: muxterm workspace <command>")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Commands:")
		fmt.Fprintln(os.Stdout, "  list                    List workspaces known to the daemon")
		fmt.Fprintln(os.Stdout, "  create <name>           Create a new empty workspace")
		fmt.Fprintln(os.Stdout, "  close <workspace-id>    Close a workspace, killing all of its panes")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Inspect one workspace's panes with 'muxterm session attach <workspace-id>'.")
		return nil
	}
	switch args[0] {
	case "list":
		return runWorkspaceList(args[1:], "muxterm workspace list")
	case "create":
		return runWorkspaceCreate(args[1:])
	case "close":
		return runWorkspaceClose(args[1:])
	default:
		return fmt.Errorf("unknown workspace command %q\n\nRun 'muxterm workspace --help' for usage.", args[0])
	}
}

// runWorkspaceList backs both `muxterm workspace list` and its older alias
// `muxterm session list`. invokedAs is the command the user actually typed, so
// --help echoes that spelling back rather than the canonical one.
func runWorkspaceList(args []string, invokedAs string) error {
	fs := flag.NewFlagSet("workspace list", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	asJSON := fs.Bool("json", false, "print machine-readable JSON")
	fs.Usage = func() {
		fmt.Fprintf(os.Stdout, "Usage: %s [--json]\n", invokedAs)
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

func runWorkspaceCreate(args []string) error {
	fs := flag.NewFlagSet("workspace create", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	asJSON := fs.Bool("json", false, "print machine-readable JSON")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm workspace create <name> [--json]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Create a new empty workspace and print its daemon-assigned id. The")
		fmt.Fprintln(os.Stdout, "workspace starts with no panes; add one with 'muxterm pane create")
		fmt.Fprintln(os.Stdout, "--workspace <id>'.")
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
		return fmt.Errorf("workspace create requires a name")
	}
	if fs.NArg() > 1 {
		fs.Usage()
		return fmt.Errorf("workspace create takes exactly one name \u2014 quote it if it contains spaces")
	}
	name := fs.Arg(0)

	return withDeadline(func() error {
		c, err := dialDaemon()
		if err != nil {
			return err
		}
		defer func() { _ = c.Close() }()

		wsID, err := c.CreateWorkspace(name)
		if err != nil {
			return err
		}
		if *asJSON {
			return printJSON(workspaceCreateJSON{WorkspaceID: wsID, Name: name})
		}
		fmt.Printf("created workspace %s (%q)\n", wsID, name)
		return nil
	})
}

func runWorkspaceClose(args []string) error {
	fs := flag.NewFlagSet("workspace close", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	asJSON := fs.Bool("json", false, "print machine-readable JSON")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm workspace close <workspace-id> [--json]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Close a workspace, killing every pane in it. This cannot be undone and")
		fmt.Fprintln(os.Stdout, "does not prompt \u2014 check 'muxterm workspace list' for the pane count first.")
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
		return fmt.Errorf("workspace close requires a workspace id")
	}
	wsID := fs.Arg(0)

	return withDeadline(func() error {
		c, err := dialDaemon()
		if err != nil {
			return err
		}
		defer func() { _ = c.Close() }()

		if err := c.CloseWorkspace(wsID); err != nil {
			return err
		}
		if *asJSON {
			return printJSON(workspaceCloseJSON{WorkspaceID: wsID, Closed: true})
		}
		fmt.Printf("closed workspace %s\n", wsID)
		return nil
	})
}
