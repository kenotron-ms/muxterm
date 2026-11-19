package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/kenotron-ms/muxterm/internal/secretfile"
)

type meetingTURNConfig struct {
	URLs   []string `json:"urls,omitempty"`
	Secret string   `json:"secret,omitempty"`
	APIURL string   `json:"apiUrl,omitempty"`
	APIKey string   `json:"apiKey,omitempty"`
}

type meetingTURNStatus struct {
	URLs                 []string `json:"urls"`
	Server               string   `json:"server"`
	Source               string   `json:"source"`
	AuthConfigured       bool     `json:"authConfigured"`
	LocalSecretAvailable bool     `json:"localSecretAvailable"`
	Mode                 string   `json:"mode"`
	APIURL               string   `json:"apiUrl,omitempty"`
}

var meetingTURNSettingsMu sync.Mutex

const defaultMeetingTURNServer = "turn.ampbox.io"
const defaultMeetingTURNAPIURL = "https://turn.ampbox.io"

func meetingTURNConfigBase() string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".config")
	}
	return base
}

func meetingTURNSettingsStore() *secretfile.Store {
	return secretfile.New(filepath.Join(meetingTURNConfigBase(), "muxterm", "meeting_turn.json"))
}

func localMeetingTURNSecretStore() *secretfile.Store {
	return secretfile.New(filepath.Join(meetingTURNConfigBase(), "muxterm-turn", "secret"))
}

func meetingTURNURLsForServer(server string) ([]string, error) {
	server = strings.TrimSpace(server)
	u, err := url.Parse("https://" + server)
	if err != nil || u.Hostname() == "" || u.Host != server || u.Port() != "" ||
		u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("enter a server name such as turn.ampbox.io, without a scheme or port")
	}
	return []string{
		"turn:" + server + ":3478?transport=udp",
		"turn:" + server + ":3478?transport=tcp",
	}, nil
}

func meetingTURNServerName(urls []string) string {
	if len(urls) == 0 {
		return ""
	}
	parts := strings.SplitN(strings.TrimPrefix(strings.TrimPrefix(urls[0], "turn:"), "turns:"), "?", 2)
	u, err := url.Parse("https://" + parts[0])
	if err != nil {
		return ""
	}
	return u.Hostname()
}

func validateMeetingTURNConfig(cfg meetingTURNConfig) error {
	if cfg.APIURL != "" || cfg.APIKey != "" {
		if len(cfg.URLs) != 0 || cfg.Secret != "" {
			return errors.New("choose either a TURN service API key or a shared secret")
		}
		if err := validateMeetingTURNAPIURL(cfg.APIURL); err != nil {
			return err
		}
		if !strings.HasPrefix(cfg.APIKey, "mtturn_") || len(cfg.APIKey) < 40 || strings.ContainsAny(cfg.APIKey, " \t\r\n") {
			return errors.New("enter the API key created by the TURN service")
		}
		return nil
	}
	if len(cfg.URLs) < 1 || len(cfg.URLs) > 8 {
		return errors.New("enter one to eight TURN URLs")
	}
	for _, raw := range cfg.URLs {
		if raw != strings.TrimSpace(raw) || strings.ContainsAny(raw, " \t\r\n") {
			return errors.New("TURN URLs cannot contain whitespace")
		}
		parts := strings.SplitN(raw, ":", 2)
		if len(parts) != 2 || (parts[0] != "turn" && parts[0] != "turns") {
			return errors.New("TURN URLs must start with turn: or turns:")
		}
		value := strings.SplitN(parts[1], "?", 2)
		u, err := url.Parse("https://" + value[0])
		if err != nil || u.Hostname() == "" || u.User != nil || u.Path != "" || u.Fragment != "" || u.RawQuery != "" {
			return errors.New("each TURN URL needs a host and numeric port")
		}
		port, err := strconv.Atoi(u.Port())
		if err != nil || port < 1 || port > 65535 {
			return errors.New("each TURN URL needs a port from 1 to 65535")
		}
		if len(value) == 2 {
			q, err := url.ParseQuery(value[1])
			if err != nil || len(q) != 1 || len(q["transport"]) != 1 || (q.Get("transport") != "udp" && q.Get("transport") != "tcp") {
				return errors.New("TURN URL query must be ?transport=udp or ?transport=tcp")
			}
		}
	}
	if len(cfg.Secret) < 32 {
		return errors.New("TURN shared secret must contain at least 32 characters")
	}
	return nil
}

func validateMeetingTURNAPIURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil ||
		u.Port() != "" || strings.TrimSuffix(u.String(), "/") != raw {
		return errors.New("enter the HTTPS origin of the TURN service, such as https://turn.ampbox.io")
	}
	return nil
}

func environmentMeetingTURNConfig() (meetingTURNConfig, error) {
	rawURLs := strings.TrimSpace(os.Getenv("MUXTERM_MEETING_TURN_URLS"))
	secretPath := strings.TrimSpace(os.Getenv("MUXTERM_MEETING_TURN_SECRET_FILE"))
	if rawURLs == "" && secretPath == "" {
		return meetingTURNConfig{}, nil
	}
	if rawURLs == "" || secretPath == "" {
		return meetingTURNConfig{}, errors.New("set both MUXTERM_MEETING_TURN_URLS and MUXTERM_MEETING_TURN_SECRET_FILE")
	}
	secret, err := os.ReadFile(secretPath)
	if err != nil {
		return meetingTURNConfig{}, fmt.Errorf("read TURN secret file: %w", err)
	}
	cfg := meetingTURNConfig{URLs: strings.Split(rawURLs, ","), Secret: strings.TrimSpace(string(secret))}
	for i := range cfg.URLs {
		cfg.URLs[i] = strings.TrimSpace(cfg.URLs[i])
	}
	return cfg, validateMeetingTURNConfig(cfg)
}

