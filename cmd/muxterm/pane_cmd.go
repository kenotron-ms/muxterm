package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// paneCreateJSON is the --json output shape for `muxterm pane create`.
type paneCreateJSON struct {
	PaneID      int    `json:"paneId"`
	WorkspaceID string `json:"workspaceId"`
}

// paneSendJSON is the --json output shape for `muxterm pane send`. Bytes is
// what was written to the PTY, not what the program in the pane made of it —
// pane input is fire-and-forget and the daemon sends no acknowledgement.
type paneSendJSON struct {
	PaneID      int    `json:"paneId"`
	WorkspaceID string `json:"workspaceId"`
	Bytes       int    `json:"bytes"`
}

// paneRenameJSON is the --json output shape for `muxterm pane rename`.
type paneRenameJSON struct {
	PaneID      int    `json:"paneId"`
	WorkspaceID string `json:"workspaceId"`
	Name        string `json:"name"`
}

// cliNamedKeys maps key names to the literal bytes a real terminal/keyboard
// would produce for them, for `pane send --keys`.
//
// SOURCE OF TRUTH: namedKeys in internal/mcp/tools_terminal.go. This is a
// deliberate byte-for-byte copy, not an independent implementation — the whole
// point of `pane send` is that a shell script driving the CLI and an agent
// driving MCP type identically into the same PTY, so a divergence here is a
// bug by definition. The copy exists only because namedKeys is unexported;
// issue #47's shared operation layer is where the two collapse into one table.
// Any edit here must be mirrored there, and vice versa.
var cliNamedKeys = map[string]string{
	"Enter":     "\r",
	"Tab":       "\t",
	"Escape":    "\x1b",
	"Backspace": "\x7f",
	"Up":        "\x1b[A",
	"Down":      "\x1b[B",
	"Right":     "\x1b[C",
	"Left":      "\x1b[D",
	"C-c":       "\x03",
	"C-d":       "\x04",
	"C-z":       "\x1a",
}

// knownKeyNames renders the accepted --keys names for help and error text,
// derived from cliNamedKeys itself so the two can never drift.
func knownKeyNames() string {
	names := make([]string, 0, len(cliNamedKeys))
	for k := range cliNamedKeys {
		names = append(names, k)
	}
	sort.Strings(names)
	return strings.Join(names, " ")
}

