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
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
)

type antigravityLogin struct {
	cmd      *exec.Cmd
	tty      *os.File
	state    string
	url      string
	message  string
	output   string // Bounded in-memory startup diagnostics; cleared before submitting auth input.
	closeTTY sync.Once
}

type antigravityLoginStatus struct {
	State   string `json:"state"`
	URL     string `json:"url,omitempty"`
	Message string `json:"message,omitempty"`
}

var antigravityAuthURL = regexp.MustCompile(`https://accounts\.google\.com/o/oauth2/(?:v2/)?auth\?[^\s\x00-\x20\x1b<>]+`)
var antigravityANSI = regexp.MustCompile("\x1b\\[[0-9;?]*[ -/]*[@-~]")
var antigravityAuthCode = regexp.MustCompile(`^[A-Za-z0-9/+_.=-]+$`)

func (login *antigravityLogin) closeTerminal() {
	if login == nil {
		return
	}
	login.closeTTY.Do(func() {
		if login.tty != nil {
			_ = login.tty.Close()
		}
	})
}

func stopAntigravityLoginProcess(login *antigravityLogin) {
	if login == nil {
		return
	}
	login.closeTerminal()
	if login.cmd != nil && login.cmd.Process != nil {
		_ = login.cmd.Process.Kill()
	}
}

func (s *Server) cancelAntigravityLogin() {
	s.antigravityLoginMu.Lock()
	login := s.antigravityLogin
	s.antigravityLogin = nil
	s.antigravityLoginMu.Unlock()
	stopAntigravityLoginProcess(login)
}

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
	return antigravityCLIAvailable()
}

