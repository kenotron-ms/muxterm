package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

// File Explorer uploads are intentionally a small, scoped write surface:
//
//   POST /api/files/upload  one multipart `file` part, the current directory
//
// It is NOT a general filesystem-write API. The only destination is a
// short-lived server-side binding issued while listing a writable directory
// under this server's configured Explorer root. The browser never receives the
// binding value: it is an HttpOnly cookie, and it never sends a path to select a
// destination.
//
// The conservative local-only boundary is intentional. Remote sessiond has a
// structural read-only filesystem protocol; there is no safe remote writer to
// extend here. See docs/designs/2026-09-15-file-explorer-upload-design.md.

const (
	filesBrowserCookie       = "muxterm_files_browser"
	filesUploadBindingTTL    = 10 * time.Minute
	filesUploadRequestLimit  = 128 << 20
	filesUploadFileLimit     = 64 << 20
	filesUploadMaxFiles      = 32
	filesUploadMaxConcurrent = 2
	filesUploadTimeout       = 10 * time.Minute
	filesUploadTempPrefix    = ".muxterm-upload-"
	filesUploadTempBytes     = 18
)

var (
	errUploadUnavailable = errors.New("Uploads are not available for this directory.")
	errUploadExpired     = errors.New("The upload destination expired. Refresh this folder and try again.")
	errUploadOrigin      = errors.New("Upload is available only from this muxterm page.")
	errUploadBusy        = errors.New("Too many uploads are in progress. Try again in a moment.")
	errUploadTooLarge    = errors.New("This file is larger than the upload limit.")
	errUploadInvalid     = errors.New("Choose an ordinary file with a valid filename.")
	errUploadArchive     = errors.New("Archives are not supported here. Choose ordinary files instead.")
	errUploadChanged     = errors.New("The destination changed before this file could be saved. Refresh the folder and try again.")
)

type filesUploadAvailability struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

type filesUploadResponse struct {
	Status  string `json:"status"` // staged | complete | conflict | failed | cancelled
	Name    string `json:"name"`
	Size    int64  `json:"size,omitempty"`
	Message string `json:"message,omitempty"`
}

type filesUploadBinding struct {
	root      fileIdentity
	dir       fileIdentity
	path      string
	until     time.Time
	bytes     int64
	files     int
	owner     *Client
	workspace string
}

type filesUploadConflict struct {
	target fileIdentity
	until  time.Time
}

// A browser key is a hash of an HttpOnly cookie set with the initial static
// document. It identifies an attached browser without putting a capability,
// host credential, path, or temporary upload id in JavaScript state.
type filesBrowserKey = [sha256.Size]byte

// filesUploadManager owns only opaque server-side binding state. Cookie values
// are hashed before they are used as map keys so neither in-memory diagnostics
// nor an accidental map dump becomes a bearer-token store.
type filesUploadManager struct {
	mu        sync.Mutex
	root      string
	rootID    fileIdentity
	rootErr   error
	bindings  map[[sha256.Size]byte]filesUploadBinding
	conflicts map[[sha256.Size]byte]map[string]filesUploadConflict
	active    int
}

type fileIdentity struct {
	dev uint64
	ino uint64
}

func newFilesUploadManager() *filesUploadManager {
	m := &filesUploadManager{
		bindings:  make(map[[sha256.Size]byte]filesUploadBinding),
		conflicts: make(map[[sha256.Size]byte]map[string]filesUploadConflict),
	}

	cwd, err := os.Getwd()
	if err != nil {
		m.rootErr = err
		return m
	}
	root, err := filepath.EvalSymlinks(filepath.Clean(cwd))
	if err != nil || !filepath.IsAbs(root) {
		if err == nil {
			err = errors.New("configured Explorer root is not absolute")
		}
		m.rootErr = err
		return m
	}
	f, id, err := openNoFollowDirectory(root)
	if err != nil {
		m.rootErr = err
		return m
	}
	_ = f.Close()
	m.root = root
	m.rootID = id
	m.cleanupStaleUploads()
	return m
}

// ensureFilesBrowser is called only while serving the authenticated app shell.
// Unlike a URL capability, the cookie is HttpOnly and contains no host, path,
// workspace, temp name, or other filesystem identifier.
func (s *Server) ensureFilesBrowser(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.filesBrowserKey(r); ok {
		return
	}
	raw, err := newFilesUploadBindingValue()
	if err != nil {
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     filesBrowserCookie,
		Value:    raw,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.filesUploadCookieSecure(),
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(filesUploadBindingTTL.Seconds()),
	})
	w.Header().Set("Cache-Control", "no-store")
}

