package mcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

func connectionSetupRequest(args map[string]any, method, path string, payload any) (string, error) {
	if err := refuseRemote(args, "connection setup belongs to this Muxterm instance"); err != nil {
		return "", err
	}
	base, err := sessiond.ServerURL()
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("invalid connection setup arguments")
	}
	request, err := http.NewRequest(method, base+"/api/connections/"+path, bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Muxterm-Browser-Request", "1")
	if token, err := sessiond.ServerToken(); err == nil && token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	client := &http.Client{Timeout: 90 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("connection setup request failed; check its state before retrying")
	}
	defer response.Body.Close()
	result, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("connection setup response could not be read; check its state before retrying")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("connection setup HTTP %d: %s", response.StatusCode, result)
	}
	return string(result), nil
}

func connectionSetupArguments(args map[string]any, allowed ...string) error {
	for key := range args {
		if key == "machine" {
			continue
		}
		found := false
		for _, name := range allowed {
			if key == name {
				found = true
			}
		}
		if !found {
			return fmt.Errorf("unsupported connection setup argument; never pass credentials or file contents to these tools")
		}
	}
	return nil
}

func registerConnectionSetupTools(srv *Server) {
	text := func(limit int) map[string]any {
		return map[string]any{"type": "string", "minLength": 1, "maxLength": limit}
	}
	identifier := func() map[string]any {
		return map[string]any{"type": "string", "pattern": "^[A-Za-z0-9_-]+$", "maxLength": 64}
	}
	array := func(limit int) map[string]any {
		return map[string]any{"type": "array", "items": text(512), "minItems": 1, "maxItems": limit, "uniqueItems": true}
	}
	srv.Register("prepare_connection", "Prepare an owner-bound OAuth connection setup on this Muxterm. Google takes selected services; remote-oauth takes name, endpoint, issuer_url and scopes. Returns the exact callback, targets, scopes and an authenticated private upload URL valid for 15 minutes. Ask the user to pause Browser Assistant and upload a registration file or enter credentials there. Never pass client IDs, secrets, file paths or file contents through agent tools. Does not create a connection or authorize an account. Local server only.", map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": withMachine(map[string]any{
			"provider": map[string]any{"type": "string", "enum": []string{"google", "remote-oauth"}},
			"services": array(6), "name": text(80), "endpoint": text(2048), "issuer_url": text(2048), "scopes": array(30),
		}), "required": []string{"provider"},
	}, func(args map[string]any) (string, error) {
		if err := connectionSetupArguments(args, "provider", "services", "name", "endpoint", "issuer_url", "scopes"); err != nil {
			return "", err
		}
		payload := make(map[string]any)
		for key, value := range args {
			if key != "machine" {
				payload[key] = value
			}
		}
		return connectionSetupRequest(args, http.MethodPost, "setups", payload)
	})
	srv.Register("configure_connection", "Configure a prepared setup using only its opaque credential_handle from check_connection. Credentials must have been privately uploaded and approved by the owner. Creates new connections atomically without overwriting existing ones. Repeating the same setup and handle returns the same IDs. Clears staged credentials on success; does not sign in, run service tools or enable tools. Local server only.", map[string]any{
		"type": "object", "additionalProperties": false, "properties": withMachine(map[string]any{"setup_id": identifier(), "credential_handle": text(43)}), "required": []string{"setup_id", "credential_handle"},
	}, func(args map[string]any) (string, error) {
		if err := connectionSetupArguments(args, "setup_id", "credential_handle"); err != nil {
			return "", err
		}
		id, err := argString(args, "setup_id")
		if err != nil {
			return "", err
		}
		handle, err := argString(args, "credential_handle")
		if err != nil {
			return "", err
		}
		return connectionSetupRequest(args, http.MethodPost, "setups/"+url.PathEscape(id)+"/configure", map[string]string{"credential_handle": handle})
	})
	srv.Register("check_connection", "Read redacted setup or connection state. Supply exactly one of setup_id or connection_id. A privately approved setup returns an opaque credential_handle for configure_connection, never client IDs or secrets. A configured connection reports existing authorization and tool-discovery state; this does not perform a fresh service check or enable tools. Connection IDs must belong to a setup created by this owner. Local server only.", map[string]any{
		"type": "object", "additionalProperties": false, "properties": withMachine(map[string]any{"setup_id": identifier(), "connection_id": identifier()}),
		"oneOf": []map[string]any{{"required": []string{"setup_id"}}, {"required": []string{"connection_id"}}},
	}, func(args map[string]any) (string, error) {
		if err := connectionSetupArguments(args, "setup_id", "connection_id"); err != nil {
			return "", err
		}
		setup, _, err := argStringOptional(args, "setup_id")
		if err != nil {
			return "", err
		}
		connection, _, err := argStringOptional(args, "connection_id")
		if err != nil {
			return "", err
		}
		if (setup == "") == (connection == "") {
			return "", fmt.Errorf("supply exactly one setup_id or connection_id")
		}
		if setup != "" {
			return connectionSetupRequest(args, http.MethodGet, "setups/"+url.PathEscape(setup), nil)
		}
		return connectionSetupRequest(args, http.MethodGet, "setup-connections/"+url.PathEscape(connection), nil)
	})
	srv.Register("cancel_connection_setup", "Cancel an owner-bound setup and discard staged credentials. Does not remove or revoke already configured connections. Local server only.", map[string]any{
		"type": "object", "additionalProperties": false, "properties": withMachine(map[string]any{"setup_id": identifier()}), "required": []string{"setup_id"},
	}, func(args map[string]any) (string, error) {
		if err := connectionSetupArguments(args, "setup_id"); err != nil {
			return "", err
		}
		id, err := argString(args, "setup_id")
		if err != nil {
			return "", err
		}
		return connectionSetupRequest(args, http.MethodDelete, "setups/"+url.PathEscape(id), nil)
	})
}