func (s *Server) handleAntigravityAuth(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		_, installSupported := antigravityCLIArchives[runtime.GOOS+"/"+runtime.GOARCH]
		unsupportedReason := ""
		if !installSupported {
			unsupportedReason = antigravityUnsupportedReason
		}
		writeSDKJSON(w, http.StatusOK, map[string]any{
			"mode": antigravityMode(), "apiKeyDetected": sdkAmplifierProviderKey("GEMINI_API_KEY") != "",
			"installed":                antigravityAvailable(),
			"installSupported":         installSupported,
			"installUnsupportedReason": unsupportedReason,
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
	s.antigravityLoginMu.Lock()
	loginActive := input.Mode != antigravityMode() && s.antigravityLogin != nil &&
		(s.antigravityLogin.state == "starting" || s.antigravityLogin.state == "awaiting_code" || s.antigravityLogin.state == "verifying")
	s.antigravityLoginMu.Unlock()
	if loginActive {
		http.Error(w, "Finish or cancel the current Antigravity sign-in before changing authentication mode", http.StatusConflict)
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
	w.Header().Set("Cache-Control", "no-store")
	switch r.Method {
	case http.MethodGet:
		if antigravityMode() == "google" {
			s.antigravityLoginMu.Lock()
			status := s.antigravityLoginStatusLocked()
			s.antigravityLoginMu.Unlock()
			writeSDKJSON(w, http.StatusOK, status)
			return
		}
		s.antigravityLoginSidecar(w, r, "antigravity-login-status")
	case http.MethodPost:
		if !antigravityAvailable() {
			http.Error(w, "Install the verified Antigravity CLI before signing in", http.StatusConflict)
			return
		}
		if antigravityMode() == "google" {
			s.startAntigravityLogin(w)
			return
		}
		if sdkAmplifierProviderKey("GEMINI_API_KEY") == "" {
			http.Error(w, "GEMINI_API_KEY is not configured", http.StatusConflict)
			return
		}
		s.antigravityLoginSidecar(w, r, "antigravity-login-start")
	case http.MethodDelete:
		if antigravityMode() == "google" {
			s.cancelAntigravityLogin()
			writeSDKJSON(w, http.StatusOK, antigravityLoginStatus{State: "idle"})
			return
		}
		s.antigravityLoginSidecar(w, r, "antigravity-login-cancel")
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) antigravityLoginSidecar(w http.ResponseWriter, r *http.Request, op string) {
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

func (s *Server) antigravityLoginStatusLocked() antigravityLoginStatus {
	if s.antigravityLogin == nil {
		return antigravityLoginStatus{State: "idle"}
	}
	login := s.antigravityLogin
	return antigravityLoginStatus{State: login.state, URL: login.url, Message: login.message}
}

func (s *Server) startAntigravityLogin(w http.ResponseWriter) {
	s.antigravityLoginMu.Lock()
	if s.antigravityLogin != nil && (s.antigravityLogin.state == "starting" || s.antigravityLogin.state == "awaiting_code" || s.antigravityLogin.state == "verifying") {
		status := s.antigravityLoginStatusLocked()
		s.antigravityLoginMu.Unlock()
		writeSDKJSON(w, http.StatusOK, status)
		return
	}
	old := s.antigravityLogin
	login := &antigravityLogin{state: "starting"}
	s.antigravityLogin = login
	s.antigravityLoginMu.Unlock()
	stopAntigravityLoginProcess(old)

	command := antigravityCLIPath()
	if _, err := exec.LookPath(command); err != nil {
		s.failAntigravityLogin(login, "Antigravity CLI is not installed")
		http.Error(w, "Antigravity CLI is not installed", http.StatusConflict)
		return
	}
	cmd := exec.Command("sh", "-c", `stty -echo && exec "$@"`, "agy-login", command, "acp", "--login")
	cmd.Env = make([]string, 0, len(os.Environ()))
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "GEMINI_API_KEY=") && !strings.HasPrefix(entry, "GOOGLE_API_KEY=") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	tty, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 40, Cols: 2048})
	if err != nil {
		s.failAntigravityLogin(login, "Could not start Antigravity sign-in")
		http.Error(w, "Could not start Antigravity sign-in", http.StatusBadGateway)
		return
	}
	s.antigravityLoginMu.Lock()
	active := s.antigravityLogin == login && login.state == "starting"
	if active {
		login.cmd = cmd
		login.tty = tty
	}
	s.antigravityLoginMu.Unlock()
	if !active {
		stopAntigravityLoginProcess(&antigravityLogin{cmd: cmd, tty: tty})
		go func() { _ = cmd.Wait() }()
		http.Error(w, "Antigravity sign-in was cancelled", http.StatusConflict)
		return
	}
	go s.readAntigravityLogin(login)
	go s.waitAntigravityLogin(login)
	time.AfterFunc(time.Minute, func() {
		s.antigravityLoginMu.Lock()
		expired := s.antigravityLogin == login && login.state == "starting"
		if expired {
			login.state = "error"
			login.message = "Antigravity did not show a Google sign-in link. Start again, or use `agy acp --login` in a terminal."
		}
		s.antigravityLoginMu.Unlock()
		if expired {
			stopAntigravityLoginProcess(login)
		}
	})
	writeSDKJSON(w, http.StatusAccepted, antigravityLoginStatus{State: "starting"})
}

func (s *Server) failAntigravityLogin(login *antigravityLogin, message string) {
	s.antigravityLoginMu.Lock()
	defer s.antigravityLoginMu.Unlock()
	if s.antigravityLogin == login {
		login.state = "error"
		login.message = message
	}
}

func (s *Server) handleAntigravityLoginCode(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if antigravityMode() != "google" {
		http.Error(w, "Google sign-in is not selected", http.StatusConflict)
		return
	}
	var input struct {
		Code string `json:"code"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&input) != nil {
		http.Error(w, "Enter the Google authorization code or localhost callback URL", http.StatusBadRequest)
		return
	}
	code := strings.TrimSpace(input.Code)
	if !validAntigravityAuthResponse(code) {
		http.Error(w, "Enter the Google authorization code or localhost callback URL", http.StatusBadRequest)
		return
	}
	s.antigravityLoginMu.Lock()
	login := s.antigravityLogin
	if login == nil || login.state != "awaiting_code" {
		s.antigravityLoginMu.Unlock()
		http.Error(w, "Antigravity is not waiting for a Google authorization code", http.StatusConflict)
		return
	}
	login.state = "verifying"
	login.url = ""
	login.output = ""
	tty := login.tty
	s.antigravityLoginMu.Unlock()
	written, err := io.WriteString(tty, code+"\r")
	if err == nil && written != len(code)+1 {
		err = io.ErrShortWrite
	}
	code = ""
	input.Code = ""
	s.antigravityLoginMu.Lock()
	completed := s.antigravityLogin == login && login.state == "complete"
	active := s.antigravityLogin == login && login.state == "verifying"
	if active && err != nil {
		login.state = "error"
		login.message = "Could not send the Google authorization code to Antigravity. Start sign-in again."
	}
	s.antigravityLoginMu.Unlock()
	if completed {
		writeSDKJSON(w, http.StatusOK, antigravityLoginStatus{State: "complete"})
		return
	}
	if !active {
		http.Error(w, "Antigravity sign-in was cancelled", http.StatusConflict)
		return
	}
	if err != nil {
		stopAntigravityLoginProcess(login)
		http.Error(w, "Could not send the Google authorization code to Antigravity", http.StatusBadGateway)
		return
	}
	writeSDKJSON(w, http.StatusAccepted, antigravityLoginStatus{State: "verifying"})
	time.AfterFunc(time.Minute, func() {
		s.antigravityLoginMu.Lock()
		expired := s.antigravityLogin == login && login.state == "verifying"
		if expired {
			login.state = "error"
			login.message = "Antigravity did not confirm Google sign-in. Start again and check the connection."
		}
		s.antigravityLoginMu.Unlock()
		if expired {
			stopAntigravityLoginProcess(login)
		}
	})
}

func validAntigravityAuthResponse(value string) bool {
	if len(value) == 0 || len(value) > 2048 {
		return false
	}
	if antigravityAuthCode.MatchString(value) {
		return true
	}
	callback, err := url.ParseRequestURI(value)
	if err != nil || (callback.Scheme != "http" && callback.Scheme != "https") || callback.User != nil {
		return false
	}
	host := strings.ToLower(callback.Hostname())
	if host != "localhost" && host != "127.0.0.1" && host != "::1" {
		return false
	}
	return callback.Query().Get("code") != ""
}

func (s *Server) readAntigravityLogin(login *antigravityLogin) {
	buffer := make([]byte, 8192)
	for {
		n, err := login.tty.Read(buffer)
		if n > 0 {
			s.antigravityLoginMu.Lock()
			if s.antigravityLogin == login && login.state == "starting" {
				login.output = (login.output + antigravityANSI.ReplaceAllString(string(buffer[:n]), ""))
				if len(login.output) > 32768 {
					login.output = login.output[len(login.output)-32768:]
				}
				if end := strings.LastIndexByte(login.output, '\n'); end >= 0 {
					match := antigravityAuthURL.FindString(login.output[:end])
					match = strings.TrimRight(match, ").,;]")
					if target, parseErr := url.Parse(match); parseErr == nil && target.Scheme == "https" && target.Host == "accounts.google.com" {
						login.url = match
						login.state = "awaiting_code"
						time.AfterFunc(10*time.Minute, func() {
							s.antigravityLoginMu.Lock()
							expired := s.antigravityLogin == login && login.state == "awaiting_code"
							if expired {
								login.state = "error"
								login.message = "The Google sign-in link expired. Start again."
							}
							s.antigravityLoginMu.Unlock()
							if expired {
								stopAntigravityLoginProcess(login)
							}
						})
					}
				}
			}
			s.antigravityLoginMu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

func (s *Server) waitAntigravityLogin(login *antigravityLogin) {
	err := login.cmd.Wait()
	login.closeTerminal()
	s.antigravityLoginMu.Lock()
	defer s.antigravityLoginMu.Unlock()
	if s.antigravityLogin != login || login.state == "error" {
		return
	}
	if err == nil && login.state == "verifying" {
		login.state = "complete"
		login.message = "Google sign-in completed. Checking Antigravity chat availability."
		return
	}
	login.state = "error"
	login.message = antigravityLoginFailure(login.output)
}

func antigravityLoginFailure(output string) string {
	output = antigravityANSI.ReplaceAllString(output, "")
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(strings.ReplaceAll(line, "\r", ""))
		lower := strings.ToLower(line)
		if !strings.Contains(lower, "error") && !strings.Contains(lower, "failed") && !strings.Contains(lower, "browser") {
			continue
		}
		line = antigravityAuthURL.ReplaceAllString(line, "[Google sign-in link]")
		line = strings.TrimSpace(line)
		if len(line) > 500 {
			line = line[:500]
		}
		if line != "" {
			return line
		}
	}
	return "Antigravity sign-in ended before Google authentication completed. Start sign-in again and follow the Google link."
}
