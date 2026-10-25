package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
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
	_, err := io.WriteString(login.tty, code+"\r")
	if err == nil {
		login.state = "verifying"
		login.url = ""
		login.output = "" // The PTY may echo the code; never keep it in memory.
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
	}
	s.geminiLoginMu.Unlock()
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
						if s.geminiLogin == login && login.state == "starting" {
							_, _ = io.WriteString(login.tty, "\r")
						}
						s.geminiLoginMu.Unlock()
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
