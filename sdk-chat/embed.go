package sdkchat

import (
	"context"
	"crypto/sha256"
	"embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

// The installed binary carries the sidecar and the exact npm dependency lock.
// Node packages are installed into a versioned cache before the sidecar starts.
//
//go:embed sidecar.mjs codex-stream.mjs acp-stream.mjs package.json package-lock.json
var files embed.FS

var names = []string{"sidecar.mjs", "codex-stream.mjs", "acp-stream.mjs", "package.json", "package-lock.json"}
var prepareMu sync.Mutex

func ready(dir string) bool {
	for _, name := range []string{
		"sidecar.mjs",
		"codex-stream.mjs",
		"acp-stream.mjs",
		"node_modules/@openai/codex-sdk/package.json",
		"node_modules/@anthropic-ai/claude-agent-sdk/package.json",
		"node_modules/@agentclientprotocol/sdk/package.json",
	} {
		if info, err := os.Stat(filepath.Join(dir, name)); err != nil || !info.Mode().IsRegular() {
			return false
		}
	}
	return true
}

// Prepare returns a runnable sidecar path for both source and installed builds.
// A completed cache tree is published atomically, so another process never
// starts Node against an npm install that is still in progress.
func Prepare() (string, error) {
	prepareMu.Lock()
	defer prepareMu.Unlock()
	if _, err := exec.LookPath("node"); err != nil {
		return "", fmt.Errorf("sdk-chat: Node.js is required for coding agent chats: %w", err)
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("sdk-chat: resolve cache directory: %w", err)
	}
	base := filepath.Join(cache, "muxterm", "sdk-chat")
	if err := os.MkdirAll(base, 0700); err != nil {
		return "", fmt.Errorf("sdk-chat: create cache directory: %w", err)
	}
	hash := sha256.New()
	contents := make(map[string][]byte, len(names))
	for _, name := range names {
		data, err := files.ReadFile(name)
		if err != nil {
			return "", fmt.Errorf("sdk-chat: read embedded %s: %w", name, err)
		}
		contents[name] = data
		hash.Write([]byte(name))
		hash.Write(data)
	}
	dest := filepath.Join(base, fmt.Sprintf("%x", hash.Sum(nil)[:8]))
	if ready(dest) {
		return filepath.Join(dest, "sidecar.mjs"), nil
	}
	npm, err := exec.LookPath("npm")
	if err != nil {
		return "", fmt.Errorf("sdk-chat: npm is required to install chat sidecar dependencies: %w", err)
	}
	lock, err := os.OpenFile(filepath.Join(base, ".install.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return "", fmt.Errorf("sdk-chat: open install lock: %w", err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return "", fmt.Errorf("sdk-chat: lock install: %w", err)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN) //nolint:errcheck
	if ready(dest) {
		return filepath.Join(dest, "sidecar.mjs"), nil
	}
	tmp, err := os.MkdirTemp(base, ".install-*")
	if err != nil {
		return "", fmt.Errorf("sdk-chat: create install directory: %w", err)
	}
	defer os.RemoveAll(tmp) //nolint:errcheck
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(tmp, name), contents[name], 0600); err != nil {
			return "", fmt.Errorf("sdk-chat: extract %s: %w", name, err)
		}
	}
	installCtx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(installCtx, npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", tmp)
	output, err := cmd.CombinedOutput()
	if err != nil {
		message := string(output)
		if len(message) > 4000 {
			message = message[len(message)-4000:]
		}
		return "", fmt.Errorf("sdk-chat: failed to install chat sidecar dependencies: %w: %s", err, message)
	}
	if !ready(tmp) {
		return "", fmt.Errorf("sdk-chat: npm install finished without required sidecar dependencies")
	}
	if err := os.RemoveAll(dest); err != nil {
		return "", fmt.Errorf("sdk-chat: remove incomplete cache: %w", err)
	}
	if err := os.Rename(tmp, dest); err != nil {
		return "", fmt.Errorf("sdk-chat: publish installed sidecar: %w", err)
	}
	return filepath.Join(dest, "sidecar.mjs"), nil
}