func (s *Server) filesBrowserKey(r *http.Request) (filesBrowserKey, bool) {
	var zero filesBrowserKey
	cookie, err := r.Cookie(filesBrowserCookie)
	if err != nil {
		return zero, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(cookie.Value)
	if err != nil || len(raw) != 32 {
		return zero, false
	}
	return sha256.Sum256([]byte(cookie.Value)), true
}

func (s *Server) registerFilesBrowser(key filesBrowserKey, client *Client) {
	s.filesBrowserMu.Lock()
	s.filesBrowsers[key] = client
	s.filesBrowserMu.Unlock()
}

func (s *Server) unregisterFilesBrowser(key filesBrowserKey, client *Client) {
	s.filesBrowserMu.Lock()
	if s.filesBrowsers[key] == client {
		delete(s.filesBrowsers, key)
	}
	s.filesBrowserMu.Unlock()
}

func (s *Server) filesBrowser(r *http.Request) (filesBrowserKey, *Client, bool) {
	key, ok := s.filesBrowserKey(r)
	if !ok {
		return key, nil, false
	}
	s.filesBrowserMu.Lock()
	client := s.filesBrowsers[key]
	s.filesBrowserMu.Unlock()
	if client == nil {
		return key, nil, false
	}
	select {
	case <-client.ctx.Done():
		return key, nil, false
	default:
		return key, client, true
	}
}

func (s *Server) filesUploadAvailability(r *http.Request, listed string) filesUploadAvailability {
	key, client, ok := s.filesBrowser(r)
	if !ok {
		return filesUploadAvailability{Reason: "Connect this Files view before uploading."}
	}
	return s.filesUploads.availability(listed, key, client)
}

// availability binds one listed local directory to one live, authenticated
// browser WebSocket. The browser sends neither a destination path nor a
// capability on subsequent writes: both live only in this server map.
func (m *filesUploadManager) availability(listed string, key filesBrowserKey, owner *Client) filesUploadAvailability {
	if m == nil || m.rootErr != nil || runtime.GOOS == "windows" {
		return filesUploadAvailability{
			Reason: "Uploads are unavailable on this server.",
		}
	}
	if owner == nil || owner.getWorkspaceID() == "" {
		return filesUploadAvailability{Reason: "Connect this Files view to a local muxterm workspace before uploading."}
	}
	if owner.getAttachedHost() != "" {
		return filesUploadAvailability{Reason: "Uploads are unavailable for remote folders because sessiond has no scoped remote writer."}
	}
	workspace := owner.getWorkspaceID()

	resolved, err := filepath.EvalSymlinks(listed)
	if err != nil || !filepath.IsAbs(resolved) {
		return filesUploadAvailability{Reason: "Uploads are unavailable for this directory."}
	}
	resolved = filepath.Clean(resolved)
	rel, err := filepath.Rel(m.root, resolved)
	if err != nil || !safeRelativeDirectory(rel) {
		return filesUploadAvailability{
			Reason: "Uploads are available only below this muxterm server's configured Explorer root.",
		}
	}

	root, rootID, err := openNoFollowDirectory(m.root)
	if err != nil || rootID != m.rootID {
		return filesUploadAvailability{Reason: "Uploads are unavailable on this server."}
	}
	defer root.Close() //nolint:errcheck

	dir, dirID, err := openDirectoryBelow(root, rel)
	if err != nil {
		return filesUploadAvailability{Reason: "Uploads are unavailable for this directory."}
	}
	defer dir.Close() //nolint:errcheck
	if err := unix.Faccessat(int(dir.Fd()), ".", unix.W_OK, unix.AT_EACCESS); err != nil {
		return filesUploadAvailability{Reason: "This directory is read-only for the muxterm server."}
	}

	until := time.Now().Add(filesUploadBindingTTL)
	m.mu.Lock()
	m.pruneLocked(time.Now())
	m.bindings[key] = filesUploadBinding{
		root:      m.rootID,
		dir:       dirID,
		path:      resolved,
		until:     until,
		owner:     owner,
		workspace: workspace,
	}
	m.mu.Unlock()

	return filesUploadAvailability{Available: true}
}

func newFilesUploadBindingValue() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// handleFilesUpload accepts exactly one file. One request per queued browser
// file keeps cancellation, progress, and a collision decision local to that
// row; browser-side concurrency is deliberately capped as well.
func (s *Server) handleFilesUpload(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Muxterm-Files-Upload") != "1" || !s.filesUploadSameOrigin(r) {
		writeFilesUploadError(w, http.StatusForbidden, filesUploadResponse{Status: "failed", Message: errUploadOrigin.Error()})
		return
	}
	m := s.filesUploads
	if m == nil {
		writeFilesUploadError(w, http.StatusServiceUnavailable, filesUploadResponse{Status: "failed", Message: errUploadUnavailable.Error()})
		return
	}

	key, owner, ok := s.filesBrowser(r)
	if !ok {
		writeFilesUploadError(w, http.StatusForbidden, filesUploadResponse{Status: "failed", Message: errUploadExpired.Error()})
		return
	}
	dir, err := m.openBoundDirectory(key, owner)
	if err != nil {
		writeFilesUploadError(w, http.StatusForbidden, filesUploadResponse{Status: "failed", Message: safeUploadMessage(err)})
		return
	}
	defer dir.Close() //nolint:errcheck
	if !m.acquire() {
		writeFilesUploadError(w, http.StatusTooManyRequests, filesUploadResponse{Status: "failed", Message: errUploadBusy.Error()})
		return
	}
	defer m.release()

	r.Body = http.MaxBytesReader(w, r.Body, filesUploadRequestLimit)
	ctx, cancel := context.WithTimeout(r.Context(), filesUploadTimeout)
	defer cancel()
	stopOwnerWatch := make(chan struct{})
	defer close(stopOwnerWatch)
	go func() {
		select {
		case <-owner.ctx.Done():
			cancel()
			_ = r.Body.Close()
		case <-stopOwnerWatch:
		}
	}()
	reader, err := r.MultipartReader()
	if err != nil {
		writeFilesUploadError(w, http.StatusBadRequest, filesUploadResponse{Status: "failed", Message: errUploadInvalid.Error()})
		return
	}

	part, err := reader.NextPart()
	if err != nil || part.FormName() != "file" {
		writeFilesUploadError(w, http.StatusBadRequest, filesUploadResponse{Status: "failed", Message: errUploadInvalid.Error()})
		return
	}
	defer part.Close() //nolint:errcheck

	name, err := validatedUploadName(part)
	if err != nil {
		writeFilesUploadError(w, http.StatusBadRequest, filesUploadResponse{Status: "failed", Message: safeUploadMessage(err)})
		return
	}
	if archiveUploadName(name) {
		writeFilesUploadError(w, http.StatusBadRequest, filesUploadResponse{Status: "failed", Name: name, Message: errUploadArchive.Error()})
		return
	}

	tmp, file, err := createUploadTemp(dir)
	if err != nil {
		writeFilesUploadError(w, http.StatusForbidden, filesUploadResponse{Status: "failed", Name: name, Message: errUploadUnavailable.Error()})
		return
	}
	complete := false
	defer func() {
		_ = file.Close()
		if !complete {
			_ = unix.Unlinkat(int(dir.Fd()), tmp, 0)
		}
	}()

	size, head, err := streamUpload(ctx, file, part)
	if err != nil {
		status := http.StatusBadRequest
		message := safeUploadMessage(err)
		if isFilesUploadTooLarge(err) || errors.Is(err, errUploadTooLarge) {
			status = http.StatusRequestEntityTooLarge
		} else if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			status = 499 // client closed the request or the server bounded it; no file was committed
		}
		writeFilesUploadError(w, status, filesUploadResponse{Status: "cancelled", Name: name, Message: message})
		return
	}
	if more, err := readerHasAnotherPart(reader); err != nil || more {
		writeFilesUploadError(w, http.StatusBadRequest, filesUploadResponse{Status: "failed", Name: name, Message: errUploadInvalid.Error()})
		return
	}
	if archiveUploadMagic(head) {
		writeFilesUploadError(w, http.StatusBadRequest, filesUploadResponse{Status: "failed", Name: name, Message: errUploadArchive.Error()})
		return
	}
	if err := file.Sync(); err != nil {
		writeFilesUploadError(w, http.StatusInternalServerError, filesUploadResponse{Status: "failed", Name: name, Message: "This file could not be saved safely. Try again."})
		return
	}
	if err := file.Close(); err != nil {
		writeFilesUploadError(w, http.StatusInternalServerError, filesUploadResponse{Status: "failed", Name: name, Message: "This file could not be saved safely. Try again."})
		return
	}
	if !m.bindingStillMatches(key, owner, dir) {
		writeFilesUploadError(w, http.StatusConflict, filesUploadResponse{Status: "cancelled", Name: name, Message: errUploadChanged.Error()})
		return
	}

	resolution := r.Header.Get("X-Muxterm-Files-Resolution")
	if !m.reserve(key, size) {
		writeFilesUploadError(w, http.StatusRequestEntityTooLarge, filesUploadResponse{Status: "failed", Name: name, Message: errUploadTooLarge.Error()})
		return
	}
	committed := false
	defer func() {
		if !committed {
			m.releaseReservation(key, size)
		}
	}()
	status, savedName, err := m.commit(dir, key, tmp, name, resolution)
	if err != nil {
		writeFilesUploadError(w, http.StatusInternalServerError, filesUploadResponse{Status: "failed", Name: name, Message: "This file could not be saved safely. Try again."})
		return
	}
	switch status {
	case "conflict":
		writeFilesUploadJSON(w, http.StatusConflict, filesUploadResponse{
			Status:  "conflict",
			Name:    name,
			Message: "A file with this name already exists. Choose what to do with it.",
		})
		return
	case "retry":
		writeFilesUploadJSON(w, http.StatusConflict, filesUploadResponse{
			Status:  "conflict",
			Name:    name,
			Message: "That existing file changed. Review the conflict and choose again.",
		})
		return
	case "complete":
		complete = true
		committed = true
		writeFilesUploadJSON(w, http.StatusCreated, filesUploadResponse{Status: "complete", Name: savedName, Size: size})
		return
	default:
		writeFilesUploadError(w, http.StatusInternalServerError, filesUploadResponse{Status: "failed", Name: name, Message: "This file could not be saved safely. Try again."})
	}
}

