package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type browserControlCommand struct {
	Action   string  `json:"action"`
	ID       string  `json:"id,omitempty"`
	URL      string  `json:"url,omitempty"`
	Selector string  `json:"selector,omitempty"`
	Ref      string  `json:"ref,omitempty"`
	Text     string  `json:"text,omitempty"`
	Key      string  `json:"key,omitempty"`
	X        float64 `json:"x,omitempty"`
	Y        float64 `json:"y,omitempty"`
	DeltaX   float64 `json:"deltaX,omitempty"`
	DeltaY   float64 `json:"deltaY,omitempty"`
}

type browserRefSnapshot struct {
	URL       string
	Selectors map[string]string
}

func browserControlSocketPath() (string, error) {
	if path := os.Getenv("MUXTERM_BROWSER_CONTROL_SOCKET"); path != "" {
		return path, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "muxterm-desktop", "browser-control.sock"), nil
}

func (c *Companion) startBrowserControl() error {
	path, err := browserControlSocketPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return fmt.Errorf("browser control path exists and is not a socket: %s", path)
		}
		connection, dialErr := net.DialTimeout("unix", path, 250*time.Millisecond)
		if dialErr == nil {
			_ = connection.Close()
			return errors.New("another Muxterm desktop app already owns browser control")
		}
		if err := os.Remove(path); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return err
	}
	if err := os.Chmod(path, 0600); err != nil {
		_ = listener.Close()
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /tabs", c.handleBrowserControlTabs)
	mux.HandleFunc("POST /action", c.handleBrowserControlAction)
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	c.mu.Lock()
	c.browserControl = server
	c.browserListener = listener
	c.browserSocket = path
	c.mu.Unlock()
	go func() { _ = server.Serve(listener) }()
	return nil
}

func (c *Companion) stopBrowserControl() {
	c.mu.Lock()
	server, listener, path := c.browserControl, c.browserListener, c.browserSocket
	c.browserControl, c.browserListener, c.browserSocket = nil, nil, ""
	c.mu.Unlock()
	if server != nil {
		_ = server.Close()
	}
	if listener != nil {
		_ = listener.Close()
	}
	if path != "" {
		_ = os.Remove(path)
	}
}

func browserControlJSON(writer http.ResponseWriter, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(writer).Encode(value)
}

func (c *Companion) handleBrowserControlTabs(writer http.ResponseWriter, _ *http.Request) {
	c.bridgeMu.Lock()
	active, tabs := c.browserState()
	c.bridgeMu.Unlock()
	sort.Slice(tabs, func(i, j int) bool { return tabs[i].ID < tabs[j].ID })
	browserControlJSON(writer, map[string]any{"active": active, "tabs": tabs})
}

func (c *Companion) handleBrowserControlAction(writer http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(writer, request.Body, 32<<10)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var command browserControlCommand
	if err := decoder.Decode(&command); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		http.Error(writer, "Invalid browser command", http.StatusBadRequest)
		return
	}
	if len(command.URL) > 4000 || len(command.Selector) > 1000 || len(command.Text) > 16000 {
		http.Error(writer, "Browser command too large", http.StatusBadRequest)
		return
	}
	if command.Action == "new_tab" {
		id, err := c.OpenBrowserTab(c.token, command.URL)
		if err != nil {
			http.Error(writer, err.Error(), http.StatusBadRequest)
			return
		}
		browserControlJSON(writer, map[string]string{"id": id})
		return
	}
	if command.Action == "navigate" {
		// URL preparation may establish an SSH tunnel, so keep it outside
		// bridgeMu while native browser messages continue to flow.
		address, err := c.prepareBrowserURL(command.URL)
		if err != nil {
			http.Error(writer, err.Error(), http.StatusBadRequest)
			return
		}
		command.URL = address.String()
	}
	c.bridgeMu.Lock()
	defer c.bridgeMu.Unlock()
	result, err := c.runBrowserControl(command)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusBadRequest)
		return
	}
	browserControlJSON(writer, result)
}

