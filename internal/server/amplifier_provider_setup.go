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
	"path/filepath"
	"time"

	"github.com/kenotron-ms/muxterm/internal/amplifierchat"
)

//go:embed amplifier_provider_bridge.py
var amplifierProviderBridge string

type providerBridgeRequest struct {
	Action           string `json:"action"`
	Provider         string `json:"provider,omitempty"`
	CredentialSource string `json:"credentialSource,omitempty"`
	APIKey           string `json:"apiKey,omitempty"`
	Model            string `json:"model,omitempty"`
	MakeDefault      bool   `json:"makeDefault,omitempty"`
}

func validAmplifierProvider(id string) bool {
	switch id {
	case "anthropic", "openai", "gemini":
		return true
	}
	return false
}

func runProviderBridge(ctx context.Context, input providerBridgeRequest) (map[string]any, error) {
	binary, err := amplifierchat.CLIExecutable()
	if err != nil {
		return nil, errors.New("Amplifier is not installed")
	}
	probe := exec.CommandContext(ctx, binary, "--version")
	probe.Stdout = io.Discard
	probe.Stderr = io.Discard
	if probe.Run() != nil {
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
	cmd := exec.CommandContext(ctx, uv, "tool", "install", "--from", "git+https://github.com/microsoft/amplifier", "amplifier")
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		http.Error(w, "Amplifier installation failed. Check network access and the uv installation, then retry.", http.StatusBadGateway)
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
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	result, err := runProviderBridge(ctx, providerBridgeRequest{Action: "status"})
	if err != nil {
		writeSDKJSON(w, http.StatusOK, map[string]any{"cliInstalled": false, "configured": false, "primary": "", "providers": []any{}, "error": err.Error()})
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
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
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