func writeFilesUploadJSON(w http.ResponseWriter, code int, v filesUploadResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeFilesUploadError(w http.ResponseWriter, code int, v filesUploadResponse) {
	writeFilesUploadJSON(w, code, v)
}

func safeUploadMessage(err error) string {
	switch {
	case errors.Is(err, errUploadExpired), errors.Is(err, errUploadOrigin), errors.Is(err, errUploadBusy),
		errors.Is(err, errUploadTooLarge), errors.Is(err, errUploadInvalid), errors.Is(err, errUploadArchive),
		errors.Is(err, errUploadChanged), errors.Is(err, errUploadUnavailable):
		return err.Error()
	case errors.Is(err, context.Canceled):
		return "Upload cancelled. No file was saved."
	case errors.Is(err, context.DeadlineExceeded):
		return "Upload took too long. No file was saved."
	case isFilesUploadTooLarge(err):
		return errUploadTooLarge.Error()
	default:
		return "This file could not be uploaded. No file was saved."
	}
}

func isFilesUploadTooLarge(err error) bool {
	var tooLarge *http.MaxBytesError
	return errors.As(err, &tooLarge)
}

func (s *Server) filesUploadSameOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	parsed, err := url.Parse(origin)
	if err != nil || origin == "" || parsed.Scheme == "" || parsed.Host == "" ||
		parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	// --no-auth is the intentionally local-only development mode. It can run
	// against a real user's production config, whose public origin must not
	// make the isolated 127.0.0.1 dev server reject its own same-origin page.
	expected := ""
	if !s.noAuth {
		expected = s.publicBaseURL()
	}
	if expected == "" {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		host, port, err := net.SplitHostPort(s.addr)
		if err != nil || host == "" || port == "" {
			return false
		}
		expected = scheme + "://" + net.JoinHostPort(host, port)
	}
	site := r.Header.Get("Sec-Fetch-Site")
	return strings.EqualFold(origin, expected) && (site == "" || site == "same-origin")
}

