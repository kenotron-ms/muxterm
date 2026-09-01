package update

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

const (
	// maxAssetBytes caps a downloaded tarball and maxBinaryBytes caps the
	// binary extracted from it. Both exist so a hostile or corrupt archive
	// cannot fill the disk holding the running binary.
	maxAssetBytes  = 256 << 20
	maxBinaryBytes = 256 << 20

	// maxChecksumBytes caps checksums.txt, which is a few hundred bytes.
	maxChecksumBytes = 1 << 20
)

// downloadClient fetches release assets. Its timeout is deliberately far
// larger than apiClient's: the tarball is tens of megabytes and a 15s budget
// would fail on any slow link.
var downloadClient = &http.Client{Timeout: 10 * time.Minute}

// Apply downloads, verifies, and installs the given release over the running
// binary. It does NOT restart the process -- see Restart.
//
// The new binary is written to a temp file beside the current executable and
// then renamed over it, so the swap is atomic and same-filesystem. Renaming
// over a running binary is safe on Linux and macOS: the running process keeps
// its original inode until it exits.
func Apply(ctx context.Context, rel *Release) error {
	if rel == nil {
		return errors.New("no release to apply")
	}

	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate running binary: %w", err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return fmt.Errorf("resolve running binary path %s: %w", exe, err)
	}
	dir := filepath.Dir(exe)

	asset := AssetName()
	assetURL, ok := rel.Assets[asset]
	if !ok {
		return fmt.Errorf("release %s has no asset %q", rel.Tag, asset)
	}
	sumsURL, ok := rel.Assets[checksumsAsset]
	if !ok {
		return fmt.Errorf("release %s has no asset %q", rel.Tag, checksumsAsset)
	}

	// Download the tarball beside the target binary so the final rename stays
	// on one filesystem, hashing as it streams rather than buffering in memory.
	tmpTar, err := os.CreateTemp(dir, ".muxterm-update-*")
	if err != nil {
		return fmt.Errorf("create temp file in %s: %w", dir, err)
	}
	tarPath := tmpTar.Name()
	defer func() { _ = os.Remove(tarPath) }()
	defer func() { _ = tmpTar.Close() }()

	got, err := downloadAndHash(ctx, assetURL, tmpTar)
	if err != nil {
		return fmt.Errorf("download %s: %w", asset, err)
	}
	if err := tmpTar.Close(); err != nil {
		return fmt.Errorf("write %s: %w", asset, err)
	}

	want, err := fetchChecksum(ctx, sumsURL, asset)
	if err != nil {
		return err
	}
	if !strings.EqualFold(want, got) {
		return fmt.Errorf("checksum mismatch for %s: manifest has %s, download hashed to %s", asset, want, got)
	}

	tmpBin, err := extractBinary(tarPath, dir)
	if err != nil {
		return err
	}
	// After a successful rename this path no longer exists and Remove is a
	// harmless no-op; on any failure below it cleans up the extracted binary.
	defer func() { _ = os.Remove(tmpBin) }()

	if err := os.Rename(tmpBin, exe); err != nil {
		return fmt.Errorf("install new binary over %s: %w", exe, err)
	}
	return nil
}

// downloadAndHash streams url into dst and returns the hex sha256 of the bytes
// written. Nothing is buffered in memory.
func downloadAndHash(ctx context.Context, url string, dst io.Writer) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}
	resp, err := downloadClient.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return "", fmt.Errorf("unexpected status %s", resp.Status)
	}

	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(dst, h), io.LimitReader(resp.Body, maxAssetBytes))
	if err != nil {
		return "", fmt.Errorf("copy body: %w", err)
	}
	if n >= maxAssetBytes {
		return "", fmt.Errorf("asset exceeds %d bytes", int64(maxAssetBytes))
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// fetchChecksum downloads a sha256sum-format manifest and returns the digest
// recorded for asset. Lines are "<sha256>  <filename>".
func fetchChecksum(ctx context.Context, url, asset string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", fmt.Errorf("build %s request: %w", checksumsAsset, err)
	}
	resp, err := downloadClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("download %s: %w", checksumsAsset, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return "", fmt.Errorf("download %s: unexpected status %s", checksumsAsset, resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxChecksumBytes))
	if err != nil {
		return "", fmt.Errorf("read %s: %w", checksumsAsset, err)
	}

	for _, line := range strings.Split(string(body), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[1] == asset {
			return fields[0], nil
		}
	}
	return "", fmt.Errorf("%s has no entry for %s", checksumsAsset, asset)
}

