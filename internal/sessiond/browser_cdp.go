package sessiond

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// ---------------------------------------------------------------------------
// CDP wire types
// ---------------------------------------------------------------------------

type cdpError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type cdpEvent struct {
	Method    string
	SessionID string
	Params    json.RawMessage
}

type cdpResult struct {
	Result json.RawMessage
	Error  *cdpError
}

// ---------------------------------------------------------------------------
// CDPConn — raw Chrome DevTools Protocol WebSocket connection.
// Multiplexes page sessions via sessionId. Safe for concurrent use.
// ---------------------------------------------------------------------------

type CDPConn struct {
	conn    *websocket.Conn
	writeMu sync.Mutex
	nextID  int64
	pendMu  sync.Mutex
	pending map[int64]chan cdpResult
	events  chan cdpEvent
	ctx     context.Context
	cancel  context.CancelFunc
}

func dialCDP(ctx context.Context, wsURL string) (*CDPConn, error) {
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		return nil, fmt.Errorf("cdp dial %s: %w", wsURL, err)
	}
	conn.SetReadLimit(32 * 1024 * 1024) // 32 MB for large frames

	cctx, cancel := context.WithCancel(ctx)
	c := &CDPConn{
		conn:    conn,
		pending: make(map[int64]chan cdpResult),
		events:  make(chan cdpEvent, 256),
		ctx:     cctx,
		cancel:  cancel,
	}
	go c.readLoop()
	return c, nil
}

func (c *CDPConn) readLoop() {
	defer c.cancel()
	for {
		_, msg, err := c.conn.Read(c.ctx)
		if err != nil {
			return
		}
		var env struct {
			ID        int64           `json:"id"`
			Method    string          `json:"method"`
			SessionID string          `json:"sessionId"`
			Params    json.RawMessage `json:"params"`
			Result    json.RawMessage `json:"result"`
			Error     *cdpError       `json:"error"`
		}
		if err := json.Unmarshal(msg, &env); err != nil {
			continue
		}
		if env.ID != 0 {
			c.pendMu.Lock()
			ch := c.pending[env.ID]
			delete(c.pending, env.ID)
			c.pendMu.Unlock()
			if ch != nil {
				select {
				case ch <- cdpResult{Result: env.Result, Error: env.Error}:
				default:
				}
			}
		} else if env.Method != "" {
			select {
			case c.events <- cdpEvent{Method: env.Method, SessionID: env.SessionID, Params: env.Params}:
			default: // drop on full buffer
			}
		}
	}
}

// Call sends a CDP command and waits for the response.
// sessionID is "" for browser-level commands, or the page session ID.
func (c *CDPConn) Call(ctx context.Context, sessionID, method string, params any) (json.RawMessage, error) {
	id := atomic.AddInt64(&c.nextID, 1)
	ch := make(chan cdpResult, 1)
	c.pendMu.Lock()
	c.pending[id] = ch
	c.pendMu.Unlock()

	body := map[string]any{
		"id":     id,
		"method": method,
	}
	if sessionID != "" {
		body["sessionId"] = sessionID
	}
	if params != nil {
		body["params"] = params
	}
	raw, _ := json.Marshal(body)

	c.writeMu.Lock()
	err := c.conn.Write(ctx, websocket.MessageText, raw)
	c.writeMu.Unlock()
	if err != nil {
		c.pendMu.Lock()
		delete(c.pending, id)
		c.pendMu.Unlock()
		return nil, fmt.Errorf("cdp write %s: %w", method, err)
	}

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case r := <-ch:
		if r.Error != nil {
			return nil, fmt.Errorf("cdp %s: %s (code %d)", method, r.Error.Message, r.Error.Code)
		}
		return r.Result, nil
	}
}

// Close cancels the connection context and closes the underlying WebSocket.
func (c *CDPConn) Close() {
	c.cancel()
	c.conn.CloseNow()
}

// ---------------------------------------------------------------------------
// Chromium process management
// ---------------------------------------------------------------------------

// chromiumBin finds the Chromium binary using a four-step search:
//  1. PATH (chromium, chromium-browser, google-chrome, google-chrome-stable)
//  2. Binary previously downloaded by muxterm itself
//  3. Binary cached by go-rod (common during development)
//  4. Fresh download from chrome-for-testing API
func chromiumBin() (string, error) {
	// 1. PATH
	for _, name := range []string{"chromium", "chromium-browser", "google-chrome", "google-chrome-stable"} {
		if path, err := exec.LookPath(name); err == nil {
			return path, nil
		}
	}

	// 2. Already downloaded by muxterm itself
	if path := ownDownloadedBin(); path != "" {
		return path, nil
	}

	// 3. go-rod cache (common during development / upgrade path)
	if path := rodCachedBin(); path != "" {
		return path, nil
	}

	// 4. Download fresh
	return downloadChromium()
}

// ownDownloadedBin returns the path to the muxterm-downloaded binary if it
// exists on disk, or "" otherwise.
func ownDownloadedBin() string {
	const version = "131.0.6778.85"
	binPath := filepath.Join(chromiumDataDir(), version, chromiumBinRelPath())
	if _, err := os.Stat(binPath); err == nil {
		return binPath
	}
	return ""
}

// rodCachedBin returns the first usable binary found in go-rod's browser cache
// directory (~/.cache/rod/browser), or "" if none is found.
func rodCachedBin() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	base := filepath.Join(home, ".cache", "rod", "browser")
	entries, err := os.ReadDir(base)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		for _, rel := range []string{
			filepath.Join("Chromium.app", "Contents", "MacOS", "Chromium"),
			filepath.Join("chrome-linux64", "chrome"),
			"chrome",
		} {
			c := filepath.Join(base, e.Name(), rel)
			if _, err := os.Stat(c); err == nil {
				return c
			}
		}
	}
	return ""
}

