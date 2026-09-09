package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// The /api/artifact routes: ONE LOCAL FILE, SHOWN THE WAY A RECIPIENT WOULD
// SEE IT.
//
//	GET  /api/artifact?path=<absolute path>   metadata + text, for the viewer
//	GET  /api/artifact/raw?path=<abs>         the bytes (images; downloads)
//	GET  /api/artifact/doc.css                the published-document stylesheet
//	POST /api/artifact/open {"path":"..."}    tell every open browser to show it
//
// ┌─ WHY THIS IS NOT A SECOND WAY TO SERVE A FILE ────────────────────────────┐
// │                                                                          │
// │  The viewer is the LOCAL PREVIEW OF THE PUBLISHED VIEW. What the user     │
// │  sees here has to be what a recipient sees at /p/{id}, or the preview is  │
// │  worthless -- publishing goes back to being a guess you confirm by        │
// │  opening the link.                                                       │
// │                                                                          │
// │  So this file DECIDES NOTHING about how a file is presented. The kind     │
// │  and the content type both come from publicationKindFor() in publish.go   │
// │  -- the same function, not a copy of its table -- and the size bound is   │
// │  publicationMaxBytes, the same constant. Agreement is therefore a         │
// │  property of the code rather than a thing to keep re-checking: a new      │
// │  extension added to the publish path shows up here on the same commit.    │
// │                                                                          │
// └──────────────────────────────────────────────────────────────────────────┘
//
// THAT INHERITANCE CARRIES THE SAFETY DECISION TOO, and it matters MORE here
// than it does on the public route. /p/{id} serves an anonymous stranger; this
// route serves a page inside muxterm's OWN authenticated origin, holding the
// user's session next to a live terminal multiplexer. A hostile .html or .svg
// rendered inline here would run with access to exactly that. publish.go
// already decided such files never render -- they download -- and the viewer
// inherits it verbatim rather than inventing a softer local rule. There is no
// iframe on this path, sandboxed or otherwise.
//
// SECURITY, otherwise: identical to /api/files next door. AuthMiddleware wraps
// these at mux registration, and they add NO authority beyond what /ws already
// grants -- the same boundary hands out a PTY, and a shell can cat any file
// this handler can read. The guard is CORRECTNESS (absolute, cleaned, a
// regular file, within the bound), deliberately not a jail; a chroot here
// would constrain the viewer without constraining the terminal beside it.

