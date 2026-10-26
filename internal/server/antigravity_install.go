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

const antigravityACPVersion = "1.4.3"
const antigravityACPURL = "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.3-linux-x86_64.zip"
const antigravityACPSHA256 = "0634ce5306ba92c932945455e7a83fda78e2d99c33fa8aa6ee0566206a382714"

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
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		return errors.New("automatic Antigravity ACP installation currently supports Linux x86-64")
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
	if _, err := os.Stat(dest); err == nil {
		return errors.New("incomplete Antigravity installation already exists")
	}
	tmp, err := os.MkdirTemp(filepath.Dir(dest), ".download-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, antigravityACPURL, nil)
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
	if hex.EncodeToString(hash.Sum(nil)) != antigravityACPSHA256 {
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
	if err := os.Rename(tmp, dest); err != nil {
		return err
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
