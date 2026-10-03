package amplifierchat

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"fmt"
	"os"
	"path/filepath"
)

//go:embed sidecar/main.py sidecar/loop-live-requirements.txt
var sidecarFiles embed.FS

func extractSidecar() (string, error) {
	script, err := sidecarFiles.ReadFile("sidecar/main.py")
	if err != nil {
		return "", err
	}
	requirements, err := sidecarFiles.ReadFile("sidecar/loop-live-requirements.txt")
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(append(append([]byte{}, script...), requirements...))
	cache := os.Getenv("XDG_CACHE_HOME")
	if cache == "" {
		if home := os.Getenv("HOME"); home != "" {
			cache = filepath.Join(home, ".cache")
		} else {
			cache = os.TempDir()
		}
	}
	dir := filepath.Join(cache, "muxterm", "amplifier-chat", fmt.Sprintf("%x", digest[:8]))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	for name, data := range map[string][]byte{"main.py": script, "loop-live-requirements.txt": requirements} {
		path := filepath.Join(dir, name)
		if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, data) {
			continue
		}
		f, err := os.CreateTemp(dir, ".extract-*")
		if err != nil {
			return "", err
		}
		if _, err = f.Write(data); err == nil {
			err = f.Close()
		} else {
			_ = f.Close()
		}
		if err == nil {
			err = os.Rename(f.Name(), path)
		}
		_ = os.Remove(f.Name())
		if err != nil {
			return "", err
		}
	}
	return filepath.Join(dir, "main.py"), nil
}
