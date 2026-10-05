package server

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const utilityDiffLimit = 1 << 20

type utilityGitRepo struct {
	Root   string `json:"root"`
	Name   string `json:"name"`
	Branch string `json:"branch"`
}

type utilityChange struct {
	Repo   string `json:"repo"`
	Path   string `json:"path"`
	Status string `json:"status"`
}

func (s *Server) sdkUtilityGitRoots(ctx context.Context, chatID string) []string {
	s.sdkChats.mu.Lock()
	chat := s.sdkChats.chats[chatID]
	folders := []string{}
	if chat != nil {
		folders = append(folders, chat.ProjectPath)
		folders = append(folders, chat.SourceFolders...)
	}
	s.sdkChats.mu.Unlock()
	roots := []string{}
	seen := map[string]bool{}
	for _, folder := range folders {
		if !filepath.IsAbs(folder) {
			continue
		}
		info, err := os.Stat(folder)
		if err != nil || !info.IsDir() {
			continue
		}
		out, err := exec.CommandContext(ctx, "git", "-C", folder, "rev-parse", "--show-toplevel").Output()
		if err != nil {
			continue
		}
		root := filepath.Clean(strings.TrimSpace(string(out)))
		if root != "" && !seen[root] {
			seen[root] = true
			roots = append(roots, root)
		}
	}
	return roots
}

func utilityGitOutput(ctx context.Context, limit int, args ...string) ([]byte, error) {
	var output bytes.Buffer
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Stdout = &output
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	if output.Len() > limit {
		return nil, io.ErrShortBuffer
	}
	return output.Bytes(), nil
}

func (s *Server) handleSDKUtilityChanges(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
	defer cancel()
	roots := s.sdkUtilityGitRoots(ctx, r.PathValue("id"))
	repos := make([]utilityGitRepo, 0, len(roots))
	changes := make([]utilityChange, 0)
	truncated := false
	for _, root := range roots {
		branch, _ := utilityGitOutput(ctx, 1024, "-C", root, "branch", "--show-current")
		repos = append(repos, utilityGitRepo{Root: root, Name: filepath.Base(root), Branch: strings.TrimSpace(string(branch))})
		out, err := utilityGitOutput(ctx, 4<<20, "-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
		if err != nil {
			truncated = true
			continue
		}
		for len(out) > 0 && len(changes) < 400 {
			end := bytes.IndexByte(out, 0)
			if end < 0 {
				break
			}
			record := string(out[:end])
			out = out[end+1:]
			if len(record) < 4 {
				continue
			}
			status, path := record[:2], record[3:]
			if strings.ContainsAny(status, "RC") {
				oldEnd := bytes.IndexByte(out, 0)
				if oldEnd >= 0 {
					out = out[oldEnd+1:]
				}
			}
			if filepath.IsLocal(path) {
				changes = append(changes, utilityChange{Repo: root, Path: filepath.ToSlash(path), Status: status})
			}
		}
		if len(out) > 0 || len(changes) >= 400 {
			truncated = true
		}
	}
	writeSDKJSON(w, http.StatusOK, map[string]any{"repos": repos, "changes": changes, "truncated": truncated})
}

func (s *Server) handleSDKUtilityChange(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	wantedRoot := filepath.Clean(r.URL.Query().Get("repo"))
	allowed := false
	for _, root := range s.sdkUtilityGitRoots(ctx, r.PathValue("id")) {
		if root == wantedRoot {
			allowed = true
			break
		}
	}
	path := r.URL.Query().Get("path")
	if !allowed || !filepath.IsLocal(path) || path == "." {
		http.Error(w, "Change unavailable", http.StatusBadRequest)
		return
	}
	root, err := os.OpenRoot(wantedRoot)
	if err != nil {
		http.Error(w, "Repository unavailable", http.StatusNotFound)
		return
	}
	defer root.Close()
	after := ""
	if file, openErr := root.Open(path); openErr == nil {
		info, statErr := file.Stat()
		if statErr == nil && info.Mode().IsRegular() {
			if info.Size() > utilityDiffLimit {
				file.Close()
				writeSDKJSON(w, http.StatusOK, map[string]any{"repo": wantedRoot, "path": path, "tooLarge": true})
				return
			}
			data, readErr := io.ReadAll(io.LimitReader(file, utilityDiffLimit+1))
			if readErr == nil && len(data) <= utilityDiffLimit {
				after = string(data)
			}
		}
		file.Close()
	}
	gitPath := filepath.ToSlash(path)
	before := ""
	sizeBytes, sizeErr := utilityGitOutput(ctx, 64, "-C", wantedRoot, "cat-file", "-s", "HEAD:"+gitPath)
	if sizeErr == nil {
		size, parseErr := strconv.ParseInt(strings.TrimSpace(string(sizeBytes)), 10, 64)
		if parseErr != nil || size > utilityDiffLimit {
			writeSDKJSON(w, http.StatusOK, map[string]any{"repo": wantedRoot, "path": path, "tooLarge": true})
			return
		}
		data, showErr := utilityGitOutput(ctx, utilityDiffLimit, "-C", wantedRoot, "show", "HEAD:"+gitPath)
		if showErr == nil {
			before = string(data)
		}
	}
	writeSDKJSON(w, http.StatusOK, map[string]any{"repo": wantedRoot, "path": path, "before": before, "after": after, "binary": !utf8.ValidString(before) || !utf8.ValidString(after)})
}
