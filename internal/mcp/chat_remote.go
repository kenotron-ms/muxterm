package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

type chatRemoteRow struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type chatRemotes struct {
	Connected  []chatRemoteRow `json:"connected"`
	Discovered []chatRemoteRow `json:"discovered"`
	Errors     []chatRemoteRow `json:"errors"`
}

// chatMachine resolves a caller's machine through the serve layer's connected
// remote registry. A bare name is accepted only when it identifies one host.
func (pt *publishTools) chatMachine(args map[string]any) (string, error) {
	name, _, err := argStringOptional(args, "machine")
	if err != nil {
		return "", err
	}
	if isLocal(name) {
		return LocalMachine, nil
	}
	body, err := pt.doRequest(http.MethodGet, "/api/remotes", nil)
	if err != nil {
		return "", fmt.Errorf("list connected remotes: %w", err)
	}
	var remotes chatRemotes
	if err := json.Unmarshal(body, &remotes); err != nil {
		return "", fmt.Errorf("decode connected remotes: %w", err)
	}
	for _, row := range remotes.Connected {
		if row.ID == name {
			return row.ID, nil
		}
	}
	var match string
	for _, row := range remotes.Connected {
		if row.Name != name {
			continue
		}
		if match != "" {
			return "", fmt.Errorf("remote name %q is ambiguous; use its id from list_remotes", name)
		}
		match = row.ID
	}
	if match != "" {
		return match, nil
	}
	return "", fmt.Errorf("machine %q is not connected; use list_remotes and connect_remote", name)
}

func (pt *publishTools) chatRequest(args map[string]any, method, path string, body []byte) ([]byte, error) {
	machine, err := pt.chatMachine(args)
	if err != nil {
		return nil, err
	}
	if machine != LocalMachine {
		path = "/api/remote-chat/" + url.PathEscape(machine) + path
	}
	return pt.doRequest(method, path, body)
}

func (pt *publishTools) remoteID(name string) (string, error) {
	if strings.TrimSpace(name) == "" || isLocal(name) {
		return "", fmt.Errorf("remote id or name required; use list_remotes")
	}
	body, err := pt.doRequest(http.MethodGet, "/api/remotes", nil)
	if err != nil {
		return "", err
	}
	var remotes chatRemotes
	if err := json.Unmarshal(body, &remotes); err != nil {
		return "", err
	}
	rows := append(append(remotes.Connected, remotes.Discovered...), remotes.Errors...)
	for _, row := range rows {
		if row.ID == name {
			return row.ID, nil
		}
	}
	var match string
	for _, row := range rows {
		if row.Name != name {
			continue
		}
		if match != "" {
			return "", fmt.Errorf("remote name %q is ambiguous; use its id", name)
		}
		match = row.ID
	}
	if match == "" {
		return "", fmt.Errorf("remote %q not found; use list_remotes", name)
	}
	return match, nil
}