func (s *Server) filesUploadCookieSecure() bool {
	// A Secure cookie is deliberately mandatory for every authenticated
	// deployment. The one exception is --no-auth dev-local, which never has a
	// credential to protect and is intentionally served over loopback HTTP.
	return !s.noAuth && s.secureCookies()
}

func (m *filesUploadManager) openBoundDirectory(key filesBrowserKey, owner *Client) (*os.File, error) {
	if m.rootErr != nil || m.root == "" {
		return nil, errUploadUnavailable
	}
	now := time.Now()
	m.mu.Lock()
	m.pruneLocked(now)
	binding, ok := m.bindings[key]
	m.mu.Unlock()
	if !ok || !now.Before(binding.until) || binding.owner != owner ||
		owner.getAttachedHost() != "" || owner.getWorkspaceID() != binding.workspace {
		return nil, errUploadExpired
	}

	root, rootID, err := openNoFollowDirectory(m.root)
	if err != nil {
		return nil, errUploadUnavailable
	}
	if rootID != binding.root || rootID != m.rootID {
		_ = root.Close()
		return nil, errUploadChanged
	}
	rel, err := filepath.Rel(m.root, binding.path)
	if err != nil || !safeRelativeDirectory(rel) {
		_ = root.Close()
		return nil, errUploadChanged
	}
	dir, dirID, err := openDirectoryBelow(root, rel)
	_ = root.Close()
	if err != nil {
		return nil, errUploadChanged
	}
	if dirID != binding.dir {
		_ = dir.Close()
		return nil, errUploadChanged
	}
	return dir, nil
}