// extractBinary pulls the muxterm binary out of a .tar.gz into a temp file in
// destDir, marks it executable, and returns its path. The caller owns cleanup.
func extractBinary(tarPath, destDir string) (string, error) {
	f, err := os.Open(tarPath)
	if err != nil {
		return "", fmt.Errorf("open downloaded archive: %w", err)
	}
	defer func() { _ = f.Close() }()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return "", fmt.Errorf("read gzip archive: %w", err)
	}
	defer func() { _ = gz.Close() }()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", fmt.Errorf("read tar archive: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg || unsafeTarPath(hdr.Name) {
			continue
		}
		if filepath.Base(filepath.FromSlash(hdr.Name)) != binaryName {
			continue
		}

		out, err := os.CreateTemp(destDir, ".muxterm-update-bin-*")
		if err != nil {
			return "", fmt.Errorf("create temp file in %s: %w", destDir, err)
		}
		outPath := out.Name()
		n, copyErr := io.Copy(out, io.LimitReader(tr, maxBinaryBytes))
		closeErr := out.Close()
		switch {
		case copyErr != nil:
			_ = os.Remove(outPath)
			return "", fmt.Errorf("extract %s: %w", binaryName, copyErr)
		case closeErr != nil:
			_ = os.Remove(outPath)
			return "", fmt.Errorf("write %s: %w", binaryName, closeErr)
		case n >= maxBinaryBytes:
			_ = os.Remove(outPath)
			return "", fmt.Errorf("extract %s: exceeds %d bytes", binaryName, int64(maxBinaryBytes))
		}
		if err := os.Chmod(outPath, 0o755); err != nil {
			_ = os.Remove(outPath)
			return "", fmt.Errorf("chmod %s: %w", outPath, err)
		}
		return outPath, nil
	}
	return "", fmt.Errorf("archive does not contain a %q binary", binaryName)
}

// unsafeTarPath reports whether a tar entry name is absolute or contains a
// ".." component. Nothing here joins entry names onto a directory, but a
// traversal-shaped entry is evidence of a hostile archive, so it is skipped.
func unsafeTarPath(name string) bool {
	if strings.HasPrefix(name, "/") {
		return true
	}
	for _, part := range strings.Split(filepath.ToSlash(name), "/") {
		if part == ".." {
			return true
		}
	}
	return false
}

// Restart replaces or restarts the running process so the new binary takes
// effect, and -- when restore says the running daemon will restore its panes --
// restarts sessiond alongside it so the user is not left on a new web binary
// talking to an old daemon.
//
// A clean os.Exit(0) is NOT a viable restart: the systemd user unit
// muxterm.service is Restart=on-failure, so a zero exit status stops the
// service rather than bringing it back on the new binary.
//
// restore comes from CheckRestoreCapability. A !restore.OK daemon is left strictly
// alone: restarting one that cannot restore destroys every pane with nothing
// to bring back, which is far worse than a version-skewed daemon.
func Restart(restore RestoreCapability) error {
	if os.Getenv("INVOCATION_ID") != "" {
		// Running under systemd (INVOCATION_ID is set for every unit it
		// starts -- the same detection sessiond uses). `systemctl --user
		// restart muxterm` is the verb install.sh already relies on for
		// upgrades. Start it detached and do not Wait: the restart kills this
		// process, so Wait would never return.
		args := []string{"--user", "restart", "muxterm"}
		if restore.OK {
			// One invocation for both units, not two: muxterm.service
			// declares After=muxterm-sessiond.service, so systemd orders the
			// daemon ahead of the web unit itself. Two separate commands
			// could not guarantee that -- this process dies partway through.
			args = []string{"--user", "restart", "muxterm-sessiond.service", "muxterm.service"}
		} else {
			log.Printf("update: leaving sessiond running: %s", restore.Reason)
		}
		cmd := exec.Command("systemctl", args...)
		if err := cmd.Start(); err != nil {
			return fmt.Errorf("systemctl %s: %w", strings.Join(args, " "), err)
		}
		return nil
	}

	// Not under systemd: re-exec the new binary in place, preserving argv and
	// the environment. A successful Exec never returns.
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate running binary: %w", err)
	}

	// The daemon is restarted BEFORE the exec because syscall.Exec replaces
	// this process image: there is no "after" for code to run in. A failure
	// is logged and deliberately does not abort the re-exec -- stranding the
	// user on the old web binary is worse than leaving the old daemon up.
	if restore.OK {
		if err := restartSessiond(); err != nil {
			log.Printf("update: restart sessiond: %v", err)
		}
	} else {
		log.Printf("update: leaving sessiond running: %s", restore.Reason)
	}

	if err := syscall.Exec(exe, os.Args, os.Environ()); err != nil {
		return fmt.Errorf("re-exec %s: %w", exe, err)
	}
	return nil
}

// restartSessiond resolves the daemon's socket and log paths and hands off to
// sessiond.RestartDaemon.
//
// The 20s budget covers a slow shutdown snapshot (every pane's scrollback is
// serialized before the daemon exits) while staying well inside the browser's
// 60s update poll, so a stuck daemon still leaves time for the web process to
// come back up on the new binary.
func restartSessiond() error {
	sock, err := sessiond.SocketPath()
	if err != nil {
		return fmt.Errorf("resolve sessiond socket path: %w", err)
	}
	logPath, err := sessiond.DefaultLogPath()
	if err != nil {
		return fmt.Errorf("resolve sessiond log path: %w", err)
	}
	return sessiond.RestartDaemon(sock, logPath, 20*time.Second)
}
