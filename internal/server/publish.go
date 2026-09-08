package server

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Publishing one local file to an anonymous, unguessable URL.
//
// THE SEMANTICS ARE LIVE, NOT SNAPSHOT. A publication is a POINTER to a file
// on this machine, re-read from disk on every request. A recipient who reloads
// the page sees the file as it is now, not as it was when the link was sent.
// The alternative -- copying the bytes at publish time into an inert snapshot
// -- was considered and deliberately rejected: the user asked to publish "the
// file", and a stale copy that silently diverges from the thing they are still
// editing is a different, more confusing product.
//
// WHAT LIVE COSTS. A pointer can be redirected after the URL has been sent.
// Publish an innocuous file, then replace it -- or replace a directory
// component of its path -- with a symlink to something sensitive, and a URL
// already in someone's inbox starts serving that instead. Nothing about the
// link changes; nothing tells the publisher. That single property is what most
// of this file exists to defeat:
//
//   - the path is fully resolved at publish time and pinned by DEVICE AND
//     INODE, not by name;
//   - every read re-resolves, re-opens with O_NOFOLLOW, and re-confirms the
//     identity against the pin, refusing to serve anything else;
//   - no symlink is followed at read time, at any component of the path;
//   - the size bound is enforced on EVERY read, because a live file can grow
//     after it was published;
//   - a file that vanished, was renamed, or lost its permissions produces a
//     clear "no longer available" answer rather than a 500 or a stale copy.
//
// WHAT THIS IS NOT. It is not a tunnel. A tunnel forwards to a live PORT and
// stays behind the auth middleware; this serves ONE FILE to anyone holding the
// link. TunnelRegistry's shape is worth copying (opaque ids, create/list/
// revoke, in-memory) and its auth posture is not, so this is a sibling rather
// than a widening of that type.
//
// WHAT IT DOES NOT TRY TO DO. There is no secret scanning and no content
// redaction here on purpose. A half-built detector earns trust it cannot repay
// -- the honest control is that the exposure is stated plainly at the point of
// publishing, bounded by a TTL, and revocable.

const (
	// publicationIDBytes is the entropy behind one public URL, in bytes of
	// crypto/rand. 16 bytes is 128 bits, rendered as 22 base64url characters.
	//
	// It is deliberately NOT tunnelGenID(): that draws 5 characters from a
	// 36-symbol alphabet using math/rand/v2, which is ~25.8 bits from a
	// NON-CRYPTOGRAPHIC generator. That is survivable for a tunnel, which is
	// auth-protected and merely wants a short handle -- guessing the id gets
	// you a login page. Here the id IS the credential: the entire access
	// control of a published file is "you know the URL". 26 bits is roughly
	// 67 million values, sweepable by an unauthenticated attacker, and
	// math/rand/v2's stream is predictable from observed output regardless.
	publicationIDBytes = 16

	// publicationIDLen is the base64url (unpadded) length of an id.
	publicationIDLen = 22

	// publicationDefaultTTL is how long a publication lives when the caller
	// names no TTL. A day is long enough to send a link and have someone in
	// another timezone read it after a night's sleep, and short enough that
	// a link forgotten in a chat thread stops working before the week is out.
	publicationDefaultTTL = 24 * time.Hour

	// publicationMaxTTL caps an explicit TTL. A week, because a LIVE pointer
	// at a file on someone's working machine should not outlive the work it
	// belongs to; anything longer wants real hosting, where the bytes are
	// uploaded once and stop tracking a working tree.
	publicationMaxTTL = 7 * 24 * time.Hour

	// publicationMaxBytes bounds what one publication may serve, checked at
	// publish time AND on every single read -- a live file can grow after it
	// was published, so a publish-time-only check is no check at all.
	publicationMaxBytes = 8 << 20

	// publicationTombstone is how long an EXPIRED publication stays in the
	// registry before the sweeper drops it. It exists so the person who
	// reloads a link minutes after it lapsed is told "this expired" rather
	// than "this is not a valid link", which reads like a typo and sends
	// them hunting for a transcription error that is not there.
	publicationTombstone = time.Hour

	// publicationSweepInterval is how often expired tombstones are collected.
	publicationSweepInterval = 10 * time.Minute
)

