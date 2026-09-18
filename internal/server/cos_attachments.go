package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/kenotron-ms/muxterm/internal/atomicfile"
	muxcfg "github.com/kenotron-ms/muxterm/internal/config"
)

// Mission Control composer attachments are a deliberately narrow ingestion
// surface:
//
//	POST /api/cos/attachments   one multipart `file` part, staged privately
//	cos-turn {attachments:[id]} binds staged ids to one queued turn
//
// THE OPERATOR NEVER RECEIVES ATTACHMENT BYTES. A turn's prompt carries a
// reference block naming each file's media type, size, and absolute path; the
// agent reads it with the file-reading tools it already has. That is the whole
// point of the design: raw bytes in a prompt would be unbounded, unreviewable,
// and impossible to expire, while a path is a reference the Operator can
// choose to follow, quote a line of, or hand to a delegated lane.
//
// The store is private and local. Nothing under it is ever served back over
// HTTP -- not to the owner, not through /p/, not through a tunnel -- because a
// read-back route is a second surface with its own authorization story, and V1
// does not need one: the browser already holds the bytes it just uploaded.
//
// See docs/designs/2026-09-18-cos-composer-attachments-v1.md.

const (
	// cosAttachmentIDPrefix keeps an id recognizable in a log line, a meta
	// filename, and a prompt reference block.
	cosAttachmentIDPrefix = "att_"
	// cosAttachmentTokenBytes is 144 bits, the same unguessable width the
	// Files upload temp name uses. Possession of an id is what authorizes
	// binding it to a turn, so it must not be enumerable.
	cosAttachmentTokenBytes = 18
	cosAttachmentTokenChars = 24 // base64url of 18 bytes, unpadded
	cosAttachmentDirName    = "cos-attachments"
	cosAttachmentTempPrefix = ".muxterm-attach-"

	// cosAttachmentStagedTTL bounds an attachment that was uploaded and
	// then never sent. Short on purpose: an abandoned draft must not leave
	// a week of the user's screenshots on disk.
	cosAttachmentStagedTTL = time.Hour
	// cosAttachmentSweepInterval is how often expiry runs after startup.
	cosAttachmentSweepInterval = 15 * time.Minute
	// cosAttachmentUploadTimeout bounds one upload request.
	cosAttachmentUploadTimeout = 2 * time.Minute
	// cosAttachmentMaxConcurrent bounds simultaneous uploads server-wide.
	cosAttachmentMaxConcurrent = 2
	// cosAttachmentHeadBytes is how much of a file is sniffed for a magic
	// number. 512 is what net/http.DetectContentType reads.
	cosAttachmentHeadBytes = 512
	// cosAttachmentTextMaxBytes bounds a TEXT attachment specifically. A
	// text file is validated as UTF-8 in full, which means reading it back
	// after the stream; keeping that bounded well below the image limit is
	// what makes the validation affordable and the Operator's read useful.
	cosAttachmentTextMaxBytes = 2 << 20 // 2 MiB
	// cosAttachmentSweepMaxEntries bounds a single sweep of the store.
	cosAttachmentSweepMaxEntries = 20_000
	// cosAttachmentMaxStaged bounds attachments that are staged but not yet
	// sent. Without it, an authenticated page can stage forever: max_files
	// bounds ONE MESSAGE, not the store, and the staged hour is a long time
	// to spend filling a disk. Sent attachments are deliberately not counted
	// -- a week of ordinary use must not lock the composer.
	cosAttachmentMaxStaged = 24
)

var (
	errAttachDisabled    = errors.New("Attachments are turned off on this server.")
	errAttachUnavailable = errors.New("Attachments are not available on this server.")
	errAttachNotAttached = errors.New("Open Mission Control in this tab before attaching a file.")
	errAttachOrigin      = errors.New("Attachments can be added only from this muxterm page.")
	errAttachBusy        = errors.New("Too many attachments are uploading. Try again in a moment.")
	errAttachInvalid     = errors.New("Choose an ordinary file with a valid filename.")
	errAttachTooLarge    = errors.New("This file is larger than the attachment limit.")
	errAttachTextTooBig  = errors.New("Text attachments are limited to 2 MB.")
	errAttachUnsupported = errors.New("That file type cannot be attached. Images and text files are supported.")
	errAttachMismatch    = errors.New("That file's contents do not match its name. Attach an ordinary image or text file.")
	errAttachNotText     = errors.New("That text file is not valid UTF-8 text.")
	errAttachGone        = errors.New("An attachment expired or was removed before this message was sent. Attach it again.")
	errAttachTooMany     = errors.New("Too many attachments for one message.")
	errAttachStagedFull  = errors.New("Too many attachments are waiting to be sent. Send or remove some first.")
)

// --- policy ----------------------------------------------------------------

// cosAttachmentPolicy is the effective, already-resolved limit set. It is
// computed once at construction; nothing browser-writable feeds it.
type cosAttachmentPolicy struct {
	Enabled      bool
	MaxFiles     int
	MaxFileBytes int64
	Retention    time.Duration
}

