package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type runningLocal struct {
	cmd  *exec.Cmd
	url  string
	done chan struct{}
	err  error
}

type LocalStatus struct {
	URL   string `json:"url"`
	Error string `json:"error"`
}

func (c *Companion) GetLocalStatus(token string) (LocalStatus, error) {
	if err := c.authorize(token); err != nil {
		return LocalStatus{}, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.local != nil {
		return LocalStatus{URL: c.local.url}, nil
	}
	return LocalStatus{Error: c.localError}, nil
}

// startLocalMuxterm launches only the server bundled inside this app. All of
// its config, session socket, and durable pane data live under this app's own
// Application Support directory, away from any separately installed muxterm.
func (c *Companion) startLocalMuxterm() (string, error) {
	c.localStartMu.Lock()
	defer c.localStartMu.Unlock()
	c.mu.Lock()
	if c.local != nil {
		url := c.local.url
		c.mu.Unlock()
		return url, nil
	}
	c.mu.Unlock()

	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", c.localFailure(err)
	}
	root := filepath.Join(configDir, "muxterm-desktop", "local")
	for _, dir := range []string{root, filepath.Join(root, "config"), filepath.Join(root, "data"), filepath.Join(root, "runtime")} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return "", c.localFailure(fmt.Errorf("create local muxterm directory: %w", err))
		}
	}
	executable, err := os.Executable()
	if err != nil {
		return "", c.localFailure(err)
	}
	serverPath := filepath.Join(filepath.Dir(executable), "muxterm-server")
	if _, err := os.Stat(serverPath); err != nil {
		return "", c.localFailure(fmt.Errorf("bundled muxterm server is missing: %w", err))
	}
	logPath := filepath.Join(root, "server.log")
	for attempt := 0; attempt < 3; attempt++ {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return "", c.localFailure(fmt.Errorf("reserve local port: %w", err))
		}
		addr := listener.Addr().String()
		_ = listener.Close()
		url := "http://" + addr + "/"

		logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			return "", c.localFailure(fmt.Errorf("open local server log: %w", err))
		}
		cmd := exec.Command(serverPath, "app-serve", "--addr", addr)
		cmd.Env = localServerEnv(root)
		cmd.Stdout = logFile
		cmd.Stderr = logFile
		if err := cmd.Start(); err != nil {
			_ = logFile.Close()
			return "", c.localFailure(fmt.Errorf("launch bundled muxterm server: %w", err))
		}
		_ = logFile.Close()

		running := &runningLocal{cmd: cmd, url: url, done: make(chan struct{})}
		go func() {
			running.err = cmd.Wait()
			close(running.done)
			c.mu.Lock()
			if c.local == running {
				c.local = nil
				c.localError = fmt.Sprintf("Local muxterm stopped. See %s", logPath)
			}
			c.mu.Unlock()
		}()

		client := http.Client{Timeout: 350 * time.Millisecond}
		deadline := time.Now().Add(15 * time.Second)
		for time.Now().Before(deadline) {
			select {
			case <-running.done:
				// A stolen ephemeral port can make bind fail. Try another one.
				goto nextPort
			default:
			}
			response, requestErr := client.Get(url)
			if requestErr == nil {
				body, readErr := io.ReadAll(io.LimitReader(response.Body, 128*1024))
				_ = response.Body.Close()
				if readErr == nil && response.StatusCode == http.StatusOK && strings.Contains(string(body), "<mux-app>") {
					c.mu.Lock()
					select {
					case <-running.done:
						c.mu.Unlock()
						goto nextPort
					default:
						c.local = running
						c.localError = ""
						c.mu.Unlock()
						return url, nil
					}
				}
			}
			time.Sleep(75 * time.Millisecond)
		}
		_ = cmd.Process.Signal(os.Interrupt)
		select {
		case <-running.done:
		case <-time.After(2 * time.Second):
			_ = cmd.Process.Kill()
			<-running.done
		}
		return "", c.localFailure(fmt.Errorf("local muxterm did not become ready; see %s", logPath))
	nextPort:
	}
	return "", c.localFailure(fmt.Errorf("local muxterm exited before opening; see %s", logPath))
}

func (c *Companion) localFailure(err error) error {
	c.mu.Lock()
	c.localError = err.Error()
	c.mu.Unlock()
	return err
}

func localServerEnv(root string) []string {
	env := make([]string, 0, len(os.Environ())+3)
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		switch key {
		case "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "MUXTERM_DEV_INSTANCE", "MUXTERM_SESSION_STATE_DIR", "MUXTERM_HOOK_REPORT_ROOT", "INVOCATION_ID":
			continue
		}
		env = append(env, entry)
	}
	return append(env,
		"XDG_CONFIG_HOME="+filepath.Join(root, "config"),
		"XDG_DATA_HOME="+filepath.Join(root, "data"),
		"XDG_RUNTIME_DIR="+filepath.Join(root, "runtime"),
	)
}

func (c *Companion) stopLocalMuxterm() {
	c.mu.Lock()
	running := c.local
	c.local = nil
	c.mu.Unlock()
	if running == nil {
		return
	}
	if err := running.cmd.Process.Signal(os.Interrupt); err != nil && !errors.Is(err, os.ErrProcessDone) {
		_ = running.cmd.Process.Kill()
	}
	select {
	case <-running.done:
	case <-time.After(3 * time.Second):
		_ = running.cmd.Process.Kill()
		<-running.done
	}
}