// publicationKind is how a publication is served. It is derived from the
// PINNED path's extension, which cannot drift because the path is pinned by
// device and inode -- see publicationKindFor.
type publicationKind string

const (
	// kindMarkdown renders through the browser-side renderer merged in #79.
	kindMarkdown publicationKind = "markdown"
	// kindText serves inline as text/plain, which nosniff makes inert.
	kindText publicationKind = "text"
	// kindImage serves inline with a real image content type.
	kindImage publicationKind = "image"
	// kindDownload never renders in muxterm's origin: HTML, SVG, and every
	// unrecognised type land here and are sent as an attachment.
	kindDownload publicationKind = "download"
)

// pubFault is a refusal to serve, carrying the HTTP status and the sentence a
// PUBLIC reader is shown. The message is deliberately path-free: the person
// holding the link is not the person who published it and has no business
// learning where on the publisher's disk the file lives.
type pubFault struct {
	Code   string // machine-readable, surfaced in the owner-side list
	Status int    // HTTP status for the public route
	Public string // shown to the anonymous reader
	Owner  string // shown to the publisher (may name the path)
	Fatal  bool   // true when the publication can never work again
}

func (e *pubFault) Error() string {
	if e.Owner != "" {
		return e.Owner
	}
	return e.Public
}

func faultSourceMissing(detail string) *pubFault {
	return &pubFault{
		Code:   "source_missing",
		Status: http.StatusGone,
		Public: "This link is no longer available: the file it pointed to is gone.",
		Owner:  "the published file is gone: " + detail,
		Fatal:  true,
	}
}

// faultIdentity is the refusal at the centre of this feature. It fires both
// for the attack and for a mundane cause worth naming, because they are
// indistinguishable from the filesystem's side and the publisher deserves to
// know which one to suspect:
//
//	the attack -- the file, or a directory above it, was replaced with a
//	symlink to something else after the link was sent;
//
//	the everyday one -- the file was saved by an editor that writes a new file
//	and renames it over the old one (sed -i, vim's default writebackup, most
//	editors' "atomic save"). That is a NEW inode, so the pin no longer matches.
//
// Re-pinning automatically would resolve the second case and hand the first
// one the win: an already-sent URL would silently start serving whatever now
// occupies the path. So this refuses in both cases, and the remedy for the
// honest one is to publish again -- which mints a NEW id, leaving the old link
// dead rather than redirected.
func faultIdentity(detail string) *pubFault {
	return &pubFault{
		Code:   "identity_mismatch",
		Status: http.StatusConflict,
		Public: "This link is broken: the file it points to is not the file that was published, so nothing was served.",
		Owner: "identity check failed, so this publication refuses to serve: " + detail +
			". Either the file was replaced deliberately, or it was saved by an editor that writes a new file and renames it into place. Publish it again to get a new link",
		Fatal: false,
	}
}

func faultTooLarge(size int64) *pubFault {
	return &pubFault{
		Code:   "too_large",
		Status: http.StatusRequestEntityTooLarge,
		Public: "This link is not being served: the file behind it is larger than the publishing size limit.",
		Owner: fmt.Sprintf("the file has grown to %d bytes, past the %d-byte publishing limit, so it is refused on every read",
			size, publicationMaxBytes),
		Fatal: false,
	}
}

func faultUnreadable(detail string) *pubFault {
	return &pubFault{
		Code:   "source_unreadable",
		Status: http.StatusGone,
		Public: "This link is no longer available: the file it pointed to cannot be read.",
		Owner:  "the published file cannot be read: " + detail,
		Fatal:  false,
	}
}

// publication is one live pointer. Everything here is set at publish time and
// never mutated afterwards, so the registry can hand out copies without a lock
// on the value itself.
type publication struct {
	id string

	// requested is the path as the caller wrote it, kept only so the owner
	// list can show what they asked for.
	requested string
	// path is the PIN: fully symlink-resolved and absolute. Every read uses
	// this and only this. Nothing at read time can widen it, because no read
	// takes a path at all -- the public route accepts an id and nothing else.
	path string
	// dev and ino are the real pin. A name can be made to point somewhere
	// else; an inode on a device cannot be made to be a different file.
	dev uint64
	ino uint64

	kind        publicationKind
	contentType string
	filename    string

	publishedAt   time.Time
	expiresAt     time.Time
	sizeAtPublish int64
}

