package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"
)

// The folder-publication routes.
//
//	OWNER SIDE, behind protect() like every other /api route:
//	  POST /api/publications/folder    publish one directory tree
//	  (list and revoke are the SAME routes as for files -- a folder is a row
//	   in the same registry, distinguished by kind, and revoking one id kills
//	   the whole tree at once)
//
//	PUBLIC SIDE, deliberately NOT behind protect():
//	  GET /p/{id}/{rest...}            one page or asset inside the tree
//
// ⛔ THIS ROUTE HAS A CALLER-CONTROLLED PATH COMPONENT AND /p/{id} DOES NOT.
// That is the whole difference between this file and publish_api.go, and it is
// not incidental -- a browsable tree cannot exist without the reader being
// able to say which page they want. publish_folder.go's header explains what
// replaces the "traversal is unrepresentable" guarantee that single-file
// publishing got for free. In one line: {rest...} is used as a MAP KEY into a
// manifest fixed at publish time and never as a path, and the path that is
// actually opened is rebuilt from the manifest's own stored relative path.
//
// Every miss -- traversal attempt, excluded file, file created after publish,
// plain typo -- returns the SAME 404 with the SAME words, so a reader probing
// paths learns nothing about what exists.

// handlePublicationCreateFolder publishes one directory tree. Protected route.
//
// Body: {"path": "<absolute path>", "ttl_seconds": <int, optional>}
func (s *Server) handlePublicationCreateFolder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path       string `json:"path"`
		TTLSeconds int64  `json:"ttl_seconds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "body must be JSON with a \"path\" field", http.StatusBadRequest)
		return
	}
	ttl := time.Duration(body.TTLSeconds) * time.Second
	p, err := s.publications.CreateFolder(body.Path, ttl)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, s.publications.view(p, s.publicationURL(p.id)))
}

// handlePublicTree serves one entry inside a published folder to an ANONYMOUS
// reader.
//
// ⛔ UNAUTHENTICATED BY DESIGN. Read publish_folder.go's header before
// changing anything here.
func (s *Server) handlePublicTree(w http.ResponseWriter, r *http.Request) {
	publicSafetyHeaders(w)

	p, ok := s.lookupPublicOrRefuse(w, r.PathValue("id"))
	if !ok {
		return
	}
	if !p.isFolder() {
		// A FILE publication has no interior. Answering with the same words
		// a missing tree page gets means /p/{fileid}/anything cannot be used
		// to probe for one.
		treeNotFound(w)
		return
	}

	rest := r.PathValue("rest")
	key, err := normalizeTreeRequest(rest)
	if err != nil {
		treeNotFound(w)
		return
	}

	base := "/p/" + p.id + "/"

	if dir, isDir := p.tree.dirs[key]; isDir {
		// A directory must be addressed with a trailing slash or every
		// relative link on the page resolves one level too high. The
		// redirect target is built from the MANIFEST key, not from the
		// request bytes.
		if key != "" && !strings.HasSuffix(rest, "/") {
			redirectPublic(w, treeEntryURL(base, key)+"/")
			return
		}
		s.serveTreeDirectory(w, p, base, dir)
		return
	}

	tf, isFile := p.tree.files[key]
	if !isFile {
		treeNotFound(w)
		return
	}
	// A file addressed WITH a trailing slash is a different URL from the one
	// the manifest holds, and serving both would give every page two
	// addresses with different relative-link bases. Refuse rather than guess.
	if strings.HasSuffix(rest, "/") {
		treeNotFound(w)
		return
	}
	s.serveTreeFile(w, p, base, parentKey(key), tf)
}

// parentKey returns the parent directory key of a manifest key.
func parentKey(key string) string {
	i := strings.LastIndex(key, "/")
	if i < 0 {
		return ""
	}
	return key[:i]
}

// lookupPublicOrRefuse resolves an id and writes the missing/expired refusal
// itself. Shared by the file route and the tree route so the two cannot drift
// into telling a reader different stories about the same lifecycle.
func (s *Server) lookupPublicOrRefuse(w http.ResponseWriter, id string) (*publication, bool) {
	p, state := s.publications.Get(id)
	switch state {
	case lookupMissing:
		publicRefusal(w, http.StatusNotFound,
			"This link is not valid.",
			"It may have been revoked, it may have expired some time ago, or the machine that published it may have restarted. Ask whoever sent it for a new one.")
		return nil, false
	case lookupExpired:
		publicRefusal(w, http.StatusGone,
			"This link has expired.",
			"It stopped working at "+p.expiresAt.UTC().Format(time.RFC3339)+". Ask whoever sent it to publish it again.")
		return nil, false
	}
	return p, true
}

// redirectPublic sends a TEMPORARY redirect, never a permanent one.
//
// 301 is cached by browsers effectively forever, and these URLs are revocable
// and expiring: a permanently cached redirect for a link that no longer exists
// is a broken address the reader cannot clear.
func redirectPublic(w http.ResponseWriter, to string) {
	w.Header().Set("Location", to)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusFound)
	w.Write([]byte("muxterm\n\nmoved to " + to + "\n")) //nolint:errcheck
}

// serveTreeFile serves one enumerated file, re-proving containment first.
func (s *Server) serveTreeFile(w http.ResponseWriter, p *publication, base, dirKey string, tf *treeFile) {
	content, _, err := readTreeFile(p.tree, tf)
	if err != nil {
		if errors.Is(err, errNotInTree) {
			treeNotFound(w)
			return
		}
		var fault *pubFault
		if errors.As(err, &fault) {
			publicRefusal(w, fault.Status, fault.Public, "")
			return
		}
		publicRefusal(w, http.StatusInternalServerError, "This page cannot be served right now.", "")
		return
	}

	switch tf.kind {
	case kindMarkdown:
		d := p.tree.dirs[dirKey]
		if d == nil {
			d = &treeDir{rel: dirKey}
		}
		w.Header().Set("Content-Security-Policy", treePageCSP)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		w.Write(treePageHTML(p, base, tf.rel, string(content), d, false)) //nolint:errcheck
	case kindDownload:
		// Unchanged from single-file publishing, and load-bearing for a
		// browsable tree specifically: an .html or .svg page inside a
		// published folder would otherwise run script in muxterm's OWN
		// origin, next to a live terminal multiplexer, having been fetched
		// by a reader who was told they were reading a wiki.
		w.Header().Set("Content-Security-Policy", inertCSP)
		w.Header().Set("Content-Type", tf.contentType)
		if tf.filename != "" {
			w.Header().Set("Content-Disposition", `attachment; filename="`+tf.filename+`"`)
		} else {
			w.Header().Set("Content-Disposition", "attachment")
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(content)))
		w.WriteHeader(http.StatusOK)
		w.Write(content) //nolint:errcheck
	default:
		// Images and text serve inline, which is what makes a wiki's
		// screenshots and code samples actually appear. nosniff plus the
		// inert CSP is what keeps that safe for bytes that are not what
		// their extension claims.
		w.Header().Set("Content-Security-Policy", inertCSP)
		w.Header().Set("Content-Type", tf.contentType)
		w.Header().Set("Content-Length", strconv.Itoa(len(content)))
		w.WriteHeader(http.StatusOK)
		w.Write(content) //nolint:errcheck
	}
}

// serveTreeDirectory serves a directory as a page: its index.md or README.md
// when it has one, always followed by a navigable listing of what is in it.
//
// Rendering the index document is what makes a docs folder feel like a site
// rather than an FTP listing. Keeping the listing underneath it is what keeps
// the folder BROWSABLE -- a page that is not linked from the index is still
// reachable, which is the difference between publishing a folder and
// publishing one document that happens to have neighbours.
func (s *Server) serveTreeDirectory(w http.ResponseWriter, p *publication, base string, d *treeDir) {
	// ⛔ THE ROOT IS RE-PROVEN HERE TOO, BEFORE A LISTING IS RENDERED.
	//
	// A listing is drawn entirely from the manifest, so it leaks no content
	// when the root has been swapped -- but it would answer 200 and look
	// healthy for a publication that is broken, while every page linked from
	// it answers 409. Found exactly that way in verification: the root page
	// returned 200 with an empty document while its own links refused. A page
	// of a publication that refuses to serve must itself refuse.
	if err := verifyTreeRoot(p.tree); err != nil {
		var fault *pubFault
		if errors.As(err, &fault) {
			publicRefusal(w, fault.Status, fault.Public, "")
			return
		}
		publicRefusal(w, http.StatusInternalServerError, "This folder cannot be served right now.", "")
		return
	}

	doc := ""
	docRel := ""
	if d.indexRel != "" {
		if tf, ok := p.tree.files[d.indexRel]; ok {
			if content, _, err := readTreeFile(p.tree, tf); err == nil {
				doc = string(content)
				docRel = tf.rel
			}
			// A broken index is not a broken directory: fall through to the
			// listing rather than refusing the whole page.
		}
	}
	w.Header().Set("Content-Security-Policy", treePageCSP)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write(treePageHTML(p, base, docRel, doc, d, true)) //nolint:errcheck
}

// treePageCSP is markdownPageCSP with ONE deliberate widening: img-src 'self'.
//
// WHY IT IS WIDENED HERE AND NOT FOR A SINGLE FILE. A wiki whose screenshots
// and diagrams do not load is not a wiki. 'self' means an image may come from
// THIS origin and nowhere else, and the only thing this origin will serve to
// an anonymous reader is an entry in a published manifest -- so an image can
// only be a file the publisher published. It specifically does NOT let a
// published page fetch an image from an attacker's host, which is what would
// turn the document into a beacon reporting who opened the link and from
// where. The renderer enforces the same rule independently: an image whose
// source is not inside this publication is drawn as its alt text and fetched
// not at all.
const treePageCSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; " +
	"img-src 'self'; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// treePageHTML builds one page of a published folder.
//
// Same construction as markdownPageHTML: document content NEVER becomes
// markup here. It is emitted as a JSON data script (encoding/json escapes <,
// > and & so it cannot terminate the script element) and rendered by #79's
// renderer, which builds Lit templates and interpolates every piece of text.
// Every other string on the page is a filename or a timestamp, escaped
// through escapeHTMLText.
func treePageHTML(p *publication, base, docRel, doc string, d *treeDir, isDir bool) []byte {
	title := path.Base(p.path)
	switch {
	case isDir && d.rel != "":
		title = path.Base(d.rel)
	case !isDir && docRel != "":
		title = path.Base(docRel)
	}

	jsonTitle, _ := json.Marshal(title)
	jsonSource, _ := json.Marshal(doc)
	// The publication base is what the browser-side link policy checks a
	// resolved link against. Its PRESENCE is also the signal that this page
	// is part of a tree and may therefore make in-tree links clickable and
	// in-tree images visible -- a single published file emits no such script
	// and keeps exactly the behaviour it had before folders existed.
	jsonBase, _ := json.Marshal(base)

	var b strings.Builder
	b.WriteString("<!doctype html>\n<html lang=\"en\"><head>\n")
	b.WriteString("<meta charset=\"utf-8\">\n")
	b.WriteString("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n")
	b.WriteString("<meta name=\"robots\" content=\"noindex, nofollow, noarchive\">\n")
	b.WriteString("<title>" + escapeHTMLText(title) + "</title>\n")
	b.WriteString("<style>" + publicDocCSS + publicTreeCSS + "</style>\n")
	b.WriteString("</head><body>\n")

	b.WriteString(breadcrumbHTML(p, base, docRel, d, isDir))

	if doc != "" {
		b.WriteString("<main id=\"doc\" class=\"doc\"><p class=\"loading\">This document needs JavaScript to render.</p></main>\n")
	} else if !isDir {
		b.WriteString("<main id=\"doc\" class=\"doc\"></main>\n")
	}

	if isDir {
		b.WriteString(directoryListingHTML(p, base, d))
	}

	b.WriteString("<script id=\"doc-title\" type=\"application/json\">")
	b.Write(jsonTitle)
	b.WriteString("</script>\n")
	b.WriteString("<script id=\"doc-source\" type=\"application/json\">")
	b.Write(jsonSource)
	b.WriteString("</script>\n")
	b.WriteString("<script id=\"doc-base\" type=\"application/json\">")
	b.Write(jsonBase)
	b.WriteString("</script>\n")
	b.WriteString("<script type=\"module\" src=\"/p/_asset/doc.js\"></script>\n")

	b.WriteString("<footer class=\"pub-footer\">published folder \u00b7 live view \u00b7 " +
		strconv.Itoa(p.tree.FileCount()) + " file" + plural(p.tree.FileCount()) +
		" \u00b7 link expires " + escapeHTMLText(p.expiresAt.UTC().Format("2006-01-02 15:04 MST")) + "</footer>\n")
	b.WriteString("</body></html>\n")
	return []byte(b.String())
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// breadcrumbHTML is the "where am I, and how do I get back" line.
//
// Every href is built from a MANIFEST key run through treeEntryURL, never from
// anything a reader sent.
func breadcrumbHTML(p *publication, base, docRel string, d *treeDir, isDir bool) string {
	var b strings.Builder
	b.WriteString("<nav class=\"pub-crumbs\">")
	b.WriteString("<a href=\"" + escapeHTMLText(base) + "\">" + escapeHTMLText(path.Base(p.path)) + "</a>")

	trail := d.rel
	if !isDir {
		trail = parentKey(docRel)
	}
	if trail != "" {
		acc := ""
		for _, seg := range strings.Split(trail, "/") {
			if acc == "" {
				acc = seg
			} else {
				acc += "/" + seg
			}
			b.WriteString("<span class=\"sep\">/</span>")
			b.WriteString("<a href=\"" + escapeHTMLText(treeEntryURL(base, acc)) + "/\">" + escapeHTMLText(seg) + "</a>")
		}
	}
	if !isDir && docRel != "" {
		b.WriteString("<span class=\"sep\">/</span>")
		b.WriteString("<span class=\"here\">" + escapeHTMLText(path.Base(docRel)) + "</span>")
	}
	b.WriteString("</nav>\n")
	return b.String()
}

// directoryListingHTML renders what is in this directory, sorted, directories
// first. Deliberately a plain list: this is somebody's folder, seen by
// somebody who has never heard of muxterm.
func directoryListingHTML(p *publication, base string, d *treeDir) string {
	var b strings.Builder
	b.WriteString("<nav class=\"pub-index\">\n")
	label := "In this folder"
	if d.indexRel != "" {
		label = "Also in this folder"
	}
	b.WriteString("<h2 class=\"pub-index-h\">" + label + "</h2>\n<ul class=\"pub-list\">\n")

	if d.rel != "" {
		parent := parentKey(d.rel)
		up := base
		if parent != "" {
			up = treeEntryURL(base, parent) + "/"
		}
		b.WriteString("<li class=\"up\"><a href=\"" + escapeHTMLText(up) + "\">\u2191 up</a></li>\n")
	}
	for _, sub := range d.subdirs {
		b.WriteString("<li class=\"dir\"><a href=\"" + escapeHTMLText(treeEntryURL(base, sub)) + "/\">" +
			escapeHTMLText(path.Base(sub)) + "/</a></li>\n")
	}
	for _, rel := range d.files {
		if rel == d.indexRel {
			// Already rendered as the page above it.
			continue
		}
		tf := p.tree.files[rel]
		if tf == nil {
			continue
		}
		cls := "file"
		if tf.kind == kindMarkdown {
			cls = "page"
		}
		b.WriteString("<li class=\"" + cls + "\"><a href=\"" + escapeHTMLText(treeEntryURL(base, rel)) + "\">" +
			escapeHTMLText(path.Base(rel)) + "</a></li>\n")
	}
	if len(d.subdirs) == 0 && len(d.files) == 0 {
		b.WriteString("<li class=\"empty\">nothing servable here</li>\n")
	}
	b.WriteString("</ul>\n</nav>\n")
	return b.String()
}