// Saved settings override the legacy environment configuration. The settings
// file is 0600 because it contains the coturn REST shared secret.
func loadMeetingTURNConfig() (meetingTURNConfig, string, error) {
	stored, err := meetingTURNSettingsStore().Load()
	if err != nil {
		return meetingTURNConfig{}, "", err
	}
	if stored != "" {
		var cfg meetingTURNConfig
		if err := json.Unmarshal([]byte(stored), &cfg); err != nil {
			return meetingTURNConfig{}, "", errors.New("saved TURN settings are unreadable")
		}
		if err := validateMeetingTURNConfig(cfg); err != nil {
			return meetingTURNConfig{}, "", fmt.Errorf("saved TURN settings: %w", err)
		}
		return cfg, "stored", nil
	}
	cfg, err := environmentMeetingTURNConfig()
	if err != nil {
		return meetingTURNConfig{}, "", err
	}
	if len(cfg.URLs) != 0 {
		return cfg, "environment", nil
	}
	return cfg, "none", nil
}

func currentMeetingTURNStatus() (meetingTURNStatus, error) {
	cfg, source, err := loadMeetingTURNConfig()
	if err != nil {
		return meetingTURNStatus{}, err
	}
	if cfg.URLs == nil {
		cfg.URLs = []string{}
	}
	local, _ := localMeetingTURNSecretStore().Load()
	if cfg.APIURL != "" {
		return meetingTURNStatus{URLs: []string{}, Source: source, AuthConfigured: cfg.APIKey != "",
			LocalSecretAvailable: len(local) >= 32, Mode: "service", APIURL: cfg.APIURL}, nil
	}
	if source == "none" {
		return meetingTURNStatus{URLs: []string{}, Source: source, Mode: "service",
			LocalSecretAvailable: len(local) >= 32, APIURL: defaultMeetingTURNAPIURL}, nil
	}
	return meetingTURNStatus{URLs: cfg.URLs, Server: meetingTURNServerName(cfg.URLs), Source: source,
		AuthConfigured: cfg.Secret != "", LocalSecretAvailable: len(local) >= 32, Mode: "shared-secret"}, nil
}

func (s *Server) handleMeetingTURNSettings(w http.ResponseWriter, r *http.Request) {
	meetingTURNSettingsMu.Lock()
	defer meetingTURNSettingsMu.Unlock()
	if r.Method == http.MethodGet {
		status, err := currentMeetingTURNStatus()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, status)
		return
	}
	if r.Method == http.MethodDelete {
		if err := meetingTURNSettingsStore().Clear(); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		status, err := currentMeetingTURNStatus()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, status)
		return
	}
	var request struct {
		Server string `json:"server"`
		Secret string `json:"secret"`
		APIURL string `json:"apiUrl"`
		APIKey string `json:"apiKey"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&request); err != nil {
		http.Error(w, "Invalid TURN settings", http.StatusBadRequest)
		return
	}
	if request.APIURL != "" || request.APIKey != "" {
		input := meetingTURNConfig{APIURL: strings.TrimSpace(request.APIURL), APIKey: strings.TrimSpace(request.APIKey)}
		if input.APIURL == "" {
			input.APIURL = defaultMeetingTURNAPIURL
		}
		if input.APIKey == "" {
			previous, _, err := loadMeetingTURNConfig()
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			if previous.APIURL == input.APIURL {
				input.APIKey = previous.APIKey
			}
		}
		if err := validateMeetingTURNConfig(input); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if _, err := fetchMeetingTURNServiceCredentials(input); err != nil {
			http.Error(w, "Could not verify TURN service: "+err.Error(), http.StatusBadGateway)
			return
		}
		encoded, err := json.Marshal(input)
		if err != nil {
			http.Error(w, "Cannot encode TURN settings", http.StatusInternalServerError)
			return
		}
		if err := meetingTURNSettingsStore().Save(string(encoded)); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		status, err := currentMeetingTURNStatus()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, status)
		return
	}
	urls, err := meetingTURNURLsForServer(request.Server)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	input := meetingTURNConfig{URLs: urls, Secret: strings.TrimSpace(request.Secret)}
	if input.Secret == "" {
		previous, _, err := loadMeetingTURNConfig()
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if meetingTURNServerName(previous.URLs) == strings.TrimSpace(request.Server) {
			input.Secret = previous.Secret
		}
		if input.Secret == "" && strings.TrimSpace(request.Server) == defaultMeetingTURNServer {
			input.Secret, err = localMeetingTURNSecretStore().Load()
			if err != nil {
				http.Error(w, "Cannot read local TURN shared secret", http.StatusInternalServerError)
				return
			}
		}
	}
	if err := validateMeetingTURNConfig(input); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		http.Error(w, "Cannot encode TURN settings", http.StatusInternalServerError)
		return
	}
	if err := meetingTURNSettingsStore().Save(string(encoded)); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	status, err := currentMeetingTURNStatus()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, status)
}
