package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type Settings struct {
	ServerURL string `json:"serverURL"`
	SSHHost   string `json:"sshHost"`
}

type Forward struct {
	Port int    `json:"port"`
	URL  string `json:"url"`
}

type runningForward struct {
	cmd  *exec.Cmd
	done chan error
	log  *syncBuffer
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

type Companion struct {
	mu             sync.Mutex
	bridgeMu       sync.Mutex
	app            *application.App
	token          string
	settings       Settings
	forwards       map[int]*runningForward
	browserSeq     int
	browserTabs    map[int]*browserTab
	activeBrowser  int
	browserRect    browserRect
	browserVisible bool
}

func (c *Companion) authorize(token string) error {
	if token != c.token || token == "" {
		return errors.New("settings window authorization failed")
	}
	return nil
}

func newCompanion() *Companion {
	c := &Companion{forwards: make(map[int]*runningForward)}
	if data, err := os.ReadFile(settingsPath()); err == nil {
		_ = json.Unmarshal(data, &c.settings)
	}
	return c
}

func settingsPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "muxterm-desktop", "settings.json")
}

func (c *Companion) GetSettings(token string) (Settings, error) {
	if err := c.authorize(token); err != nil {
		return Settings{}, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.settings, nil
}

func (c *Companion) SaveSettings(token string, s Settings) error {
	if err := c.authorize(token); err != nil {
		return err
	}
	s.ServerURL = strings.TrimSpace(s.ServerURL)
	s.SSHHost = strings.TrimSpace(s.SSHHost)
	if s.ServerURL != "" {
		u, err := url.Parse(s.ServerURL)
		if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.Fragment != "" {
			return errors.New("enter a full http:// or https:// muxterm URL")
		}
		if u.Scheme == "http" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" {
			return errors.New("use https:// for a remote muxterm URL")
		}
		s.ServerURL = strings.TrimRight(u.String(), "/") + "/"
	}
	if s.SSHHost != "" && (strings.HasPrefix(s.SSHHost, "-") || strings.ContainsAny(s.SSHHost, " \t\r\n")) {
		return errors.New("SSH host must be one SSH alias or user@host, with no spaces")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if s.SSHHost != c.settings.SSHHost && len(c.forwards) > 0 {
		return errors.New("stop current port forwards before changing the SSH host")
	}
	path := settingsPath()
	if path == "" {
		return errors.New("cannot find user configuration directory")
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	if err := os.WriteFile(path, append(data, '\n'), 0600); err != nil {
		return err
	}
	c.settings = s
	return nil
}

func (c *Companion) OpenMuxtermWindow(token string) error {
	if err := c.authorize(token); err != nil {
		return err
	}
	if err := c.openMuxtermWindow(); err != nil {
		return err
	}
	if window, ok := c.app.Window.GetByName("companion"); ok {
		window.Hide()
	}
	return nil
}

func (c *Companion) openMuxtermWindow() error {
	c.mu.Lock()
	s := c.settings
	c.mu.Unlock()
	if s.ServerURL == "" {
		return errors.New("save the muxterm URL first")
	}
	server, _ := url.Parse(s.ServerURL)
	if s.SSHHost != "" && (server.Hostname() == "localhost" || server.Hostname() == "127.0.0.1") && server.Port() != "" {
		port, err := strconv.Atoi(server.Port())
		if err != nil {
			return err
		}
		if _, err := c.StartForward(c.token, port); err != nil {
			return err
		}
	}
	if window, ok := c.app.Window.GetByName("muxterm"); ok {
		window.SetURL(s.ServerURL)
		window.Show()
		window.Focus()
		return nil
	}
	browserScript, err := assets.ReadFile("assets/browser.js")
	if err != nil {
		return err
	}
	c.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name: "muxterm", Title: "muxterm", URL: s.ServerURL,
		Width: 1400, Height: 900, MinWidth: 700, MinHeight: 500,
		JS: string(browserScript),
	})
	return nil
}

func (c *Companion) showSettings() {
	if window, ok := c.app.Window.GetByName("companion"); ok {
		window.Show()
		window.Focus()
	}
}

func (c *Companion) OpenMuxtermBrowser(token string) error {
	s, err := c.GetSettings(token)
	if err != nil {
		return err
	}
	if s.ServerURL == "" {
		return errors.New("save the muxterm URL first")
	}
	return c.app.Browser.OpenURL(s.ServerURL)
}

func (c *Companion) OpenBrowserTab(token, rawURL string) (int, error) {
	if err := c.authorize(token); err != nil {
		return 0, err
	}
	return c.openBrowserTab(rawURL)
}

