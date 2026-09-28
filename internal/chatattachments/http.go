package chatattachments

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
)

const maxRequestBytes = MaxFileBytes + (1 << 20)

type apiError struct {
	Error  string `json:"error"`
	Reason string `json:"reason"`
}

func fail(w http.ResponseWriter, status int, code, reason string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(apiError{Error: code, Reason: reason})
}

// RegisterRoutes mounts the browser API. protect must be muxterm's existing
// authentication middleware; a nil protect function is rejected. Both routes
// are owner-only, and uploads also require a same-origin request header.
func RegisterRoutes(mux *http.ServeMux, store *Store, protect func(http.Handler) http.Handler) error {
	if mux == nil || store == nil || protect == nil {
		return errors.New("attachment routes require a mux, store and auth wrapper")
	}
	mux.Handle("POST /api/sdk-chat-attachments", protect(http.HandlerFunc(store.handleUpload)))
	mux.Handle("GET /api/sdk-chat-attachments/{id}", protect(http.HandlerFunc(store.handleGet)))
	return nil
}

func (s *Store) handleUpload(w http.ResponseWriter, r *http.Request) {
	// Browsers cannot set this header in a cross-origin form post. Together
	// with the owner's auth middleware, this prevents ambient-cookie CSRF.
	if r.Header.Get("X-Muxterm-Chat-Attachment") != "1" {
		fail(w, http.StatusForbidden, "upload_header_required", "X-Muxterm-Chat-Attachment: 1 is required")
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" {
		fail(w, http.StatusUnsupportedMediaType, "multipart_required", "send one multipart file field")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
	reader, err := r.MultipartReader()
	if err != nil {
		fail(w, 400, "invalid_multipart", err.Error())
		return
	}
	part, err := reader.NextPart()
	if err != nil {
		fail(w, 400, "file_required", "send one multipart file field named file")
		return
	}
	if part.FormName() != "file" || part.FileName() == "" {
		fail(w, 400, "file_required", "send one multipart file field named file")
		return
	}
	item, err := s.Save(part.FileName(), part.Header.Get("Content-Type"), part)
	_ = part.Close()
	if err != nil {
		var maxErr *http.MaxBytesError
		switch {
		case errors.Is(err, ErrTooLarge), errors.As(err, &maxErr):
			fail(w, http.StatusRequestEntityTooLarge, "attachment_too_large", ErrTooLarge.Error())
		case errors.Is(err, ErrInvalidName):
			fail(w, 400, "invalid_filename", err.Error())
		case errors.Is(err, ErrInvalidImage):
			fail(w, 415, "invalid_image", err.Error())
		default:
			fail(w, 500, "store_failed", "attachment storage failed")
		}
		return
	}
	// Drain no additional field data: a multipart body with extra parts is
	// rejected and the completed upload removed below.
	next, err := reader.NextPart()
	if next != nil || err != io.EOF {
		_ = s.remove(item.ID)
		if next != nil {
			_ = next.Close()
		}
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			fail(w, 413, "attachment_too_large", ErrTooLarge.Error())
		} else {
			fail(w, 400, "one_file_required", "send exactly one file field")
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(item)
}

func (s *Store) handleGet(w http.ResponseWriter, r *http.Request) {
	path, item, err := s.ResolvePath(r.PathValue("id"))
	if err != nil {
		if errors.Is(err, ErrInvalidID) || errors.Is(err, ErrNotFound) {
			fail(w, 404, "attachment_not_found", "attachment not found")
		} else {
			fail(w, 500, "read_failed", "attachment could not be read")
		}
		return
	}
	w.Header().Set("Content-Type", item.ContentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", strings.ReplaceAll(item.Filename, "\"", "")))
	w.Header().Set("Content-Length", fmt.Sprint(item.Size))
	http.ServeFile(w, r, path)
}
