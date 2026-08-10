package ai

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// KeyFileName is the name of the file (within the muxterm config directory)
// that stores the Anthropic API key.
const KeyFileName = "anthropic_key"

// DefaultKeyPath returns the default location of the Anthropic key file:
// $XDG_CONFIG_HOME/muxterm/anthropic_key, falling back to
// $HOME/.config/muxterm/anthropic_key when XDG_CONFIG_HOME is unset.
func DefaultKeyPath() string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".config")
	}
	return filepath.Join(base, "muxterm", KeyFileName)
}

// keyStore is a file-backed store for the Anthropic API key, sized for
// muxterm's actual load (a single OS account, occasional key changes) --
// not a high-throughput secret store. Modeled on
// internal/authserver/tokenstore.go's atomic-write conventions.
type keyStore struct {
	path string
}

// newKeyStore returns a keyStore backed by the file at path. The parent
// directory and file are created with owner-only permissions (0700/0600)
// on Save, mirroring internal/authserver/tokenstore.go's posture.
func newKeyStore(path string) *keyStore {
	return &keyStore{path: path}
}

// Load reads the key from disk. A missing file is the normal default and
// returns ("", nil) rather than an error. A permission mode other than
// 0600 is logged as a warning (path only, never contents) but never
// prevents the read -- a permission warning must never brick the server.
func (k *keyStore) Load() (string, error) {
	if info, err := os.Stat(k.path); err == nil {
		if perm := info.Mode().Perm(); perm != 0o600 {
			log.Printf("ai: key file %s has mode %#o, expected 0600", k.path, perm)
		}
	}

	data, err := os.ReadFile(k.path)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("ai: read key file %s: %w", k.path, err)
	}
	return strings.TrimSpace(string(data)), nil
}

// Save persists key to disk atomically: write to a .tmp file at 0600,
// chmod it to 0600 again to defeat a permissive umask, then rename over
// the target.
func (k *keyStore) Save(key string) error {
	dir := filepath.Dir(k.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("ai: mkdir %s: %w", dir, err)
	}

	tmp := k.path + ".tmp"
	defer os.Remove(tmp) // no-op once Rename succeeds; cleans up tmp on any earlier failure path
	if err := os.WriteFile(tmp, []byte(key), 0o600); err != nil {
		return fmt.Errorf("ai: write %s: %w", tmp, err)
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return fmt.Errorf("ai: chmod %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, k.path); err != nil {
		return fmt.Errorf("ai: rename %s: %w", k.path, err)
	}
	return nil
}

// Clear removes the key file. A missing file is treated as success.
func (k *keyStore) Clear() error {
	if err := os.Remove(k.path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("ai: remove %s: %w", k.path, err)
	}
	return nil
}
