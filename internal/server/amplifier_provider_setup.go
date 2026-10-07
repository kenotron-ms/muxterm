package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/kenotron-ms/muxterm/internal/amplifierchat"
)

// Provider setup reports only where a credential may be found. A credential
// is not proof that Amplifier can use the provider.
type amplifierProviderState struct {
	ID      string `json:"id"`
	Source  string `json:"source,omitempty"`
	EnvName string `json:"envName,omitempty"`
}

var amplifierKeyAssignment = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func amplifierKeyNames(path string) map[string]bool {
	names := make(map[string]bool)
	data, err := os.ReadFile(path)
	if err != nil || len(data) > 1<<20 {
		return names
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "export "))
		name, value, ok := strings.Cut(line, "=")
		name = strings.TrimSpace(name)
		if ok && amplifierKeyAssignment.MatchString(name) && strings.TrimSpace(value) != "" {
			names[name] = true
		}
	}
	return names
}

func validAmplifierProvider(id string) bool {
	switch id {
	case "github-copilot", "openai-chatgpt", "openai", "anthropic", "gemini":
		return true
	}
	return false
}

func (s *Server) handleAmplifierProviderSetup(w http.ResponseWriter, r *http.Request) {
	home, _ := os.UserHomeDir()
	keys := map[string]bool{}
	if home != "" {
		keys = amplifierKeyNames(filepath.Join(home, ".amplifier", "keys.env"))
	}
	providers := []struct {
		id   string
		envs []string
	}{
		{"github-copilot", []string{"COPILOT_AGENT_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"}},
		{"openai-chatgpt", nil},
		{"openai", []string{"OPENAI_API_KEY"}},
		{"anthropic", []string{"ANTHROPIC_API_KEY"}},
		{"gemini", []string{"GOOGLE_API_KEY", "GEMINI_API_KEY"}},
	}
	states := make([]amplifierProviderState, 0, len(providers))
	for _, provider := range providers {
		state := amplifierProviderState{ID: provider.id}
		for _, name := range provider.envs {
			if os.Getenv(name) != "" {
				state.Source, state.EnvName = "environment", name
				break
			}
			if keys[name] && state.Source == "" {
				state.Source, state.EnvName = "amplifier-keys", name
			}
		}
		if state.Source == "" && home != "" && provider.id == "openai-chatgpt" {
			if info, err := os.Stat(filepath.Join(home, ".amplifier", "openai-chatgpt-oauth.json")); err == nil && info.Size() > 0 {
				state.Source = "oauth-cache"
			}
		}
		states = append(states, state)
	}
	binary, lookupErr := amplifierchat.CLIExecutable()
	cliReady := false
	if lookupErr == nil {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		cliReady = amplifierchat.CheckAmplifierCLI(ctx) == nil
		cancel()
	}
	configured := false
	if home != "" {
		if info, err := os.Stat(filepath.Join(home, ".amplifier", "settings.yaml")); err == nil && info.Size() > 0 {
			configured = true
		}
	}
	primary := ""
	if cliReady {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		if output, err := exec.CommandContext(ctx, binary, "provider", "list", "--format", "json").Output(); err == nil {
			var rows []struct {
				Name string `json:"name"`
			}
			if json.Unmarshal(output, &rows) == nil {
				for _, row := range rows {
					if strings.HasPrefix(strings.TrimSpace(row.Name), "★") {
						primary = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(row.Name), "★"))
						break
					}
				}
			}
		}
		cancel()
	}
	w.Header().Set("Cache-Control", "no-store")
	writeSDKJSON(w, http.StatusOK, map[string]any{"cliInstalled": cliReady, "configured": configured, "primary": primary, "providers": states})
}

// The CLI owns provider configuration and secrets. Checking a provider runs
// its own model connectivity probe and returns no subprocess output or keys.
func (s *Server) handleAmplifierProviderCheck(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Provider string `json:"provider"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&input) != nil || !validAmplifierProvider(input.Provider) {
		http.Error(w, "unsupported provider", http.StatusBadRequest)
		return
	}
	binary, err := amplifierchat.CLIExecutable()
	if err != nil {
		http.Error(w, "install Amplifier CLI first", http.StatusPreconditionFailed)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, binary, "provider", "test", input.Provider).Run(); err != nil {
		if ctx.Err() != nil {
			http.Error(w, "provider check timed out", http.StatusGatewayTimeout)
		} else {
			http.Error(w, "provider check failed; finish Amplifier setup or sign-in, then try again", http.StatusBadGateway)
		}
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeSDKJSON(w, http.StatusOK, map[string]any{"ok": true})
}
