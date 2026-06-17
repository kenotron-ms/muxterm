package server

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

const githubReleaseAPI = "https://api.github.com/repos/kenotron-ms/muxterm/releases/latest"

// githubRelease is the subset of the GitHub releases API response we need.
type githubRelease struct {
	TagName string `json:"tag_name"`
	Body    string `json:"body"`
	Assets  []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	} `json:"assets"`
}

// FetchLatestRelease queries the GitHub releases API and returns the latest
// tag name, release notes body, and asset download URL for this platform.
// Returns empty strings (and a nil error) when the API request succeeds but
// no matching asset is found; returns a non-nil error on HTTP/JSON failure.
func FetchLatestRelease() (tag, notes, downloadURL string, err error) {
	client := &http.Client{Timeout: 15 * time.Second}
	req, _ := http.NewRequest("GET", githubReleaseAPI, nil)
	req.Header.Set("Accept", "application/vnd.github.v3+json")
	req.Header.Set("User-Agent", "muxterm-updater/1.0")

	resp, err := client.Do(req)
	if err != nil {
		return "", "", "", fmt.Errorf("fetch: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", "", "", fmt.Errorf("github API %d", resp.StatusCode)
	}

	var rel githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return "", "", "", fmt.Errorf("decode: %w", err)
	}

	assetName := fmt.Sprintf("muxterm_%s_%s.tar.gz", runtime.GOOS, runtime.GOARCH)
	for _, a := range rel.Assets {
		if a.Name == assetName {
			return rel.TagName, rel.Body, a.BrowserDownloadURL, nil
		}
	}
	return rel.TagName, rel.Body, "", nil // no matching asset for this platform
}

// handleUpdateCheck returns JSON describing the current and latest versions.
// Restricted to localhost callers.
//
//	GET /api/update-check
//	→ {"current":"v0.4.0","latest":"v0.5.0","updateAvailable":true,"releaseNotes":"..."}
func (s *Server) handleUpdateCheck(w http.ResponseWriter, r *http.Request) {
	if !IsLocalhost(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	current := s.version
	tag, notes, _, err := FetchLatestRelease()

	w.Header().Set("Content-Type", "application/json")
	if err != nil || tag == "" {
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"current":         current,
			"latest":          "",
			"updateAvailable": false,
			"releaseNotes":    "",
		})
		return
	}
	json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
		"current":         current,
		"latest":          tag,
		"updateAvailable": tag != current,
		"releaseNotes":    notes,
	})
}

