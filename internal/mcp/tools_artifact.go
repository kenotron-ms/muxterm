package mcp

import (
	"encoding/json"
	"fmt"
)

// The `view_file` tool: put a document on the user's screen.
//
// WHY A TOOL AT ALL, WHEN read_file EXISTS. read_file answers "what does this
// file say" to the AGENT. This answers "let me look at that" to the PERSON, and
// they are different acts with different outputs. An agent asked to show
// somebody a diagram cannot do it by reading the diagram; an agent asked to
// show somebody a 400-line design doc cannot do it by pasting 400 lines into a
// chat pane. The two tools are complements, not alternatives, and the
// description below says so because an agent choosing between them will read
// nothing else.
//
// IT SPEAKS HTTP TO THE SERVE LAYER, not to sessiond -- the same shape as the
// publish and tunnel tools next door, and for the same reason: what it needs is
// the set of connected BROWSERS, which is a property of `muxterm serve`, and
// sessiond has never heard of a browser. Registered directly on srv rather than
// through the lazyClient so it does not require a running daemon.
//
// LOCAL ONLY. A remote machine's file cannot be shown in this browser: the
// viewer reads what it displays through THIS server's /api/artifact, so a path
// on another host would resolve here to something else or to nothing. Refused
// by name via refuseRemote rather than silently shown from the wrong machine --
// the failure the machine argument exists to prevent.

// artifactTools speaks to the serve layer's artifact API. Stateless, like
// publishTools; it holds nothing between calls.
type artifactTools struct{ *publishTools }

func newArtifactTools() *artifactTools { return &artifactTools{newPublishTools()} }

// view returns what the server did, in the words an agent should repeat.
func (at *artifactTools) view(args map[string]any) (string, error) {
	if err := refuseRemote(args, "the viewer shows a file on the machine this browser is connected to"); err != nil {
		return "", err
	}
	path, err := argString(args, "path")
	if err != nil {
		return "", err
	}

	body, err := json.Marshal(map[string]string{"path": path})
	if err != nil {
		return "", err
	}
	resp, err := at.doRequest("POST", "/api/artifact/open", body)
	if err != nil {
		return "", err
	}

	var out struct {
		Path     string `json:"path"`
		Name     string `json:"name"`
		Browsers int    `json:"browsers"`
	}
	if err := json.Unmarshal(resp, &out); err != nil {
		return "", err
	}

	// ZERO BROWSERS IS THE ANSWER THAT MATTERS. An agent that believes it just
	// showed somebody something, when nothing was open to show it in, will say
	// so to the user and be wrong. It is not an error -- the server did
	// exactly what was asked -- so it is reported rather than raised.
	if out.Browsers == 0 {
		return fmt.Sprintf(
			"%s is ready to view, but NO BROWSER IS CONNECTED to this muxterm, so nobody saw it. "+
				"It will not appear retroactively when one opens. Say this rather than reporting success.",
			out.Path), nil
	}
	plural := "browser"
	if out.Browsers > 1 {
		plural = "browsers"
	}
	return fmt.Sprintf(
		"showing %s in the Viewer, in %d connected %s. It is rendered exactly as a published link would "+
			"show it: markdown as a document, text as text, images drawn, and HTML/SVG/PDF not rendered but "+
			"offered as a download.",
		out.Path, out.Browsers, plural), nil
}

// registerArtifactTools registers `view_file` directly on srv, without the
// lazyClient: like the publish and tunnel tools it speaks to the serve layer's
// HTTP API, so it must not require sessiond to be running.
func registerArtifactTools(srv *Server) {
	at := newArtifactTools()

	srv.Register(
		"view_file",
		"SHOW one local file to the human, in muxterm's Viewer, in every browser currently connected. This is "+
			"how you answer \"show me that\" -- it puts a document in front of a PERSON, whereas read_file puts "+
			"one in front of YOU. Reach for it when somebody asks to look at, see, or be shown a file, and when "+
			"a diagram, a screenshot or a long document would be worse pasted into chat than opened. IT SHOWS "+
			"EXACTLY WHAT A PUBLISHED LINK WOULD SHOW, using the same renderer, the same stylesheet and the same "+
			"8 MB bound: markdown renders as a document, text as text, images are drawn, and HTML, SVG, PDF and "+
			"unrecognised types are NOT rendered -- they are offered as a download, because they can carry script "+
			"and the viewer runs inside the user's authenticated session. Nothing is published and no link is "+
			"created: this is local, read-only, and visible only to someone already logged in to this muxterm. "+
			"Returns how many browsers were told -- ZERO means nobody saw it, which you must report rather than "+
			"claiming success. Local machine only",
		map[string]any{
			"type": "object",
			"properties": withMachine(map[string]any{
				"path": map[string]any{
					"type": "string",
					"description": "absolute path (or one starting with ~/) of the file to show; a relative path is an error, " +
						"and so is a directory",
				},
			}),
			"required": []string{"path"},
		},
		func(args map[string]any) (string, error) { return at.view(args) },
	)
}
