package mcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// Publishing a local file to an anonymous public URL, from an agent session.
//
// These are the reason the feature is useful before any button exists: a
// chief-of-staff session can publish a file on the user's behalf, tell them
// what is now exposed, and revoke it -- with no UI at all.
//
// LIKE tunnelTools, these talk to the SERVE layer's HTTP API rather than to
// sessiond, because the publication registry lives in the serve layer. They
// therefore work whether or not a daemon is running, and they authenticate
// with the same-user local token.
//
// MACHINE SCOPING, AND WHY IT IS A REFUSAL RATHER THAN A PARAMETER.
// PR #90's rule is that a tool is either machine-scoped or explicitly refuses
// a machine argument -- a schema that merely OMITS "machine" does not reject
// one, it ignores one, and performs the action on THIS machine while
// answering success. All three tools here take a machine parameter and refuse
// any value but local, for two different reasons:
//
//   - publish_file: read_file already crosses the boundary read-only, but
//     turning a remote read into a PUBLIC URL is a bigger step than reading,
//     and the live identity check (device+inode, re-verified on every request)
//     would have to run on the far side, on every read, through the transport.
//     Publishing a remote file with the guard running only here would be a
//     link that looks pinned and is not. Named as a follow-on rather than
//     half-built.
//   - list_publications, revoke_publication: the registry is this machine's.
//     Revocation is destructive and stays local-only regardless, under the
//     standing rule that destructive actions do not cross a machine boundary.
type publishTools struct{}

func newPublishTools() *publishTools { return &publishTools{} }

const (
	publishRemoteRefusal = "publishing is deliberately local-only in this round. Publishing a file on another " +
		"machine would need the live identity check -- device and inode, re-verified on every single read -- to " +
		"run on that machine too, and a link that looks pinned but is not is worse than no link. " +
		"Publish it from a session on that machine instead"

	publishRegistryRefusal = "the publication registry belongs to the muxterm serve process on THIS machine, " +
		"and revoking is destructive, so it never crosses a machine boundary. Run this from a session on that machine"
)

// publish registers one local file and returns the URL to send.
func (pt *publishTools) publish(args map[string]any) (string, error) {
	if err := refuseRemote(args, publishRemoteRefusal); err != nil {
		return "", err
	}
	path, err := argString(args, "path")
	if err != nil {
		return "", err
	}
	payload := map[string]any{"path": path}
	if raw, present := args["ttl_seconds"]; present && raw != nil {
		n, terr := argInt(args, "ttl_seconds")
		if terr != nil {
			return "", terr
		}
		payload["ttl_seconds"] = n
	}
	body, _ := json.Marshal(payload)
	resp, err := pt.doRequest(http.MethodPost, "/api/publications", body)
	if err != nil {
		return "", fmt.Errorf("publish_file: %w", err)
	}
	return string(resp), nil
}

// list returns every publication with a FRESH disk check per row, which is
// what makes it answerable: "what have I got hanging out on the internet right
// now, and is any of it broken" is one call.
func (pt *publishTools) list(args map[string]any) (string, error) {
	if err := refuseRemote(args, publishRegistryRefusal); err != nil {
		return "", err
	}
	resp, err := pt.doRequest(http.MethodGet, "/api/publications", nil)
	if err != nil {
		return "", fmt.Errorf("list_publications: %w", err)
	}
	return string(resp), nil
}

// revoke removes one publication, or every publication when all is true.
func (pt *publishTools) revoke(args map[string]any) (string, error) {
	if err := refuseRemote(args, publishRegistryRefusal); err != nil {
		return "", err
	}
	all, _ := args["all"].(bool)
	id, idErr := argString(args, "publication_id")
	if all {
		if idErr == nil && id != "" {
			return "", fmt.Errorf("pass either publication_id or all:true, not both -- refusing rather than guessing which one you meant")
		}
		resp, err := pt.doRequest(http.MethodDelete, "/api/publications", nil)
		if err != nil {
			return "", fmt.Errorf("revoke_publication: %w", err)
		}
		return string(resp), nil
	}
	if idErr != nil {
		return "", idErr
	}
	resp, err := pt.doRequest(http.MethodDelete, "/api/publications/"+id, nil)
	if err != nil {
		return "", fmt.Errorf("revoke_publication %s: %w", id, err)
	}
	return string(resp), nil
}

