package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// SDK utility reads are confined by os.Root, including symlinks and rename races.
func (s *Server) sdkUtilityRoot(r *http.Request) (*os.Root, string, bool) {
	s.sdkChats.mu.Lock()
	chat := s.sdkChats.chats[r.PathValue("id")]
	path := ""
	if chat != nil {
		path = chat.ProjectPath
	}
	s.sdkChats.mu.Unlock()
	if path == "" {
		return nil, "", false
	}
	root, err := os.OpenRoot(path)
	if err != nil {
		return nil, "", false
	}
	return root, path, true
}

func utilityRelative(r *http.Request) (string, bool) {
	p := r.URL.Query().Get("path")
	if p == "" {
		return ".", true
	}
	if filepath.IsAbs(p) || !filepath.IsLocal(p) {
		return "", false
	}
	return p, true
}

func (s *Server) handleSDKUtilityFiles(w http.ResponseWriter, r *http.Request) {
	root, project, ok := s.sdkUtilityRoot(r)
	if !ok {
		http.Error(w, "Project folder unavailable", 404)
		return
	}
	defer root.Close()
	rel, ok := utilityRelative(r)
	if !ok {
		http.Error(w, "Path leaves the project folder", 400)
		return
	}
	dir, err := root.Open(rel)
	if err != nil {
		http.Error(w, "Folder unavailable", 404)
		return
	}
	defer dir.Close()
	info, err := dir.Stat()
	if err != nil || !info.IsDir() {
		http.Error(w, "Folder unavailable", 404)
		return
	}
	entries, err := dir.ReadDir(500)
	if err != nil && !errors.Is(err, io.EOF) {
		http.Error(w, "Folder unavailable", 500)
		return
	}
	type row struct {
		Name string `json:"name"`
		Dir  bool   `json:"dir"`
	}
	rows := make([]row, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		child := filepath.Join(rel, name)
		// Only show entries that remain inside the root after symlink resolution.
		f, e := root.Open(child)
		if e != nil {
			continue
		}
		st, e := f.Stat()
		f.Close()
		if e != nil || (!st.IsDir() && !st.Mode().IsRegular()) {
			continue
		}
		rows = append(rows, row{name, st.IsDir()})
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Dir != rows[j].Dir {
			return rows[i].Dir
		}
		return strings.ToLower(rows[i].Name) < strings.ToLower(rows[j].Name)
	})
	writeSDKJSON(w, 200, map[string]any{"root": project, "path": rel, "entries": rows})
}

func (s *Server) sdkUtilityFile(w http.ResponseWriter, r *http.Request, raw bool) {
	root, _, ok := s.sdkUtilityRoot(r)
	if !ok {
		http.Error(w, "Project folder unavailable", 404)
		return
	}
	defer root.Close()
	rel, ok := utilityRelative(r)
	if !ok || rel == "." {
		http.Error(w, "Path leaves the project folder", 400)
		return
	}
	f, err := root.Open(rel)
	if err != nil {
		http.Error(w, "File unavailable", 404)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.Error(w, "File unavailable", 404)
		return
	}
	kind, contentType := publicationKindFor(rel)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	if raw {
		if kind == kindImage {
			w.Header().Set("Content-Type", contentType)
		} else {
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("Content-Disposition", "attachment; filename=\""+safeAttachmentName(filepath.Base(rel))+"\"")
		}
		http.ServeContent(w, r, "", info.ModTime(), f)
		return
	}
	result := artifactResponse{Path: rel, Name: filepath.Base(rel), Size: info.Size(), Modified: info.ModTime().Unix(), Kind: string(kind), ContentType: contentType, MaxBytes: publicationMaxBytes}
	if info.Size() > publicationMaxBytes {
		result.TooLarge = true
	} else if kind == kindMarkdown || kind == kindText {
		bytes, err := io.ReadAll(io.LimitReader(f, publicationMaxBytes+1))
		if err != nil {
			http.Error(w, "File unavailable", 500)
			return
		}
		if int64(len(bytes)) > publicationMaxBytes {
			result.TooLarge = true
		} else if isProbablyUTF8Text(bytes) {
			result.Text = string(bytes)
		} else {
			result.Binary = true
		}
	}
	writeArtifactJSON(w, 200, result)
}
func (s *Server) handleSDKUtilityFile(w http.ResponseWriter, r *http.Request) {
	s.sdkUtilityFile(w, r, false)
}
func (s *Server) handleSDKUtilityRaw(w http.ResponseWriter, r *http.Request) {
	s.sdkUtilityFile(w, r, true)
}

// Query only the current project's branch, once when the PR panel mounts.
func (s *Server) handleSDKUtilityPR(w http.ResponseWriter, r *http.Request) {
	root, project, ok := s.sdkUtilityRoot(r)
	if !ok {
		http.Error(w, "Project folder unavailable", 404)
		return
	}
	root.Close()
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	branch, err := exec.CommandContext(ctx, "git", "-C", project, "branch", "--show-current").Output()
	name := strings.TrimSpace(string(branch))
	result := map[string]any{"branch": name, "number": 0, "title": "", "state": "", "url": ""}
	if err != nil || name == "" {
		writeSDKJSON(w, 200, result)
		return
	}
	cmd := exec.CommandContext(ctx, "gh", "pr", "view", name, "--json", "number,title,state,url,headRefName")
	cmd.Dir = project
	output, err := cmd.Output()
	if err == nil {
		var pr map[string]any
		if json.Unmarshal(output, &pr) == nil {
			for _, k := range []string{"number", "title", "state", "url"} {
				result[k] = pr[k]
			}
		}
	}
	writeSDKJSON(w, 200, result)
}
