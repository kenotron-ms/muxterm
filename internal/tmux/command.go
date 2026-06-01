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

// ResizePaneRelative resizes a pane by moving one of its borders.
// dir is one of R (expand right), L (shrink left), D (expand down), U (shrink up).
// amount is the number of cells to move the border.
func (c *CommandWriter) ResizePaneRelative(paneID, dir string, amount int) error {
	return c.send("resize-pane -%s -t \"%s\" %d", dir, paneID, amount)
}

// ResizeWindow resizes a window to the given width and height.
func (c *CommandWriter) ResizeWindow(windowID string, width, height int) error {
	return c.send("resize-window -t %s -x %d -y %d", windowID, width, height)
}

// RefreshClientSize tells tmux the size of THIS control-mode client. This is the
// only mechanism that actually resizes a `-CC` client: tmux does not read the
// PTY winsize for control-mode clients, and with `window-size latest` the window
// follows the client size. So `refresh-client -C WxH` is what drives resize.
func (c *CommandWriter) RefreshClientSize(width, height int) error {
	return c.send("refresh-client -C %dx%d", width, height)
}

// SetOption applies a tmux option (set [-g] key value).
// Pass global=true to set the option globally across all sessions/windows/panes.
func (c *CommandWriter) SetOption(global bool, key, value string) error {
	if global {
		return c.send("set -g %s %s", key, value)
	}
	return c.send("set %s %s", key, value)
}

// NewWindow creates a new window, optionally with a name.
func (c *CommandWriter) NewWindow(name string) error {
	if name == "" {
		return c.send("new-window")
	}
	return c.send("new-window -n %s", name)
}

// NewWindowWithCommand creates a new window that runs a shell command.
// name may be empty (tmux picks a name from the command).
// command is passed verbatim as the window's startup command.
func (c *CommandWriter) NewWindowWithCommand(name, command string) error {
	if name == "" {
		return c.send("new-window -- %s", command)
	}
	return c.send("new-window -n %s -- %s", name, command)
}

// ClosePane kills a pane.
func (c *CommandWriter) ClosePane(paneID string) error {
	return c.send("kill-pane -t %s", paneID)
}

// CloseWindow kills an entire window (and all its panes). Closing a tab maps to
// this, not kill-pane — a window may hold multiple panes, and kill-pane on a
// window id would only remove one of them.
func (c *CommandWriter) CloseWindow(windowID string) error {
	return c.send("kill-window -t %s", windowID)
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