func (c *Companion) runBrowserControl(command browserControlCommand) (any, error) {
	active, tabs := c.browserState()
	if command.Action == "tabs" {
		return map[string]any{"active": active, "tabs": tabs}, nil
	}
	id := command.ID
	if id == "" {
		id = active
	}
	if id == "" {
		return nil, errors.New("no native browser tab is open")
	}
	found := false
	for _, tab := range tabs {
		if tab.ID == id {
			found = true
			break
		}
	}
	if !found {
		return nil, errors.New("native browser tab not found")
	}
	if command.Ref != "" {
		if command.Selector != "" {
			return nil, errors.New("choose either ref or selector")
		}
		snapshot := c.browserRefs[id]
		for _, tab := range tabs {
			if tab.ID == id && tab.URL != snapshot.URL {
				return nil, errors.New("page changed; inspect again")
			}
		}
		command.Selector = snapshot.Selectors[command.Ref]
		if command.Selector == "" {
			return nil, errors.New("element ref expired; inspect again")
		}
	}
	switch command.Action {
	case "select_tab":
		return map[string]string{"selected": id}, c.browserSelect(id)
	case "navigate":
		if err := c.browserAction(id, "navigate", command.URL); err != nil {
			return nil, err
		}
		delete(c.browserRefs, id)
		return map[string]string{"navigated": command.URL}, nil
	case "back", "forward", "reload":
		return map[string]string{"action": command.Action}, c.browserAction(id, command.Action, "")
	case "screenshot":
		data, err := c.browserScreenshot(id)
		if err != nil {
			return nil, err
		}
		if len(data) > 1800000 {
			return nil, errors.New("screenshot too large")
		}
		return map[string]string{"mimeType": "image/jpeg", "data": data}, nil
	case "inspect", "click", "type", "key", "scroll":
		if command.Action == "type" && command.Text == "" {
			return nil, errors.New("text is required")
		}
		if command.Action == "key" && !strings.Contains("|Enter|Tab|Escape|Backspace|ArrowLeft|ArrowUp|ArrowRight|ArrowDown|Home|End|Delete|", "|"+command.Key+"|") {
			return nil, errors.New("unsupported key")
		}
		code, err := assets.ReadFile("assets/automation.js")
		if err != nil {
			return nil, err
		}
		arguments, err := json.Marshal(command)
		if err != nil {
			return nil, err
		}
		response, err := c.browserEvaluate(id, "("+string(code)+")("+string(arguments)+")")
		if err != nil {
			return nil, err
		}
		var outcome struct {
			Result json.RawMessage `json:"result"`
			Error  string          `json:"error"`
		}
		if err := json.Unmarshal([]byte(response), &outcome); err != nil {
			return nil, errors.New("browser returned an invalid result")
		}
		if outcome.Error != "" {
			return nil, errors.New(outcome.Error)
		}
		if command.Action == "inspect" {
			var page struct {
				URL      string `json:"url"`
				Title    string `json:"title"`
				Text     string `json:"text"`
				Elements []struct {
					Selector string `json:"selector"`
					Tag      string `json:"tag"`
					Role     string `json:"role"`
					Type     string `json:"type"`
					Label    string `json:"label"`
				} `json:"elements"`
			}
			if err := json.Unmarshal(outcome.Result, &page); err != nil {
				return nil, errors.New("invalid browser inspection")
			}
			selectors := make(map[string]string, len(page.Elements))
			lines := make([]string, 0, len(page.Elements))
			for index, element := range page.Elements {
				ref := "e" + strconv.Itoa(index+1)
				selectors[ref] = element.Selector
				label := strings.Join(strings.Fields(element.Label), " ")
				if len(label) > 100 {
					label = label[:100]
				}
				kind := element.Tag
				if element.Role != "" {
					kind = element.Role
				} else if element.Type != "" {
					kind += "[" + element.Type + "]"
				}
				lines = append(lines, ref+" "+kind+" "+strconv.Quote(label))
			}
			if c.browserRefs == nil {
				c.browserRefs = make(map[string]browserRefSnapshot)
			}
			c.browserRefs[id] = browserRefSnapshot{URL: page.URL, Selectors: selectors}
			return map[string]any{"url": page.URL, "title": page.Title, "text": page.Text, "elements": lines}, nil
		}
		return outcome.Result, nil
	default:
		return nil, errors.New("unsupported browser action")
	}
}