// cosAttachmentCapability is what a browser is told. It is an ADDITIVE field
// on cos-subscribe-result: an older browser drops it and keeps today's
// behaviour, which is "no attachments".
type cosAttachmentCapability struct {
	Enabled      bool     `json:"enabled"`
	Reason       string   `json:"reason,omitempty"`
	MaxFiles     int      `json:"max_files,omitempty"`
	MaxFileBytes int64    `json:"max_file_bytes,omitempty"`
	TextMaxBytes int64    `json:"text_max_bytes,omitempty"`
	Accept       []string `json:"accept,omitempty"`
}

// --- accepted content ------------------------------------------------------

// cosAttachmentType is one accepted file family. Extension and content must
// AGREE: a name is a claim the uploader makes and a magic number is evidence,
// and accepting either alone is how a store ends up holding something the
// Operator will later read as if it were what it was called.
type cosAttachmentType struct {
	kind  string // image | text
	media string
	exts  []string
	// magic lists accepted leading-byte forms. Empty means "text": the
	// whole file is validated as UTF-8 instead.
	magic [][]byte
	// riff marks the RIFF container form (WEBP), whose tag sits at byte 8.
	riff string
}

var cosAttachmentTypes = []cosAttachmentType{
	{kind: "image", media: "image/png", exts: []string{".png"}, magic: [][]byte{[]byte("\x89PNG\r\n\x1a\n")}},
	{kind: "image", media: "image/jpeg", exts: []string{".jpg", ".jpeg"}, magic: [][]byte{[]byte("\xff\xd8\xff")}},
	{kind: "image", media: "image/gif", exts: []string{".gif"}, magic: [][]byte{[]byte("GIF87a"), []byte("GIF89a")}},
	{kind: "image", media: "image/webp", exts: []string{".webp"}, riff: "WEBP"},
	{kind: "text", media: "text/plain", exts: []string{".txt", ".text", ".log"}},
	{kind: "text", media: "text/markdown", exts: []string{".md", ".markdown"}},
	{kind: "text", media: "application/json", exts: []string{".json"}},
	{kind: "text", media: "text/csv", exts: []string{".csv"}},
	{kind: "text", media: "application/yaml", exts: []string{".yaml", ".yml"}},
	{kind: "text", media: "application/toml", exts: []string{".toml"}},
	{kind: "text", media: "text/x-diff", exts: []string{".diff", ".patch"}},
}

// cosAttachmentAccept is the browser `accept` attribute list, derived from the
// same table so the picker and the server cannot drift apart.
func cosAttachmentAccept() []string {
	seen := make(map[string]bool)
	out := make([]string, 0, len(cosAttachmentTypes)*2)
	for _, t := range cosAttachmentTypes {
		for _, ext := range t.exts {
			if !seen[ext] {
				seen[ext] = true
				out = append(out, ext)
			}
		}
	}
	sort.Strings(out)
	return out
}

// cosAttachmentSafeName rejects the characters that would survive the shared
// filename validator and still break the reference block.
//
// validatedUploadName already rejects separators, NUL and unicode.IsControl.
// It does NOT reject U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR or
// U+0085 NEL, which are not control characters -- and which JavaScript's `.`
// does not match. A file named with one of those produces a block the browser
// parser refuses whole, so a perfectly good attachment renders as a raw
// protocol block, absolute server path and all, in the middle of the
// conversation. Refuse the name instead of shipping that.
func cosAttachmentSafeName(name string) bool {
	for _, r := range name {
		switch r {
		case '\u0085', '\u2028', '\u2029':
			return false
		}
	}
	return true
}

func cosAttachmentTypeForName(name string) (cosAttachmentType, bool) {
	ext := strings.ToLower(filepath.Ext(name))
	if ext == "" {
		return cosAttachmentType{}, false
	}
	for _, t := range cosAttachmentTypes {
		for _, candidate := range t.exts {
			if candidate == ext {
				return t, true
			}
		}
	}
	return cosAttachmentType{}, false
}

// contentMatches reports whether the head bytes are consistent with the
// declared type. Text returns true here and is validated in full separately.
func (t cosAttachmentType) contentMatches(head []byte) bool {
	if t.kind == "text" {
		return true
	}
	if t.riff != "" {
		return len(head) >= 12 && bytes.HasPrefix(head, []byte("RIFF")) && string(head[8:12]) == t.riff
	}
	for _, m := range t.magic {
		if bytes.HasPrefix(head, m) {
			return true
		}
	}
	return false
}

// --- stored record ---------------------------------------------------------

// cosAttachmentMeta is the on-disk record beside each attachment directory.
// It holds no capability and no browser-supplied path: the only identifier is
// the id that names it.
type cosAttachmentMeta struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Kind      string    `json:"kind"`
	MediaType string    `json:"media_type"`
	Size      int64     `json:"size"`
	SHA256    string    `json:"sha256"`
	CreatedAt time.Time `json:"created_at"`
	// BoundAt is when this attachment was accepted onto a turn. Zero means
	// still staged, which is a much shorter life.
	BoundAt time.Time `json:"bound_at,omitzero"`
	TurnID  string    `json:"turn_id,omitempty"`
}

func (m cosAttachmentMeta) expiresAt(retention time.Duration) time.Time {
	if m.BoundAt.IsZero() {
		return m.CreatedAt.Add(cosAttachmentStagedTTL)
	}
	return m.BoundAt.Add(retention)
}

// cosAttachmentRef is one resolved attachment, ready to be named in a prompt.
type cosAttachmentRef struct {
	meta cosAttachmentMeta
	path string
}

