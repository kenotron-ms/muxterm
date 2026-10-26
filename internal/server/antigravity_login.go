package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func antigravityModePath() (string, error) {
	dataHome := os.Getenv("XDG_DATA_HOME")
	if dataHome == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dataHome = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(dataHome, "muxterm", "antigravity-auth-mode"), nil
}

func antigravityMode() string {
	path, err := antigravityModePath()
	if err == nil {
		data, readErr := os.ReadFile(path)
		if readErr == nil && strings.TrimSpace(string(data)) == "api-key" {
			return "api-key"
		}
	}
	return "google"
}

func antigravityAvailable() bool {
	path, err := exec.LookPath(sdkACPExecutable("antigravity"))
	if err != nil {
		return false
	}
	dir, err := antigravityManagedDir()
	if err == nil && path == filepath.Join(dir, "agy_acp_server.par") {
		return antigravityInstalled(dir)
	}
	// A separately installed agent or command override is managed by its owner.
	return true
}

func (s *Server) handleAntigravityAuth(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeSDKJSON(w, http.StatusOK, map[string]any{
			"mode": antigravityMode(), "apiKeyDetected": sdkAmplifierProviderKey("GEMINI_API_KEY") != "",
			"installed":        antigravityAvailable(),
			"installSupported": runtime.GOOS == "linux" && runtime.GOARCH == "amd64",
		})
		return
	}
	if r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var input struct {
		Mode string `json:"mode"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&input) != nil || (input.Mode != "google" && input.Mode != "api-key") {
		http.Error(w, "Choose Google sign-in or a detected API key", http.StatusBadRequest)
		return
	}
	if input.Mode == "api-key" && sdkAmplifierProviderKey("GEMINI_API_KEY") == "" {
		http.Error(w, "GEMINI_API_KEY is not configured", http.StatusConflict)
		return
	}
	path, err := antigravityModePath()
	if err == nil {
		err = os.MkdirAll(filepath.Dir(path), 0700)
	}
	if err == nil {
		var file *os.File
		file, err = os.CreateTemp(filepath.Dir(path), ".antigravity-auth-*")
		if err == nil {
			defer os.Remove(file.Name())
			_, err = file.WriteString(input.Mode + "\n")
			if closeErr := file.Close(); err == nil {
				err = closeErr
			}
			if err == nil {
				err = os.Rename(file.Name(), path)
			}
		}
	}
	if err != nil {
		http.Error(w, "Could not save Antigravity authentication choice", http.StatusInternalServerError)
		return
	}
	writeSDKJSON(w, http.StatusOK, map[string]any{
		"mode": input.Mode, "apiKeyDetected": sdkAmplifierProviderKey("GEMINI_API_KEY") != "",
	})
}

func (s *Server) handleAntigravityLogin(w http.ResponseWriter, r *http.Request) {
	op := "antigravity-login-status"
	switch r.Method {
	case http.MethodGet:
	case http.MethodPost:
		if !antigravityAvailable() {
			http.Error(w, "Antigravity ACP is not installed", http.StatusConflict)
			return
		}
		if antigravityMode() == "api-key" && sdkAmplifierProviderKey("GEMINI_API_KEY") == "" {
			http.Error(w, "GEMINI_API_KEY is not configured", http.StatusConflict)
			return
		}
		op = "antigravity-login-start"
	case http.MethodDelete:
		op = "antigravity-login-cancel"
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	result, err := s.sdkChats.call(ctx, op, map[string]any{})
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(result)
}

func (s *Server) handleAntigravityLoginCallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var input struct {
		URL string `json:"url"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&input) != nil || input.URL == "" {
		http.Error(w, "Paste the complete Google callback URL", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	result, err := s.sdkChats.call(ctx, "antigravity-login-finish", map[string]any{"callbackURL": input.URL})
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(result)
}