// artifactResponse is GET /api/artifact.
//
// Text is populated for exactly the two kinds that render as text in the
// browser -- markdown and text -- and is empty for everything else. An image
// is fetched as bytes from /api/artifact/raw; a download is not fetched at
// all until the user asks for it.
type artifactResponse struct {
	Path        string `json:"path"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	Modified    int64  `json:"modified"` // unix seconds
	Kind        string `json:"kind"`     // markdown | text | image | download
	ContentType string `json:"contentType"`
	Text        string `json:"text"`
	// TooLarge is the honest answer for a file past the bound: the metadata
	// is real, the bytes were never read, and the viewer says so by name
	// instead of hanging the browser on 200MB of anything.
	TooLarge bool `json:"tooLarge"`
	// MaxBytes is the bound itself, on the wire, so the viewer can state the
	// number it was measured against rather than hard-coding a copy of it.
	MaxBytes int64 `json:"maxBytes"`
	// Binary is set when a file classified as text does not decode as UTF-8.
	// Rendering it anyway produces mojibake, which looks like a broken viewer
	// rather than an unsuitable file.
	Binary bool `json:"binary"`
}

func writeArtifactJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeArtifactError(w http.ResponseWriter, code int, err error) {
	writeArtifactJSON(w, code, map[string]string{"error": err.Error()})
}

// artifactPath validates the ?path= (or body) argument and stats it.
//
// Anything relative is refused rather than resolved against the server's cwd,
// for handleFilesList's reason verbatim: a browser that thinks it is asking
// for "web/src/x.md" and is shown somewhere else has been lied to.
//
// Stat, not Lstat: a symlink to a document is a document, and following it is
// what every other reader of this path does. What the symlink cannot do is
// make a directory look like a file -- IsDir() is checked after resolution.
func artifactPath(raw string) (string, os.FileInfo, int, error) {
	p := strings.TrimSpace(raw)
	if p == "" {
		return "", nil, http.StatusBadRequest, errors.New(`"path" is required and must be an absolute path`)
	}
	// `~/` expands, exactly as it does for publishing (resolvePublishPath):
	// an agent naming a file in the user's home should not have to know that
	// server's idea of $HOME, and the two entry points must not disagree
	// about what a given string means.
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, herr := os.UserHomeDir()
		if herr != nil {
			return "", nil, http.StatusBadRequest, fmt.Errorf("cannot expand %q: %w", raw, herr)
		}
		p = filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(p, "~"), "/"))
	}
	if !filepath.IsAbs(p) {
		return "", nil, http.StatusBadRequest, fmt.Errorf("%q is not an absolute path", p)
	}
	p = filepath.Clean(p)

	fi, err := os.Stat(p)
	switch {
	case os.IsNotExist(err):
		return "", nil, http.StatusNotFound, fmt.Errorf("%s does not exist", p)
	case os.IsPermission(err):
		return "", nil, http.StatusForbidden, fmt.Errorf("%s cannot be read", p)
	case err != nil:
		return "", nil, http.StatusInternalServerError, err
	case fi.IsDir():
		return "", nil, http.StatusBadRequest, fmt.Errorf("%s is a directory, not a file", p)
	case !fi.Mode().IsRegular():
		// A fifo, a device or a socket. Reading one can block forever, which
		// is a hung viewer rather than an error the user can act on.
		return "", nil, http.StatusBadRequest, fmt.Errorf("%s is not a regular file", p)
	}
	return p, fi, http.StatusOK, nil
}

// handleArtifact answers GET /api/artifact?path=<absolute path>.
func (s *Server) handleArtifact(w http.ResponseWriter, r *http.Request) {
	p, fi, code, err := artifactPath(r.URL.Query().Get("path"))
	if err != nil {
		writeArtifactError(w, code, err)
		return
	}

	// THE SAME CLASSIFIER THE PUBLIC ROUTE USES. Not a copy of its table.
	kind, ctype := publicationKindFor(p)

	resp := artifactResponse{
		Path:        p,
		Name:        filepath.Base(p),
		Size:        fi.Size(),
		Modified:    fi.ModTime().Unix(),
		Kind:        string(kind),
		ContentType: ctype,
		MaxBytes:    publicationMaxBytes,
	}

	// THE SAME BOUND, CHECKED BEFORE ANY READ. A file past it is described,
	// never read: the whole point of a bound is that the expensive thing does
	// not happen. Applies to every kind, including the ones whose bytes this
	// handler would not have returned anyway, so the answer a user gets for a
	// 200MB file is the same sentence whatever its extension is.
	if fi.Size() > publicationMaxBytes {
		resp.TooLarge = true
		writeArtifactJSON(w, http.StatusOK, resp)
		return
	}

	// Only text-shaped kinds are read here. An image is bytes the browser
	// fetches itself; a download is bytes nobody has asked for yet.
	if kind == kindMarkdown || kind == kindText {
		buf, rerr := readArtifactBytes(p)
		if rerr != nil {
			writeArtifactError(w, http.StatusInternalServerError, rerr)
			return
		}
		// A file the extension called text but which is not UTF-8 -- a .log
		// that is really a core dump, a .json that is really gzip. Saying so
		// is better than a screenful of replacement characters.
		if !isProbablyUTF8Text(buf) {
			resp.Binary = true
		} else {
			resp.Text = string(buf)
		}
	}

	writeArtifactJSON(w, http.StatusOK, resp)
}

// readArtifactBytes reads at most publicationMaxBytes+1 and refuses the file
// if it reached that, catching a file that grew between the stat and the read.
func readArtifactBytes(p string) ([]byte, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close() //nolint:errcheck
	buf, err := io.ReadAll(io.LimitReader(f, publicationMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(buf)) > publicationMaxBytes {
		return nil, fmt.Errorf("this file is larger than the %d MB a viewer will read", publicationMaxBytes>>20)
	}
	return buf, nil
}

// isProbablyUTF8Text answers "would rendering these bytes as text produce
// something a person can read".
//
// A NUL byte is the giveaway and it is checked first: no text file has one,
// and every binary format this matters for has them early. utf8.Valid alone
// would pass a run of NULs.
func isProbablyUTF8Text(buf []byte) bool {
	for _, b := range buf {
		if b == 0 {
			return false
		}
	}
	return utf8.Valid(buf)
}

// handleArtifactRaw answers GET /api/artifact/raw?path=<absolute path>.
//
// It serves the BYTES, and it serves them under exactly the rules the public
// route uses:
//
//   - an image goes inline with its real image content type;
//   - EVERYTHING ELSE goes as an attachment under application/octet-stream,
//     which is what makes this route unable to become an inline-HTML hole in
//     muxterm's own origin no matter what a caller points it at.
//
// X-Content-Type-Options: nosniff is what makes the second bullet true rather
// than merely intended: without it a browser may sniff an attachment's bytes,
// decide they are HTML, and act on that decision.
func (s *Server) handleArtifactRaw(w http.ResponseWriter, r *http.Request) {
	p, fi, code, err := artifactPath(r.URL.Query().Get("path"))
	if err != nil {
		writeArtifactError(w, code, err)
		return
	}
	if fi.Size() > publicationMaxBytes {
		writeArtifactError(w, http.StatusRequestEntityTooLarge, fmt.Errorf(
			"%s is %d bytes, past the %d MB a viewer will read", p, fi.Size(), publicationMaxBytes>>20))
		return
	}
	buf, err := readArtifactBytes(p)
	if err != nil {
		writeArtifactError(w, http.StatusInternalServerError, err)
		return
	}

	kind, ctype := publicationKindFor(p)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if kind == kindImage {
		w.Header().Set("Content-Type", ctype)
	} else {
		// Not an image: never rendered in this origin. Note this covers the
		// TEXT kinds too -- the viewer already has their characters from
		// /api/artifact, so the only reason to hit this route for one is to
		// save it, and an attachment is what saving means.
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", "attachment; filename=\""+safeAttachmentName(filepath.Base(p))+"\"")
	}
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(buf)
}

// handleArtifactDocCSS answers GET /api/artifact/doc.css with publicDocCSS --
// the stylesheet the public /p/{id} page inlines, byte for byte.
//
// THIS ROUTE IS THE OTHER HALF OF THE AGREEMENT. Sharing the renderer makes
// the two views produce the same ELEMENTS; sharing this makes them produce the
// same PAGE. A copy of these rules in the frontend would agree on the day it
// was written and drift on the first change to either side, which is exactly
// the failure the viewer exists to prevent.
//
// It carries no secret -- it is already served to anonymous readers on every
// published page -- but it stays behind protect() with the rest of /api
// because there is no reason for it not to.
func (s *Server) handleArtifactDocCSS(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, publicDocCSS)
}

// artifactOpenRequest is the body of POST /api/artifact/open.
type artifactOpenRequest struct {
	Path string `json:"path"`
}

// handleArtifactOpen answers POST /api/artifact/open: show this file, in
// every browser currently looking at this server.
//
// WHAT IT IS FOR. The chief of staff is asked "show me the design doc". It
// needs a way to put a document in front of the person who asked, and an MCP
// tool that returns text to its own transcript is not that -- the person asked
// to LOOK at something.
//
// WHY IT VALIDATES BEFORE BROADCASTING. A tool that reports success and leaves
// every open tab showing "that file does not exist" has told the agent one
// thing and the human another. The file is proved readable HERE, once, so the
// failure lands in the caller's hands where it can be acted on.
//
// WHAT IT IS NOT. It carries a path, opens a read-only viewer, and grants
// nothing: every byte it leads to was already readable through /api/artifact
// by the same authenticated session. It cannot navigate to a workspace, run
// anything, or close anything.
func (s *Server) handleArtifactOpen(w http.ResponseWriter, r *http.Request) {
	var req artifactOpenRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeArtifactError(w, http.StatusBadRequest, fmt.Errorf("could not read the request body: %w", err))
		return
	}
	p, _, code, err := artifactPath(req.Path)
	if err != nil {
		writeArtifactError(w, code, err)
		return
	}

	// How many browsers were told. Zero is not an error -- the server is
	// working exactly as asked -- but it is the single most useful thing to
	// tell an agent that thinks it just showed someone something, so it is
	// returned rather than swallowed.
	n := s.hub.BroadcastOpenArtifact(p)
	writeArtifactJSON(w, http.StatusOK, map[string]any{
		"path":     p,
		"name":     filepath.Base(p),
		"browsers": n,
	})
}
