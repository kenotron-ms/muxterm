// Package secretfile is an owner-only, file-backed store for a single secret.
//
// It exists because muxterm now accepts a credential through the browser, and
// a credential that arrives over HTTP has to land somewhere that is NOT the
// config file. On this machine ~/.config/muxterm/config.toml is mode 0644 --
// world-readable -- and internal/config.Write deliberately re-chmods it to
// 0644 on every write. That is the right posture for a file full of themes
// and font sizes and the wrong one for a key, so keys live here instead: a
// separate file, 0600, in a 0700 directory, holding nothing but the value.
//
// Three properties, and they are the whole point:
//
//   - The value goes IN and never comes back OUT over HTTP. Nothing in this
//     package renders, hints at, masks, or measures a secret. Callers ask
//     Present(), which is a bool.
//   - Errors carry the PATH, never the contents. A store that names the
//     secret in its own failure message defeats itself.
//   - Writes are atomic and permission-pinned: write a temp file at 0600,
//     chmod it again to defeat a permissive umask, then rename over the
//     target.
//
// Conventions follow internal/ai/keystore.go, which does the same job for the
// Anthropic key. That type is unexported and its Status leaks the last four
// characters of the key; this one is exported and leaks nothing. The two
// should eventually collapse into this package -- see the PR note.
package secretfile

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// Store is a single secret in a single file. The zero value is not usable;
// build one with New.
type Store struct {
	path string
}

// New returns a Store backed by the file at path. Nothing is created until
// Save is called: a store that has never been written is simply absent, which
// is the normal default and never an error.
func New(path string) *Store { return &Store{path: path} }

// Path is the file this store reads and writes. Safe to log and safe to show
// a user -- it is a location, not a value.
func (s *Store) Path() string { return s.path }

// Present reports whether a non-empty secret is stored.
//
// This is the ONLY thing any HTTP surface is allowed to learn about a stored
// secret. Not its length, not its prefix, not its last four characters --
// whether it is there.
func (s *Store) Present() bool {
	v, err := s.Load()
	if err != nil {
		// A read failure is reported by Load's own log line. For the
		// purposes of "is one configured", an unreadable secret is not
		// a usable one.
		return false
	}
	return v != ""
}

// Load reads the secret. A missing file returns ("", nil): absence is the
// default state, not a failure.
//
// A mode other than 0600 is logged (path only) and does NOT block the read.
// A permission warning must never brick a running server, and a user who
// chmods their own key file has made a choice muxterm can complain about but
// should not override mid-flight.
func (s *Store) Load() (string, error) {
	if info, err := os.Stat(s.path); err == nil {
		if perm := info.Mode().Perm(); perm != 0o600 {
			log.Printf("secretfile: %s has mode %#o, expected 0600", s.path, perm)
		}
	}
	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		// %w on the os error, which carries the path and the errno and
		// never the contents of a file it failed to read.
		return "", fmt.Errorf("secretfile: read %s: %w", s.path, err)
	}
	return strings.TrimSpace(string(data)), nil
}

// Save writes the secret atomically at 0600 inside a 0700 directory.
//
// The chmod after the write is not redundant with the 0600 passed to
// WriteFile: WriteFile's mode is masked by the process umask, so a umask of
// 0022 would otherwise yield 0644 and hand the key to every account on the
// machine.
func (s *Store) Save(secret string) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return fmt.Errorf("secretfile: refusing to save an empty secret to %s", s.path)
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("secretfile: mkdir %s: %w", dir, err)
	}
	tmp := s.path + ".tmp"
	defer os.Remove(tmp) //nolint:errcheck // no-op once Rename succeeds; cleans up on any earlier failure

	if err := os.WriteFile(tmp, []byte(secret), 0o600); err != nil {
		return fmt.Errorf("secretfile: write %s: %w", tmp, err)
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return fmt.Errorf("secretfile: chmod %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("secretfile: rename %s: %w", s.path, err)
	}
	return nil
}

// Clear removes the secret. A missing file is success: clearing something
// that is already gone is exactly the state the caller asked for.
func (s *Store) Clear() error {
	if err := os.Remove(s.path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("secretfile: remove %s: %w", s.path, err)
	}
	return nil
}
