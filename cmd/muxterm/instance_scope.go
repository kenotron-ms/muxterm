package main

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/kenotron-ms/muxterm/internal/config"
)

// differentListenPort distinguishes an explicitly selected second listener
// from another spelling of the installed listener's address.
func differentListenPort(addr, installedAddr string) bool {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return false // normal address validation reports the useful error
	}
	if installedAddr == "" {
		installedAddr = config.DefaultAddr
	}
	_, installedPort, err := net.SplitHostPort(installedAddr)
	return err == nil && port != installedPort
}

// The dev targets already bind their daemon and durable data to one private
// runtime tree. Keep that scope so their CLI tools continue to find the same
// daemon as the browser.
func alreadyIsolatedServeInstance() bool {
	if os.Getenv("MUXTERM_DEV_INSTANCE") != "1" || os.Getenv("MUXTERM_COS_SESSION_ID") == "" {
		return false
	}
	runtimeDir := os.Getenv("XDG_RUNTIME_DIR")
	dataDir := os.Getenv("XDG_DATA_HOME")
	if runtimeDir == "" || dataDir == "" {
		return false
	}
	runtimeDir = filepath.Clean(runtimeDir)
	dataDir = filepath.Clean(dataDir)
	if !strings.HasPrefix(dataDir, runtimeDir+string(os.PathSeparator)) {
		return false
	}
	for key, root := range map[string]string{
		"MUXTERM_SESSION_STATE_DIR": runtimeDir,
		"MUXTERM_HOOK_REPORT_ROOT":  dataDir,
	} {
		if override := os.Getenv(key); override != "" && !strings.HasPrefix(filepath.Clean(override), root+string(os.PathSeparator)) {
			return false
		}
	}
	return true
}

// scopeServeInstance moves every local registration and persistence path before
// the server, sidecar, or sessiond is created. The port is the instance key:
// restarting the same test port retains its own chats, while a forgotten XDG
// override cannot publish them into the installed instance.
func scopeServeInstance(addr string) error {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	root := filepath.Join(os.TempDir(), fmt.Sprintf("muxterm-instance-%d-%s", os.Getuid(), port))
	if err := os.MkdirAll(root, 0o700); err != nil {
		return fmt.Errorf("create instance directory: %w", err)
	}
	info, err := os.Lstat(root)
	if err != nil {
		return err
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || int(owner.Uid) != os.Getuid() || info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("instance directory %s must be a private directory owned by the current user", root)
	}
	for key, value := range map[string]string{
		"XDG_RUNTIME_DIR":        root,
		"XDG_DATA_HOME":          filepath.Join(root, "data"),
		"XDG_CONFIG_HOME":        filepath.Join(root, "config"),
		"MUXTERM_COS_SESSION_ID": "muxterm-cos-instance-" + port,
		"MUXTERM_DEV_INSTANCE":   "1",
	} {
		if err := os.Setenv(key, value); err != nil {
			return err
		}
	}
	// These direct path overrides take precedence over XDG in registration.
	for _, key := range []string{"MUXTERM_SESSION_STATE_DIR", "MUXTERM_HOOK_REPORT_ROOT", "INVOCATION_ID"} {
		if err := os.Unsetenv(key); err != nil {
			return err
		}
	}
	return nil
}
