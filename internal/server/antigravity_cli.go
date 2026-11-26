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
const antigravityCLIVersion = "1.5.15"

type antigravityCLIArchive struct{ url, sha512 string }

var antigravityCLIArchives = map[string]antigravityCLIArchive{
	"linux/amd64":  {"https://github.com/google-antigravity/antigravity-cli/releases/download/1.5.15/agy_cli_linux_x64.tar.gz", "af3f0be58b8475940d79f9abea19e762ecc3d265ea9f56cff8dd805e27ba299b44a305a79504a7ffe6ebdfa29a294c56edc4caed1875990bfaf2fef1508ec8b0"},
	"linux/arm64":  {"https://github.com/google-antigravity/antigravity-cli/releases/download/1.5.15/agy_cli_linux_arm64.tar.gz", "d64ad759781b50dfacfa7d9826c0ad469959d01bdf5a170acd4c83472eba31c677baf0052ac8ab48eef40f0d3f0e26057e752aabd24331c79f4c881d4b872125"},
	"darwin/amd64": {"https://github.com/google-antigravity/antigravity-cli/releases/download/1.5.15/agy_cli_mac_x64.tar.gz", "2276e0f189a917e7eaa4b00ece59fe6a1062914472e13247f402b56fe26c9afacd0af494476e31a5610fb0b273400ca4013f273d56d69c6fdd7e2d0ec933f596"},
	"darwin/arm64": {"https://github.com/google-antigravity/antigravity-cli/releases/download/1.5.15/agy_cli_mac_arm64.tar.gz", "b03a841eb3a29be918a66960b775f68ed4f3bcc02f33962131bbbc26c46ea983ceac6c832ad46efd11d73d9a2cb97df4ab24d4bc92ee47d3d5ece7b8d8b61235"},
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
	return antigravityCLIMatchesVersion(antigravityCLIPath())
}

func antigravityCLIMatchesVersion(command string) bool {
	path, err := exec.LookPath(command)
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
	managed := filepath.Join(dest, "agy")
	if antigravityCLIMatchesVersion(managed) {
		return exposeAntigravityCLI(managed)
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
	if err := os.Rename(tmp, dest); err != nil {
		return err
	}
	return exposeAntigravityCLI(managed)
}

// Publish the managed executable at Google's standard Unix CLI location,
// preserving existing commands and every kind of existing directory entry.
func exposeAntigravityCLI(managed string) error {
	if _, err := exec.LookPath("agy"); err == nil {
		return nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	bin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(bin, 0755); err != nil {
		return err
	}
	if err := os.Symlink(managed, filepath.Join(bin, "agy")); err != nil && !errors.Is(err, os.ErrExist) {
		return fmt.Errorf("expose Antigravity CLI in %s: %w", bin, err)
	}
	return nil
}
