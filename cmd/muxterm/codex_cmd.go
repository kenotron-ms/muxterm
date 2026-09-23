package main

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// runCodex replaces this wrapper process with Codex and injects an
// invocation-scoped, explicitly trusted hook layer. It does not read or write
// the user's global Codex configuration.
func runCodex(args []string) error {
	if len(args) > 0 && (args[0] == "--help" || args[0] == "-h") {
		fmt.Fprintln(os.Stdout, "Usage: muxterm codex [codex arguments...]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Run Codex with invocation-scoped muxterm rich session reporting.")
		fmt.Fprintln(os.Stdout, "Coverage includes lifecycle, local tools, plans and permissions; hosted tools are excluded.")
		return nil
	}
	codex, err := exec.LookPath("codex")
	if err != nil {
		return fmt.Errorf("finding codex: %w", err)
	}
	for i, arg := range args {
		if (arg == "-c" || arg == "--config") && i+1 < len(args) && (strings.HasPrefix(args[i+1], "hooks") || strings.HasPrefix(args[i+1], "tools.update_plan")) {
			return fmt.Errorf("Codex reporting injection conflicts with config override %q", args[i+1])
		}
	}
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	hooks, err := sessiond.CodexRichHookArgs(codex, cwd)
	if err != nil {
		return fmt.Errorf("Codex reporting injection failed: %w", err)
	}
	argv := append([]string{"codex"}, sessiond.CodexNotifyOverride()...)
	argv = append(argv, hooks...)
	argv = append(argv, args...)
	self, err := os.Executable()
	if err != nil {
		return err
	}
	env := append(os.Environ(),
		sessiond.CodexHookBridgeEnv+"="+self,
		sessiond.CodexRichReportingEnv+"=1",
		"MUXTERM_CODEX_PID="+strconv.Itoa(os.Getpid()),
	)
	return syscall.Exec(codex, argv, env)
}