func (c *Companion) openBrowserTab(rawURL string) (int, error) {
	u, err := c.prepareBrowserURL(rawURL)
	if err != nil {
		return 0, err
	}
	id, err := c.browserOpen(u.String())
	if err == nil {
		c.evalMuxtermJS("window.__muxtermDesktopOpenPanel?.()")
	}
	return id, err
}

func (c *Companion) prepareBrowserURL(rawURL string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil {
		return nil, errors.New("enter a full http:// or https:// URL")
	}
	if u.Scheme == "http" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" {
		return nil, errors.New("use https:// for a non-local browser tab")
	}
	if (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1") && u.Port() != "" {
		port, err := strconv.Atoi(u.Port())
		if err != nil || port < 1 || port > 65535 {
			return nil, errors.New("invalid localhost port")
		}
		c.mu.Lock()
		host := c.settings.SSHHost
		c.mu.Unlock()
		if host != "" {
			if _, err := c.StartForward(c.token, port); err != nil {
				return nil, err
			}
		}
	}
	return u, nil
}

func (c *Companion) ListForwards(token string) ([]Forward, error) {
	if err := c.authorize(token); err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	list := make([]Forward, 0, len(c.forwards))
	for port := range c.forwards {
		list = append(list, Forward{Port: port, URL: previewURL(port)})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Port < list[j].Port })
	return list, nil
}

func previewURL(port int) string { return "http://localhost:" + strconv.Itoa(port) + "/" }

func (c *Companion) StartForward(token string, port int) (Forward, error) {
	if err := c.authorize(token); err != nil {
		return Forward{}, err
	}
	if port < 1 || port > 65535 {
		return Forward{}, errors.New("port must be between 1 and 65535")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.forwards[port]; exists {
		return Forward{Port: port, URL: previewURL(port)}, nil
	}
	if c.settings.SSHHost == "" {
		return Forward{}, errors.New("save the SSH host first")
	}
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	probe, err := net.Listen("tcp", addr)
	if err != nil {
		return Forward{}, fmt.Errorf("local port %d is already in use: %w", port, err)
	}
	_ = probe.Close()

	// Only the child SSH process started here is ever stopped by this app.
	cmd := exec.Command("ssh", "-N", "-T", "-o", "BatchMode=yes",
		"-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10",
		"-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
		"-L", fmt.Sprintf("127.0.0.1:%d:127.0.0.1:%d", port, port), c.settings.SSHHost)
	log := &syncBuffer{}
	cmd.Stderr = log
	if err := cmd.Start(); err != nil {
		return Forward{}, fmt.Errorf("start ssh: %w", err)
	}
	running := &runningForward{cmd: cmd, done: make(chan error, 1), log: log}
	go func() { running.done <- cmd.Wait() }()

	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-running.done:
			return Forward{}, fmt.Errorf("ssh forwarding failed: %v: %s", err, strings.TrimSpace(log.String()))
		default:
		}
		conn, err := net.DialTimeout("tcp", addr, 100*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			c.forwards[port] = running
			go c.watchForward(port, running)
			return Forward{Port: port, URL: previewURL(port)}, nil
		}
		time.Sleep(75 * time.Millisecond)
	}
	_ = cmd.Process.Kill()
	<-running.done
	return Forward{}, fmt.Errorf("ssh did not open local port %d: %s", port, strings.TrimSpace(log.String()))
}

func (c *Companion) watchForward(port int, running *runningForward) {
	<-running.done
	c.mu.Lock()
	if c.forwards[port] == running {
		delete(c.forwards, port)
	}
	c.mu.Unlock()
}

func (c *Companion) StopForward(token string, port int) error {
	if err := c.authorize(token); err != nil {
		return err
	}
	c.mu.Lock()
	running := c.forwards[port]
	delete(c.forwards, port)
	c.mu.Unlock()
	if running == nil {
		return errors.New("that port is not forwarded")
	}
	return running.cmd.Process.Kill()
}

func (c *Companion) OpenPreview(token string, port int) error {
	if err := c.authorize(token); err != nil {
		return err
	}
	c.mu.Lock()
	_, active := c.forwards[port]
	c.mu.Unlock()
	if !active {
		return errors.New("forward the port first")
	}
	return c.app.Browser.OpenURL(previewURL(port))
}

func (c *Companion) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, running := range c.forwards {
		_ = running.cmd.Process.Kill()
	}
	c.forwards = make(map[int]*runningForward)
}
