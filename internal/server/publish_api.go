package server

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// The publishing routes, in two families that could not be more different in
// posture:
//
//	OWNER SIDE, behind protect() like every other /api route:
//	  GET    /api/publications        what am I exposing right now
//	  POST   /api/publications        publish one file
//	  DELETE /api/publications/{id}   revoke one, immediately
//	  DELETE /api/publications        revoke everything
//
//	PUBLIC SIDE, deliberately NOT behind protect():
//	  GET /p/{id}                     the published file, to anyone with the link
//	  GET /p/_asset/doc.js            the markdown renderer for the page above
//
// ⛔ THE AUTH BYPASS IS THE FEATURE AND THE RISK. Every other route in this
// server sits behind AuthMiddleware. These two do not, because a link that
// needs a muxterm account is not a link you can send to anyone. The bypass is
// scoped by REGISTRATION, not by a conditional inside the middleware: the two
// public patterns are simply registered without protect(), and no existing
// pattern changes. There is no flag, no header, and no request-derived
// condition anywhere that can turn a protected route into an unprotected one.
//
// Both public patterns are FIXED SHAPE. /p/{id} has exactly two segments and
// the id is validated to 22 base64url characters before the registry is
// consulted; /p/_asset/doc.js is a literal with no wildcard at all. There is no
// caller-controlled path component anywhere on the public side, so directory
// traversal is not filtered, it is unrepresentable.

// publicAssetPath is the built public-document renderer inside PublicDocFS.
// Its name is pinned in web/vite.public-doc.config.ts precisely so this
// constant can exist -- a content-hashed name would have to be discovered at
// runtime, and a discovered name is a name an attacker can influence.
const publicAssetPath = "public-doc.js"

// handlePublicationsList returns every publication with a freshly re-checked
// disk state. Protected route.
func (s *Server) handlePublicationsList(w http.ResponseWriter, _ *http.Request) {
	items := s.publications.List()
	out := make([]publicationView, 0, len(items))
	for _, p := range items {
		out = append(out, s.publications.view(p, s.publicationURL(p.id)))
	}
	writeJSON(w, http.StatusOK, out)
}

