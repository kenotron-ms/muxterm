package main

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// runCodex replaces this wrapper process with Codex and injects only an
// invocation-scoped completion notifier. It does not read or write the user's
// global Codex configuration.
func runCodex(args []string) error {
	if len(args) > 0 && (args[0] == "--help" || args[0] == "-h") {
		fmt.Fprintln(os.Stdout, "Usage: muxterm codex [codex arguments...]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Run Codex with invocation-scoped muxterm completion reporting.")
		fmt.Fprintln(os.Stdout, "Coverage is completion-only: the fleet row appears after the first completed turn.")
		return nil
	}
	codex, err := exec.LookPath("codex")
	if err != nil {
		return fmt.Errorf("finding codex: %w", err)
	}
	argv := append([]string{"codex"}, sessiond.CodexNotifyOverride()...)
	argv = append(argv, args...)
	return syscall.Exec(codex, argv, os.Environ())
}