// --- store -----------------------------------------------------------------

type cosAttachmentStore struct {
	policy cosAttachmentPolicy
	root   string
	// rootErr records why the store is inert. A store that cannot resolve
	// or create its private root reports unavailable rather than falling
	// back to some other directory.
	rootErr error

	mu     sync.Mutex
	active int

	now func() time.Time
}

// newCosAttachmentStore resolves the private root and sweeps it once. It
// returns a non-nil store even when disabled or broken, so every call site
// gets a policy answer rather than a nil check.
func newCosAttachmentStore(cfg muxcfg.CosAttachmentsConfig) *cosAttachmentStore {
	resolved := cfg.Resolved()
	enabled := resolved.Enabled
	if override, ok := muxcfg.CosAttachmentsEnvOverride(); ok {
		enabled = override
	}
	s := &cosAttachmentStore{
		policy: cosAttachmentPolicy{
			Enabled:      enabled,
			MaxFiles:     resolved.MaxFiles,
			MaxFileBytes: resolved.MaxFileBytes,
			Retention:    time.Duration(resolved.RetentionHours) * time.Hour,
		},
		now: time.Now,
	}
	if !enabled {
		return s
	}
	root, err := cosAttachmentRoot()
	if err != nil {
		s.rootErr = err
		log.Printf("cos: attachments disabled: %v", err)
		return s
	}
	// 0700: the store holds whatever a person chose to show the Operator.
	// Nothing else on the machine has a reason to read it.
	if err := os.MkdirAll(root, 0o700); err != nil {
		s.rootErr = err
		log.Printf("cos: attachments disabled: %v", err)
		return s
	}
	if err := os.Chmod(root, 0o700); err != nil {
		s.rootErr = err
		log.Printf("cos: attachments disabled: %v", err)
		return s
	}
	s.root = root
	s.sweep()
	return s
}

// cosAttachmentRoot follows the same XDG-with-HOME-fallback pattern as the
// Mission Control catalog, so a dev instance with its own XDG_DATA_HOME gets
// its own attachment store for free.
func cosAttachmentRoot() (string, error) {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home := os.Getenv("HOME")
		if home == "" {
			return "", errors.New("neither XDG_DATA_HOME nor HOME is set")
		}
		base = filepath.Join(home, ".local", "share")
	}
	if !filepath.IsAbs(base) {
		return "", fmt.Errorf("attachment root %q is not absolute", base)
	}
	return filepath.Join(base, "muxterm", cosAttachmentDirName), nil
}

func (s *cosAttachmentStore) available() bool {
	return s != nil && s.policy.Enabled && s.rootErr == nil && s.root != ""
}

// capability is what the browser is told at subscribe time.
// capability tolerates a nil receiver on purpose: a Hub built directly, rather
// than through server.New, has no store, and asking it what it supports must
// answer "nothing" instead of panicking. (Go short-circuits ||, so the nil
// check below is sufficient -- but it is load-bearing, so do not reorder it.)
func (s *cosAttachmentStore) capability() cosAttachmentCapability {
	if s == nil {
		return cosAttachmentCapability{Reason: errAttachUnavailable.Error()}
	}
	if !s.policy.Enabled {
		return cosAttachmentCapability{
			Reason: "Attachments are turned off. Set [cos.attachments] enabled = true to allow them.",
		}
	}
	if s.rootErr != nil || s.root == "" {
		return cosAttachmentCapability{Reason: errAttachUnavailable.Error()}
	}
	return cosAttachmentCapability{
		Enabled:      true,
		MaxFiles:     s.policy.MaxFiles,
		MaxFileBytes: s.policy.MaxFileBytes,
		TextMaxBytes: cosAttachmentTextMaxBytes,
		Accept:       cosAttachmentAccept(),
	}
}

// acquire/release bound simultaneous uploads. They share s.mu with
// commit/discard; every critical section here is short and does no blocking
// I/O beyond a metadata write.
func (s *cosAttachmentStore) acquire() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active >= cosAttachmentMaxConcurrent {
		return false
	}
	s.active++
	return true
}

func (s *cosAttachmentStore) release() {
	s.mu.Lock()
	if s.active > 0 {
		s.active--
	}
	s.mu.Unlock()
}

// --- identifiers -----------------------------------------------------------