// publicationView is one row of the owner-facing list.
type publicationView struct {
	ID            string `json:"id"`
	URL           string `json:"url"`
	Path          string `json:"path"`
	RequestedPath string `json:"requested_path,omitempty"`
	PublishedAt   string `json:"published_at"`
	ExpiresAt     string `json:"expires_at"`
	Expired       bool   `json:"expired"`
	SecondsLeft   int64  `json:"seconds_left"`
	Kind          string `json:"kind"`
	ContentType   string `json:"content_type"`
	SizeAtPublish int64  `json:"size_at_publish"`
	Size          int64  `json:"size"`
	IdentityOK    bool   `json:"identity_ok"`
	Status        string `json:"status"`
	StatusDetail  string `json:"status_detail,omitempty"`
}

// PublicationRegistry tracks live file publications by id. Safe for concurrent
// use. Deliberately IN MEMORY, like TunnelRegistry: a restart therefore
// revokes everything, which is the fail-closed direction. Persisting these
// would mean a machine that reboots quietly resumes serving files to the
// internet on behalf of a user who is no longer at the keyboard.
type PublicationRegistry struct {
	mu    sync.RWMutex
	items map[string]*publication
	now   func() time.Time // swappable for tests; nil means time.Now
}

// NewPublicationRegistry returns an empty, ready-to-use registry.
func NewPublicationRegistry() *PublicationRegistry {
	return &PublicationRegistry{items: make(map[string]*publication)}
}

func (r *PublicationRegistry) clock() time.Time {
	if r.now != nil {
		return r.now()
	}
	return time.Now()
}

// Create pins path and registers it under a fresh cryptographically random id.
//
// ttl of 0 means publicationDefaultTTL; anything above publicationMaxTTL is an
// error rather than a silent clamp, because a caller who asked for a month and
// silently got a week would tell their recipient the wrong thing.
func (r *PublicationRegistry) Create(path string, ttl time.Duration) (*publication, error) {
	if ttl == 0 {
		ttl = publicationDefaultTTL
	}
	if ttl < 0 {
		return nil, fmt.Errorf("ttl must be positive")
	}
	if ttl > publicationMaxTTL {
		return nil, fmt.Errorf("ttl %s exceeds the maximum of %s for a public link", ttl, publicationMaxTTL)
	}

	requested := path
	resolved, err := resolvePublishPath(path)
	if err != nil {
		return nil, err
	}

	f, fi, err := openPinnedPath(resolved)
	if err != nil {
		return nil, err
	}
	defer f.Close() //nolint:errcheck

	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return nil, fmt.Errorf("cannot determine the identity (device and inode) of %s on this platform, so it cannot be published", resolved)
	}
	if fi.Size() > publicationMaxBytes {
		return nil, fmt.Errorf("%s is %d bytes, past the %d-byte publishing limit", resolved, fi.Size(), publicationMaxBytes)
	}

	kind, ctype := publicationKindFor(resolved)
	now := r.clock()
	p := &publication{
		id:            "",
		requested:     requested,
		path:          resolved,
		dev:           uint64(st.Dev), //nolint:unconvert // Dev is int32 on darwin
		ino:           uint64(st.Ino), //nolint:unconvert // Ino width varies by platform
		kind:          kind,
		contentType:   ctype,
		filename:      safeAttachmentName(filepath.Base(resolved)),
		publishedAt:   now,
		expiresAt:     now.Add(ttl),
		sizeAtPublish: fi.Size(),
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	for range 20 {
		id, gerr := publicationGenID()
		if gerr != nil {
			return nil, fmt.Errorf("publish: no cryptographic randomness available: %w", gerr)
		}
		if _, exists := r.items[id]; exists {
			continue
		}
		p.id = id
		r.items[id] = p
		return p, nil
	}
	return nil, errors.New("publish: could not generate a unique id after 20 attempts")
}

// lookupState distinguishes the three answers the public route needs to give,
// because collapsing them loses the only information the reader can act on.
type lookupState int

const (
	lookupMissing lookupState = iota // never existed, or revoked, or lost to a restart
	lookupExpired                    // existed, and its TTL has passed
	lookupLive
)

