package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/kenotron-ms/muxterm/internal/secretfile"
)

// Unified owns its host and token. Muxterm stores only the choice of host and,
// for an existing host, a write-only token in its own instance data directory.
// The local choice discovers Unified's normal owner-only token automatically.
const unifiedLocalURL = "http://127.0.0.1:8941"

type unifiedConnectionSettings struct {
	Mode string `json:"mode"` // local or existing
	URL  string `json:"url,omitempty"`
}

type unifiedConnectionStatus struct {
	Mode             string `json:"mode"`
	URL              string `json:"url"`
	Installed        bool   `json:"installed"`
	InstallSupported bool   `json:"installSupported"`
	TokenConfigured  bool   `json:"tokenConfigured"`
	Connected        bool   `json:"connected"`
	Message          string `json:"message,omitempty"`
}

var unifiedSettingsMu sync.Mutex
var unifiedInstallMu sync.Mutex

func unifiedSettingsDir() string  { return filepath.Join(sdkDataDir(), "unified") }
func unifiedSettingsFile() string { return filepath.Join(unifiedSettingsDir(), "connection.json") }
func unifiedTokenFile() string    { return filepath.Join(unifiedSettingsDir(), "control-token") }

func unifiedLocalDataDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".amplifier-unified"), nil
}

func readUnifiedSettings() (unifiedConnectionSettings, error) {
	data, err := os.ReadFile(unifiedSettingsFile())
	if errors.Is(err, os.ErrNotExist) {
		return unifiedConnectionSettings{Mode: "local"}, nil
	}
	if err != nil {
		return unifiedConnectionSettings{}, err
	}
	var settings unifiedConnectionSettings
	if err := json.Unmarshal(data, &settings); err != nil {
		return settings, err
	}
	if settings.Mode != "local" && settings.Mode != "existing" {
		return settings, errors.New("invalid Unified connection mode")
	}
	if settings.Mode == "existing" {
		if _, err := validateUnifiedURL(settings.URL); err != nil {
			return settings, err
		}
	}
	return settings, nil
}

func validateUnifiedURL(value string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil || u == nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" ||
		(u.Scheme != "http" && u.Scheme != "https") {
		return "", errors.New("Enter a Unified HTTP or HTTPS origin without a path, query, or credentials")
	}
	if u.Scheme == "http" && u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1" {
		return "", errors.New("Use HTTPS for a Unified host outside this computer")
	}
	return u.Scheme + "://" + u.Host, nil
}

func unifiedConnection() (string, string, error) {
	settings, err := readUnifiedSettings()
	if err != nil {
		return "", "", err
	}
	if settings.Mode == "local" {
		dataDir, err := unifiedLocalDataDir()
		if err != nil {
			return "", "", err
		}
		return unifiedLocalURL, filepath.Join(dataDir, "config", "auth", "control-token"), nil
	}
	return settings.URL, unifiedTokenFile(), nil
}

func unifiedConnectionAvailable() bool {
	_, tokenFile, err := unifiedConnection()
	return err == nil && secretfile.New(tokenFile).Present()
}

