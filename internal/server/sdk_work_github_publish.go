package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"slices"
	"strings"
	"time"
)

func workGitHubAPI(ctx context.Context, gh, method, path string, input, output any) error {
	args := []string{"api", "--hostname", "github.com", "--method", method, path}
	var payload []byte
	if input != nil {
		var err error
		payload, err = json.Marshal(input)
		if err != nil {
			return err
		}
		args = append(args, "--input", "-")
	}
	cmd := exec.CommandContext(ctx, gh, args...)
	cmd.Env = githubEnvironment()
	cmd.Stdin = bytes.NewReader(payload)
	data, err := cmd.Output()
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok && len(exit.Stderr) != 0 {
			return fmt.Errorf("%s", strings.TrimSpace(string(exit.Stderr)))
		}
		return err
	}
	if output != nil {
		return json.Unmarshal(data, output)
	}
	return nil
}

func (s *Server) handleWorkGitHubPublish(w http.ResponseWriter, r *http.Request) {
	s.publishWorkToGitHub(w, r, false)
}

func (s *Server) handleWorkGitHubResult(w http.ResponseWriter, r *http.Request) {
	s.publishWorkToGitHub(w, r, true)
}

func (s *Server) publishWorkToGitHub(w http.ResponseWriter, r *http.Request, result bool) {
	if !humanBrowserRequest(r) {
		http.Error(w, "GitHub publication requires a browser session", http.StatusForbidden)
		return
	}
	var req struct {
		Owner    string `json:"owner"`
		Repo     string `json:"repo"`
		Assignee string `json:"assignee"`
	}
	if !result {
		if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req) != nil ||
			!validWorkGitHubRepoPart(req.Owner) || !validWorkGitHubRepoPart(req.Repo) ||
			(req.Assignee != "" && !validWorkGitHubRepoPart(req.Assignee)) {
			http.Error(w, "Enter a GitHub repository and optional assignee", http.StatusBadRequest)
			return
		}
	}
	s.workGitHubMu.Lock()
	defer s.workGitHubMu.Unlock()
	h := s.sdkChats
	h.mu.Lock()
	current := h.workItems[r.PathValue("id")]
	if current == nil {
		h.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	item := *current
	h.mu.Unlock()
	if (!result && item.GitHubSource != nil) || (result && item.GitHubResultURL != "") {
		writeSDKJSON(w, http.StatusOK, item)
		return
	}
	if result && (item.GitHubSource == nil || item.Status != "done") {
		http.Error(w, "Complete the linked Work before publishing its result", http.StatusConflict)
		return
	}
	if !result && !checkWorkGoal(item.GoalCondition, item.GoalRevision).Passed {
		http.Error(w, "File a checked Work goal before publishing", http.StatusConflict)
		return
	}
	gh, err := githubBinary("gh")
	if err != nil {
		http.Error(w, "Connect GitHub in Connections first", http.StatusUnauthorized)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	if result {
		item.GitHubResultURL, err = publishWorkGitHubResult(ctx, gh, item)
	} else {
		item.GitHubSource, err = publishWorkGitHubIssue(ctx, gh, item, req.Owner, req.Repo, req.Assignee)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	copy := *h.workItems[item.ID]
	copy.GitHubSource = item.GitHubSource
	copy.GitHubResultURL = item.GitHubResultURL
	if err := h.saveWorkLocked(&copy); err != nil {
		http.Error(w, "GitHub accepted publication, but the Work link could not be saved: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeSDKJSON(w, http.StatusOK, copy)
}

func publishWorkGitHubIssue(ctx context.Context, gh string, item sdkWorkItem, owner, repo, assignee string) (*workGitHubSource, error) {
	path := "repos/" + owner + "/" + repo
	labels := slices.Clone(item.Labels)
	if !slices.Contains(labels, "muxterm:work") {
		labels = append(labels, "muxterm:work")
	}
	for _, label := range labels {
		if err := workGitHubAPI(ctx, gh, http.MethodGet, path+"/labels/"+url.PathEscape(label), nil, nil); err != nil {
			return nil, fmt.Errorf("GitHub label %q could not be verified: %w", label, err)
		}
	}
	body := item.Brief + "\n\n" + item.GoalCondition
	if item.Acceptance != "" {
		body += "\n\n## Acceptance criteria\n" + item.Acceptance
	}
	input := map[string]any{"title": item.Title, "body": body, "labels": labels}
	if assignee != "" {
		if err := workGitHubAPI(ctx, gh, http.MethodGet, path+"/assignees/"+assignee, nil, nil); err != nil {
			return nil, fmt.Errorf("GitHub cannot assign this issue to %s: %w", assignee, err)
		}
		input["assignees"] = []string{assignee}
	}
	source := workGitHubSource{Owner: owner, Repo: repo}
	if err := workGitHubAPI(ctx, gh, http.MethodPost, path+"/issues", input, &source); err != nil {
		return nil, err
	}
	if !source.valid() {
		return nil, fmt.Errorf("GitHub returned an invalid issue link")
	}
	return &source, nil
}

func publishWorkGitHubResult(ctx context.Context, gh string, item sdkWorkItem) (string, error) {
	outcome := item.Outcome
	var evidence []string
	for _, update := range item.Updates {
		if outcome == "" && update.Completion != nil {
			outcome = update.Completion.Reason
		}
		for _, reference := range update.Evidence {
			if !slices.Contains(evidence, reference) {
				evidence = append(evidence, reference)
			}
		}
	}
	body := "## Completed Work\n\n" + item.Title
	if outcome != "" {
		body += "\n\n" + outcome
	}
	if len(evidence) > 0 {
		body += "\n\n## Evidence\n\n- " + strings.Join(evidence, "\n- ")
	}
	source := item.GitHubSource
	path := fmt.Sprintf("repos/%s/%s/issues/%d/comments", source.Owner, source.Repo, source.Number)
	var comment struct {
		URL string `json:"html_url"`
	}
	err := workGitHubAPI(ctx, gh, http.MethodPost, path, map[string]string{"body": body}, &comment)
	if err == nil && !strings.HasPrefix(comment.URL, source.url()+"#issuecomment-") {
		err = fmt.Errorf("GitHub returned an invalid result link")
	}
	return comment.URL, err
}