// bindingStillMatches fences the moment immediately before commit. A directory
// navigation, host/workspace reattach, or expiry replaces/revokes the map
// entry; the old request then discards its temporary file rather than finishing
// after the Files surface has moved.
func (m *filesUploadManager) bindingStillMatches(key filesBrowserKey, owner *Client, dir *os.File) bool {
	var st unix.Stat_t
	if unix.Fstat(int(dir.Fd()), &st) != nil {
		return false
	}
	id := fileIdentity{dev: uint64(st.Dev), ino: uint64(st.Ino)}
	m.mu.Lock()
	binding, ok := m.bindings[key]
	m.mu.Unlock()
	return ok && time.Now().Before(binding.until) && binding.owner == owner &&
		binding.workspace == owner.getWorkspaceID() && owner.getAttachedHost() == "" &&
		binding.dir == id
}

func (m *filesUploadManager) acquire() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active >= filesUploadMaxConcurrent {
		return false
	}
	m.active++
	return true
}

func (m *filesUploadManager) release() {
	m.mu.Lock()
	m.active--
	m.mu.Unlock()
}

// cancelOwner revokes every directory capability held by a WebSocket that just
// disconnected. In-flight handlers also watch that client context and unlink
// their owned temporary file before returning.
func (m *filesUploadManager) cancelOwner(owner *Client) {
	if m == nil || owner == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for key, binding := range m.bindings {
		if binding.owner == owner {
			delete(m.bindings, key)
			delete(m.conflicts, key)
		}
	}
}

// reserve makes the aggregate drop limit server-enforced, not just a browser
// convenience. The cookie binding is replaced only after the in-surface queue
// settles and refreshes its listing, so the binding is the upload batch scope.
func (m *filesUploadManager) reserve(key [sha256.Size]byte, bytes int64) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	binding, ok := m.bindings[key]
	if !ok || binding.bytes+bytes > filesUploadRequestLimit || binding.files >= filesUploadMaxFiles {
		return false
	}
	binding.bytes += bytes
	binding.files++
	m.bindings[key] = binding
	return true
}

func (m *filesUploadManager) releaseReservation(key [sha256.Size]byte, bytes int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	binding, ok := m.bindings[key]
	if !ok {
		return
	}
	binding.bytes -= bytes
	binding.files--
	if binding.bytes < 0 || binding.files < 0 {
		// This is only reachable through a programming error; do not let it
		// create a negative allowance that silently widens the limit.
		binding.bytes = 0
		binding.files = 0
	}
	m.bindings[key] = binding
}

func (m *filesUploadManager) pruneLocked(now time.Time) {
	for key, binding := range m.bindings {
		if !now.Before(binding.until) {
			delete(m.bindings, key)
			delete(m.conflicts, key)
		}
	}
	for key, conflicts := range m.conflicts {
		for name, conflict := range conflicts {
			if !now.Before(conflict.until) {
				delete(conflicts, name)
			}
		}
		if len(conflicts) == 0 {
			delete(m.conflicts, key)
		}
	}
}

