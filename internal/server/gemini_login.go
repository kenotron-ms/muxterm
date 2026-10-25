package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/creack/pty"
)

// Gemini CLI owns the OAuth exchange and credential file. This PTY only makes
// its headless authorization-code prompt usable from the browser.
type geminiLogin struct {
	cmd     *exec.Cmd
	tty     *os.File
	state   string
	url     string
	message string
	output  string
	entered bool
}

type geminiLoginStatus struct {
	State   string `json:"state"`
	URL     string `json:"url,omitempty"`
	Message string `json:"message,omitempty"`
}

var geminiAuthURL = regexp.MustCompile(`https://accounts\.google\.com/o/oauth2/v2/auth\?[^\s\x00-\x20\x1b<>]+`)
var geminiANSI = regexp.MustCompile("\x1b\\[[0-9;?]*[ -/]*[@-~]")

func geminiAuthModePath() (string, error) {
	dataHome := os.Getenv("XDG_DATA_HOME")
	if dataHome == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dataHome = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(dataHome, "muxterm", "gemini-auth-mode"), nil
}

func geminiAuthMode() string {
	path, err := geminiAuthModePath()
	if err != nil {
		return "google"
	}
	data, err := os.ReadFile(path)
	if err == nil && strings.TrimSpace(string(data)) == "api-key" {
		return "api-key"
	}
	return "google"
}

