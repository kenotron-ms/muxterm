package mcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// tunnelTools groups the MCP tunnel tool handlers. Unlike workspace and layout
// tools, tunnel tools communicate directly with the serve-layer HTTP REST API
// rather than through the sessiond daemon, because the TunnelRegistry lives in
// the serve layer. The serve process writes its URL to a well-known file on
// startup; tunnelTools reads that file on every call via sessiond.ServerURL().
type tunnelTools struct{}

// newTunnelTools creates a tunnelTools instance.
func newTunnelTools() *tunnelTools {
	return &tunnelTools{}
}

// listTunnels returns a JSON array of all active tunnels, each with "id" and
// "port" fields.
func (tt *tunnelTools) listTunnels(_ map[string]any) (string, error) {
	body, err := tt.doRequest(http.MethodGet, "/api/tunnels", nil)
	if err != nil {
		return "", fmt.Errorf("list tunnels: %w", err)
	}
	return string(body), nil
}

// createTunnel registers a new port-forward tunnel for args["port"] and
// returns {"id":"<id>","port":<port>}. The tunnel is reachable at /t/{id}/ on
// the muxterm serve layer.
func (tt *tunnelTools) createTunnel(args map[string]any) (string, error) {
	port, err := argInt(args, "port")
	if err != nil {
		return "", err
	}
	payload, _ := json.Marshal(map[string]any{"port": port})
	body, err := tt.doRequest(http.MethodPost, "/api/tunnels", payload)
	if err != nil {
		return "", fmt.Errorf("create tunnel: %w", err)
	}
	return string(body), nil
}

// closeTunnel deregisters the tunnel identified by args["tunnel_id"] and
// returns {"ok":true}.
func (tt *tunnelTools) closeTunnel(args map[string]any) (string, error) {
	id, err := argString(args, "tunnel_id")
	if err != nil {
		return "", err
	}
	body, err := tt.doRequest(http.MethodDelete, "/api/tunnels/"+id, nil)
	if err != nil {
		return "", fmt.Errorf("close tunnel: %w", err)
	}
	return string(body), nil
}

// doRequest sends an HTTP request to the serve-layer tunnel API. It reads the
// server base URL from the file written by the serve process at startup via
// sessiond.ServerURL(). Returns the response body on 2xx or an error.
func (tt *tunnelTools) doRequest(method, path string, body []byte) ([]byte, error) {
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
	// Authenticate as a same-user local helper process. Without this the
	// only thing admitting these calls is the serve layer's loopback
	// bypass, which behind_reverse_proxy disables -- turning every tunnel
	// tool into an unexplained 401 the moment reverse-proxy mode is on. A
	// serve process that published no token (older build) yields "", and
	// the request proceeds unauthenticated exactly as before.
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