// handleUpdate downloads the latest binary, replaces the install path, performs
// a sessiond handoff if the sessiondProto changed, then exits so the service
// manager can restart with the new binary. Restricted to localhost callers.
//
//	POST /api/update
//	→ {"ok":true,"version":"v0.5.0"}
func (s *Server) handleUpdate(w http.ResponseWriter, r *http.Request) {
	if !IsLocalhost(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if s.version == "dev" {
		http.Error(w, "update not available for dev builds", http.StatusBadRequest)
		return
	}

	// Resolve the current binary's real path (follow symlinks once).
	execPath, err := os.Executable()
	if err != nil {
		http.Error(w, fmt.Sprintf("executable path: %v", err), http.StatusInternalServerError)
		return
	}
	installPath, err := filepath.EvalSymlinks(execPath)
	if err != nil {
		installPath = execPath
	}

	// Fetch latest release metadata.
	tag, _, downloadURL, err := FetchLatestRelease()
	if err != nil {
		http.Error(w, fmt.Sprintf("fetch release: %v", err), http.StatusInternalServerError)
		return
	}
	if downloadURL == "" {
		http.Error(w, fmt.Sprintf("no release asset for %s/%s", runtime.GOOS, runtime.GOARCH), http.StatusNotFound)
		return
	}

	// Download archive to a temp file.
	tmpArchive := filepath.Join(os.TempDir(), fmt.Sprintf("muxterm-update-%s.tar.gz", tag))
	if err := downloadToFile(tmpArchive, downloadURL); err != nil {
		http.Error(w, fmt.Sprintf("download: %v", err), http.StatusInternalServerError)
		return
	}
	defer os.Remove(tmpArchive) //nolint:errcheck

	// Extract the muxterm binary from the archive.
	tmpBin := filepath.Join(os.TempDir(), fmt.Sprintf("muxterm-new-%s", tag))
	if err := extractBinaryFromTarGz(tmpArchive, tmpBin); err != nil {
		http.Error(w, fmt.Sprintf("extract: %v", err), http.StatusInternalServerError)
		return
	}
	defer os.Remove(tmpBin) //nolint:errcheck

	if err := os.Chmod(tmpBin, 0o755); err != nil {
		http.Error(w, fmt.Sprintf("chmod: %v", err), http.StatusInternalServerError)
		return
	}

	// Ask the new binary what its sessiondProto is.
	out, err := exec.Command(tmpBin, "version-json").Output()
	if err != nil {
		http.Error(w, fmt.Sprintf("version-json: %v", err), http.StatusInternalServerError)
		return
	}
	var newVersion struct {
		SessiondProto string `json:"sessiondProto"`
	}
	if err := json.Unmarshal(out, &newVersion); err != nil {
		http.Error(w, fmt.Sprintf("parse version-json: %v", err), http.StatusInternalServerError)
		return
	}

	// ATOMIC: rename new binary to install path. The old binary's inode is
	// still open (it is THIS process), so this process continues running
	// unaffected. The install path now points to the new binary.
	if err := os.Rename(tmpBin, installPath); err != nil {
		http.Error(w, fmt.Sprintf("rename: %v", err), http.StatusInternalServerError)
		return
	}

	// If the sessiond protocol version changed, perform a live state handoff
	// so PTY sessions survive without interruption.
	protoChanged := newVersion.SessiondProto != s.sessiondProto
	if protoChanged {
		log.Printf("muxterm update: sessiondProto changed (%s → %s), initiating handoff",
			s.sessiondProto, newVersion.SessiondProto)
		if err := startHandoff(installPath); err != nil {
			log.Printf("muxterm update: handoff failed: %v (sessions will restart)", err)
			// Non-fatal: sessions will reconnect after the new binary starts.
		}
	}

	// Respond before exiting so the browser receives the JSON reply.
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "version": tag}) //nolint:errcheck

	// Brief delay then exit — launchd/systemd restarts us with the new binary.
	go func() {
		time.Sleep(200 * time.Millisecond)
		log.Printf("muxterm update: exiting for service manager restart (new binary: %s %s)", tag, installPath)
		os.Exit(0)
	}()
}

// startHandoff launches the new binary in sessiond --handoff mode and waits
// for the new sessiond to take over the canonical Unix socket (up to 30s).
func startHandoff(installPath string) error {
	socketPath, err := sessiond.SocketPath()
	if err != nil {
		return fmt.Errorf("socket path: %w", err)
	}

	cmd := exec.Command(installPath, "sessiond", "--handoff")
	cmd.Stdout = os.Stderr // log subprocess output to our stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start: %w", err)
	}

	// Wait for the transition: old sessiond dies, new sessiond comes up.
	return waitForSessiondHandoff(socketPath, 30*time.Second)
}

// waitForSessiondHandoff waits for the sessiond canonical socket to transition
// through dead (old sessiond exited) and back to alive (new sessiond ready).
func waitForSessiondHandoff(socketPath string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)

	// Phase 1: wait for the old sessiond to die (IsAlive → false).
	if sessiond.IsAlive(socketPath) {
		for time.Now().Before(deadline) {
			if !sessiond.IsAlive(socketPath) {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
	}

	// Phase 2: wait for the new sessiond to come up (IsAlive → true).
	for time.Now().Before(deadline) {
		if sessiond.IsAlive(socketPath) {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("new sessiond did not become ready within %v", timeout)
}

// downloadToFile downloads url to destPath, overwriting any existing file.
func downloadToFile(destPath, url string) error {
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Get(url) //nolint:noctx
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download HTTP %d", resp.StatusCode)
	}

	f, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, resp.Body)
	return err
}

// extractBinaryFromTarGz opens the tar.gz at archivePath, finds the entry
// named "muxterm" (regardless of containing directory), and writes it to
// destPath. Returns an error if no such entry is found.
func extractBinaryFromTarGz(archivePath, destPath string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		if filepath.Base(hdr.Name) != "muxterm" {
			continue
		}
		out, err := os.Create(destPath)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, tr); err != nil {
			out.Close()
			return err
		}
		return out.Close()
	}
	return fmt.Errorf("muxterm binary not found in archive %s", archivePath)
}