func unifiedExecutable() (string, error) {
	if path, err := exec.LookPath("amplifier-unified"); err == nil {
		return path, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	path := filepath.Join(home, ".local", "bin", "amplifier-unified")
	if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && info.Mode()&0111 != 0 {
		return path, nil
	}
	return "", errors.New("Amplifier Unified is not installed")
}

func unifiedStatus() unifiedConnectionStatus {
	settings, err := readUnifiedSettings()
	status := unifiedConnectionStatus{Mode: settings.Mode, URL: settings.URL,
		InstallSupported: (runtime.GOOS == "linux" || runtime.GOOS == "darwin") && os.Getenv("MUXTERM_DEV_INSTANCE") != "1"}
	if status.Mode == "" {
		status.Mode = "local"
	}
	if status.Mode == "local" {
		status.URL = unifiedLocalURL
	}
	_, executableErr := unifiedExecutable()
	status.Installed = executableErr == nil
	if err != nil {
		status.Message = "Could not read the saved Unified connection"
		return status
	}
	_, tokenFile, err := unifiedConnection()
	if err == nil {
		status.TokenConfigured = secretfile.New(tokenFile).Present()
	}
	return status
}

func writeUnifiedJSON(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}

func (s *Server) handleUnifiedConnectionGet(w http.ResponseWriter, _ *http.Request) {
	writeUnifiedJSON(w, http.StatusOK, unifiedStatus())
}

func (s *Server) handleUnifiedConnectionPut(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Mode  string `json:"mode"`
		URL   string `json:"url"`
		Token string `json:"token"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&input) != nil ||
		(input.Mode != "local" && input.Mode != "existing") {
		http.Error(w, "Choose this computer or an existing Unified host", http.StatusBadRequest)
		return
	}
	settings := unifiedConnectionSettings{Mode: input.Mode}
	if input.Mode == "existing" {
		var err error
		settings.URL, err = validateUnifiedURL(input.URL)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}
	unifiedSettingsMu.Lock()
	defer unifiedSettingsMu.Unlock()
	if input.Mode == "existing" && strings.TrimSpace(input.Token) == "" {
		previous, err := readUnifiedSettings()
		if err != nil || previous.Mode != "existing" || previous.URL != settings.URL || !secretfile.New(unifiedTokenFile()).Present() {
			http.Error(w, "Enter the existing host's control token", http.StatusBadRequest)
			return
		}
	}
	if input.Mode == "existing" && strings.TrimSpace(input.Token) != "" {
		if err := secretfile.New(unifiedTokenFile()).Save(input.Token); err != nil {
			http.Error(w, "Could not save the Unified token", http.StatusInternalServerError)
			return
		}
	}
	if err := os.MkdirAll(unifiedSettingsDir(), 0700); err != nil {
		http.Error(w, "Could not create Unified settings", http.StatusInternalServerError)
		return
	}
	data, _ := json.Marshal(settings)
	tmp, err := os.CreateTemp(unifiedSettingsDir(), ".connection-*")
	if err == nil {
		defer os.Remove(tmp.Name())
		err = tmp.Chmod(0600)
		if err == nil {
			_, err = tmp.Write(data)
		}
		closeErr := tmp.Close()
		if err == nil {
			err = closeErr
		}
		if err == nil {
			err = os.Rename(tmp.Name(), unifiedSettingsFile())
		}
	}
	if err != nil {
		http.Error(w, "Could not save Unified settings", http.StatusInternalServerError)
		return
	}
	if input.Mode == "local" {
		_ = secretfile.New(unifiedTokenFile()).Clear()
	}
	writeUnifiedJSON(w, http.StatusOK, unifiedStatus())
}

func (s *Server) handleUnifiedConnectionCheck(w http.ResponseWriter, r *http.Request) {
	base, tokenFile, err := unifiedConnection()
	if err != nil {
		http.Error(w, "Unified connection is not configured", http.StatusBadRequest)
		return
	}
	token, err := secretfile.New(tokenFile).Load()
	if err != nil || token == "" {
		http.Error(w, "Unified control token is unavailable", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/clients/attach",
		bytes.NewBufferString(`{"clientId":"muxterm-connection-check","kind":"native","protocolVersion":1,"includeState":false}`))
	if err != nil {
		http.Error(w, "Invalid Unified host", http.StatusBadRequest)
		return
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Amplifier-Client", "muxterm-connection-check")
	client := &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		http.Error(w, "Could not reach Unified at the configured address", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		http.Error(w, fmt.Sprintf("Unified rejected the connection (HTTP %d)", response.StatusCode), http.StatusBadGateway)
		return
	}
	var result struct {
		ProtocolVersion int    `json:"protocolVersion"`
		HostInstanceID  string `json:"hostInstanceId"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&result) != nil || result.ProtocolVersion != 1 || result.HostInstanceID == "" {
		http.Error(w, "Unified does not support the connected-client contract", http.StatusBadGateway)
		return
	}
	status := unifiedStatus()
	status.Connected = true
	writeUnifiedJSON(w, http.StatusOK, status)
}

func (s *Server) handleUnifiedInstall(w http.ResponseWriter, r *http.Request) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" || os.Getenv("MUXTERM_DEV_INSTANCE") == "1" {
		http.Error(w, "Install Unified from a deployed Linux or macOS Muxterm instance", http.StatusBadRequest)
		return
	}
	unifiedInstallMu.Lock()
	defer unifiedInstallMu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Minute)
	defer cancel()
	bin, err := unifiedExecutable()
	freshInstall := err != nil
	if err != nil {
		curlPath, lookupErr := exec.LookPath("curl")
		if lookupErr != nil {
			http.Error(w, "The curl installer is unavailable on this computer", http.StatusBadRequest)
			return
		}
		installer, createErr := os.CreateTemp("", "muxterm-unified-install-*.sh")
		if createErr != nil {
			http.Error(w, "Could not prepare the Unified installer", http.StatusInternalServerError)
			return
		}
		defer os.Remove(installer.Name())
		installerPath := installer.Name()
		if closeErr := installer.Close(); closeErr != nil {
			http.Error(w, "Could not prepare the Unified installer", http.StatusInternalServerError)
			return
		}
		cmd := exec.CommandContext(ctx, curlPath, "--proto", "=https", "--tlsv1.2", "-fsSL", "https://raw.githubusercontent.com/microsoft/amplifier-unified/main/scripts/install.sh", "-o", installerPath)
		if output, runErr := cmd.CombinedOutput(); runErr != nil {
			_ = output
			http.Error(w, "Could not download the official Unified installer", http.StatusBadGateway)
			return
		}
		cmd = exec.CommandContext(ctx, "bash", installerPath, "--no-open")
		cmd.Env = append(os.Environ(), "UV_LINK_MODE=copy")
		if output, runErr := cmd.CombinedOutput(); runErr != nil {
			_ = output // Installer output is never sent to the browser.
			http.Error(w, "Could not install Amplifier Unified", http.StatusBadGateway)
			return
		}
		bin, err = unifiedExecutable()
		if err != nil {
			http.Error(w, "Unified was installed but its command was not found", http.StatusBadGateway)
			return
		}
	}
	if !freshInstall {
		check := exec.CommandContext(ctx, bin, "service", "status", "--wait", "1")
		if check.Run() != nil {
			start := exec.CommandContext(ctx, bin, "service", "start")
			if start.Run() != nil {
				install := exec.CommandContext(ctx, bin, "service", "install")
				if install.Run() != nil {
					http.Error(w, "Unified is installed, but its background service could not start", http.StatusBadGateway)
					return
				}
			}
		}
	}
	cmd := exec.CommandContext(ctx, bin, "service", "status", "--wait", "60")
	if output, runErr := cmd.CombinedOutput(); runErr != nil {
		_ = output
		http.Error(w, "Unified service was installed but did not become ready; check its service status", http.StatusBadGateway)
		return
	}
	writeUnifiedJSON(w, http.StatusOK, unifiedStatus())
}
