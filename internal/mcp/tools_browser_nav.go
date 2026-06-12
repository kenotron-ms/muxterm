package mcp

import (
	"context"
	"time"
)

// browserTools groups the MCP browser tool handlers (navigation, interaction,
// and observation, split across three files in this package) and holds a
// reference to the Client. The default per-action timeout is the design's 10s.
type browserTools struct {
	c *Client
}

// newBrowserTools creates a browserTools instance backed by c.
func newBrowserTools(c *Client) *browserTools {
	return &browserTools{c: c}
}

// browserTimeout is the default wait for a browser-action-result (design: 10s).
const browserTimeout = 10 * time.Second

// callAction dispatches a browser action for the pane in args["pane_id"] and
// returns the standard {ok:true} / {error:...} JSON. params carries the action
// operands (ref/selector/value/key/expr). Used by every nav and interaction
// tool; observation tools format their own results.
func (bt *browserTools) callAction(args map[string]any, action string, params map[string]any) (string, error) {
	paneID, err := argInt(args, "pane_id")
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), browserTimeout)
	defer cancel()
	res, err := bt.c.SendBrowserAction(ctx, paneID, action, params)
	if err != nil {
		return "", err
	}
	if res.Error != "" {
		return jsonText(map[string]any{"error": res.Error}), nil
	}
	return jsonText(map[string]any{"ok": true}), nil
}

// browserGoto navigates the pane to args["url"] (shim action "goto", value=url).
func (bt *browserTools) browserGoto(args map[string]any) (string, error) {
	url, err := argString(args, "url")
	if err != nil {
		return "", err
	}
	return bt.callAction(args, "goto", map[string]any{"value": url})
}

// browserGoBack navigates back in history (shim action "go-back").
func (bt *browserTools) browserGoBack(args map[string]any) (string, error) {
	return bt.callAction(args, "go-back", nil)
}

// browserGoForward navigates forward in history (shim action "go-forward").
func (bt *browserTools) browserGoForward(args map[string]any) (string, error) {
	return bt.callAction(args, "go-forward", nil)
}

// browserReload reloads the current page (shim action "reload").
func (bt *browserTools) browserReload(args map[string]any) (string, error) {
	return bt.callAction(args, "reload", nil)
}
