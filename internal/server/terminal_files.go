package server

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The terminal explorer is local and read-only. os.Root keeps every requested
// path inside the serve process's home directory, including through symlinks.
func terminalHomeRoot() (*os.Root, bool) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return nil, false
	}
	root, err := os.OpenRoot(home)
	return root, err == nil
}

func terminalRelativePath(r *http.Request) (string, bool) {
	path := r.URL.Query().Get("path")
	if path == "" {
		return ".", true
	}
	return path, filepath.IsLocal(path)
}

func (s *Server) handleTerminalFiles(w http.ResponseWriter, r *http.Request) {
	root, ok := terminalHomeRoot()
	if !ok {
		http.Error(w, "Home folder unavailable", http.StatusNotFound)
		return
	}
	defer root.Close()
	path, ok := terminalRelativePath(r)
	if !ok {
		http.Error(w, "Invalid folder path", http.StatusBadRequest)
		return
	}
	dir, err := root.Open(path)
	if err != nil {
		http.Error(w, "Folder unavailable", http.StatusNotFound)
		return
	}
	defer dir.Close()
	info, err := dir.Stat()
	if err != nil || !info.IsDir() {
		http.Error(w, "Folder unavailable", http.StatusNotFound)
		return
	}
	entries, err := dir.ReadDir(500)
	if err != nil && !errors.Is(err, io.EOF) {
		http.Error(w, "Folder unavailable", http.StatusInternalServerError)
		return
	}
	type row struct {
		Name string `json:"name"`
		Dir  bool   `json:"dir"`
		Size int64  `json:"size"`
	}
	rows := make([]row, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		child, err := root.Open(filepath.Join(path, name))
		if err != nil {
			continue
		}
		stat, err := child.Stat()
		child.Close()
		if err != nil || (!stat.IsDir() && !stat.Mode().IsRegular()) {
			continue
		}
		rows = append(rows, row{Name: name, Dir: stat.IsDir(), Size: stat.Size()})
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Dir != rows[j].Dir {
			return rows[i].Dir
		}
		return strings.ToLower(rows[i].Name) < strings.ToLower(rows[j].Name)
	})
	truncated := false
	if len(entries) == 500 {
		more, readErr := dir.ReadDir(1)
		truncated = readErr == nil && len(more) > 0
	}
	w.Header().Set("Cache-Control", "no-store")
	writeArtifactJSON(w, http.StatusOK, map[string]any{"path": path, "entries": rows, "truncated": truncated})
}

const terminalPreviewLimit = 256 << 10

func (s *Server) handleTerminalFile(w http.ResponseWriter, r *http.Request) {
	root, ok := terminalHomeRoot()
	if !ok {
		http.Error(w, "Home folder unavailable", http.StatusNotFound)
		return
	}
	defer root.Close()
	path, ok := terminalRelativePath(r)
	if !ok || path == "." {
		http.Error(w, "Invalid file path", http.StatusBadRequest)
		return
	}
	file, err := root.Open(path)
	if err != nil {
		http.Error(w, "File unavailable", http.StatusNotFound)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.Error(w, "File unavailable", http.StatusNotFound)
		return
	}
	result := map[string]any{"path": path, "name": filepath.Base(path), "size": info.Size(), "text": "", "tooLarge": info.Size() > terminalPreviewLimit, "binary": false}
	if info.Size() <= terminalPreviewLimit {
		data, err := io.ReadAll(io.LimitReader(file, terminalPreviewLimit+1))
		if err != nil {
			http.Error(w, "File unavailable", http.StatusInternalServerError)
			return
		}
		if len(data) > terminalPreviewLimit {
			result["tooLarge"] = true
		} else if isProbablyUTF8Text(data) {
			result["text"] = string(data)
		} else {
			result["binary"] = true
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	writeArtifactJSON(w, http.StatusOK, result)
}
