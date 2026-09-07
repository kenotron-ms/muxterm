package cos

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

// embeddedSidecar is the chief-of-staff sidecar TREE -- the script and the
// bundle it loads -- compiled INTO the muxterm binary.
//
// This is not an optimization, it is the distribution mechanism. muxterm ships
// as a single binary (the homebrew tap, the curl installer, and the release
// tarball all deliver exactly one executable), so a sidecar that only lives
// beside the binary does not exist on any installed machine. v0.19.0 shipped
// that way and the Dashboard failed on first use for everyone who was not
// running out of a source checkout.
//
// The bundle under sidecar/bundle/ is here for exactly the same reason, and it
// travels WITH the script rather than beside it: both are extracted as one unit
// under one content digest, so main.py can find its own bundle at
// __file__/../bundle/bundle.md whether it is running from a source checkout or
// from the extracted copy. That is what makes the chief-of-staff bundle
// resolvable with no `amplifier bundle add` step and no network fetch of the
// bundle definition, and what makes it impossible for a binary to load a
// bundle from a different version of itself.
//
// go:embed cannot reference a parent directory, which is why both live under
// internal/cos/ -- the package that owns their lifecycle -- rather than in a
// top-level sidecar/ tree or in the repo's behaviors/ directory next to
// behaviors/muxterm.yaml.
//
// The two paths are named EXPLICITLY rather than embedding sidecar/ wholesale.
// That directory also holds dev-driver.py and stub-sidecar.py -- test fixtures
// worth ~26KB that would otherwise ride into every release binary and get
// written to every user's cache. Anything new that the sidecar genuinely needs
// at runtime has to be added here on purpose.
//
//go:embed sidecar/main.py sidecar/bundle
var embeddedSidecar embed.FS

// sidecarScriptName is the tree-relative path of the script itself. Callers
// get the extracted copy of THIS file; everything else in the tree is support
// material that main.py resolves relative to its own location.
const sidecarScriptName = "sidecar/main.py"

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

// embeddedSidecarFiles lists the tree-relative paths of every embedded file,
// sorted. Sorting is what makes the digest below reproducible: fs.WalkDir is
// already lexical, but stating it removes the question.
func embeddedSidecarFiles() ([]string, error) {
	var paths []string
	err := fs.WalkDir(embeddedSidecar, "sidecar", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			paths = append(paths, p)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(paths)
	return paths, nil
}

// embeddedSidecarDigest is a content digest over the WHOLE tree -- every path
// and every byte. Addressing by it is what makes an upgrade safe: a muxterm
// carrying different bytes extracts to a different directory and can never be
// handed the previous version's script, or the previous version's bundle.
//
// Path and length are hashed alongside the content so that moving a byte from
// one file to the next, or renaming a file, changes the digest.
func embeddedSidecarDigest(paths []string) (string, error) {
	h := sha256.New()
	for _, p := range paths {
		data, err := embeddedSidecar.ReadFile(p)
		if err != nil {
			return "", err
		}
		fmt.Fprintf(h, "%s\x00%d\x00", p, len(data))
		h.Write(data)
	}
	return hex.EncodeToString(h.Sum(nil))[:16], nil
}

// ExtractEmbeddedSidecar materializes the embedded sidecar tree on disk and
// returns the path of the script within it. It is safe to call concurrently
// from any number of processes: each write goes to a per-process temp file in
// the destination directory and is then os.Rename'd into place, so a reader
// either sees no file or sees the whole file, never a torn one.
//
// Files already holding exactly these bytes are left alone, which is the
// common case after the first run.
func ExtractEmbeddedSidecar() (string, error) {
	paths, err := embeddedSidecarFiles()
	if err != nil {
		return "", fmt.Errorf("cos: could not read the embedded sidecar tree: %w", err)
	}
	digest, err := embeddedSidecarDigest(paths)
	if err != nil {
		return "", fmt.Errorf("cos: could not digest the embedded sidecar tree: %w", err)
	}
	root := filepath.Join(sidecarCacheDir(), digest)

	// The script is written LAST, so a caller that finds main.py present and
	// correct is looking at a tree whose other files were written first. That
	// ordering is the only thing standing between an interrupted extraction
	// and a sidecar booting against half a bundle.
	ordered := make([]string, 0, len(paths))
	for _, p := range paths {
		if p != sidecarScriptName {
			ordered = append(ordered, p)
		}
	}
	ordered = append(ordered, sidecarScriptName)

	for _, rel := range ordered {
		data, err := embeddedSidecar.ReadFile(rel)
		if err != nil {
			return "", fmt.Errorf("cos: could not read embedded %s: %w", rel, err)
		}
		// filepath.FromSlash: embed paths are always slash-separated.
		dest := filepath.Join(root, filepath.FromSlash(trimSidecarPrefix(rel)))
		if err := writeExtracted(dest, data); err != nil {
			return "", err
		}
	}
	return filepath.Join(root, "main.py"), nil
}

// trimSidecarPrefix strips the embed root so the extracted tree is laid out the
// same as internal/cos/sidecar/ itself -- main.py at the top, bundle/ beside
// it. main.py's own default-bundle lookup depends on that shape.
func trimSidecarPrefix(p string) string {
	const prefix = "sidecar/"
	if len(p) > len(prefix) && p[:len(prefix)] == prefix {
		return p[len(prefix):]
	}
	return p
}

// writeExtracted atomically materializes one file, skipping the write when the
// destination already holds these exact bytes.
//
// The content check is not just an optimization. The path is content-addressed,
// so anything already there SHOULD be right -- but a truncated write from an
// older muxterm, or a copy someone edited in place, would otherwise be reused
// forever.
func writeExtracted(path string, content []byte) error {
	if data, err := os.ReadFile(path); err == nil && bytes.Equal(data, content) {
		return nil
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return extractErr(dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".extract.*.tmp")
	if err != nil {
		return extractErr(dir, err)
	}
	tmpName := tmp.Name()
	// Best-effort cleanup covering every failure path below. After a
	// successful rename both calls are harmless no-ops.
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}()

	if _, err := tmp.Write(content); err != nil {
		return extractErr(tmpName, err)
	}
	// 0600 is deliberate: the script is handed to a python interpreter, never
	// exec'd directly, so it does not need the execute bit -- and neither does
	// anything else in the tree.
	if err := tmp.Chmod(0o600); err != nil {
		return extractErr(tmpName, err)
	}
	if err := tmp.Close(); err != nil {
		return extractErr(tmpName, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return extractErr(path, err)
	}
	return nil
}

// extractErr names the path that failed and points at the escape hatch, since
// the usual cause is a cache directory that is read-only or owned by someone
// else, and no amount of retrying will fix that.
func extractErr(path string, err error) error {
	return fmt.Errorf("cos: could not extract the embedded sidecar to %s: %w; "+
		"set %s to a readable copy of main.py to bypass extraction", path, err, EnvSidecar)
}
