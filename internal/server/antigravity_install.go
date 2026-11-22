package server

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"debug/elf"
	"debug/macho"
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

// Pinned to the official ACP registry's antigravity-acp/agent.json at
// e29b5bf3bfd8756db5d901690b43dc31e926ccd5.
const antigravityACPVersion = "1.5.2"

var antigravityManagedVersions = []string{antigravityACPVersion, "1.5.0", "1.4.3"}

type antigravityArchive struct {
	url    string
	sha256 string
}

var antigravityArchives = map[string]antigravityArchive{
	"linux/amd64":  {"https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.5.2-linux-x86_64.zip", "99dd8612450805011619d7b8447ce374c289e00549d8557f36790e1dd6256852"},
	"linux/arm64":  {"https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.5.2-linux-arm64.zip", "e729e05ef54ef0763e48900032466b47fa7c9939cde257f93ba49410ab577acb"},
	"darwin/amd64": {"https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.5.2-darwin-x86_64.zip", "92addb5580577b5356d35484d72d1a113d9c5312ad766bcb304983aa8e3fbb06"},
	"darwin/arm64": {"https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.5.2-darwin-arm64.zip", "123a16d5c40a8ac99e20f01a62b68dd860fd96b1c528dfb8eaa37ca8733d4845"},
}

func antigravityArchiveFor(goos, goarch string) (antigravityArchive, bool) {
	archive, ok := antigravityArchives[goos+"/"+goarch]
	return archive, ok
}

const antigravityUnsupportedReason = "Automatic Antigravity installation supports Linux and macOS on x86-64 and ARM64; install agy 1.5.14 manually on this platform."

var antigravityInstallMu sync.Mutex

func antigravityManagedDir() (string, error) {
	path, err := antigravityModePath()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(path), "antigravity-acp", antigravityACPVersion, runtime.GOOS+"-"+runtime.GOARCH), nil
}

func antigravityInstalled(dir string) bool {
	for _, name := range []string{"agy_acp_server.par", "localharness_external"} {
		path := filepath.Join(dir, name)
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&0111 == 0 || !antigravityBinaryMatchesHost(path) {
			return false
		}
	}
	return true
}

// Check one managed executable against this process's platform. Legacy installs
// have no platform component in their path, so file presence alone is unsafe.
func antigravityBinaryMatchesHost(path string) bool {
	switch runtime.GOOS {
	case "linux":
		file, err := elf.Open(path)
		if err != nil {
			return false
		}
		defer file.Close()
		return (runtime.GOARCH == "amd64" && file.Machine == elf.EM_X86_64) ||
			(runtime.GOARCH == "arm64" && file.Machine == elf.EM_AARCH64)
	case "darwin":
		cpu := macho.CpuAmd64
		if runtime.GOARCH == "arm64" {
			cpu = macho.CpuArm64
		} else if runtime.GOARCH != "amd64" {
			return false
		}
		if file, err := macho.Open(path); err == nil {
			defer file.Close()
			return file.Cpu == cpu
		}
		file, err := macho.OpenFat(path)
		if err != nil {
			return false
		}
		defer file.Close()
		for _, arch := range file.Arches {
			if arch.Cpu == cpu {
				return true
			}
		}
	}
	return false
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
	if err := installAntigravityCLI(ctx); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeSDKJSON(w, http.StatusOK, map[string]any{"installed": true})
}