func runPane(args []string) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(os.Stdout, "Usage: muxterm pane <command>")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Commands:")
		fmt.Fprintln(os.Stdout, "  create [--workspace ID] [--cmd ARG]...   Spawn a terminal pane")
		fmt.Fprintln(os.Stdout, "  send <pane-id> [--text S] [--keys K]     Type into a pane's PTY")
		fmt.Fprintln(os.Stdout, "  rename <pane-id> <name>                  Set a pane's display name")
		fmt.Fprintln(os.Stdout, "  close <pane-id> [--workspace ID]         Kill a pane")
		fmt.Fprintln(os.Stdout, "  resize <pane-id> --cols N --rows N       Resize a pane's PTY")
		return nil
	}
	switch args[0] {
	case "create":
		return runPaneCreate(args[1:])
	case "send":
		return runPaneSend(args[1:])
	case "rename":
		return runPaneRename(args[1:])
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
		paneID, err := c.CreatePane(cmd, "", 0, "")
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

// runPaneSend implements `muxterm pane send <pane-id> [--text STR] [--keys K]`,
// the CLI half of MCP's send_input. It attaches as ClientKindCLI, which is what
// keeps a scripted keystroke from stealing PTY-size authority away from the
// human's browser: the daemon only calls TouchAuthority for "interactive"
// connections (internal/sessiond/server.go, the FramePaneData branch of
// conn.serve).
func runPaneSend(args []string) error {
	fs := flag.NewFlagSet("pane send", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	workspace := fs.String("workspace", "", "workspace id owning the pane (default: search all workspaces)")
	text := fs.String("text", "", "literal bytes to send, unchanged (never read as a key name)")
	asJSON := fs.Bool("json", false, "print machine-readable JSON")
	var keys keyListFlag
	fs.Var(&keys, "keys", "comma-separated key names sent after --text; repeatable")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm pane send <pane-id> [--text STR] [--keys NAME[,NAME]...] [--workspace ID] [--json]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Send input to a pane's PTY, exactly as MCP's send_input does.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "--text is sent as literal bytes, unchanged: it is never read as a key name")
		fmt.Fprintln(os.Stdout, "and escapes like \\n are not interpreted, so any payload is safe \u2014 including")
		fmt.Fprintln(os.Stdout, "the 5-character string \"Enter\". --keys translates key names into their byte")
		fmt.Fprintln(os.Stdout, "sequences. Given both, --text goes first and --keys second, so this types a")
		fmt.Fprintln(os.Stdout, "command and runs it:")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "  muxterm pane send 1 --text 'echo hello' --keys Enter")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "At least one of --text or --keys is required. Delivery is fire-and-forget \u2014")
		fmt.Fprintln(os.Stdout, "the daemon does not acknowledge pane input \u2014 so this reports the bytes sent,")
		fmt.Fprintln(os.Stdout, "not what the program did with them. Read that back with 'muxterm read-screen'.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Key names: "+knownKeyNames())
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
		return fmt.Errorf("pane send requires a pane id")
	}
	paneID, err := strconv.Atoi(fs.Arg(0))
	if err != nil {
		return fmt.Errorf("invalid pane id %q: %v", fs.Arg(0), err)
	}

	// fs.Visit reports only the flags actually present on the command line, so
	// "--text ''" (a deliberate empty payload) stays distinguishable from an
	// omitted --text, matching argStringOptional's present flag on the MCP side.
	textPresent := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "text" {
			textPresent = true
		}
	})
	if !textPresent && len(keys) == 0 {
		fs.Usage()
		return fmt.Errorf("pane send requires at least one of --text or --keys")
	}

	var payload []byte
	if textPresent {
		payload = append(payload, *text...)
	}
	for _, k := range keys {
		b, ok := cliNamedKeys[k]
		if !ok {
			// An unknown name is an error rather than being sent as literal
			// text: a typo'd key silently degrading into junk bytes in the
			// pane would be a miserable failure to diagnose.
			return fmt.Errorf("unknown key name %q in --keys (known: %s)", k, knownKeyNames())
		}
		payload = append(payload, b...)
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
		if err := c.Input(uint32(paneID), payload); err != nil {
			return err
		}
		if *asJSON {
			return printJSON(paneSendJSON{PaneID: paneID, WorkspaceID: wsID, Bytes: len(payload)})
		}
		fmt.Printf("sent %d bytes to pane %d in workspace %s\n", len(payload), paneID, wsID)
		return nil
	})
}

func runPaneRename(args []string) error {
	fs := flag.NewFlagSet("pane rename", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	workspace := fs.String("workspace", "", "workspace id owning the pane (default: search all workspaces)")
	asJSON := fs.Bool("json", false, "print machine-readable JSON")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm pane rename <pane-id> <name> [--workspace ID] [--json]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Set a pane's display label. An empty name clears it back to the default.")
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
	if fs.NArg() < 2 {
		fs.Usage()
		return fmt.Errorf("pane rename requires a pane id and a name")
	}
	if fs.NArg() > 2 {
		fs.Usage()
		return fmt.Errorf("pane rename takes exactly one name \u2014 quote it if it contains spaces")
	}
	paneID, err := strconv.Atoi(fs.Arg(0))
	if err != nil {
		return fmt.Errorf("invalid pane id %q: %v", fs.Arg(0), err)
	}
	name := fs.Arg(1)

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
		if err := c.RenamePane(paneID, name); err != nil {
			return err
		}
		if *asJSON {
			return printJSON(paneRenameJSON{PaneID: paneID, WorkspaceID: wsID, Name: name})
		}
		fmt.Printf("renamed pane %d in workspace %s to %q\n", paneID, wsID, name)
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