// Get returns the publication for id and its lifecycle state.
func (r *PublicationRegistry) Get(id string) (*publication, lookupState) {
	if !validPublicationID(id) {
		return nil, lookupMissing
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.items[id]
	if !ok {
		return nil, lookupMissing
	}
	if !r.clock().Before(p.expiresAt) {
		return p, lookupExpired
	}
	return p, lookupLive
}

// Revoke removes id immediately. Returns false when the id is not registered.
// Immediate is the whole point: with live content, revocation and expiry are
// the ONLY controls the publisher retains over what a recipient can still see.
func (r *PublicationRegistry) Revoke(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.items[id]; !ok {
		return false
	}
	delete(r.items, id)
	return true
}

// RevokeAll removes every publication and returns how many were removed.
func (r *PublicationRegistry) RevokeAll() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := len(r.items)
	r.items = make(map[string]*publication)
	return n
}

// List returns every registered publication, newest first, each re-checked
// against disk right now. The re-check is the point: a list that only echoed
// what was recorded at publish time could not answer "is any of it broken",
// which is half of what the owner needs to know.
func (r *PublicationRegistry) List() []*publication {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*publication, 0, len(r.items))
	for _, p := range r.items {
		out = append(out, p)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].publishedAt.After(out[j-1].publishedAt); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// sweep drops publications that expired more than publicationTombstone ago.
func (r *PublicationRegistry) sweep() int {
	cutoff := r.clock().Add(-publicationTombstone)
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for id, p := range r.items {
		if p.expiresAt.Before(cutoff) {
			delete(r.items, id)
			n++
		}
	}
	return n
}

// view builds one owner-facing row, including a fresh identity check.
func (r *PublicationRegistry) view(p *publication, url string) publicationView {
	now := r.clock()
	v := publicationView{
		ID:            p.id,
		URL:           url,
		Path:          p.path,
		PublishedAt:   p.publishedAt.UTC().Format(time.RFC3339),
		ExpiresAt:     p.expiresAt.UTC().Format(time.RFC3339),
		Expired:       !now.Before(p.expiresAt),
		Kind:          string(p.kind),
		ContentType:   p.contentType,
		SizeAtPublish: p.sizeAtPublish,
		Size:          -1,
	}
	if p.requested != p.path {
		v.RequestedPath = p.requested
	}
	if left := p.expiresAt.Sub(now); left > 0 {
		v.SecondsLeft = int64(left.Seconds())
	}

	f, fi, err := openPinned(p)
	if err != nil {
		var fault *pubFault
		if errors.As(err, &fault) {
			v.Status = fault.Code
			v.StatusDetail = fault.Owner
		} else {
			v.Status = "error"
			v.StatusDetail = err.Error()
		}
		if v.Expired {
			v.Status = "expired"
			v.StatusDetail = "this publication has expired; the link now answers 410 Gone"
		}
		return v
	}
	defer f.Close() //nolint:errcheck
	v.Size = fi.Size()
	v.IdentityOK = true
	v.Status = "ok"
	if v.Expired {
		v.Status = "expired"
		v.StatusDetail = "this publication has expired; the link now answers 410 Gone"
	}
	return v
}

// publicationGenID returns 128 bits of crypto/rand as 22 base64url characters.
func publicationGenID() (string, error) {
	b := make([]byte, publicationIDBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// validPublicationID is shape validation, applied before the registry is even
// consulted. The public route takes an id and NOTHING else -- no path, no
// filename, no suffix a caller controls -- so path traversal is not sanitised
// here, it is absent by construction: there is no path argument to traverse.
func validPublicationID(id string) bool {
	if len(id) != publicationIDLen {
		return false
	}
	for i := range len(id) {
		c := id[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_':
		default:
			return false
		}
	}
	return true
}

// resolvePublishPath turns a caller-supplied path into the absolute,
// symlink-free path that will be pinned. Called ONLY at publish time.
func resolvePublishPath(path string) (string, error) {
	p := strings.TrimSpace(path)
	if p == "" {
		return "", errors.New("path is required")
	}
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("cannot expand %q: %w", path, err)
		}
		p = filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(p, "~"), "/"))
	}
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("path %q must be absolute (or start with ~/): a relative path would be resolved against a working directory the caller cannot see", path)
	}
	p = filepath.Clean(p)

	// EvalSymlinks does the resolving. Publishing THROUGH a symlink is fine
	// and convenient -- /tmp is one on macOS -- but what gets pinned is
	// always the real path it lands on, so the link can be re-pointed later
	// without changing what this publication serves.
	resolved, err := filepath.EvalSymlinks(p)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("no such file: %s", p)
		}
		return "", fmt.Errorf("cannot resolve %s: %w", p, err)
	}
	if !filepath.IsAbs(resolved) {
		return "", fmt.Errorf("%s did not resolve to an absolute path", p)
	}
	if err := ensureNoSymlinkComponents(resolved); err != nil {
		return "", err
	}
	return resolved, nil
}

