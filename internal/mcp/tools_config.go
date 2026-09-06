package mcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// configTools groups the MCP config tool handlers. Like tunnelTools, config
// tools communicate directly with the serve-layer HTTP REST API rather than
// through the sessiond daemon, because config state lives in the serve layer.
// The serve process writes its URL to a well-known file on startup; configTools
// reads that file on every call via sessiond.ServerURL().
type configTools struct{}

// newConfigTools creates a configTools instance.
func newConfigTools() *configTools {
	return &configTools{}
}

// getConfig returns the full resolved muxterm configuration as a JSON string.
func (ct *configTools) getConfig(_ map[string]any) (string, error) {
	body, err := ct.doRequest(http.MethodGet, "/api/config", nil)
	if err != nil {
		return "", fmt.Errorf("get_config: %w", err)
	}
	return string(body), nil
}

// updateConfig accepts a "changes" argument (a JSON object with partial config
// fields) and applies them to the running server via PATCH /api/config. The
// server merges, writes to disk, and broadcasts to all connected clients.
//
// Example: update_config({"changes": {"theme": {"palette": "dracula"}}})
func (ct *configTools) updateConfig(args map[string]any) (string, error) {
	changes, ok := args["changes"]
	if !ok {
		return "", fmt.Errorf("missing required argument: changes")
	}
	payload, err := json.Marshal(changes)
	if err != nil {
		return "", fmt.Errorf("update_config: marshal changes: %w", err)
	}
	body, err := ct.doRequest(http.MethodPatch, "/api/config", payload)
	if err != nil {
		return "", fmt.Errorf("update_config: %w", err)
	}
	return string(body), nil
}

// doRequest sends an HTTP request to the serve-layer config API. It reads the
// server base URL from the file written by the serve process at startup via
// sessiond.ServerURL(). Returns the response body on 2xx or an error.
func (ct *configTools) doRequest(method, path string, body []byte) ([]byte, error) {
	serverURL, err := sessiond.ServerURL()
	if err != nil {
		return nil, err
	}
	var reqBody io.Reader
	if body != nil {
		reqBody = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, serverURL+path, reqBody)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	// Same-user local helper credential -- see the equivalent block in
	// tools_tunnel.go's doRequest for why this is required once
	// behind_reverse_proxy disables the loopback bypass.
	if token, err := sessiond.ServerToken(); err == nil && token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, respBody)
	}
	return respBody, nil
}

// registerConfigTools registers the get_config and update_config MCP tools on
// srv. These tools do not require a sessiond connection — they talk directly
// to the HTTP serve layer via sessiond.ServerURL().
func registerConfigTools(srv *Server) {
	ct := newConfigTools()

	srv.Register(
		"get_config",
		"get the full resolved muxterm configuration (theme, font, terminal, keys, workspace, driver)",
		map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
		ct.getConfig,
	)

	srv.Register(
		"update_config",
		"update muxterm configuration; accepts a partial config object, merges it, writes to disk, and broadcasts to all connected clients; example: {\"changes\": {\"theme\": {\"palette\": \"dracula\"}, \"font\": {\"size\": 15}}}",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"changes": map[string]any{
					"type":        "object",
					"description": "partial config object with fields to update (theme, font, terminal, keys)",
				},
			},
			"required": []string{"changes"},
		},
		ct.updateConfig,
	)
}
