package server

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

// Pinned to the official ACP registry's antigravity-acp/agent.json release.
const antigravityACPVersion = "1.5.0"
const antigravityPreviousACPVersion = "1.4.3"

type antigravityArchive struct {
	url    string
	sha256 string
}

var antigravityArchives = map[string]antigravityArchive{
	"linux/amd64":  {"https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.5.0-linux-x86_64.zip", "36f373e8948edf1727b39c7d62b5722d6a4474bdfd72b04ad3d6def571808c9f"},
	"linux/arm64":  {"https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.5.0-linux-arm64.zip", "1e184f439477b54138e94440056b26a78c0a8075a8fd2ffda637ec31267c6459"},
	"darwin/amd64": {"https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.5.0-darwin-x86_64.zip", "86a94e33b25d4a38ff30526ad844546860aa9ed98698498d9e87d30eb794426e"},
	"darwin/arm64": {"https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.5.0-darwin-arm64.zip", "c82ecb4ef476bfc35cbe5b2745cdddef873b99c9f5bd7fd11e5ca1fc1667a3fc"},
}

func antigravityArchiveFor(goos, goarch string) (antigravityArchive, bool) {
	archive, ok := antigravityArchives[goos+"/"+goarch]
	return archive, ok
}

const antigravityUnsupportedReason = "Automatic Antigravity installation supports Linux and macOS on x86-64 and ARM64; install the ACP registry agent manually on this platform."

var antigravityInstallMu sync.Mutex

func antigravityManagedDir() (string, error) {
	path, err := antigravityModePath()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(path), "antigravity-acp", antigravityACPVersion), nil
}

func antigravityInstalled(dir string) bool {
	for _, name := range []string{"agy_acp_server.par", "localharness_external"} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil || !info.Mode().IsRegular() || info.Mode()&0111 == 0 {
			return false
		}
	}
	return true
}

func installAntigravityACP(ctx context.Context) error {
	artifact, supported := antigravityArchiveFor(runtime.GOOS, runtime.GOARCH)
	if !supported {
		return errors.New(antigravityUnsupportedReason)
	}
	antigravityInstallMu.Lock()
	defer antigravityInstallMu.Unlock()
	dest, err := antigravityManagedDir()
	if err != nil {
		return err
	}
	if antigravityInstalled(dest) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(filepath.Dir(dest), ".download-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, artifact.url, nil)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 3 * time.Minute}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("download Antigravity ACP: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("download Antigravity ACP: HTTP %d", response.StatusCode)
	}
	archive, err := os.Create(filepath.Join(tmp, "agent.zip"))
	if err != nil {
		return err
	}
	hash := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(archive, hash), io.LimitReader(response.Body, 500<<20))
	closeErr := archive.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if size >= 500<<20 {
		return errors.New("Antigravity ACP archive exceeds size limit")
	}
	if hex.EncodeToString(hash.Sum(nil)) != artifact.sha256 {
		return errors.New("Antigravity ACP archive checksum mismatch")
	}
	reader, err := zip.OpenReader(filepath.Join(tmp, "agent.zip"))
	if err != nil {
		return err
	}
	defer reader.Close()
	seen := map[string]bool{}
	for _, file := range reader.File {
		if file.Name != "agy_acp_server.par" && file.Name != "localharness_external" {
			return errors.New("Antigravity ACP archive contains an unexpected file")
		}
		if seen[file.Name] {
			return errors.New("Antigravity ACP archive contains duplicate files")
		}
		seen[file.Name] = true
		if file.UncompressedSize64 > 1<<30 {
			return errors.New("Antigravity ACP file exceeds size limit")
		}
		source, err := file.Open()
		if err != nil {
			return err
		}
		target, err := os.OpenFile(filepath.Join(tmp, file.Name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
		if err != nil {
			source.Close()
			return err
		}
		_, copyErr := io.CopyN(target, source, int64(file.UncompressedSize64))
		closeErr := target.Close()
		source.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if !seen["agy_acp_server.par"] || !seen["localharness_external"] {
		return errors.New("Antigravity ACP archive is incomplete")
	}
	if err := os.Remove(filepath.Join(tmp, "agent.zip")); err != nil {
		return err
	}
	// A valid installation was returned above. Preserve any incomplete directory
	// until the verified replacement is ready, and restore it if rename fails.
	backup := ""
	if _, err := os.Lstat(dest); err == nil {
		backup, err = os.MkdirTemp(filepath.Dir(dest), ".incomplete-*")
		if err != nil {
			return fmt.Errorf("prepare Antigravity replacement: %w", err)
		}
		if err := os.Remove(backup); err != nil {
			return fmt.Errorf("prepare Antigravity replacement: %w", err)
		}
		if err := os.Rename(dest, backup); err != nil {
			return fmt.Errorf("prepare Antigravity replacement: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.Rename(tmp, dest); err != nil {
		if backup != "" {
			if restoreErr := os.Rename(backup, dest); restoreErr != nil {
				return fmt.Errorf("install Antigravity: %w; restore incomplete installation: %v", err, restoreErr)
			}
		}
		return err
	}
	if backup != "" {
		_ = os.RemoveAll(backup)
	}
	return nil
}

func (s *Server) handleAntigravityInstall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	if err := installAntigravityACP(ctx); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeSDKJSON(w, http.StatusOK, map[string]any{"installed": true})
}