// handlePublicationCreate publishes one file. Protected route.
//
// Body: {"path": "<absolute path>", "ttl_seconds": <int, optional>}
func (s *Server) handlePublicationCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path       string `json:"path"`
		TTLSeconds int64  `json:"ttl_seconds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "body must be JSON with a \"path\" field", http.StatusBadRequest)
		return
	}
	ttl := time.Duration(body.TTLSeconds) * time.Second
	p, err := s.publications.Create(body.Path, ttl)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, s.publications.view(p, s.publicationURL(p.id)))
}

// handlePublicationRevoke removes one publication, or all of them when no id
// segment is present. Protected route. Revocation takes effect on the very
// next request: there is no cache anywhere on the public path (every public
// response carries Cache-Control: no-store) and nothing is copied at publish.
func (s *Server) handlePublicationRevoke(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "revoked": s.publications.RevokeAll()})
		return
	}
	if !s.publications.Revoke(id) {
		http.Error(w, "publication not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "revoked": 1})
}

// publicationURL returns the address to hand to a recipient.
//
// Absolute only when an operator configured a public origin, exactly like
// tunnelURL and for the same reason: the only origin muxterm can derive
// without configuration is its own listen address, which is loopback in every
// deployment that has a remote reader. A confidently wrong absolute URL is
// worse than an honest relative one. Never derived from a request header.
func (s *Server) publicationURL(id string) string {
	path := "/p/" + id
	base := s.publicBaseURL()
	if base == "" {
		return path
	}
	return base + path
}

// handlePublicDocument serves a published file to an ANONYMOUS reader.
//
// ⛔ UNAUTHENTICATED BY DESIGN. Read the file header before changing anything
// here. The only input is an id; there is no path, no filename, and no query
// parameter that reaches the filesystem.
func (s *Server) handlePublicDocument(w http.ResponseWriter, r *http.Request) {
	publicSafetyHeaders(w)

	id := r.PathValue("id")
	p, state := s.publications.Get(id)
	switch state {
	case lookupMissing:
		publicRefusal(w, http.StatusNotFound,
			"This link is not valid.",
			"It may have been revoked, it may have expired some time ago, or the machine that published it may have restarted. Ask whoever sent it for a new one.")
		return
	case lookupExpired:
		publicRefusal(w, http.StatusGone,
			"This link has expired.",
			"It stopped working at "+p.expiresAt.UTC().Format(time.RFC3339)+". Ask whoever sent it to publish it again.")
		return
	}

	content, _, err := readPinned(p)
	if err != nil {
		var fault *pubFault
		if errors.As(err, &fault) {
			publicRefusal(w, fault.Status, fault.Public, "")
			return
		}
		publicRefusal(w, http.StatusInternalServerError, "This link cannot be served right now.", "")
		return
	}

	switch p.kind {
	case kindMarkdown:
		w.Header().Set("Content-Security-Policy", markdownPageCSP)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		w.Write(markdownPageHTML(p, content)) //nolint:errcheck
	case kindDownload:
		// HTML and SVG both carry script and would execute in muxterm's own
		// origin, alongside a live terminal multiplexer, so neither ever
		// renders here. They download, as does every type this server does
		// not positively recognise.
		w.Header().Set("Content-Security-Policy", inertCSP)
		w.Header().Set("Content-Type", p.contentType)
		if p.filename != "" {
			w.Header().Set("Content-Disposition", `attachment; filename="`+p.filename+`"`)
		} else {
			w.Header().Set("Content-Disposition", "attachment")
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(content)))
		w.WriteHeader(http.StatusOK)
		w.Write(content) //nolint:errcheck
	default:
		w.Header().Set("Content-Security-Policy", inertCSP)
		w.Header().Set("Content-Type", p.contentType)
		w.Header().Set("Content-Length", strconv.Itoa(len(content)))
		w.WriteHeader(http.StatusOK)
		w.Write(content) //nolint:errcheck
	}
}

// handlePublicAsset serves the one script the markdown page loads. Public,
// because the page that loads it is public; a literal path, because nothing
// about it is caller-controlled.
func (s *Server) handlePublicAsset(w http.ResponseWriter, _ *http.Request) {
	publicSafetyHeaders(w)
	if s.publicDocFS == nil {
		http.Error(w, "this build has no embedded web assets", http.StatusNotFound)
		return
	}
	b, err := fs.ReadFile(s.publicDocFS, publicAssetPath)
	if err != nil {
		http.Error(w, "public document renderer is not present in this build", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	// The renderer is immutable for the life of the binary, but caching it
	// would leave a stale renderer paired with a newer server after an
	// upgrade, for a saving measured in tens of kilobytes once per reader.
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	w.Write(b) //nolint:errcheck
}

const (
	// markdownPageCSP is what the rendered document page runs under. Script
	// comes only from this origin (the one asset above) and there is no
	// inline script. img-src is 'none' because #79's renderer draws a
	// markdown image as its alt text and fetches nothing -- the CSP states
	// that rather than leaving room for it, so a published document cannot be
	// turned into a beacon that reports who opened the link. If image
	// rendering is ever enabled, widen this deliberately and say why.
	markdownPageCSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; " +
		"img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

	// inertCSP accompanies every non-markdown body. Combined with nosniff it
	// means that even if a browser were talked into treating the bytes as
	// markup, the markup could load nothing and run nothing.
	inertCSP = "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)

// publicSafetyHeaders are set on EVERY public response, including refusals.
func publicSafetyHeaders(w http.ResponseWriter) {
	// nosniff is load-bearing, not decoration: it is what makes serving an
	// unexpected byte stream as text/plain actually inert.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Referrer-Policy", "no-referrer")
	// An unguessable URL that a crawler indexes is no longer unguessable.
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	// no-store is what makes LIVE actually live and REVOCATION actually
	// immediate. A cached copy at a CDN, a proxy, or in the reader's browser
	// would keep answering after the publisher revoked, and would keep
	// showing yesterday's bytes after they edited.
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, private")
	w.Header().Set("Pragma", "no-cache")
}

// publicRefusal writes a plain-text explanation. Deliberately text/plain and
// deliberately path-free: the reader is not the publisher and must not learn
// where on the publisher's disk anything lives, and a plain body cannot
// reflect anything into markup.
func publicRefusal(w http.ResponseWriter, status int, headline, detail string) {
	w.Header().Set("Content-Security-Policy", inertCSP)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	body := "muxterm\n\n" + headline + "\n"
	if detail != "" {
		body += "\n" + detail + "\n"
	}
	w.Write([]byte(body)) //nolint:errcheck
}

// markdownPageHTML builds the shell around #79's renderer.
//
// The markdown source is embedded as a JSON string in a data script rather
// than as markup. encoding/json escapes <, > and & to \u00xx by default, so
// the source cannot terminate the script element no matter what it contains,
// and the renderer that reads it never produces raw HTML (see
// web/src/lib/markdown-view.ts). Nothing on this path concatenates document
// content into markup.
func markdownPageHTML(p *publication, content []byte) []byte {
	title, _ := json.Marshal(p.filename)
	source, _ := json.Marshal(string(content))

	var b strings.Builder
	b.WriteString("<!doctype html>\n<html lang=\"en\"><head>\n")
	b.WriteString("<meta charset=\"utf-8\">\n")
	b.WriteString("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n")
	b.WriteString("<meta name=\"robots\" content=\"noindex, nofollow, noarchive\">\n")
	b.WriteString("<title>" + escapeHTMLText(p.filename) + "</title>\n")
	b.WriteString("<style>" + publicDocCSS + "</style>\n")
	b.WriteString("</head><body>\n")
	// The placeholder says what is actually true if the script never runs --
	// a permanent "Loading…" would be a lie told to a reader with JavaScript
	// disabled. public-doc.ts clears it before rendering.
	b.WriteString("<main id=\"doc\" class=\"doc\"><p class=\"loading\">This document needs JavaScript to render.</p></main>\n")
	b.WriteString("<script id=\"doc-title\" type=\"application/json\">")
	b.Write(title)
	b.WriteString("</script>\n")
	b.WriteString("<script id=\"doc-source\" type=\"application/json\">")
	b.Write(source)
	b.WriteString("</script>\n")
	b.WriteString("<script type=\"module\" src=\"/p/_asset/doc.js\"></script>\n")
	b.WriteString("<footer class=\"pub-footer\">published from muxterm \u00b7 live view \u00b7 link expires " +
		escapeHTMLText(p.expiresAt.UTC().Format("2006-01-02 15:04 MST")) + "</footer>\n")
	b.WriteString("</body></html>\n")
	return []byte(b.String())
}

// escapeHTMLText escapes the four characters that matter in element text and
// in a double-quoted attribute. Used only for server-generated strings (a
// sanitised filename, a formatted timestamp); document content never comes
// through here, it goes through the JSON data script.
func escapeHTMLText(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;")
	return r.Replace(s)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

// sweepPublications drops expired tombstones on a timer. Started by
// ListenAndServe and stopped with it.
func (s *Server) sweepPublications(done <-chan struct{}) {
	t := time.NewTicker(publicationSweepInterval)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case <-t.C:
			s.publications.sweep()
		}
	}
}
