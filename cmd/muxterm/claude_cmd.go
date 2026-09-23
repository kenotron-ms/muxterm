package main

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

//go:embed claude_plugin
var claudePluginFS embed.FS

func runClaude(args []string) error {
	if len(args) > 0 && (args[0] == "--help" || args[0] == "-h") {
		fmt.Fprintln(os.Stdout, "Usage: muxterm claude [claude arguments...]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Run Claude with invocation-scoped muxterm session reporting.")
		fmt.Fprintln(os.Stdout, "Raw `claude` launches are outside muxterm's reporting coverage.")
		return nil
	}
	claude, err := exec.LookPath("claude")
	if err != nil {
		return fmt.Errorf("finding claude: %w", err)
	}
	self, err := os.Executable()
	if err != nil {
		return fmt.Errorf("finding muxterm executable: %w", err)
	}
	plugin, err := materializeClaudePlugin()
	if err != nil {
		return err
	}
	argv := []string{"claude", "--plugin-dir", plugin}
	argv = append(argv, args...)
	env := append(os.Environ(), "MUXTERM_CLAUDE_BRIDGE="+self)
	return syscall.Exec(claude, argv, env)
}

func materializeClaudePlugin() (string, error) {
	dir, err := os.MkdirTemp("", "muxterm-claude-plugin-")
	if err != nil {
		return "", fmt.Errorf("create Claude plugin directory: %w", err)
	}
	err = fs.WalkDir(claudePluginFS, "claude_plugin", func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, _ := filepath.Rel("claude_plugin", path)
		dst := filepath.Join(dir, rel)
		if entry.IsDir() {
			return os.MkdirAll(dst, 0o700)
		}
		body, readErr := claudePluginFS.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		mode := os.FileMode(0o600)
		if filepath.Base(path) == "report.sh" {
			mode = 0o700
		}
		return os.WriteFile(dst, body, mode)
	})
	if err != nil {
		return "", fmt.Errorf("materialize Claude plugin: %w", err)
	}
	return dir, nil
}
