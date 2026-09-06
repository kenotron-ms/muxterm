package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/mcp"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// spawnLaneJSON is the --json output shape for `muxterm spawn-lane`. The field
// SET mirrors the MCP spawn_lane result (workspace id, pane id, harness,
// whether the workspace was created) so a script and an agent learn the same
// four facts; the key spelling is camelCase because that is what every other
// muxterm CLI --json payload uses (see workspace_cmd.go / pane_cmd.go), and a
// script piping muxterm into jq should not have to switch conventions
// mid-pipeline. The argv is reported on the human-readable line only, where it
// is a debugging aid rather than part of the contract.
type spawnLaneJSON struct {
	WorkspaceID      string `json:"workspaceId"`
	PaneID           int    `json:"paneId"`
	Harness          string `json:"harness"`
	WorkspaceCreated bool   `json:"workspaceCreated"`
}

// runSpawnLane implements `muxterm spawn-lane <workspace-name> --harness H
// --prompt P [--goal G] [--placement P]`, the CLI half of MCP's spawn_lane.
//
// It exists so delegation is testable and scriptable without an agent in the
// loop: the same resolve-or-create-workspace, attach, create-pane-with-argv
// sequence, driven from a shell. Both sides call mcp.HarnessArgv and
// mcp.ResolveOrCreateWorkspace, so the argv a lane is started with cannot
// differ between them.
//
// Attaches as ClientKindCLI, like every other one-shot CLI command: a scripted
// spawn must not take PTY-size authority away from the human's browser.
//
// Create-only by design. There is no `spawn-lane --close`; a lane is closed
// with `muxterm pane close`, which is a separate, deliberate act.
func runSpawnLane(args []string) error {
	fs := flag.NewFlagSet("spawn-lane", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	harness := fs.String("harness", "", "coding-agent CLI to launch: "+strings.Join(mcp.Launchable, " | ")+" (required)")
	prompt := fs.String("prompt", "", "the lane's opening turn (required; ignored when --goal is given)")
	goal := fs.String("goal", "", "stop condition: launches a /goal loop instead of a plain prompt (amplifier only)")
	placement := fs.String("placement", "", "tab | split-right | split-left | split-above | split-below (advisory; the split is executed by the web UI)")
	asJSON := fs.Bool("json", false, "print machine-readable JSON")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm spawn-lane <workspace-name> --harness H --prompt P [--goal G] [--placement P] [--json]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Delegate work: launch a coding-agent session in a pane of the named")
		fmt.Fprintln(os.Stdout, "workspace, creating that workspace if no workspace has that exact name.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "The prompt is passed as argv, not typed, so the session is already")
		fmt.Fprintln(os.Stdout, "mid-conversation the moment the pane appears \u2014 no keystrokes can be lost")
		fmt.Fprintln(os.Stdout, "to a program that has not finished starting.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "  muxterm spawn-lane backend --harness amplifier --prompt 'fix the auth refresh'")
		fmt.Fprintln(os.Stdout, "  muxterm spawn-lane backend --harness amplifier --prompt x \\")
		fmt.Fprintln(os.Stdout, "      --goal 'refresh tokens rotate without re-login'")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "--goal launches 'amplifier run \"/goal <condition>\" --mode chat', so the lane")
		fmt.Fprintln(os.Stdout, "carries its own declared stop condition. Claude Code has no goal mode and")
		fmt.Fprintln(os.Stdout, "rejects --goal rather than ignoring it.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "This command only creates. Close a lane with 'muxterm pane close'.")
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
		return fmt.Errorf("spawn-lane requires a workspace name")
	}
	if fs.NArg() > 1 {
		fs.Usage()
		return fmt.Errorf("spawn-lane takes exactly one workspace name \u2014 quote it if it contains spaces")
	}
	workspace := fs.Arg(0)

	// Build argv before dialing: an unlaunchable harness, or a goal on a
	// harness with no goal mode, must fail before a workspace is created for
	// it, or a rejected delegation would still leave an empty workspace behind.
	argv, err := mcp.HarnessArgv(*harness, *prompt, *goal)
	if err != nil {
		return err
	}

	return withDeadline(func() error {
		c, err := dialDaemon()
		if err != nil {
			return err
		}
		defer func() { _ = c.Close() }()

		wsID, created, err := mcp.ResolveOrCreateWorkspace(c, workspace)
		if err != nil {
			return err
		}
		// CreatePane is connection-scoped (it carries no workspace id), so the
		// attach is not optional bookkeeping -- it is what decides which
		// workspace the pane lands in.
		if _, err := c.Attach(wsID, "wide", sessiond.ClientKindCLI); err != nil {
			return err
		}
		paneID, err := c.CreatePane(argv, *placement, 0, "")
		if err != nil {
			return err
		}
		if *asJSON {
			return printJSON(spawnLaneJSON{
				WorkspaceID:      wsID,
				PaneID:           paneID,
				Harness:          *harness,
				WorkspaceCreated: created,
			})
		}
		disposition := "existing"
		if created {
			disposition = "new"
		}
		fmt.Printf("spawned %s lane in pane %d of %s workspace %s (%q)\n  argv: %q\n",
			*harness, paneID, disposition, wsID, workspace, argv)
		return nil
	})
}