func (s *Server) handleGeminiAuth(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeSDKJSON(w, http.StatusOK, map[string]any{
			"mode": geminiAuthMode(), "apiKeyDetected": sdkAmplifierProviderKey("GEMINI_API_KEY") != "",
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
	if err := json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&input); err != nil || (input.Mode != "google" && input.Mode != "api-key") {
		http.Error(w, "Choose Google sign-in or a detected API key", http.StatusBadRequest)
		return
	}
	if input.Mode == "api-key" && sdkAmplifierProviderKey("GEMINI_API_KEY") == "" {
		http.Error(w, "GEMINI_API_KEY is not configured", http.StatusConflict)
		return
	}
	path, err := geminiAuthModePath()
	if err == nil {
		err = os.MkdirAll(filepath.Dir(path), 0700)
	}
	if err == nil {
		var file *os.File
		file, err = os.CreateTemp(filepath.Dir(path), ".gemini-auth-*")
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
		http.Error(w, "Could not save Gemini authentication choice", http.StatusInternalServerError)
		return
	}
	writeSDKJSON(w, http.StatusOK, map[string]any{
		"mode": input.Mode, "apiKeyDetected": sdkAmplifierProviderKey("GEMINI_API_KEY") != "",
	})
}

func (s *Server) geminiLoginStatusLocked() geminiLoginStatus {
	if s.geminiLogin == nil {
		return geminiLoginStatus{State: "idle"}
	}
	login := s.geminiLogin
	return geminiLoginStatus{State: login.state, URL: login.url, Message: login.message}
}

func (s *Server) handleGeminiLogin(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.geminiLoginMu.Lock()
		status := s.geminiLoginStatusLocked()
		s.geminiLoginMu.Unlock()
		writeSDKJSON(w, http.StatusOK, status)
	case http.MethodPost:
		s.geminiLoginMu.Lock()
		if s.geminiLogin != nil && (s.geminiLogin.state == "starting" || s.geminiLogin.state == "awaiting_code" || s.geminiLogin.state == "verifying") {
			status := s.geminiLoginStatusLocked()
			s.geminiLoginMu.Unlock()
			writeSDKJSON(w, http.StatusOK, status)
			return
		}
		old := s.geminiLogin
		s.geminiLogin = nil
		if old != nil {
			_ = old.tty.Close()
			_ = old.cmd.Process.Kill()
		}
		command := sdkACPExecutable("gemini")
		if _, err := exec.LookPath(command); err != nil {
			s.geminiLoginMu.Unlock()
			http.Error(w, "Gemini CLI is not installed", http.StatusConflict)
			return
		}
		cmd := exec.Command(command, "--skip-trust")
		cmd.Env = append(os.Environ(), "NO_BROWSER=true")
		tty, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 40, Cols: 2048})
		if err != nil {
			s.geminiLoginMu.Unlock()
			http.Error(w, "Could not start Gemini CLI login", http.StatusBadGateway)
			return
		}
		login := &geminiLogin{cmd: cmd, tty: tty, state: "starting"}
		s.geminiLogin = login
		s.geminiLoginMu.Unlock()
		go s.readGeminiLogin(login)
		go s.waitGeminiLogin(login)
		time.AfterFunc(time.Minute, func() {
			s.geminiLoginMu.Lock()
			if s.geminiLogin == login && login.state == "starting" {
				login.state = "error"
				login.message = "Gemini CLI did not show a Google sign-in link. Use the terminal login instead."
				_ = login.tty.Close()
				_ = login.cmd.Process.Kill()
			}
			s.geminiLoginMu.Unlock()
		})
		writeSDKJSON(w, http.StatusAccepted, geminiLoginStatus{State: "starting"})
	case http.MethodDelete:
		s.geminiLoginMu.Lock()
		login := s.geminiLogin
		s.geminiLogin = nil
		s.geminiLoginMu.Unlock()
		if login != nil {
			_ = login.tty.Close()
			_ = login.cmd.Process.Kill()
		}
		writeSDKJSON(w, http.StatusOK, geminiLoginStatus{State: "idle"})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleGeminiLoginCode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var input struct {
		Code string `json:"code"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 4096))
	if err := decoder.Decode(&input); err != nil {
		http.Error(w, "Invalid authorization code", http.StatusBadRequest)
		return
	}
	code := strings.TrimSpace(input.Code)
	if code == "" || len(code) > 2048 || strings.ContainsAny(code, "\r\n\x00") {
		http.Error(w, "Invalid authorization code", http.StatusBadRequest)
		return
	}
	s.geminiLoginMu.Lock()
	login := s.geminiLogin
	if login == nil || login.state != "awaiting_code" {
		s.geminiLoginMu.Unlock()
		http.Error(w, "Gemini CLI is not waiting for an authorization code", http.StatusConflict)
		return
	}
	login.state = "verifying"
	login.url = ""
	login.output = "" // Do not retain the authorization code if the PTY echoes it.
	tty := login.tty
	s.geminiLoginMu.Unlock()
	_, err := io.WriteString(tty, code+"\r")
	s.geminiLoginMu.Lock()
	active := s.geminiLogin == login && login.state == "verifying"
	if active && err == nil {
		time.AfterFunc(time.Minute, func() {
			s.geminiLoginMu.Lock()
			if s.geminiLogin == login && login.state == "verifying" {
				login.state = "error"
				login.message = "Gemini CLI did not confirm sign-in. Try again or use a terminal."
				_ = login.tty.Close()
				_ = login.cmd.Process.Kill()
			}
			s.geminiLoginMu.Unlock()
		})
	} else if active {
		login.state = "error"
		login.message = "Could not send the authorization code to Gemini CLI. Try again."
	}
	s.geminiLoginMu.Unlock()
	if !active {
		http.Error(w, "Gemini CLI sign-in was cancelled", http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, "Could not send the authorization code to Gemini CLI", http.StatusBadGateway)
		return
	}
	writeSDKJSON(w, http.StatusAccepted, geminiLoginStatus{State: "verifying"})
}

func (s *Server) readGeminiLogin(login *geminiLogin) {
	buffer := make([]byte, 8192)
	for {
		n, err := login.tty.Read(buffer)
		if n > 0 {
			s.geminiLoginMu.Lock()
			if s.geminiLogin == login && (login.state == "starting" || login.state == "awaiting_code") {
				login.output = (login.output + geminiANSI.ReplaceAllString(string(buffer[:n]), ""))
				if len(login.output) > 32768 {
					login.output = login.output[len(login.output)-32768:]
				}
				if login.state == "starting" && !login.entered && strings.Contains(login.output, "Sign in with Google") {
					login.entered = true
					go func() {
						time.Sleep(300 * time.Millisecond)
						s.geminiLoginMu.Lock()
						active := s.geminiLogin == login && login.state == "starting"
						tty := login.tty
						s.geminiLoginMu.Unlock()
						if active {
							_, _ = io.WriteString(tty, "\r")
						}
					}()
				}
				if match := geminiAuthURL.FindString(login.output); match != "" {
					match = strings.TrimRight(match, ").,;]")
					if target, parseErr := url.Parse(match); parseErr == nil && target.Scheme == "https" && target.Host == "accounts.google.com" {
						login.url = match
						login.state = "awaiting_code"
						time.AfterFunc(10*time.Minute, func() {
							s.geminiLoginMu.Lock()
							if s.geminiLogin == login && login.state == "awaiting_code" {
								login.state = "error"
								login.message = "The Google sign-in link expired. Start again."
								_ = login.tty.Close()
								_ = login.cmd.Process.Kill()
							}
							s.geminiLoginMu.Unlock()
						})
					}
				}
			}
			s.geminiLoginMu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

func (s *Server) waitGeminiLogin(login *geminiLogin) {
	err := login.cmd.Wait()
	_ = login.tty.Close()
	s.geminiLoginMu.Lock()
	defer s.geminiLoginMu.Unlock()
	if s.geminiLogin != login || login.state == "error" {
		return
	}
	if err == nil && login.state == "verifying" {
		login.state = "complete"
		login.message = "Gemini CLI finished signing in. Check the connection."
		return
	}
	login.state = "error"
	login.message = "Gemini CLI login ended before sign-in completed. Try again or use a terminal."
}
