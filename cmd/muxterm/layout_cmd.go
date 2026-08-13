package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
)

// layoutGetJSON is the --json output shape for `muxterm layout get`.
type layoutGetJSON struct {
	WorkspaceID string `json:"workspaceId"`
	ASCII       string `json:"ascii"`
}

func runLayout(args []string) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(os.Stdout, "Usage: muxterm layout <command>")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Commands:")
		fmt.Fprintln(os.Stdout, "  get [--workspace ID]   Print the ASCII layout diagram for a workspace")
		return nil
	}
	switch args[0] {
	case "get":
		return runLayoutGet(args[1:])
	default:
		return fmt.Errorf("unknown layout command %q\n\nRun 'muxterm layout --help' for usage.", args[0])
	}
}

func runLayoutGet(args []string) error {
	fs := flag.NewFlagSet("layout get", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	workspace := fs.String("workspace", "", "workspace id (default: first workspace)")
	asJSON := fs.Bool("json", false, "print machine-readable JSON")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm layout get [--workspace ID] [--json]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Print the ASCII layout diagram for a workspace.")
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
		ascii, err := c.GetLayout()
		if err != nil {
			return err
		}
		if *asJSON {
			return printJSON(layoutGetJSON{WorkspaceID: wsID, ASCII: ascii})
		}
		fmt.Print(ascii)
		if ascii != "" && ascii[len(ascii)-1] != '\n' {
			fmt.Println()
		}
		return nil
	})
}