// refuseRemote implements the localOnly rule for tools that do NOT go through
// the lazyClient (these speak HTTP to the serve layer, not to sessiond, so
// run.go's localOnly wrapper does not apply to them).
func refuseRemote(args map[string]any, reason string) error {
	name, _, err := argStringOptional(args, "machine")
	if err != nil {
		return err
	}
	if isLocal(name) {
		return nil
	}
	return fmt.Errorf("machine %q: refused -- %s. Nothing was done on this machine instead", name, reason)
}

// doRequest sends one request to the serve-layer publications API, reading the
// server URL and the same-user local token from the runtime-dir handoff files.
func (pt *publishTools) doRequest(method, path string, body []byte) ([]byte, error) {
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
	if token, terr := sessiond.ServerToken(); terr == nil && token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close() //nolint:errcheck
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, bytes.TrimSpace(respBody))
	}
	return respBody, nil
}

// registerPublishTools registers the 3 publishing MCP tools directly on srv,
// without the lazyClient: like the tunnel tools they speak to the serve
// layer's HTTP API, so they must not require sessiond to be running.
func registerPublishTools(srv *Server) {
	pt := newPublishTools()

	srv.Register(
		"publish_file",
		"publish ONE local file to an anonymous public URL that anyone holding the link can read, with no muxterm "+
			"account. Returns id, url, expires_at, kind and a fresh identity check. THE CONTENT IS LIVE, NOT A "+
			"SNAPSHOT: the file is re-read from disk on every request, so edits are visible to everyone holding the "+
			"link immediately, and a file that later gains a secret leaks it through a link already sent. The link "+
			"cannot be un-sent; revoking stops future reads but cannot recall what was already read. Every "+
			"publication expires -- ttl_seconds defaults to 86400 (24h) and cannot exceed 604800 (7 days). Markdown "+
			"renders as a page; HTML and SVG never render and are served as downloads. The file is pinned by device "+
			"and inode at publish time and re-verified on every read, so if it is replaced -- including by a symlink "+
			"-- the link refuses to serve rather than serving the new target. Local machine only",
		map[string]any{
			"type": "object",
			"properties": withMachine(map[string]any{
				"path": map[string]any{
					"type":        "string",
					"description": "absolute path (or one starting with ~/) of the file to publish; a relative path is an error",
				},
				"ttl_seconds": map[string]any{
					"type":        "integer",
					"description": "how long the link works, in seconds. Default 86400 (24h), maximum 604800 (7 days). A larger value is an error, never a silent clamp",
				},
			}),
			"required": []string{"path"},
		},
		func(args map[string]any) (string, error) { return pt.publish(args) },
	)

	srv.Register(
		"list_publications",
		"everything currently published from this machine to a public URL, newest first. Each row: id, url, path, "+
			"published_at, expires_at, expired, seconds_left, kind, content_type, size_at_publish, current size, "+
			"identity_ok and status. Every row is RE-CHECKED AGAINST DISK as this is called, so status answers "+
			"\"is any of it broken\": ok, expired, source_missing (the file was deleted or renamed), "+
			"identity_mismatch (the file was replaced, so the link refuses to serve), too_large (it grew past the "+
			"limit) or source_unreadable. size is -1 when the file could not be read at all. Local machine only",
		map[string]any{
			"type":       "object",
			"properties": withMachine(map[string]any{}),
		},
		func(args map[string]any) (string, error) { return pt.list(args) },
	)

	srv.Register(
		"revoke_publication",
		"revoke a public link by publication_id, or all:true to revoke every publication at once. Takes effect on "+
			"the very next request -- nothing is cached anywhere on the public path. It stops FUTURE reads only: it "+
			"cannot recall anything a recipient already read or saved. Local machine only",
		map[string]any{
			"type": "object",
			"properties": withMachine(map[string]any{
				"publication_id": map[string]any{
					"type":        "string",
					"description": "the id from publish_file or list_publications",
				},
				"all": map[string]any{
					"type":        "boolean",
					"description": "revoke every publication on this machine. Mutually exclusive with publication_id",
				},
			}),
		},
		func(args map[string]any) (string, error) { return pt.revoke(args) },
	)
}
