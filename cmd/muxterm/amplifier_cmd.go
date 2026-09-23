package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// runAmplifier selects a muxterm-owned root bundle for this invocation only.
// It neither installs nor selects an Amplifier bundle in user configuration.
func runAmplifier(args []string) error {
	amplifier, err := exec.LookPath("amplifier")
	if err != nil {
		return fmt.Errorf("finding amplifier: %w", err)
	}
	self, err := os.Executable()
	if err != nil {
		return fmt.Errorf("finding muxterm executable: %w", err)
	}
	bundlesDir := filepath.Join(".amplifier", "bundles")
	if err := os.MkdirAll(bundlesDir, 0o700); err != nil {
		return fmt.Errorf("create project Amplifier bundle directory: %w", err)
	}
	dir, err := os.MkdirTemp(bundlesDir, "muxterm-invocation-")
	if err != nil {
		return fmt.Errorf("create Amplifier bundle directory: %w", err)
	}
	defer os.RemoveAll(dir)
	bundleName := filepath.Base(dir)
	source := os.Getenv("MUXTERM_AMPLIFIER_HOOK_SOURCE")
	if source == "" {
		source = "git+https://github.com/kenotron-ms/muxterm@main#subdirectory=modules/hooks-muxterm-session"
	}
	bundle := "---\nbundle:\n  name: " + bundleName + "\n  version: 1.0.0\nincludes:\n  - bundle: git+https://github.com/microsoft/amplifier-foundation@main#subdirectory=bundles/anchors/bundle.md\nhooks:\n  - module: hooks-muxterm-session\n    source: " + strconv.Quote(source) + "\n---\n"
	path := filepath.Join(dir, "bundle.md")
	if err := os.WriteFile(path, []byte(bundle), 0o600); err != nil {
		return fmt.Errorf("write Amplifier invocation bundle: %w", err)
	}
	argv := []string{"amplifier"}
	if len(args) == 0 {
		args = []string{"run"}
	}
	argv = append(argv, args...)
	if args[0] == "run" && !hasAmplifierBundleArg(args[1:]) {
		argv = append(argv, "--bundle", bundleName)
	}
	env := append(os.Environ(), "MUXTERM_AMPLIFIER_BRIDGE="+self)
	cmd := exec.Command(amplifier, argv[1:]...)
	cmd.Env = env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("amplifier exited: %w", err)
	}
	return nil
}

func hasAmplifierBundleArg(args []string) bool {
	for _, arg := range args {
		if arg == "-B" || arg == "--bundle" || strings.HasPrefix(arg, "--bundle=") {
			return true
		}
	}
	return false
}