// ensureNoSymlinkComponents walks every component of an absolute path and
// refuses if any one of them is a symlink.
//
// O_NOFOLLOW only guards the FINAL component. The attack this closes is the
// other one: leave the file alone and swap a DIRECTORY above it for a symlink,
// and a name-based reopen lands somewhere else entirely with the final
// component still an innocent regular file.
func ensureNoSymlinkComponents(abs string) error {
	rest := strings.TrimPrefix(abs, string(os.PathSeparator))
	if rest == "" {
		return fmt.Errorf("%s is the filesystem root, not a file", abs)
	}
	prefix := string(os.PathSeparator)
	for _, part := range strings.Split(rest, string(os.PathSeparator)) {
		if part == "" {
			continue
		}
		prefix = filepath.Join(prefix, part)
		fi, err := os.Lstat(prefix)
		if err != nil {
			if os.IsNotExist(err) {
				return faultSourceMissing(prefix + " does not exist")
			}
			return faultUnreadable(err.Error())
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			return faultIdentity(prefix + " is a symbolic link, and no symlink is followed when serving a publication")
		}
	}
	return nil
}

// openPinnedPath opens a resolved path for reading without following a
// symlink at any component, and returns the open file with its fstat.
//
// The caller gets an OPEN FILE DESCRIPTOR, not a path, and every subsequent
// decision -- identity, regular-file, size, bytes -- is made against that
// descriptor. That is what closes the window between checking and reading:
// whatever the name points at afterwards, this fd still refers to the inode
// that was verified.
func openPinnedPath(resolved string) (*os.File, os.FileInfo, error) {
	if err := ensureNoSymlinkComponents(resolved); err != nil {
		return nil, nil, err
	}
	f, err := os.OpenFile(resolved, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		switch {
		case os.IsNotExist(err):
			return nil, nil, faultSourceMissing(resolved + " does not exist")
		case os.IsPermission(err):
			return nil, nil, faultUnreadable(err.Error())
		case errors.Is(err, syscall.ELOOP):
			return nil, nil, faultIdentity(resolved + " is now a symbolic link, and no symlink is followed when serving a publication")
		default:
			return nil, nil, faultUnreadable(err.Error())
		}
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close() //nolint:errcheck
		return nil, nil, faultUnreadable(err.Error())
	}
	if !fi.Mode().IsRegular() {
		f.Close() //nolint:errcheck
		return nil, nil, faultIdentity(resolved + " is no longer a regular file")
	}
	return f, fi, nil
}

// openPinned re-opens a publication's pinned path and proves it is still the
// same file. Called on EVERY read, never once at publish.
func openPinned(p *publication) (*os.File, os.FileInfo, error) {
	f, fi, err := openPinnedPath(p.path)
	if err != nil {
		return nil, nil, err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		f.Close() //nolint:errcheck
		return nil, nil, faultIdentity("the identity of this file can no longer be determined")
	}
	if uint64(st.Dev) != p.dev || uint64(st.Ino) != p.ino { //nolint:unconvert // widths vary by platform
		f.Close() //nolint:errcheck
		return nil, nil, faultIdentity(fmt.Sprintf(
			"the file at this path is now device %d inode %d, but this link was published for device %d inode %d",
			uint64(st.Dev), uint64(st.Ino), p.dev, p.ino)) //nolint:unconvert
	}
	// Re-checked HERE, on every read, not only at publish. A live file can
	// grow after it was published; a bound enforced once is a bound that
	// stops applying the moment the thing it bounds changes.
	if fi.Size() > publicationMaxBytes {
		size := fi.Size()
		f.Close() //nolint:errcheck
		return nil, nil, faultTooLarge(size)
	}
	return f, fi, nil
}

