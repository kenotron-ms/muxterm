package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The installer is interactive, but these checks only inspect installed CLIs
// and public package metadata. They run even when no settings page is open.
var codingAgentVersions = []struct {
	harness, executable, npmPackage string
}{
	{"codex", "codex", "@openai/codex"},
	{"claude", "claude", "@anthropic-ai/claude-code"},
	{"copilot", "copilot", "@github/copilot"},
	{"opencode", "opencode", "opencode-ai"},
	{"pi", "pi", "@earendil-works/pi-coding-agent"},
	{"deepseek", "dsh", "@deepseek-ai/dsh"},
	{"amplifier", "amplifier", ""}, // Installed from Git; no comparable registry version.
}

var agentSemver = regexp.MustCompile(`\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b`)

type codingAgentVersion struct {
	Harness         string `json:"harness"`
	Installed       bool   `json:"installed"`
	Version         string `json:"version,omitempty"`
	InstallMethod   string `json:"installMethod,omitempty"`
	LatestVersion   string `json:"latestVersion,omitempty"`
	UpdateAvailable bool   `json:"updateAvailable"`
	CheckedAt       string `json:"checkedAt"`
}

type codingAgentVersionCache struct {
	mu        sync.RWMutex
	refreshMu sync.Mutex
	agents    []codingAgentVersion
}

func (c *codingAgentVersionCache) snapshot() []codingAgentVersion {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return append([]codingAgentVersion(nil), c.agents...)
}

func (c *codingAgentVersionCache) run(ctx context.Context) {
	c.refresh(ctx)
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.refresh(ctx)
		}
	}
}

func (c *codingAgentVersionCache) refresh(ctx context.Context) {
	c.refreshMu.Lock()
	defer c.refreshMu.Unlock()
	agents := make([]codingAgentVersion, len(codingAgentVersions))
	var workers sync.WaitGroup
	for i, info := range codingAgentVersions {
		workers.Add(1)
		go func() {
			defer workers.Done()
			agents[i] = inspectCodingAgent(ctx, info.harness, info.executable, info.npmPackage)
		}()
	}
	workers.Wait()
	if ctx.Err() != nil {
		return
	}
	c.mu.Lock()
	c.agents = agents
	c.mu.Unlock()
}

func inspectCodingAgent(ctx context.Context, harness, executable, npmPackage string) codingAgentVersion {
	status := codingAgentVersion{Harness: harness, CheckedAt: time.Now().UTC().Format(time.RFC3339)}
	if path, err := exec.LookPath(executable); err == nil {
		status.Installed = true
		if harness == "codex" {
			if target, err := filepath.EvalSymlinks(path); err == nil && strings.Contains(filepath.ToSlash(target), "/.codex/packages/standalone/") {
				status.InstallMethod = "standalone"
			} else {
				status.InstallMethod = "npm"
			}
		}
		commandCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
		cmd := exec.CommandContext(commandCtx, path, "--version")
		cmd.Dir = os.TempDir()
		output, err := cmd.CombinedOutput()
		cancel()
		if err == nil {
			status.Version = agentSemver.FindString(string(output))
		}
	}
	if npmPackage != "" {
		status.LatestVersion = latestNPMPackageVersion(ctx, npmPackage)
		status.UpdateAvailable = status.Installed && olderAgentVersion(status.Version, status.LatestVersion)
	}
	return status
}

func latestNPMPackageVersion(ctx context.Context, packageName string) string {
	requestCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	endpoint := "https://registry.npmjs.org/" + url.PathEscape(packageName) + "/latest"
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return ""
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return ""
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return ""
	}
	var packageInfo struct {
		Version string `json:"version"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&packageInfo) != nil {
		return ""
	}
	return packageInfo.Version
}

func olderAgentVersion(current, latest string) bool {
	current = strings.TrimPrefix(current, "v")
	latest = strings.TrimPrefix(latest, "v")
	if current == "" || latest == "" || agentSemver.FindString(current) != current || agentSemver.FindString(latest) != latest {
		return false
	}
	currentParts := strings.SplitN(strings.SplitN(current, "+", 2)[0], "-", 2)
	latestParts := strings.SplitN(strings.SplitN(latest, "+", 2)[0], "-", 2)
	currentNumbers := strings.Split(currentParts[0], ".")
	latestNumbers := strings.Split(latestParts[0], ".")
	for i := range 3 {
		a, _ := strconv.Atoi(currentNumbers[i])
		b, _ := strconv.Atoi(latestNumbers[i])
		if a != b {
			return a < b
		}
	}
	return strings.Contains(current, "-") && !strings.Contains(latest, "-")
}

func (s *Server) handleCodingAgentVersions(w http.ResponseWriter, _ *http.Request) {
	writeSDKJSON(w, http.StatusOK, map[string]any{"agents": s.agentVersions.snapshot()})
}

func (s *Server) handleCodingAgentVersionRefresh(w http.ResponseWriter, r *http.Request) {
	s.agentVersions.refresh(r.Context())
	if r.Context().Err() != nil {
		http.Error(w, "scan cancelled", http.StatusServiceUnavailable)
		return
	}
	s.handleCodingAgentVersions(w, r)
}