func newCosAttachmentID() (string, error) {
	buf := make([]byte, cosAttachmentTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return cosAttachmentIDPrefix + base64.RawURLEncoding.EncodeToString(buf), nil
}

// validCosAttachmentID is the ONLY thing that turns a browser-supplied string
// into a path component. It rejects anything that is not exactly the shape
// this server mints, which is what keeps `..`, a separator, or a symlink name
// from ever reaching filepath.Join.
func validCosAttachmentID(id string) bool {
	if !strings.HasPrefix(id, cosAttachmentIDPrefix) {
		return false
	}
	token := strings.TrimPrefix(id, cosAttachmentIDPrefix)
	if len(token) != cosAttachmentTokenChars {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	return err == nil && len(raw) == cosAttachmentTokenBytes
}

func (s *cosAttachmentStore) metaPath(id string) string { return filepath.Join(s.root, id+".json") }
func (s *cosAttachmentStore) dirPath(id string) string  { return filepath.Join(s.root, id) }

// --- read / resolve --------------------------------------------------------

func (s *cosAttachmentStore) load(id string) (cosAttachmentMeta, error) {
	if !s.available() {
		return cosAttachmentMeta{}, errAttachUnavailable
	}
	if !validCosAttachmentID(id) {
		return cosAttachmentMeta{}, errAttachGone
	}
	data, err := os.ReadFile(s.metaPath(id))
	if err != nil {
		return cosAttachmentMeta{}, errAttachGone
	}
	var meta cosAttachmentMeta
	if err := json.Unmarshal(data, &meta); err != nil || meta.ID != id || meta.Name == "" {
		return cosAttachmentMeta{}, errAttachGone
	}
	if !s.now().Before(meta.expiresAt(s.policy.Retention)) {
		return cosAttachmentMeta{}, errAttachGone
	}
	return meta, nil
}

// resolve turns the browser's id list into references, ALL OR NOTHING.
//
// Partial acceptance is the failure this rejects by construction: a message
// that silently arrives with three of its four screenshots is worse than one
// that is refused, because the person has no way to see which one the Operator
// never got.
func (s *cosAttachmentStore) resolve(ids []string) ([]cosAttachmentRef, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	if !s.policy.Enabled {
		return nil, errAttachDisabled
	}
	if !s.available() {
		return nil, errAttachUnavailable
	}
	if len(ids) > s.policy.MaxFiles {
		return nil, errAttachTooMany
	}
	seen := make(map[string]bool, len(ids))
	refs := make([]cosAttachmentRef, 0, len(ids))
	for _, id := range ids {
		if seen[id] {
			// A duplicate id is a browser bug, not a second file. Naming
			// the same path twice in one prompt is confusing noise.
			continue
		}
		seen[id] = true
		meta, err := s.load(id)
		if err != nil {
			return nil, err
		}
		path := filepath.Join(s.dirPath(id), meta.Name)
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() != meta.Size {
			return nil, errAttachGone
		}
		refs = append(refs, cosAttachmentRef{meta: meta, path: path})
	}
	if len(refs) == 0 {
		return nil, errAttachGone
	}
	return refs, nil
}

// commit starts the retention clock BEFORE the turn is queued.
//
// Order matters. Binding after submission leaves a window in which a queued
// turn names a path whose staged hour can expire under it; binding first can
// at worst extend the life of an attachment whose turn was never admitted,
// which costs one file and no correctness.
func (s *cosAttachmentStore) commit(refs []cosAttachmentRef) error {
	// Held against handleCosAttachmentDiscard, which reads BoundAt and then
	// deletes. Without this lock a discard from a second tab can decide an
	// attachment is still staged, this function can bind it, and the discard
	// can then delete the file out from under a prompt that already names it.
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for _, ref := range refs {
		// Re-read rather than trusting the resolve-time copy: an expiry sweep
		// or a discard may have landed in between.
		meta, err := s.load(ref.meta.ID)
		if err != nil {
			return err
		}
		if info, statErr := os.Lstat(ref.path); statErr != nil || !info.Mode().IsRegular() {
			return errAttachGone
		}
		if !meta.BoundAt.IsZero() {
			continue
		}
		meta.BoundAt = now
		if err := s.writeMeta(meta); err != nil {
			return err
		}
	}
	return nil
}

// note records which turn an attachment went out on. Best effort and purely
// for operator legibility: nothing reads TurnID to make a decision.
func (s *cosAttachmentStore) note(refs []cosAttachmentRef, turnID string) {
	if turnID == "" {
		return
	}
	for _, ref := range refs {
		meta, err := s.load(ref.meta.ID)
		if err != nil || meta.TurnID != "" {
			continue
		}
		meta.TurnID = turnID
		if err := s.writeMeta(meta); err != nil {
			log.Printf("cos: attachment %s note turn: %v", meta.ID, err)
		}
	}
}

func (s *cosAttachmentStore) writeMeta(meta cosAttachmentMeta) error {
	data, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	return atomicfile.Write(s.metaPath(meta.ID), data, 0o600)
}

// --- the reference block ---------------------------------------------------

// The exact sentinel lines that delimit the attachment reference block. They
// are a stable wire contract shared with web/src/lib/cos-attachments.ts: the
// server writes this block into the delivered prompt, and every browser --
// live, queue replay, and history replay alike -- parses the SAME block back
// out to render chips. One serialization, one parser, and history therefore
// renders exactly what the Operator actually received.
const (
	cosAttachmentBlockOpen  = "[muxterm-attachments]"
	cosAttachmentBlockClose = "[/muxterm-attachments]"
)

// cosAttachmentBlock renders the reference block.
//
// A name can contain neither a newline nor a path separator (validated at
// upload), so nothing inside a line can forge the closing sentinel, which must
// stand alone on its own line.
func cosAttachmentBlock(refs []cosAttachmentRef) string {
	if len(refs) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(cosAttachmentBlockOpen)
	b.WriteString("\n")
	for _, ref := range refs {
		fmt.Fprintf(&b, "- %s (%s, %s) -> %s\n",
			ref.meta.Name, ref.meta.MediaType, cosHumanBytes(ref.meta.Size), ref.path)
	}
	b.WriteString(cosAttachmentBlockClose)
	return b.String()
}

// cosComposePrompt is the one place text and attachments become a single
// prompt string. That single string is what makes submission atomic: it enters
// the existing relay as one admission, becomes one queue entry, and reaches
// the sidecar as one turn op. There is no second message to lose.
//
// It ALWAYS neutralizes a sentinel the person typed themselves, whether or not
// they attached anything. The block is presented to the Operator as the server
// speaking -- the charter says so, and tells it to read the paths named there
// -- and the browser hides the block from the message bubble. Leaving a typed
// sentinel intact would let an ordinary message forge an attachment the server
// never staged, pointing anywhere on disk, and hide that it had done so. The
// block has exactly one author.
func cosComposePrompt(text string, refs []cosAttachmentRef) string {
	text = cosNeutralizeSentinels(text)
	block := cosAttachmentBlock(refs)
	switch {
	case block == "":
		return text
	case text == "":
		return block
	default:
		return text + "\n\n" + block
	}
}

// cosNeutralizeSentinels disarms any line of user text that is exactly a block
// sentinel, by indenting it one space. The parser requires an exact line match,
// so a leading space is enough, and the line still reads as what the person
// wrote -- which is why this is an indent rather than a deletion or a refusal.
func cosNeutralizeSentinels(text string) string {
	if !strings.Contains(text, cosAttachmentBlockOpen) && !strings.Contains(text, cosAttachmentBlockClose) {
		return text
	}
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		trimmed := strings.TrimRight(line, "\r")
		if trimmed == cosAttachmentBlockOpen || trimmed == cosAttachmentBlockClose {
			lines[i] = " " + line
		}
	}
	return strings.Join(lines, "\n")
}

func cosHumanBytes(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/float64(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.0f KB", float64(n)/float64(1<<10))
	default:
		return fmt.Sprintf("%d B", n)
	}
}

// --- upload ----------------------------------------------------------------

type cosAttachmentResponse struct {
	Status    string `json:"status"` // ready | failed
	ID        string `json:"id,omitempty"`
	Name      string `json:"name,omitempty"`
	Kind      string `json:"kind,omitempty"`
	MediaType string `json:"media_type,omitempty"`
	Size      int64  `json:"size,omitempty"`
	Message   string `json:"message,omitempty"`
}

func writeCosAttachmentJSON(w http.ResponseWriter, code int, v cosAttachmentResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func safeAttachMessage(err error) string {
	switch {
	case errors.Is(err, errAttachDisabled), errors.Is(err, errAttachUnavailable),
		errors.Is(err, errAttachNotAttached), errors.Is(err, errAttachOrigin),
		errors.Is(err, errAttachBusy), errors.Is(err, errAttachInvalid),
		errors.Is(err, errAttachTooLarge), errors.Is(err, errAttachTextTooBig),
		errors.Is(err, errAttachUnsupported), errors.Is(err, errAttachMismatch),
		errors.Is(err, errAttachNotText), errors.Is(err, errAttachGone),
		errors.Is(err, errAttachTooMany), errors.Is(err, errAttachStagedFull):
		return err.Error()
	case errors.Is(err, context.Canceled):
		return "Attachment cancelled. Nothing was saved."
	case errors.Is(err, context.DeadlineExceeded):
		return "That upload took too long. Nothing was saved."
	case isFilesUploadTooLarge(err):
		return errAttachTooLarge.Error()
	default:
		return "That file could not be attached. Nothing was saved."
	}
}

// handleCosAttachmentUpload accepts exactly one file and stages it privately.
//
// The authorization story is deliberately identical to the Files upload
// surface it sits beside: same-origin, an explicit custom header no
// cross-origin form can set, the shared authentication middleware on the
// route, and a live authenticated browser WebSocket resolved from the HttpOnly
// browser cookie. Possession of the returned id is what later authorizes
// binding it to a turn -- the id is 144 unguessable bits and never leaves this
// origin.
func (s *Server) handleCosAttachmentUpload(w http.ResponseWriter, r *http.Request) {
	store := s.hub.cosAttachments
	if store == nil || !store.policy.Enabled {
		// A disabled capability has no route worth probing.
		http.NotFound(w, r)
		return
	}
	if r.Header.Get("X-Muxterm-Cos-Attachment") != "1" || !s.filesUploadSameOrigin(r) {
		writeCosAttachmentJSON(w, http.StatusForbidden,
			cosAttachmentResponse{Status: "failed", Message: errAttachOrigin.Error()})
		return
	}
	if !store.available() {
		writeCosAttachmentJSON(w, http.StatusServiceUnavailable,
			cosAttachmentResponse{Status: "failed", Message: errAttachUnavailable.Error()})
		return
	}
	_, owner, ok := s.filesBrowser(r)
	if !ok {
		writeCosAttachmentJSON(w, http.StatusForbidden,
			cosAttachmentResponse{Status: "failed", Message: errAttachNotAttached.Error()})
		return
	}
	if !store.acquire() {
		writeCosAttachmentJSON(w, http.StatusTooManyRequests,
			cosAttachmentResponse{Status: "failed", Message: errAttachBusy.Error()})
		return
	}
	defer store.release()

	// One byte of slack over the policy limit so an exactly-at-limit file
	// still reports the friendly limit error rather than a transport one.
	r.Body = http.MaxBytesReader(w, r.Body, store.policy.MaxFileBytes+(1<<20))
	ctx, cancel := context.WithTimeout(r.Context(), cosAttachmentUploadTimeout)
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
		writeCosAttachmentJSON(w, http.StatusBadRequest,
			cosAttachmentResponse{Status: "failed", Message: errAttachInvalid.Error()})
		return
	}
	part, err := reader.NextPart()
	if err != nil || part.FormName() != "file" {
		writeCosAttachmentJSON(w, http.StatusBadRequest,
			cosAttachmentResponse{Status: "failed", Message: errAttachInvalid.Error()})
		return
	}
	defer part.Close() //nolint:errcheck

	// validatedUploadName is shared with the Files surface on purpose: a
	// filename is a filename, and two copies of that rule would drift.
	name, err := validatedUploadName(part)
	if err != nil {
		writeCosAttachmentJSON(w, http.StatusBadRequest,
			cosAttachmentResponse{Status: "failed", Message: errAttachInvalid.Error()})
		return
	}
	if !cosAttachmentSafeName(name) {
		writeCosAttachmentJSON(w, http.StatusBadRequest,
			cosAttachmentResponse{Status: "failed", Message: errAttachInvalid.Error()})
		return
	}
	if archiveUploadName(name) {
		writeCosAttachmentJSON(w, http.StatusBadRequest,
			cosAttachmentResponse{Status: "failed", Name: name, Message: errAttachUnsupported.Error()})
		return
	}
	typ, ok := cosAttachmentTypeForName(name)
	if !ok {
		writeCosAttachmentJSON(w, http.StatusUnsupportedMediaType,
			cosAttachmentResponse{Status: "failed", Name: name, Message: errAttachUnsupported.Error()})
		return
	}

	meta, err := store.stage(ctx, part, name, typ)
	if err != nil {
		status := http.StatusBadRequest
		switch {
		case errors.Is(err, errAttachTooLarge), errors.Is(err, errAttachTextTooBig), isFilesUploadTooLarge(err):
			status = http.StatusRequestEntityTooLarge
		case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
			status = 499 // client closed the request or the server bounded it
		case errors.Is(err, errAttachUnavailable):
			status = http.StatusServiceUnavailable
		case errors.Is(err, errAttachStagedFull):
			status = http.StatusTooManyRequests
		}
		writeCosAttachmentJSON(w, status,
			cosAttachmentResponse{Status: "failed", Name: name, Message: safeAttachMessage(err)})
		return
	}
	// A second part means something other than this browser's single-file
	// form posted here. The file is already staged; drop it rather than
	// returning an id for a request shape muxterm does not issue.
	if more, err := readerHasAnotherPart(reader); err != nil || more {
		store.remove(meta.ID)
		writeCosAttachmentJSON(w, http.StatusBadRequest,
			cosAttachmentResponse{Status: "failed", Name: name, Message: errAttachInvalid.Error()})
		return
	}

	writeCosAttachmentJSON(w, http.StatusCreated, cosAttachmentResponse{
		Status:    "ready",
		ID:        meta.ID,
		Name:      meta.Name,
		Kind:      meta.Kind,
		MediaType: meta.MediaType,
		Size:      meta.Size,
	})
}

// handleCosAttachmentDiscard deletes ONE staged attachment the person just
// took back off their message.
//
// It exists because the alternative is worse than it looks: without it,
// removing a chip only drops a row from the browser, and the file sits in the
// store for the whole staged hour. Someone who attaches the wrong screenshot
// and immediately removes it has every right to expect it gone, and "it
// expires within an hour" is not the same promise.
//
// It can only ever delete a STAGED attachment. One already bound to a turn is
// referenced by that turn's prompt and by the transcript, so deleting it would
// leave history pointing at nothing; that request is refused, not honored
// quietly.
func (s *Server) handleCosAttachmentDiscard(w http.ResponseWriter, r *http.Request) {
	store := s.hub.cosAttachments
	if store == nil || !store.policy.Enabled {
		http.NotFound(w, r)
		return
	}
	if r.Header.Get("X-Muxterm-Cos-Attachment") != "1" || !s.filesUploadSameOrigin(r) {
		writeCosAttachmentJSON(w, http.StatusForbidden,
			cosAttachmentResponse{Status: "failed", Message: errAttachOrigin.Error()})
		return
	}
	if _, _, ok := s.filesBrowser(r); !ok {
		writeCosAttachmentJSON(w, http.StatusForbidden,
			cosAttachmentResponse{Status: "failed", Message: errAttachNotAttached.Error()})
		return
	}
	id := r.PathValue("id")
	if !validCosAttachmentID(id) {
		writeCosAttachmentJSON(w, http.StatusBadRequest,
			cosAttachmentResponse{Status: "failed", Message: errAttachGone.Error()})
		return
	}
	// Same lock commit() takes, for the same reason: check-then-delete must
	// not straddle a binding.
	store.mu.Lock()
	defer store.mu.Unlock()
	meta, err := store.readMetaRaw(id)
	if err != nil {
		// Already gone is the outcome the caller wanted.
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !meta.BoundAt.IsZero() {
		writeCosAttachmentJSON(w, http.StatusConflict, cosAttachmentResponse{
			Status:  "failed",
			Message: "That attachment was already sent and is part of the conversation.",
		})
		return
	}
	store.remove(id)
	w.WriteHeader(http.StatusNoContent)
}

// stage streams one part into the private store and makes it immutable.
//
// The file is written to a temp path first and moved into its own directory
// only after content validation passes, so a rejected upload never occupies an
// addressable id, and a committed one is never partially written.
func (s *cosAttachmentStore) stage(
	ctx context.Context, src io.Reader, name string, typ cosAttachmentType,
) (cosAttachmentMeta, error) {
	if !s.available() {
		return cosAttachmentMeta{}, errAttachUnavailable
	}
	limit := s.policy.MaxFileBytes
	if typ.kind == "text" && limit > cosAttachmentTextMaxBytes {
		limit = cosAttachmentTextMaxBytes
	}

	if full, err := s.stagedAtCapacity(); err != nil {
		return cosAttachmentMeta{}, errAttachUnavailable
	} else if full {
		return cosAttachmentMeta{}, errAttachStagedFull
	}

	tmp, err := os.CreateTemp(s.root, cosAttachmentTempPrefix+"*")
	if err != nil {
		return cosAttachmentMeta{}, errAttachUnavailable
	}
	tmpName := tmp.Name()
	committed := false
	defer func() {
		_ = tmp.Close()
		if !committed {
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return cosAttachmentMeta{}, errAttachUnavailable
	}

	sum := sha256.New()
	head := make([]byte, 0, cosAttachmentHeadBytes)
	buf := make([]byte, 32<<10)
	var total int64
	for {
		select {
		case <-ctx.Done():
			return cosAttachmentMeta{}, ctx.Err()
		default:
		}
		n, rerr := src.Read(buf)
		if n > 0 {
			total += int64(n)
			if total > limit {
				if typ.kind == "text" && limit == cosAttachmentTextMaxBytes {
					return cosAttachmentMeta{}, errAttachTextTooBig
				}
				return cosAttachmentMeta{}, errAttachTooLarge
			}
			if len(head) < cap(head) {
				want := min(cap(head)-len(head), n)
				head = append(head, buf[:want]...)
			}
			sum.Write(buf[:n])
			if _, werr := tmp.Write(buf[:n]); werr != nil {
				return cosAttachmentMeta{}, werr
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			if errors.Is(rerr, http.ErrBodyReadAfterClose) {
				return cosAttachmentMeta{}, context.Canceled
			}
			return cosAttachmentMeta{}, rerr
		}
	}
	if total == 0 {
		return cosAttachmentMeta{}, errAttachInvalid
	}
	// An archive that renamed itself .png is the case a name check alone
	// cannot see.
	if archiveUploadMagic(head) {
		return cosAttachmentMeta{}, errAttachMismatch
	}
	if !typ.contentMatches(head) {
		return cosAttachmentMeta{}, errAttachMismatch
	}
	if err := tmp.Sync(); err != nil {
		return cosAttachmentMeta{}, err
	}
	if typ.kind == "text" {
		if err := validateUTF8File(tmpName, total); err != nil {
			return cosAttachmentMeta{}, err
		}
	}
	if err := tmp.Close(); err != nil {
		return cosAttachmentMeta{}, err
	}
	// Immutable once staged. A 0400 regular file in a 0700 directory is
	// what makes "the Operator reads a reference" a true statement: the
	// bytes the person attached are the bytes the agent sees later.
	if err := os.Chmod(tmpName, 0o400); err != nil {
		return cosAttachmentMeta{}, err
	}

	id, err := newCosAttachmentID()
	if err != nil {
		return cosAttachmentMeta{}, err
	}
	dir := s.dirPath(id)
	if err := os.Mkdir(dir, 0o700); err != nil {
		return cosAttachmentMeta{}, err
	}
	if err := os.Rename(tmpName, filepath.Join(dir, name)); err != nil {
		_ = os.RemoveAll(dir)
		return cosAttachmentMeta{}, err
	}
	committed = true

	meta := cosAttachmentMeta{
		ID:        id,
		Name:      name,
		Kind:      typ.kind,
		MediaType: typ.media,
		Size:      total,
		SHA256:    hex.EncodeToString(sum.Sum(nil)),
		CreatedAt: s.now(),
	}
	if err := s.writeMeta(meta); err != nil {
		_ = os.RemoveAll(dir)
		return cosAttachmentMeta{}, err
	}
	return meta, nil
}

// validateUTF8File proves a text attachment really is text before the Operator
// is told it can read it as such. Bounded by cosAttachmentTextMaxBytes, which
// is why this can read the whole file rather than carrying a partial rune
// across a streaming chunk boundary.
func validateUTF8File(path string, size int64) error {
	if size > cosAttachmentTextMaxBytes {
		return errAttachTextTooBig
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return errAttachNotText
	}
	return nil
}

// stagedAtCapacity answers "may one more file be staged" as cheaply as it can.
//
// The common case reads directory names only. Metadata is opened solely when
// the store already holds more records than the staged cap, which is the only
// case where the answer can be no -- so an ordinary upload against a store
// full of last week's sent attachments pays nothing.
func (s *cosAttachmentStore) stagedAtCapacity() (bool, error) {
	ids, err := s.recordIDs(cosAttachmentMaxStaged + 1)
	if err != nil {
		return false, err
	}
	if len(ids) <= cosAttachmentMaxStaged {
		return false, nil
	}
	count := 0
	for _, id := range ids {
		meta, err := s.readMetaRaw(id)
		if err != nil || !meta.BoundAt.IsZero() {
			continue
		}
		count++
		if count >= cosAttachmentMaxStaged {
			// One sweep, then re-ask: the cap must not be reached by records
			// that expired and simply have not been swept yet.
			s.sweep()
			return s.stagedAfterSweep()
		}
	}
	return false, nil
}

func (s *cosAttachmentStore) stagedAfterSweep() (bool, error) {
	ids, err := s.recordIDs(0)
	if err != nil {
		return false, err
	}
	count := 0
	for _, id := range ids {
		meta, err := s.readMetaRaw(id)
		if err != nil || !meta.BoundAt.IsZero() {
			continue
		}
		count++
	}
	return count >= cosAttachmentMaxStaged, nil
}

// recordIDs lists attachment directories, reading at most `limit` entries when
// limit is positive. It never materializes the whole directory at once.
func (s *cosAttachmentStore) recordIDs(limit int) ([]string, error) {
	dir, err := os.Open(s.root)
	if err != nil {
		return nil, err
	}
	defer dir.Close() //nolint:errcheck
	var ids []string
	for {
		entries, err := dir.ReadDir(256)
		for _, entry := range entries {
			if entry.IsDir() && validCosAttachmentID(entry.Name()) {
				ids = append(ids, entry.Name())
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return ids, nil
			}
			return nil, err
		}
		if limit > 0 && len(ids) > limit {
			return ids, nil
		}
	}
}

func (s *cosAttachmentStore) remove(id string) {
	if !s.available() || !validCosAttachmentID(id) {
		return
	}
	dir := s.dirPath(id)
	// A 0400 file in a 0700 directory is unlinkable by its owner; the
	// directory's write bit is what matters, and RemoveAll handles it.
	if err := os.RemoveAll(dir); err != nil {
		log.Printf("cos: attachment %s remove: %v", id, err)
	}
	if err := os.Remove(s.metaPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("cos: attachment %s remove meta: %v", id, err)
	}
}

// --- expiry ----------------------------------------------------------------

// sweep deletes expired attachments and anything in the root that is not a
// well-formed pair. Bounded so a hostile or enormous root cannot turn startup
// into an unbounded traversal.
func (s *cosAttachmentStore) sweep() {
	if !s.available() {
		return
	}
	// Batched rather than os.ReadDir: a store that somehow grew enormous must
	// not be materialized in one slice before the cap below is even consulted.
	dir, err := os.Open(s.root)
	if err != nil {
		log.Printf("cos: attachment sweep: %v", err)
		return
	}
	defer dir.Close() //nolint:errcheck
	now := s.now()
	seen := 0
	for {
		entries, readErr := dir.ReadDir(256)
		if len(entries) == 0 && readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				log.Printf("cos: attachment sweep: %v", readErr)
			}
			return
		}
		if s.sweepBatch(entries, now, &seen) {
			return
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				log.Printf("cos: attachment sweep: %v", readErr)
			}
			return
		}
	}
}

// sweepBatch handles one directory batch. It returns true when the sweep must
// stop, either because the entry cap was reached or the store is exhausted.
func (s *cosAttachmentStore) sweepBatch(entries []os.DirEntry, now time.Time, seen *int) bool {
	for _, entry := range entries {
		*seen++
		if *seen > cosAttachmentSweepMaxEntries {
			log.Printf("cos: attachment sweep stopped at %d entries", cosAttachmentSweepMaxEntries)
			return true
		}
		name := entry.Name()
		switch {
		case strings.HasPrefix(name, cosAttachmentTempPrefix):
			// An interrupted upload. Its temp file is never addressable.
			info, err := entry.Info()
			if err == nil && now.Sub(info.ModTime()) > cosAttachmentUploadTimeout {
				_ = os.Remove(filepath.Join(s.root, name))
			}
		case entry.IsDir():
			if !validCosAttachmentID(name) {
				continue
			}
			meta, err := s.readMetaRaw(name)
			if err != nil || !now.Before(meta.expiresAt(s.policy.Retention)) {
				s.remove(name)
			}
		case strings.HasSuffix(name, ".json"):
			id := strings.TrimSuffix(name, ".json")
			if !validCosAttachmentID(id) {
				continue
			}
			if info, err := os.Stat(s.dirPath(id)); err != nil || !info.IsDir() {
				_ = os.Remove(filepath.Join(s.root, name))
			}
		}
	}
	return false
}

// readMetaRaw reads a record WITHOUT the expiry check load() applies, so the
// sweeper can decide what to delete instead of being told it is already gone.
func (s *cosAttachmentStore) readMetaRaw(id string) (cosAttachmentMeta, error) {
	data, err := os.ReadFile(s.metaPath(id))
	if err != nil {
		return cosAttachmentMeta{}, err
	}
	var meta cosAttachmentMeta
	if err := json.Unmarshal(data, &meta); err != nil || meta.ID != id {
		return cosAttachmentMeta{}, errors.New("unreadable attachment record")
	}
	return meta, nil
}

// runSweeper keeps expiry honest for a server that stays up for weeks. It
// exits with ctx, and a disabled store never starts one.
func (s *cosAttachmentStore) runSweeper(ctx context.Context) {
	if !s.available() {
		return
	}
	ticker := time.NewTicker(cosAttachmentSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.sweep()
		}
	}
}
