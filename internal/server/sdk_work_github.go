package server

import (
	"context"
	"encoding/json"
	"net/http"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

var workGitHubRepoPart = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)

type workGitHubIssue struct {
	ID        int64  `json:"id"`
	Number    int    `json:"number"`
	Title     string `json:"title"`
	Assignees []struct {
		Login string `json:"login"`
	} `json:"assignees"`
	PullRequest json.RawMessage `json:"pull_request,omitempty"`
}

func (s *Server) handleWorkGitHubSync(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !humanBrowserRequest(r) {
		http.Error(w, "GitHub sync requires a browser session", http.StatusForbidden)
		return
	}
	owner, repo := r.PathValue("owner"), r.PathValue("repo")
	for _, part := range []string{owner, repo} {
		if !workGitHubRepoPart.MatchString(part) || part == "." || part == ".." {
			http.Error(w, "Enter a GitHub repository as owner/repo", http.StatusBadRequest)
			return
		}
	}
	gh, err := githubBinary("gh")
	if err != nil {
		http.Error(w, "Connect GitHub in Connections first", http.StatusUnauthorized)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	env := githubEnvironment()
	auth := exec.CommandContext(ctx, gh, "auth", "status", "--hostname", "github.com", "--json", "hosts")
	auth.Env = env
	data, err := auth.Output()
	var status struct {
		Hosts map[string][]struct{ Login, State string }
	}
	if err != nil || json.Unmarshal(data, &status) != nil {
		http.Error(w, "Could not read GitHub accounts", http.StatusBadGateway)
		return
	}
	var incoming []workGitHubIssue
	seen := make(map[int64]bool)
	readable := false
	for _, account := range status.Hosts["github.com"] {
		if account.State != "success" || account.Login == "" {
			continue
		}
		tokenCmd := exec.CommandContext(ctx, gh, "auth", "token", "--hostname", "github.com", "--user", account.Login)
		tokenCmd.Env = env
		token, err := tokenCmd.Output()
		if err != nil {
			continue
		}
		path := "repos/" + owner + "/" + repo + "/issues?state=open&labels=muxterm%3Awork&assignee=" + account.Login + "&per_page=100"
		list := exec.CommandContext(ctx, gh, "api", "--hostname", "github.com", "--paginate", "--slurp", path)
		list.Env = append(append([]string(nil), env...), "GH_TOKEN="+strings.TrimSpace(string(token)))
		data, err := list.Output()
		var pages [][]workGitHubIssue
		if err != nil || json.Unmarshal(data, &pages) != nil {
			continue
		}
		readable = true
		for _, page := range pages {
			for _, issue := range page {
				if len(issue.PullRequest) == 0 && !seen[issue.ID] {
					seen[issue.ID] = true
					incoming = append(incoming, issue)
				}
			}
		}
	}
	if !readable {
		http.Error(w, "No signed-in GitHub account could read this repository’s issues", http.StatusBadGateway)
		return
	}
	writeSDKJSON(w, http.StatusOK, map[string]any{"issues": incoming})
}
