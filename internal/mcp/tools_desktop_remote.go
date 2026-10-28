package mcp

import (
	"encoding/json"
	"errors"
	"net/url"
	"strconv"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// A desktop client reached over SSH needs the remote serve process's Chat
// sidebar and loopback port. The token never leaves the remote machine: SSH
// forwards to its loopback listener, where the existing local-auth rule runs.
func registerDesktopRemoteSnapshot(srv *Server) {
	pt := newPublishTools()
	srv.Register("desktop_remote_snapshot", "Read this machine's Chat sessions and folders, plus the loopback port used to open this muxterm UI through an SSH tunnel. Intended for the Muxterm Mac app. Does not return credentials. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{})},
		func(args map[string]any) (string, error) {
			if err := refuseRemote(args, chatLocalOnly); err != nil {
				return "", err
			}
			chats, err := pt.doRequest("GET", "/api/sdk-chats?archived=false", nil)
			if err != nil {
				return "", err
			}
			projects, err := pt.doRequest("GET", "/api/sdk-projects", nil)
			if err != nil {
				return "", err
			}
			address, err := sessiond.ServerURL()
			if err != nil {
				return "", err
			}
			u, err := url.Parse(address)
			if err != nil {
				return "", err
			}
			port, err := strconv.Atoi(u.Port())
			if err != nil || port < 1 || port > 65535 {
				return "", errors.New("remote muxterm has no tunnelable server port")
			}
			result, _ := json.Marshal(map[string]any{"sessions": json.RawMessage(chats), "projects": json.RawMessage(projects), "port": port})
			return string(result), nil
		})
}
