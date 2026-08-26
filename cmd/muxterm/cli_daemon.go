package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

const cliRequestTimeout = 5 * time.Second

const daemonNotRunningMsg = `muxterm daemon not running — start it with "muxterm serve"`

// dialDaemon resolves the sessiond socket path, fails fast with a clear
// message if the daemon is not running (mirroring runDoctor's precedent),
// dials it, and starts the client's background read loop. Callers must
// Close() the returned client.
func dialDaemon() (*sessiond.Client, error) {
	sock, err := sessiond.SocketPath()
	if err != nil {
		return nil, fmt.Errorf("resolve sessiond socket path: %w", err)
	}
	if _, statErr := os.Stat(sock); statErr != nil {
		return nil, fmt.Errorf("%s", daemonNotRunningMsg)
	}
	c, err := sessiond.Dial(sock)
	if err != nil {
		return nil, fmt.Errorf("%s (dialing %s: %v)", daemonNotRunningMsg, sock, err)
	}
	go func() { _ = c.Run() }()
	return c, nil
}

// withDeadline runs fn on its own goroutine and bounds its wall-clock time to
// cliRequestTimeout, so a one-shot CLI invocation never hangs a cron job
// indefinitely on an unresponsive daemon.
func withDeadline(fn func() error) error {
	done := make(chan error, 1)
	go func() { done <- fn() }()
	select {
	case err := <-done:
		return err
	case <-time.After(cliRequestTimeout):
		return fmt.Errorf("timed out after %s waiting for the muxterm daemon", cliRequestTimeout)
	}
}

// attachForPane attaches to workspaceID (if non-empty) and confirms paneID
// exists in it, or, when workspaceID is empty, searches every workspace known
// to the daemon for the pane. It returns the workspace id the pane was found
// in.
func attachForPane(c *sessiond.Client, workspaceID string, paneID int) (string, error) {
	if workspaceID != "" {
		comp, err := c.Attach(workspaceID, "wide", sessiond.ClientKindCLI)
		if err != nil {
			return "", err
		}
		if !hasPane(comp.Panes, paneID) {
			return "", fmt.Errorf("pane %d not found in workspace %s", paneID, workspaceID)
		}
		return workspaceID, nil
	}
	wss, err := c.ListWorkspaces()
	if err != nil {
		return "", err
	}
	for _, ws := range wss {
		comp, err := c.Attach(ws.WorkspaceID, "wide", sessiond.ClientKindCLI)
		if err != nil {
			continue
		}
		if hasPane(comp.Panes, paneID) {
			return ws.WorkspaceID, nil
		}
	}
	return "", fmt.Errorf("pane %d not found in any workspace (pass --workspace to target one explicitly)", paneID)
}

// attachDefaultWorkspace attaches to workspaceID, or, when workspaceID is
// empty, to the first workspace known to the daemon. It returns the workspace
// id that was actually attached.
func attachDefaultWorkspace(c *sessiond.Client, workspaceID string) (string, error) {
	if workspaceID == "" {
		wss, err := c.ListWorkspaces()
		if err != nil {
			return "", err
		}
		if len(wss) == 0 {
			return "", fmt.Errorf("no workspaces exist — create one in the muxterm UI first")
		}
		workspaceID = wss[0].WorkspaceID
	}
	if _, err := c.Attach(workspaceID, "wide", sessiond.ClientKindCLI); err != nil {
		return "", err
	}
	return workspaceID, nil
}

func hasPane(panes []sessiond.PaneInfo, paneID int) bool {
	for _, p := range panes {
		if p.PaneID == paneID {
			return true
		}
	}
	return false
}

// reorderFlagsFirst rearranges args so every flag token (and its value
// token, if the flag takes one) precedes positional arguments. The stdlib
// flag package stops parsing at the first non-flag token, so an invocation
// shaped "<pane-id> --scrollback --json" — this CLI's documented usage,
// positional id before its flags (e.g. "muxterm read-screen 1 --scrollback
// --json") — would otherwise silently drop every flag after the id instead
// of erroring. Reordering here preserves flag.Parse's own semantics (unknown
// flags, missing values, etc. still error exactly as they would from
// flag.Parse itself) while accepting flags in any position relative to
// positional arguments.
func reorderFlagsFirst(fs *flag.FlagSet, args []string) []string {
	flags := make([]string, 0, len(args))
	positional := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			positional = append(positional, args[i+1:]...)
			break
		}
		if len(a) == 0 || a[0] != '-' || a == "-" {
			positional = append(positional, a)
			continue
		}
		flags = append(flags, a)
		name := strings.TrimLeft(a, "-")
		if eq := strings.IndexByte(name, '='); eq >= 0 {
			continue // "--flag=value" is self-contained; no separate value token
		}
		f := fs.Lookup(name)
		if f == nil {
			continue // unknown flag: let fs.Parse report the real error
		}
		if bf, ok := f.Value.(interface{ IsBoolFlag() bool }); ok && bf.IsBoolFlag() {
			continue // boolean flag takes no separate value token
		}
		if i+1 < len(args) {
			i++
			flags = append(flags, args[i])
		}
	}
	return append(flags, positional...)
}

// printJSON writes v to stdout as indented JSON.
func printJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

// stringSliceFlag implements flag.Value for a repeatable string flag, used by
// `pane create --cmd ARG` (one element of argv per --cmd occurrence).
type stringSliceFlag []string

func (s *stringSliceFlag) String() string { return strings.Join(*s, " ") }

func (s *stringSliceFlag) Set(v string) error {
	*s = append(*s, v)
	return nil
}