func (m *filesUploadManager) noteConflict(key [sha256.Size]byte, name string, target fileIdentity) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rows := m.conflicts[key]
	if rows == nil {
		rows = make(map[string]filesUploadConflict)
		m.conflicts[key] = rows
	}
	rows[name] = filesUploadConflict{target: target, until: time.Now().Add(filesUploadBindingTTL)}
}

func (m *filesUploadManager) conflictFor(key [sha256.Size]byte, name string) (fileIdentity, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.conflicts[key][name]
	if !ok || !time.Now().Before(row.until) {
		return fileIdentity{}, false
	}
	return row.target, true
}

func (m *filesUploadManager) clearConflict(key [sha256.Size]byte, name string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rows := m.conflicts[key]; rows != nil {
		delete(rows, name)
	}
}

// commit makes a completed temporary file visible. `linkat` creates a new
// pathname without an overwrite race. Explicit replacement uses Linux's atomic
// rename-exchange only after the prior conflict inode is rechecked; a changed
// target is exchanged back and returned as another conflict rather than being
// replaced.
func (m *filesUploadManager) commit(dir *os.File, key [sha256.Size]byte, tmp, name, resolution string) (status, savedName string, err error) {
	dirfd := int(dir.Fd())
	switch resolution {
	case "", "new":
		existing, exists, err := existingUploadTarget(dirfd, name)
		if err != nil {
			return "", "", err
		}
		if exists {
			m.noteConflict(key, name, existing)
			return "conflict", name, nil
		}
		if err := unix.Linkat(dirfd, tmp, dirfd, name, 0); err != nil {
			if errors.Is(err, syscall.EEXIST) {
				if current, exists, lookupErr := existingUploadTarget(dirfd, name); lookupErr == nil && exists {
					m.noteConflict(key, name, current)
					return "conflict", name, nil
				}
			}
			return "", "", err
		}
		if err := unix.Unlinkat(dirfd, tmp, 0); err != nil {
			return "", "", err
		}
		if err := dir.Sync(); err != nil {
			return "", "", err
		}
		return "complete", name, nil

	case "keep":
		for n := 1; n <= 10000; n++ {
			candidate := duplicateUploadName(name, n)
			if candidate == "" {
				return "", "", errUploadInvalid
			}
			err := unix.Linkat(dirfd, tmp, dirfd, candidate, 0)
			if errors.Is(err, syscall.EEXIST) {
				continue
			}
			if err != nil {
				return "", "", err
			}
			if err := unix.Unlinkat(dirfd, tmp, 0); err != nil {
				return "", "", err
			}
			if err := dir.Sync(); err != nil {
				return "", "", err
			}
			m.clearConflict(key, name)
			return "complete", candidate, nil
		}
		return "", "", errUploadChanged

	case "replace":
		expected, ok := m.conflictFor(key, name)
		if !ok {
			return "retry", name, nil
		}
		current, exists, err := existingUploadTarget(dirfd, name)
		if err != nil {
			return "", "", err
		}
		if !exists || current != expected {
			if exists {
				m.noteConflict(key, name, current)
			}
			return "retry", name, nil
		}
		if runtime.GOOS != "linux" {
			return "retry", name, nil
		}
		if err := unix.Renameat2(dirfd, tmp, dirfd, name, unix.RENAME_EXCHANGE); err != nil {
			if errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.EEXIST) {
				return "retry", name, nil
			}
			return "", "", err
		}
		swapped, exists, err := existingUploadTarget(dirfd, tmp)
		if err != nil || !exists || swapped != expected {
			// The temporary name was freshly generated with O_EXCL and is not
			// user-addressable. Exchange it back before reporting the race.
			_ = unix.Renameat2(dirfd, tmp, dirfd, name, unix.RENAME_EXCHANGE)
			if err != nil {
				return "", "", err
			}
			return "retry", name, nil
		}
		if err := unix.Unlinkat(dirfd, tmp, 0); err != nil {
			return "", "", err
		}
		if err := dir.Sync(); err != nil {
			return "", "", err
		}
		m.clearConflict(key, name)
		return "complete", name, nil

	default:
		return "", "", errUploadInvalid
	}
}

