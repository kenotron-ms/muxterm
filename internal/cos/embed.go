package cos

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
)

// embeddedSidecar is the chief-of-staff sidecar script, compiled INTO the
// muxterm binary.
//
// This is not an optimization, it is the distribution mechanism. muxterm ships
// as a single binary (the homebrew tap, the curl installer, and the release
// tarball all deliver exactly one executable), so a sidecar that only lives
// beside the binary does not exist on any installed machine. v0.19.0 shipped
// that way and the Dashboard failed on first use for everyone who was not
// running out of a source checkout.
//
// go:embed cannot reference a parent directory, which is why the script lives
// under internal/cos/ -- the package that owns its lifecycle -- rather than in
// a top-level sidecar/ tree.
//
//go:embed sidecar/main.py
var embeddedSidecar []byte

// sidecarCacheDir resolves the directory that holds extracted copies of the
// embedded sidecar. It follows the XDG-with-HOME-fallback pattern already used
// by snapshotDir (internal/sessiond/snapshot.go, $XDG_DATA_HOME) and socketDir
// (internal/sessiond/spawn.go, $XDG_RUNTIME_DIR):
//   - If XDG_CACHE_HOME is set, uses $XDG_CACHE_HOME/muxterm/sidecar.
//   - Otherwise falls back to $HOME/.cache/muxterm/sidecar.
//   - With neither set, falls back to a uid-keyed directory under the temp
//     dir, rather than writing a relative .cache/ into whatever the working
//     directory happens to be.
func sidecarCacheDir() string {
	base := os.Getenv("XDG_CACHE_HOME")
	if base == "" {
		if home := os.Getenv("HOME"); home != "" {
			base = filepath.Join(home, ".cache")
		} else {
			base = filepath.Join(os.TempDir(), fmt.Sprintf("muxterm-cache-%d", os.Getuid()))
		}
	}
	return filepath.Join(base, "muxterm", "sidecar")
}

// embeddedSidecarPath returns the content-addressed path the embedded sidecar
// extracts to. Addressing by content digest is what makes an upgrade safe: a
// new muxterm carries different bytes, so it extracts to a different directory
// and can never be handed the previous version's script.
func embeddedSidecarPath() string {
	sum := sha256.Sum256(embeddedSidecar)
	return filepath.Join(sidecarCacheDir(), hex.EncodeToString(sum[:])[:16], "main.py")
}

// ExtractEmbeddedSidecar materializes the embedded sidecar on disk and returns
// its path. It is safe to call concurrently from any number of processes: the
// write goes to a per-process temp file in the destination directory and is
// then os.Rename'd into place, so a reader either sees no file or sees the
// whole file, never a torn one.
//
// Extraction is skipped entirely when the target already holds these exact
// bytes, which is the common case after the first run.
func ExtractEmbeddedSidecar() (string, error) {
	path := embeddedSidecarPath()

	// The path is content-addressed, so anything already there SHOULD be
	// right -- but compare anyway. A truncated write from an older muxterm,
	// or a copy someone edited in place, would otherwise be reused forever.
	if data, err := os.ReadFile(path); err == nil && bytes.Equal(data, embeddedSidecar) {
		return path, nil
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", extractErr(dir, err)
	}
	tmp, err := os.CreateTemp(dir, "main.py.*.tmp")
	if err != nil {
		return "", extractErr(dir, err)
	}
	tmpName := tmp.Name()
	// Best-effort cleanup covering every failure path below. After a
	// successful rename both calls are harmless no-ops.
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}()

	if _, err := tmp.Write(embeddedSidecar); err != nil {
		return "", extractErr(tmpName, err)
	}
	// 0600 is deliberate: the script is handed to a python interpreter, never
	// exec'd directly, so it does not need the execute bit.
	if err := tmp.Chmod(0o600); err != nil {
		return "", extractErr(tmpName, err)
	}
	if err := tmp.Close(); err != nil {
		return "", extractErr(tmpName, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return "", extractErr(path, err)
	}
	return path, nil
}

// extractErr names the path that failed and points at the escape hatch, since
// the usual cause is a cache directory that is read-only or owned by someone
// else, and no amount of retrying will fix that.
func extractErr(path string, err error) error {
	return fmt.Errorf("cos: could not extract the embedded sidecar to %s: %w; "+
		"set %s to a readable copy of main.py to bypass extraction", path, err, EnvSidecar)
}
