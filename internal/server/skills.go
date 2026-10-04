package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The version is pinned so a server update, rather than an npm publish, changes
// which installer can write to the owner's agent configuration directories.
const skillsPackage = "skills@1.7.0"

var skillSlug = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]+/[A-Za-z0-9][A-Za-z0-9_.-]*$`)
var nodeVersion = regexp.MustCompile(`^v([0-9]+)\.([0-9]+)\.`)
var skillsInstallMu sync.Mutex

type installedSkill struct {
	Name      string   `json:"name"`
	Path      string   `json:"path"`
	Scope     string   `json:"scope"`
	Agents    []string `json:"agents"`
	Source    string   `json:"source"`
	SourceURL string   `json:"sourceUrl"`
}

type searchSkill struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Source   string `json:"source"`
	Installs int    `json:"installs"`
}

func skillsCommand(ctx context.Context, args ...string) ([]byte, error) {
	version, err := exec.CommandContext(ctx, "node", "--version").Output()
	match := nodeVersion.FindStringSubmatch(strings.TrimSpace(string(version)))
	if err != nil || match == nil {
		return nil, fmt.Errorf("Skills requires Node.js 22.20 or newer on this server")
	}
	major, _ := strconv.Atoi(match[1])
	minor, _ := strconv.Atoi(match[2])
	if major < 22 || (major == 22 && minor < 20) {
		return nil, fmt.Errorf("Skills requires Node.js 22.20 or newer on this server (found %s)", strings.TrimSpace(string(version)))
	}
	cmd := exec.CommandContext(ctx, "npx", append([]string{"--yes", skillsPackage}, args...)...)
	// Never invoke a shell or permit the browser to supply flags. The process
	// owns only the fixed CLI arguments and one validated skill identifier.
	out, err := cmd.Output()
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return nil, fmt.Errorf("skills command failed: %w: %s", err, strings.TrimSpace(string(exit.Stderr)))
		}
		return nil, fmt.Errorf("skills command failed: %w", err)
	}
	return out, nil
}

func (s *Server) handleSkillsList(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	out, err := skillsCommand(ctx, "list", "--global", "--json")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	var rows []installedSkill
	if err := json.Unmarshal(out, &rows); err != nil {
		http.Error(w, "skills returned invalid installed skill data", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(rows)
}

func (s *Server) handleSkillsSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) < 2 || len(q) > 100 {
		http.Error(w, "search needs 2 to 100 characters", http.StatusBadRequest)
		return
	}
	// This is the search API used by `npx skills find`; the CLI's human output
	// has no JSON mode. Keep discovery in the existing catalog.
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	endpoint := "https://skills.sh/api/search?q=" + url.QueryEscape(q) + "&limit=20"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		http.Error(w, "invalid search", http.StatusBadRequest)
		return
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		http.Error(w, "skill catalog unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		http.Error(w, "skill catalog unavailable", http.StatusBadGateway)
		return
	}
	var result struct {
		Skills []searchSkill `json:"skills"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&result); err != nil {
		http.Error(w, "skill catalog returned invalid data", http.StatusBadGateway)
		return
	}
	if result.Skills == nil {
		result.Skills = []searchSkill{}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result.Skills)
}

func (s *Server) handleSkillsInstall(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&req); err != nil || !skillSlug.MatchString(req.ID) {
		http.Error(w, "choose a GitHub skill from the catalog", http.StatusBadRequest)
		return
	}
	if !skillsInstallMu.TryLock() {
		http.Error(w, "another skill is installing", http.StatusConflict)
		return
	}
	defer skillsInstallMu.Unlock()
	parts := strings.Split(req.ID, "/")
	source := parts[0] + "/" + parts[1] + "@" + parts[2]
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	// Explicit global targets make new chats on every project see the skill.
	// npx skills writes its canonical ~/.agents/skills copy and the Codex and
	// Claude links. Amplifier's SDK chat mounts that same canonical directory.
	if _, err := skillsCommand(ctx, "add", source, "--global", "--agent", "codex", "--agent", "claude-code", "--yes"); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"id": req.ID, "status": "installed"})
}