// downloadChromium downloads a pinned Chromium build from chrome-for-testing
// and returns the path to the binary.
func downloadChromium() (string, error) {
	// Pinned version — update this when a newer version is validated
	const version = "131.0.6778.85"

	dataDir := chromiumDataDir()
	binPath := filepath.Join(dataDir, version, chromiumBinRelPath())

	// Already downloaded?
	if _, err := os.Stat(binPath); err == nil {
		return binPath, nil
	}

	platform := chromiumPlatform()
	zipURL := fmt.Sprintf(
		"https://storage.googleapis.com/chrome-for-testing-public/%s/%s/chrome-%s.zip",
		version, platform, platform,
	)

	// Download to temp file
	resp, err := http.Get(zipURL) //nolint:noctx
	if err != nil {
		return "", fmt.Errorf("chromium download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("chromium download: HTTP %d", resp.StatusCode)
	}

	tmpFile, err := os.CreateTemp("", "chromium-*.zip")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmpFile.Name())

	if _, err := io.Copy(tmpFile, resp.Body); err != nil {
		return "", fmt.Errorf("chromium download write: %w", err)
	}
	tmpFile.Close()

	// Extract
	destDir := filepath.Join(dataDir, version)
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return "", err
	}
	if err := unzipChromium(tmpFile.Name(), destDir); err != nil {
		return "", fmt.Errorf("chromium extract: %w", err)
	}
	if err := os.Chmod(binPath, 0o755); err != nil {
		return "", err
	}
	return binPath, nil
}

// chromiumPlatform returns the chrome-for-testing platform string for the
// current OS/arch combination.
func chromiumPlatform() string {
	switch runtime.GOOS {
	case "darwin":
		if runtime.GOARCH == "arm64" {
			return "mac-arm64"
		}
		return "mac-x64"
	case "linux":
		return "linux64"
	default:
		return "linux64"
	}
}

// chromiumBinRelPath returns the path to the Chromium executable relative to
// the per-version extraction directory.
func chromiumBinRelPath() string {
	platform := chromiumPlatform()
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join("chrome-"+platform,
			"Google Chrome for Testing.app",
			"Contents", "MacOS",
			"Google Chrome for Testing")
	default: // linux
		return filepath.Join("chrome-"+platform, "chrome")
	}
}

// chromiumDataDir returns the platform-conventional directory for storing the
// muxterm-managed Chromium binary.
//
// macOS: ~/Library/Application Support/muxterm/chromium
// Linux: $XDG_DATA_HOME/muxterm/chromium, falling back to
//
//	~/.local/share/muxterm/chromium, then os.TempDir()/muxterm-chromium.
func chromiumDataDir() string {
	if runtime.GOOS == "darwin" {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, "Library", "Application Support", "muxterm", "chromium")
		}
	}
	if xdg := os.Getenv("XDG_DATA_HOME"); xdg != "" {
		return filepath.Join(xdg, "muxterm", "chromium")
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".local", "share", "muxterm", "chromium")
	}
	return filepath.Join(os.TempDir(), "muxterm-chromium")
}

// unzipChromium extracts the Chromium zip to destDir, preserving file modes.
func unzipChromium(zipPath, destDir string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		path := filepath.Join(destDir, f.Name)
		if f.FileInfo().IsDir() {
			os.MkdirAll(path, 0o755) //nolint:errcheck
			continue
		}
		os.MkdirAll(filepath.Dir(path), 0o755) //nolint:errcheck
		dst, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, f.Mode())
		if err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			dst.Close()
			return err
		}
		_, err = io.Copy(dst, rc)
		rc.Close()
		dst.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// launchChromium starts Chromium on a free port and returns the process and
// the CDP WebSocket URL for connecting.
func launchChromium(ctx context.Context, binPath, profileDir string, progressCb func(int)) (*exec.Cmd, string, error) {
	if progressCb != nil {
		progressCb(0)
	}

	// Pre-allocate a free port
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, "", fmt.Errorf("chromium port: %w", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()

	if err := os.MkdirAll(profileDir, 0o755); err != nil {
		return nil, "", err
	}

	cmd := exec.Command(binPath,
		"--headless",
		"--no-sandbox",
		"--disable-dev-shm-usage",
		"--disable-gpu",
		fmt.Sprintf("--remote-debugging-port=%d", port),
		"--user-data-dir="+profileDir,
	)
	cmd.Stderr = io.Discard
	cmd.Stdout = io.Discard
	if err := cmd.Start(); err != nil {
		return nil, "", fmt.Errorf("chromium start: %w", err)
	}

	// Poll /json/version until Chrome is ready
	wsURL, err := waitForChromium(ctx, port)
	if err != nil {
		cmd.Process.Kill() //nolint:errcheck
		return nil, "", err
	}

	if progressCb != nil {
		progressCb(100)
	}
	return cmd, wsURL, nil
}

// waitForChromium polls the Chrome DevTools HTTP endpoint until Chromium
// reports its WebSocket debugger URL or the timeout elapses.
func waitForChromium(ctx context.Context, port int) (string, error) {
	url := fmt.Sprintf("http://127.0.0.1:%d/json/version", port)
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		default:
		}
		resp, err := http.Get(url) //nolint:noctx
		if err != nil {
			time.Sleep(100 * time.Millisecond)
			continue
		}
		var info struct {
			WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
		}
		json.NewDecoder(resp.Body).Decode(&info) //nolint:errcheck
		resp.Body.Close()
		if info.WebSocketDebuggerURL != "" {
			return info.WebSocketDebuggerURL, nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return "", fmt.Errorf("chromium did not start in 15s on port %d", port)
}
