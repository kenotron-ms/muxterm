package server

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// This exact CLI release was verified with concurrent ACP prompts and /goal.
// New versions fail closed until their behavior is checked again.
const antigravityCLIVersion = "1.5.14"

type antigravityCLIArchive struct{ url, sha512 string }

var antigravityCLIArchives = map[string]antigravityCLIArchive{
	"linux/amd64":  {"https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/linux-x64/cli_linux_x64.tar.gz", "83311d3f354567612dc16c1ae2ea9b503d6f6833aa4e138d39aa229da3f3bb99b0e4d7cca0bce4796b0060d6a51d8113eb7449ed5dc0e7900bf217107ea5bff9"},
	"linux/arm64":  {"https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/linux-arm/cli_linux_arm64.tar.gz", "c9b29bba475f63a1a80161ae93ba72b221c7a586d9851e4d0061546704bab66d6b2760b25d716d191724fc7564f3246456ee151e28aa37af48dbcd72bdc6c463"},
	"darwin/amd64": {"https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/darwin-x64/cli_mac_x64.tar.gz", "1b6a1fc6dbe46ba6d9d0405d1b6095189f35ebfc4c3c33ceb1fd1b6d0c9fd702b52ac10b64b8b52aed0d8d71ae02c5df3cffd5e3e3d37549c2daffcce2a853c7"},
	"darwin/arm64": {"https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/darwin-arm/cli_mac_arm64.tar.gz", "26830fd46bfb9200d073cf3e71bf94b707552557b4380ec01afd6e99f3a2b030e65422dab1867f77318078692defc859a7547d17ec4b0b1e9369f13c9c3caea6"},
}

func antigravityCLIManagedDir() (string, error) {
	path, err := antigravityModePath()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(path), "antigravity-cli", antigravityCLIVersion, runtime.GOOS+"-"+runtime.GOARCH), nil
}

func antigravityCLIPath() string {
	if command := os.Getenv("MUXTERM_ACP_ANTIGRAVITY_COMMAND"); command != "" {
		return command
	}
	if dir, err := antigravityCLIManagedDir(); err == nil {
		path := filepath.Join(dir, "agy")
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && info.Mode()&0111 != 0 && antigravityBinaryMatchesHost(path) {
			return path
		}
	}
	if path, err := exec.LookPath("agy"); err == nil {
		return path
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".local", "bin", "agy")
	}
	return "agy"
}

func antigravityCLIAvailable() bool {
	path, err := exec.LookPath(antigravityCLIPath())
	if err != nil || !antigravityBinaryMatchesHost(path) {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, path, "--version").Output()
	return err == nil && strings.TrimSpace(string(output)) == antigravityCLIVersion
}

func installAntigravityCLI(ctx context.Context) error {
	artifact, ok := antigravityCLIArchives[runtime.GOOS+"/"+runtime.GOARCH]
	if !ok {
		return errors.New("automatic Antigravity CLI installation supports Linux and macOS on x86-64 and ARM64")
	}
	antigravityInstallMu.Lock()
	defer antigravityInstallMu.Unlock()
	dest, err := antigravityCLIManagedDir()
	if err != nil {
		return err
	}
	if info, err := os.Stat(filepath.Join(dest, "agy")); err == nil && info.Mode().IsRegular() && info.Mode()&0111 != 0 && antigravityCLIAvailable() {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(filepath.Dir(dest), ".cli-download-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, artifact.url, nil)
	if err != nil {
		return err
	}
	response, err := (&http.Client{Timeout: 3 * time.Minute}).Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("download Antigravity CLI: HTTP %d", response.StatusCode)
	}
	archivePath := filepath.Join(tmp, "cli.tar.gz")
	file, err := os.Create(archivePath)
	if err != nil {
		return err
	}
	hash := sha512.New()
	size, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, 500<<20))
	closeErr := file.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if size >= 500<<20 {
		return errors.New("Antigravity CLI archive exceeds size limit")
	}
	if hex.EncodeToString(hash.Sum(nil)) != artifact.sha512 {
		return errors.New("Antigravity CLI archive checksum mismatch")
	}
	file, err = os.Open(archivePath)
	if err != nil {
		return err
	}
	defer file.Close()
	compressed, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer compressed.Close()
	reader := tar.NewReader(compressed)
	header, err := reader.Next()
	if err != nil {
		return err
	}
	if header.Name != "antigravity" || header.Typeflag != tar.TypeReg || header.Size <= 0 || header.Size > 1<<30 {
		return errors.New("unexpected Antigravity CLI archive")
	}
	targetPath := filepath.Join(tmp, "agy")
	target, err := os.OpenFile(targetPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		return err
	}
	_, copyErr = io.CopyN(target, reader, header.Size)
	closeErr = target.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if _, err := reader.Next(); err != io.EOF {
		if err != nil {
			return fmt.Errorf("reading Antigravity CLI archive: %w", err)
		}
		return errors.New("unexpected additional Antigravity CLI archive file")
	}
	if !antigravityBinaryMatchesHost(targetPath) {
		return errors.New("Antigravity CLI binary does not match this host")
	}
	if err := os.Remove(archivePath); err != nil {
		return err
	}
	if _, err := os.Lstat(dest); err == nil {
		if err := os.RemoveAll(dest); err != nil {
			return fmt.Errorf("removing unusable Antigravity CLI install: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.Rename(tmp, dest)
}
