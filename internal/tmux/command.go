package tmux

import (
	"fmt"
	"io"
	"strings"
	"sync"
)

// CommandWriter sends tmux commands through control mode.
type CommandWriter struct {
	W  io.Writer
	mu sync.Mutex
}

// send formats and writes a command line to the writer, thread-safe.
func (c *CommandWriter) send(format string, args ...any) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	line := fmt.Sprintf(format, args...)
	_, err := fmt.Fprintf(c.W, "%s\n", line)
	return err
}

// SendKeys sends text that tmux interprets through send-keys.
func (c *CommandWriter) SendKeys(paneID, keys string) error {
	return c.send("send-keys -t %s -- %s", paneID, keys)
}

// SendKeysLiteral sends raw bytes as hex-encoded send-keys for the terminal.
func (c *CommandWriter) SendKeysLiteral(paneID string, data []byte) error {
	hexParts := make([]string, len(data))
	for i, b := range data {
		hexParts[i] = fmt.Sprintf("%02x", b)
	}
	return c.send("send-keys -t %s -H %s", paneID, strings.Join(hexParts, " "))
}

// SelectWindow selects a tmux window.
func (c *CommandWriter) SelectWindow(windowID string) error {
	return c.send("select-window -t %s", windowID)
}

// SelectPane selects a tmux pane.
func (c *CommandWriter) SelectPane(paneID string) error {
	return c.send("select-pane -t %s", paneID)
}

// SplitWindow splits a pane. horizontal=true uses -h, horizontal=false uses -v.
func (c *CommandWriter) SplitWindow(paneID string, horizontal bool) error {
	flag := "-v"
	if horizontal {
		flag = "-h"
	}
	return c.send("split-window %s -t %s", flag, paneID)
}

// ResizePane resizes a pane to the given width and height.
func (c *CommandWriter) ResizePane(paneID string, width, height int) error {
	return c.send("resize-pane -t %s -x %d -y %d", paneID, width, height)
}

// NewWindow creates a new window, optionally with a name.
func (c *CommandWriter) NewWindow(name string) error {
	if name == "" {
		return c.send("new-window")
	}
	return c.send("new-window -n %s", name)
}

// ClosePane kills a pane.
func (c *CommandWriter) ClosePane(paneID string) error {
	return c.send("kill-pane -t %s", paneID)
}

// RenameWindow renames a window.
func (c *CommandWriter) RenameWindow(windowID, name string) error {
	return c.send("rename-window -t %s %s", windowID, name)
}

// CreateSession creates a new detached session.
func (c *CommandWriter) CreateSession(name string) error {
	return c.send("new-session -d -s %s", name)
}

// ListWindows queries all windows with their properties.
func (c *CommandWriter) ListWindows() error {
	return c.send("list-windows -F '#{window_id} #{window_name} #{window_layout} #{window_active}'")
}

// ListPanes queries all panes across all windows with their properties.
func (c *CommandWriter) ListPanes() error {
	return c.send("list-panes -s -F '#{pane_id} #{pane_width} #{pane_height} #{pane_active}'")
}