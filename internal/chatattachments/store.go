// Package chatattachments stores browser uploads outside project directories and
// resolves opaque attachment IDs into paths for the SDK chat harnesses.
package chatattachments

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
)

const MaxFileBytes int64 = 20 << 20

var idPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

var (
	ErrInvalidID    = errors.New("invalid attachment id")
	ErrNotFound     = errors.New("attachment not found")
	ErrTooLarge     = fmt.Errorf("attachment exceeds the %d MiB limit", MaxFileBytes>>20)
	ErrInvalidName  = errors.New("filename must be a single nonempty path component without control characters")
	ErrInvalidImage = errors.New("declared image content type does not match image bytes")
)

// Attachment is the persistent metadata and the browser's upload response.
// Path is deliberately absent: clients receive an opaque ID, while trusted
// server code uses ResolvePath to hand a local path to a harness.
type Attachment struct {
	ID          string `json:"id"`
	Filename    string `json:"filename"`
	ContentType string `json:"contentType"`
	Kind        string `json:"kind"`
	Size        int64  `json:"size"`
}

type Store struct{ root string }

// DefaultRoot follows muxterm's XDG data directory and never uses a project.
func DefaultRoot() (string, error) {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Abs(filepath.Join(base, "muxterm", "sdk-chat-attachments"))
}

// NewStore accepts an absolute root. The root and each attachment directory
// are private to the server user.
func NewStore(root string) (*Store, error) {
	if !filepath.IsAbs(root) {
		return nil, errors.New("attachment root must be absolute")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	return &Store{root: filepath.Clean(root)}, nil
}

func validName(name string) bool {
	if name == "" || name == "." || name == ".." || name == "metadata.json" || len(name) > 255 || strings.ContainsAny(name, `/\`) {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) || r == '\u0085' || r == '\u2028' || r == '\u2029' {
			return false
		}
	}
	return true
}

func classify(head []byte, declared string) (string, string, error) {
	detected := http.DetectContentType(head)
	if strings.HasPrefix(detected, "image/") {
		switch detected {
		case "image/png", "image/jpeg", "image/gif", "image/webp":
			return detected, "image", nil
		}
	}
	if declared != "" {
		media, _, err := mime.ParseMediaType(declared)
		if err == nil {
			if strings.HasPrefix(media, "image/") {
				return "", "", ErrInvalidImage
			}
			return media, "file", nil
		}
	}
	return detected, "file", nil
}

// Save streams one upload into a private attachment directory. A failed write
// removes the entire incomplete record. IDs are random and never reused.
func (s *Store) Save(filename, declaredType string, source io.Reader) (Attachment, error) {
	if !validName(filename) {
		return Attachment{}, ErrInvalidName
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return Attachment{}, err
	}
	id := hex.EncodeToString(random[:])
	dir := filepath.Join(s.root, id)
	if err := os.Mkdir(dir, 0700); err != nil {
		return Attachment{}, err
	}
	complete := false
	defer func() {
		if !complete {
			_ = os.RemoveAll(dir)
		}
	}()

	path := filepath.Join(dir, filename)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return Attachment{}, err
	}
	var head [512]byte
	n, readErr := io.ReadFull(source, head[:])
	if readErr != nil && readErr != io.EOF && readErr != io.ErrUnexpectedEOF {
		_ = f.Close()
		return Attachment{}, readErr
	}
	contentType, kind, err := classify(head[:n], declaredType)
	if err != nil {
		_ = f.Close()
		return Attachment{}, err
	}
	if _, err = f.Write(head[:n]); err != nil {
		_ = f.Close()
		return Attachment{}, err
	}
	remaining, err := io.Copy(f, io.LimitReader(source, MaxFileBytes-int64(n)+1))
	if err != nil {
		_ = f.Close()
		return Attachment{}, err
	}
	if err = f.Close(); err != nil {
		return Attachment{}, err
	}
	size := int64(n) + remaining
	if size > MaxFileBytes {
		return Attachment{}, ErrTooLarge
	}
	item := Attachment{ID: id, Filename: filename, ContentType: contentType, Kind: kind, Size: size}
	metadata, err := json.Marshal(item)
	if err != nil {
		return Attachment{}, err
	}
	if err = os.WriteFile(filepath.Join(dir, "metadata.json"), metadata, 0600); err != nil {
		return Attachment{}, err
	}
	complete = true
	return item, nil
}

// ResolvePath is the trusted harness seam: an attachment ID becomes an
// absolute local file path, after its metadata and file are checked.
func (s *Store) ResolvePath(id string) (string, Attachment, error) {
	if !idPattern.MatchString(id) {
		return "", Attachment{}, ErrInvalidID
	}
	dir := filepath.Join(s.root, id)
	data, err := os.ReadFile(filepath.Join(dir, "metadata.json"))
	if errors.Is(err, os.ErrNotExist) {
		return "", Attachment{}, ErrNotFound
	}
	if err != nil {
		return "", Attachment{}, err
	}
	var item Attachment
	if err := json.Unmarshal(data, &item); err != nil {
		return "", Attachment{}, err
	}
	if item.ID != id || !validName(item.Filename) {
		return "", Attachment{}, errors.New("invalid attachment metadata")
	}
	path := filepath.Join(dir, item.Filename)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", Attachment{}, ErrNotFound
	}
	if err != nil {
		return "", Attachment{}, err
	}
	if !info.Mode().IsRegular() || info.Size() != item.Size {
		return "", Attachment{}, errors.New("attachment file failed integrity check")
	}
	return path, item, nil
}

func (s *Store) remove(id string) error {
	if !idPattern.MatchString(id) {
		return ErrInvalidID
	}
	return os.RemoveAll(filepath.Join(s.root, id))
}
