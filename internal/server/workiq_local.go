package server

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha512"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// The official npm package includes native executables, so this installation
// does not need npm, Node, or a process-wide PATH change.
const (
	workIQVersion   = "1.0.1"
	workIQTarball   = "https://registry.npmjs.org/@microsoft/workiq/-/workiq-1.0.1.tgz"
	workIQIntegrity = "syOh4Py5hR3rh7kRHzYipxU2tJMzUfu7VBJ5bTzXCEh2S0BXVCZVu6TWmFYMmkTk8QEreMaqPMWQEy4aMBd/Xg=="
)

var workIQInstallMu sync.Mutex

func workIQLocalMarker() string {
	return filepath.Join(sdkDataDir(), "connections", "workiq-local-enabled")
}

func workIQPackageBinary() (string, error) {
	arch := runtime.GOARCH
	if arch != "amd64" && arch != "arm64" {
		return "", fmt.Errorf("Work IQ does not support %s/%s", runtime.GOOS, arch)
	}
	suffix := map[string]string{"amd64": "x64", "arm64": "arm64"}[arch]
	switch runtime.GOOS {
	case "linux":
		return "package/bin/linux-" + suffix + "/workiq", nil
	case "darwin":
		return "package/bin/osx-" + suffix + "/workiq", nil
	case "windows":
		return "package/bin/win-" + suffix + "/workiq.exe", nil
	default:
		return "", fmt.Errorf("Work IQ does not support %s/%s", runtime.GOOS, arch)
	}
}

func workIQBinaryPath() string {
	name := "workiq"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(sdkDataDir(), "dependencies", "workiq", workIQVersion, runtime.GOOS+"-"+runtime.GOARCH, name)
}

func installedWorkIQBinary() string {
	path := workIQBinaryPath()
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm()&0100 == 0) {
		return ""
	}
	return path
}

func workIQEnabledBinary() string {
	data, err := os.ReadFile(workIQLocalMarker())
	if err != nil || strings.TrimSpace(string(data)) != workIQBinaryPath() {
		return ""
	}
	return installedWorkIQBinary()
}

func installWorkIQ(ctx context.Context) (string, error) {
	workIQInstallMu.Lock()
	defer workIQInstallMu.Unlock()
	if path := installedWorkIQBinary(); path != "" {
		return path, nil
	}
	selected, err := workIQPackageBinary()
	if err != nil {
		return "", err
	}
	parent := filepath.Dir(workIQBinaryPath())
	if err := os.MkdirAll(parent, 0700); err != nil {
		return "", fmt.Errorf("create Work IQ data directory: %w", err)
	}
	// Stage the download and selected binary on the destination filesystem.
	archive, err := os.CreateTemp(parent, ".workiq-download-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(archive.Name())
	defer archive.Close()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, workIQTarball, nil)
	if err != nil {
		return "", err
	}
	response, err := (&http.Client{Timeout: 5 * time.Minute}).Do(request)
	if err != nil {
		return "", fmt.Errorf("download Work IQ: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download Work IQ: npm registry returned %s", response.Status)
	}
	const maxArchive = 160 << 20
	digest := sha512.New()
	n, err := io.Copy(io.MultiWriter(archive, digest), io.LimitReader(response.Body, maxArchive+1))
	if err != nil {
		return "", fmt.Errorf("download Work IQ: %w", err)
	}
	if n > maxArchive || base64.StdEncoding.EncodeToString(digest.Sum(nil)) != workIQIntegrity {
		return "", errors.New("Work IQ package failed its pinned integrity check")
	}
	if _, err := archive.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	compressed, err := gzip.NewReader(archive)
	if err != nil {
		return "", fmt.Errorf("read Work IQ package: %w", err)
	}
	defer compressed.Close()
	reader := tar.NewReader(compressed)
	staged, err := os.CreateTemp(parent, ".workiq-binary-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(staged.Name())
	defer staged.Close()
	found := false
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", fmt.Errorf("read Work IQ package: %w", err)
		}
		if header.Name != selected {
			continue
		}
		if found || header.Typeflag != tar.TypeReg || header.Size <= 0 || header.Size > 100<<20 {
			return "", errors.New("Work IQ package has an invalid platform binary")
		}
		if _, err := io.CopyN(staged, reader, header.Size); err != nil {
			return "", fmt.Errorf("extract Work IQ binary: %w", err)
		}
		found = true
	}
	if !found {
		return "", errors.New("Work IQ package does not contain this platform's binary")
	}
	if err := staged.Chmod(0700); err != nil {
		return "", err
	}
	if err := staged.Sync(); err != nil {
		return "", err
	}
	if err := staged.Close(); err != nil {
		return "", err
	}
	path := workIQBinaryPath()
	if err := os.Rename(staged.Name(), path); err != nil {
		return "", fmt.Errorf("install Work IQ binary: %w", err)
	}
	return path, nil
}

func (s *Server) handleWorkIQLocal(w http.ResponseWriter, r *http.Request) {
	marker := workIQLocalMarker()
	if _, err := os.Stat(marker); err != nil && !errors.Is(err, os.ErrNotExist) {
		http.Error(w, "Microsoft connection settings could not be read", http.StatusInternalServerError)
		return
	}
	switch r.Method {
	case http.MethodPost:
		path, err := installWorkIQ(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		if err := os.MkdirAll(filepath.Dir(marker), 0700); err != nil {
			http.Error(w, "Microsoft connection settings could not be saved", http.StatusInternalServerError)
			return
		}
		staged, err := os.CreateTemp(filepath.Dir(marker), ".workiq-marker-*")
		if err != nil {
			http.Error(w, "Microsoft connection settings could not be saved", http.StatusInternalServerError)
			return
		}
		defer os.Remove(staged.Name())
		if _, err = staged.WriteString(path + "\n"); err == nil {
			err = staged.Chmod(0600)
		}
		if closeErr := staged.Close(); err == nil {
			err = closeErr
		}
		if err == nil {
			err = os.Rename(staged.Name(), marker)
		}
		if err != nil {
			http.Error(w, "Microsoft connection settings could not be saved", http.StatusInternalServerError)
			return
		}
	case http.MethodDelete:
		if err := os.Remove(marker); err != nil && !errors.Is(err, os.ErrNotExist) {
			http.Error(w, "Microsoft connection settings could not be removed", http.StatusInternalServerError)
			return
		}
	}
	writeSDKJSON(w, http.StatusOK, map[string]any{
		"installed": installedWorkIQBinary() != "",
		"enabled":   workIQEnabledBinary() != "",
		"command":   installedWorkIQBinary(),
	})
}
