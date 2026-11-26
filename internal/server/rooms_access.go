package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var roomsRepoPart = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)

type roomsGitHubUser struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
}

type roomsRepository struct {
	ID          int64  `json:"id"`
	FullName    string `json:"full_name"`
	HasIssues   bool   `json:"has_issues"`
	Permissions struct {
		Admin bool `json:"admin"`
	} `json:"permissions"`
}

var roomsGitHubClient = &http.Client{
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func roomsGitHubRead(ctx context.Context, token, path string, result any) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/"+path, nil)
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := roomsGitHubClient.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return false
	}
	if result == nil {
		return true
	}
	return json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(result) == nil
}

func (s *Server) handleRoomsAccess(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !humanBrowserRequest(r) {
		http.Error(w, "Rooms requires a local browser session", http.StatusForbidden)
		return
	}
	owner, repo := r.PathValue("owner"), r.PathValue("repo")
	if !roomsRepoPart.MatchString(owner) || !roomsRepoPart.MatchString(repo) ||
		owner == "." || owner == ".." || repo == "." || repo == ".." {
		http.Error(w, "Invalid repository name", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	token, err := githubCLIToken(ctx)
	var user roomsGitHubUser
	if err != nil || !roomsGitHubRead(ctx, token, "user", &user) || user.ID <= 0 || user.Login == "" {
		http.Error(w, "Sign in to GitHub in Connections", http.StatusUnauthorized)
		return
	}

	path := "repos/" + owner + "/" + repo
	var repository roomsRepository
	if !roomsGitHubRead(ctx, token, path, &repository) || repository.ID <= 0 ||
		!strings.EqualFold(repository.FullName, owner+"/"+repo) || !repository.HasIssues ||
		!roomsGitHubRead(ctx, token, path+"/issues?state=all&per_page=1", nil) {
		http.Error(w, "Repository access unavailable", http.StatusNotFound)
		return
	}

	instanceID, err := roomsInstanceID()
	if err != nil {
		http.Error(w, "Rooms instance identity unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		InstanceID      string          `json:"instanceId"`
		User            roomsGitHubUser `json:"user"`
		RepositoryID    int64           `json:"repositoryId"`
		IssueRead       bool            `json:"issueRead"`
		RepositoryAdmin bool            `json:"repositoryAdmin"`
	}{instanceID, user, repository.ID, true, repository.Permissions.Admin})
}

func roomsInstanceID() (string, error) {
	dir := filepath.Join(sdkDataDir(), "rooms")
	path := filepath.Join(dir, "instance-id")
	if id, err := readRoomsInstanceID(path); !errors.Is(err, os.ErrNotExist) {
		return id, err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	file, err := os.CreateTemp(dir, "instance-id-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(file.Name())

	var id [16]byte
	rand.Read(id[:])
	_, writeErr := file.WriteString(hex.EncodeToString(id[:]))
	if err := errors.Join(writeErr, file.Close()); err != nil {
		return "", err
	}
	// Publish the completed ID without replacing one created concurrently.
	if err := os.Link(file.Name(), path); err != nil && !errors.Is(err, os.ErrExist) {
		return "", err
	}
	return readRoomsInstanceID(path)
}

func readRoomsInstanceID(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if _, err := hex.DecodeString(string(data)); err != nil || len(data) != 32 {
		return "", errors.New("invalid Rooms instance ID")
	}
	return string(data), nil
}
