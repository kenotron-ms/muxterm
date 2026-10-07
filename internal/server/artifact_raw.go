package server

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// handleArtifactRaw serves raster images linked from chat Markdown. The route
// accepts paths only inside the current user's artifacts directory; os.Root
// also keeps symlinks and rename races from escaping that directory.
func (s *Server) handleArtifactRaw(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")

	home, err := os.UserHomeDir()
	if err != nil {
		http.Error(w, "Image unavailable", http.StatusNotFound)
		return
	}
	path := r.URL.Query().Get("path")
	if strings.HasPrefix(path, "~/") {
		path = filepath.Join(home, path[2:])
	}
	if !filepath.IsAbs(path) {
		http.Error(w, "Image unavailable", http.StatusNotFound)
		return
	}
	rootPath := filepath.Join(home, "artifacts")
	rel, err := filepath.Rel(rootPath, path)
	if err != nil || rel == "." || !filepath.IsLocal(rel) {
		http.Error(w, "Image unavailable", http.StatusNotFound)
		return
	}
	kind, contentType := publicationKindFor(rel)
	if kind != kindImage {
		http.Error(w, "Image unavailable", http.StatusNotFound)
		return
	}
	limit := int64(8 << 20)
	if r.URL.Query().Has("max_bytes") {
		limit, err = strconv.ParseInt(r.URL.Query().Get("max_bytes"), 10, 64)
		if err != nil || limit <= 0 || limit > 8<<20 {
			http.Error(w, "Invalid preview size limit", http.StatusBadRequest)
			return
		}
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		http.Error(w, "Image unavailable", http.StatusNotFound)
		return
	}
	defer root.Close()
	f, err := root.Open(rel)
	if err != nil {
		http.Error(w, "Image unavailable", http.StatusNotFound)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.Error(w, "Image unavailable", http.StatusNotFound)
		return
	}
	if info.Size() > limit {
		http.Error(w, "Image is too large to preview", http.StatusRequestEntityTooLarge)
		return
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		http.Error(w, "Image unavailable", http.StatusInternalServerError)
		return
	}
	if int64(len(data)) > limit {
		http.Error(w, "Image is too large to preview", http.StatusRequestEntityTooLarge)
		return
	}
	w.Header().Set("Content-Type", contentType)
	http.ServeContent(w, r, "", info.ModTime(), bytes.NewReader(data))
}