// readPinned returns the full current contents of a publication.
//
// The whole file is read into memory rather than streamed because the bound is
// small and the alternative races: streaming means announcing a Content-Length
// from a stat and then discovering the file changed underneath the copy.
func readPinned(p *publication) ([]byte, os.FileInfo, error) {
	f, fi, err := openPinned(p)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close() //nolint:errcheck

	// Read one byte past the limit: a file that grew between the fstat above
	// and this read is caught here rather than served.
	buf, err := io.ReadAll(io.LimitReader(f, publicationMaxBytes+1))
	if err != nil {
		return nil, nil, faultUnreadable(err.Error())
	}
	if int64(len(buf)) > publicationMaxBytes {
		return nil, nil, faultTooLarge(int64(len(buf)))
	}
	return buf, fi, nil
}

// publicationKindFor decides how a file is served, from the extension of the
// PINNED path.
//
// WHY EXTENSION, AND WHY THIS IS STABLE UNDER LIVE SEMANTICS. The path is
// pinned by device and inode, so the extension cannot drift: serving a
// different name would require failing the identity check, and that refuses
// outright. The CONTENT can still drift -- the same inode can be rewritten
// with entirely different bytes -- which is exactly why no branch below ever
// treats bytes as trusted markup:
//
//   - markdown goes through #79's renderer, which builds Lit templates and
//     interpolates every piece of model text, so embedded HTML is rendered as
//     the characters it is;
//   - text serves as text/plain under nosniff, so a file that turns into HTML
//     is displayed, not executed;
//   - HTML and SVG carry script and would run in muxterm's OWN origin, next to
//     a live terminal multiplexer, so they never render: they download.
//
// Sniffing the bytes instead was rejected for the same reason: a sniffer that
// upgrades a file to text/html the moment its content changes is a mechanism
// for turning a live publication into stored XSS.
func publicationKindFor(path string) (publicationKind, string) {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".md", ".markdown", ".mdown", ".mkd", ".mdx":
		return kindMarkdown, "text/html; charset=utf-8"
	case ".png":
		return kindImage, "image/png"
	case ".jpg", ".jpeg":
		return kindImage, "image/jpeg"
	case ".gif":
		return kindImage, "image/gif"
	case ".webp":
		return kindImage, "image/webp"
	case ".avif":
		return kindImage, "image/avif"
	case ".txt", ".text", ".log", ".csv", ".tsv", ".json", ".yaml", ".yml", ".toml", ".ini", ".conf",
		".go", ".ts", ".tsx", ".js", ".jsx", ".py", ".rb", ".rs", ".c", ".h", ".cc", ".cpp", ".hpp",
		".java", ".kt", ".swift", ".sh", ".bash", ".zsh", ".fish", ".sql", ".css", ".diff", ".patch",
		".env", ".gitignore", ".dockerfile", ".makefile", ".lua", ".php", ".pl", ".r", ".scala", ".dot":
		return kindText, "text/plain; charset=utf-8"
	case "":
		// No extension at all: served as text, which is what a README, a
		// LICENSE or a Makefile actually is, and inert under nosniff.
		return kindText, "text/plain; charset=utf-8"
	}
	// Everything else -- HTML, SVG, XML, PDF, archives, binaries, anything
	// unrecognised -- downloads. Active content never renders in this origin,
	// and an unknown type is treated as potentially active.
	if ct := mime.TypeByExtension(ext); ct != "" && strings.HasPrefix(ct, "image/") &&
		!strings.Contains(ct, "svg") {
		return kindImage, ct
	}
	return kindDownload, "application/octet-stream"
}

// safeAttachmentName reduces a filename to something that cannot inject a
// header or a directory. Anything outside the allow-list is dropped; an empty
// result means the Content-Disposition carries no filename at all, which is
// correct and unremarkable.
func safeAttachmentName(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '.', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
		if b.Len() >= 80 {
			break
		}
	}
	out := strings.Trim(b.String(), "._-")
	return out
}