func existingUploadTarget(dirfd int, name string) (fileIdentity, bool, error) {
	var st unix.Stat_t
	err := unix.Fstatat(dirfd, name, &st, unix.AT_SYMLINK_NOFOLLOW)
	if errors.Is(err, syscall.ENOENT) {
		return fileIdentity{}, false, nil
	}
	if err != nil {
		return fileIdentity{}, false, err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG || st.Nlink > 1 {
		return fileIdentity{}, false, errUploadChanged
	}
	return fileIdentity{dev: uint64(st.Dev), ino: uint64(st.Ino)}, true, nil //nolint:unconvert
}

func createUploadTemp(dir *os.File) (string, *os.File, error) {
	for range 8 {
		buf := make([]byte, filesUploadTempBytes)
		if _, err := rand.Read(buf); err != nil {
			return "", nil, err
		}
		name := filesUploadTempPrefix + base64.RawURLEncoding.EncodeToString(buf)
		fd, err := unix.Openat(
			int(dir.Fd()),
			name,
			unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_CLOEXEC|unix.O_NOFOLLOW,
			0o600,
		)
		if errors.Is(err, syscall.EEXIST) {
			continue
		}
		if err != nil {
			return "", nil, err
		}
		return name, os.NewFile(uintptr(fd), name), nil
	}
	return "", nil, errors.New("could not create upload temporary file")
}

func streamUpload(ctx context.Context, dst *os.File, src io.Reader) (int64, []byte, error) {
	buf := make([]byte, 32<<10)
	head := make([]byte, 0, 512)
	var total int64
	for {
		select {
		case <-ctx.Done():
			return 0, nil, ctx.Err()
		default:
		}
		n, rerr := src.Read(buf)
		if n > 0 {
			if total+int64(n) > filesUploadFileLimit {
				return 0, nil, errUploadTooLarge
			}
			if len(head) < cap(head) {
				want := cap(head) - len(head)
				if want > n {
					want = n
				}
				head = append(head, buf[:want]...)
			}
			written, werr := dst.Write(buf[:n])
			total += int64(written)
			if werr != nil {
				return 0, nil, werr
			}
			if written != n {
				return 0, nil, io.ErrShortWrite
			}
		}
		if rerr == io.EOF {
			return total, head, nil
		}
		if rerr != nil {
			if errors.Is(rerr, http.ErrBodyReadAfterClose) {
				return 0, nil, context.Canceled
			}
			return 0, nil, rerr
		}
	}
}

func validatedUploadName(part *multipart.Part) (string, error) {
	disposition := part.Header.Get("Content-Disposition")
	_, params, err := mime.ParseMediaType(disposition)
	if err != nil {
		return "", errUploadInvalid
	}
	name := params["filename"]
	if name == "" {
		return "", errUploadInvalid
	}
	if !utf8.ValidString(name) || len(name) > 240 || name == "." || name == ".." ||
		strings.ContainsAny(name, `/\`) || strings.ContainsRune(name, 0) {
		return "", errUploadInvalid
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", errUploadInvalid
		}
	}
	if reservedUploadName(name) {
		return "", errUploadInvalid
	}
	return name, nil
}

func reservedUploadName(name string) bool {
	base := strings.ToUpper(strings.TrimSuffix(name, filepath.Ext(name)))
	switch base {
	case "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
		"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9":
		return true
	}
	return false
}

func archiveUploadName(name string) bool {
	lower := strings.ToLower(name)
	for _, suffix := range []string{".zip", ".tar", ".tgz", ".gz", ".bz2", ".xz", ".7z", ".rar"} {
		if strings.HasSuffix(lower, suffix) {
			return true
		}
	}
	return false
}

func archiveUploadMagic(head []byte) bool {
	return bytes.HasPrefix(head, []byte("PK\x03\x04")) ||
		bytes.HasPrefix(head, []byte("\x1f\x8b")) ||
		bytes.HasPrefix(head, []byte("Rar!\x1a\x07")) ||
		bytes.HasPrefix(head, []byte("7z\xbc\xaf\x27\x1c"))
}

func duplicateUploadName(name string, n int) string {
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	suffix := fmt.Sprintf(" (%d)", n)
	maxStem := 240 - len(ext) - len(suffix)
	if maxStem <= 0 {
		return ""
	}
	for len(stem) > maxStem {
		_, size := utf8.DecodeLastRuneInString(stem)
		stem = stem[:len(stem)-size]
	}
	return stem + suffix + ext
}

func safeRelativeDirectory(rel string) bool {
	if rel == "." {
		return true
	}
	if rel == "" || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// openNoFollowDirectory opens every component relative to /, rejecting a
// symlink at every step. It deliberately returns an open descriptor: subsequent
// operations do not re-resolve a string path that a concurrent rename could
// redirect.
func openNoFollowDirectory(abs string) (*os.File, fileIdentity, error) {
	if !filepath.IsAbs(abs) {
		return nil, fileIdentity{}, errors.New("directory must be absolute")
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, fileIdentity{}, err
	}
	clean := strings.TrimPrefix(filepath.Clean(abs), string(filepath.Separator))
	if clean != "" {
		for _, part := range strings.Split(clean, string(filepath.Separator)) {
			next, err := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
			_ = unix.Close(fd)
			if err != nil {
				return nil, fileIdentity{}, err
			}
			fd = next
		}
	}
	return directoryFile(fd)
}

func openDirectoryBelow(root *os.File, rel string) (*os.File, fileIdentity, error) {
	fd, err := unix.Dup(int(root.Fd()))
	if err != nil {
		return nil, fileIdentity{}, err
	}
	if rel != "." {
		for _, part := range strings.Split(rel, string(filepath.Separator)) {
			next, err := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
			_ = unix.Close(fd)
			if err != nil {
				return nil, fileIdentity{}, err
			}
			fd = next
		}
	}
	return directoryFile(fd)
}

func directoryFile(fd int) (*os.File, fileIdentity, error) {
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		_ = unix.Close(fd)
		return nil, fileIdentity{}, err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFDIR {
		_ = unix.Close(fd)
		return nil, fileIdentity{}, errors.New("not a directory")
	}
	return os.NewFile(uintptr(fd), "muxterm-upload-directory"), fileIdentity{
		dev: uint64(st.Dev),
		ino: uint64(st.Ino),
	}, nil //nolint:unconvert
}

// readerHasAnotherPart makes the one-file request shape structural. Reading the
// next part also detects arbitrary text fields instead of ignoring them.
func readerHasAnotherPart(reader *multipart.Reader) (bool, error) {
	part, err := reader.NextPart()
	if part != nil {
		_ = part.Close()
	}
	if errors.Is(err, io.EOF) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// cleanupStaleUploads is deliberately bounded and conservative. A temporary
// file is deleted only when its unguessable 144-bit name, regular-file type,
// unshared link count, and server-created 0600 mode all match. WalkDir does not
// follow symlinked directories, and unlinking happens relative to a freshly
// no-follow-opened parent descriptor. A cap keeps a hostile or enormous root
// from turning server start into an unbounded traversal.
func (m *filesUploadManager) cleanupStaleUploads() {
	if m.root == "" || m.rootErr != nil {
		return
	}
	const maxEntries = 10_000
	seen := 0
	_ = filepath.WalkDir(m.root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return filepath.SkipDir
		}
		seen++
		if seen > maxEntries {
			return fs.SkipAll
		}
		if entry.IsDir() || !isFilesUploadTempName(entry.Name()) {
			return nil
		}
		relDir, relErr := filepath.Rel(m.root, filepath.Dir(path))
		if relErr != nil || !safeRelativeDirectory(relDir) {
			return nil
		}
		root, _, openErr := openNoFollowDirectory(m.root)
		if openErr != nil {
			return fs.SkipAll
		}
		dir, _, openErr := openDirectoryBelow(root, relDir)
		_ = root.Close()
		if openErr != nil {
			return nil
		}
		defer dir.Close() //nolint:errcheck
		var st unix.Stat_t
		if unix.Fstatat(int(dir.Fd()), entry.Name(), &st, unix.AT_SYMLINK_NOFOLLOW) != nil ||
			st.Mode&unix.S_IFMT != unix.S_IFREG || st.Nlink != 1 || st.Mode&0o777 != 0o600 {
			return nil
		}
		_ = unix.Unlinkat(int(dir.Fd()), entry.Name(), 0)
		return nil
	})
}

func isFilesUploadTempName(name string) bool {
	if !strings.HasPrefix(name, filesUploadTempPrefix) {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(name, filesUploadTempPrefix))
	return err == nil && len(raw) == filesUploadTempBytes
}
