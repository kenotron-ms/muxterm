package server

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"time"

	"github.com/kenotron-ms/muxterm/internal/amplifierchat"
)

//go:embed amplifier_provider_bridge.py
var amplifierProviderBridge string

type providerBridgeRequest struct {
	Action           string   `json:"action"`
	Provider         string   `json:"provider,omitempty"`
	CredentialSource string   `json:"credentialSource,omitempty"`
	APIKey           string   `json:"apiKey,omitempty"`
	Model            string   `json:"model,omitempty"`
	IDs              []string `json:"ids,omitempty"`
	ExpectedIDs      []string `json:"expectedIds,omitempty"`
}

func validAmplifierProvider(id string) bool {
	switch id {
	case "anthropic", "openai", "gemini", "github-copilot":
		return true
	}
	return false
}

func isolatedAmplifierProfile() bool {
	account, err := user.Current()
	if err != nil {
		return false
	}
	actualHome := filepath.Clean(account.HomeDir)
	selectedHome, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	if filepath.Clean(selectedHome) != actualHome {
		return true
	}
	if configuredHome := os.Getenv("AMPLIFIER_HOME"); configuredHome != "" {
		return filepath.Clean(configuredHome) != filepath.Join(actualHome, ".amplifier")
	}
	return false
}

func runProviderBridge(ctx context.Context, input providerBridgeRequest) (map[string]any, error) {
	_, err := amplifierchat.CLIExecutable()
	if err != nil {
		return nil, errors.New("Amplifier is not installed")
	}
	if amplifierchat.CheckAmplifierCLI(ctx) != nil {
		return nil, errors.New("Amplifier's tool environment does not match this Amplifier home")
	}
	python, err := amplifierchat.ResolveInterpreter()
	if err != nil {
		return nil, errors.New("Amplifier is not installed")
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return nil, errors.New("Invalid provider request")
	}
	cmd := exec.CommandContext(ctx, python, "-c", amplifierProviderBridge)
	cmd.Stdin = bytes.NewReader(encoded)
	// Provider SDK stderr can include sensitive request details. Keep it out of
	// HTTP responses and application logs.
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, errors.New("Provider action timed out")
		}
		return nil, errors.New("Amplifier provider integration is unavailable in its selected Python environment")
	}
	var result map[string]any
	if output.Len() > 1<<20 || json.Unmarshal(output.Bytes(), &result) != nil {
		return nil, errors.New("Amplifier returned an invalid provider response")
	}
	if message, ok := result["error"].(string); ok {
		return nil, errors.New(message)
	}
	result["isolatedProfile"] = isolatedAmplifierProfile()
	return result, nil
}

func (s *Server) handleAmplifierInstall(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	uv, err := exec.LookPath("uv")
	if err != nil {
		if home, e := os.UserHomeDir(); e == nil {
			candidate := filepath.Join(home, ".local", "bin", "uv")
			if info, e := os.Stat(candidate); e == nil && info.Mode().Perm()&0111 != 0 {
				uv = candidate
			}
		}
	}
	if uv == "" {
		http.Error(w, "Install uv first to install Amplifier", http.StatusPreconditionFailed)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 6*time.Minute)
	defer cancel()
	// The graphical provider API requires the current Foundation settings
	// module. An older uv-managed Amplifier can still supply keys.env, but must
	// be upgraded when the user explicitly chooses Update Amplifier.
	cmd := exec.CommandContext(ctx, uv, "tool", "install", "--force", "--from", "git+https://github.com/microsoft/amplifier", "amplifier")
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		http.Error(w, "Amplifier installation or update failed. Check network access and the uv installation, then retry.", http.StatusBadGateway)
		return
	}
	result, err := runProviderBridge(ctx, providerBridgeRequest{Action: "status"})
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeSDKJSON(w, http.StatusOK, result)
}

func (s *Server) handleAmplifierProviderSetup(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	// A freshly installed uv tool can take longer on its first provider-list
	// invocation while Amplifier initializes its module cache.
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	result, err := runProviderBridge(ctx, providerBridgeRequest{Action: "status"})
	if err != nil {
		writeSDKJSON(w, http.StatusOK, map[string]any{"cliInstalled": false, "configured": false, "primary": "", "providers": []any{}, "isolatedProfile": isolatedAmplifierProfile(), "error": err.Error()})
		return
	}
	writeSDKJSON(w, http.StatusOK, result)
}

func decodeProviderRequest(w http.ResponseWriter, r *http.Request) (providerBridgeRequest, bool) {
	var input providerBridgeRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 20000)).Decode(&input); err != nil || !validAmplifierProvider(input.Provider) {
		http.Error(w, "Unsupported provider or invalid request", http.StatusBadRequest)
		return input, false
	}
	return input, true
}

func (s *Server) handleAmplifierProviderSave(w http.ResponseWriter, r *http.Request) {
	input, ok := decodeProviderRequest(w, r)
	if !ok {
		return
	}
	input.Action = "save"
	w.Header().Set("Cache-Control", "no-store")
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	result, err := runProviderBridge(ctx, input)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeSDKJSON(w, http.StatusOK, result)
}

func (s *Server) handleAmplifierProviderCheck(w http.ResponseWriter, r *http.Request) {
	input, ok := decodeProviderRequest(w, r)
	if !ok {
		return
	}
	input.Action = "check"
	input.APIKey = ""
	w.Header().Set("Cache-Control", "no-store")
	ctx, cancel := context.WithTimeout(r.Context(), 180*time.Second)
	defer cancel()
	result, err := runProviderBridge(ctx, input)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeSDKJSON(w, http.StatusOK, result)
}

func (s *Server) handleAmplifierProviderReorder(w http.ResponseWriter, r *http.Request) {
	var input providerBridgeRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 20000)).Decode(&input); err != nil || len(input.IDs) == 0 || len(input.IDs) != len(input.ExpectedIDs) {
		http.Error(w, "Invalid provider order", http.StatusBadRequest)
		return
	}
	input.Action = "reorder"
	w.Header().Set("Cache-Control", "no-store")
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	result, err := runProviderBridge(ctx, input)
	if err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	writeSDKJSON(w, http.StatusOK, result)
}
