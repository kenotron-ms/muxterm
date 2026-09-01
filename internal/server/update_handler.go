// internal/server/update_handler.go
package server

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/kenotron-ms/muxterm/internal/update"
)

// The /api/update/* family lets the owner upgrade muxterm from the browser.
// Both routes are protected by AuthMiddleware at mux registration, exactly
// like the config and AI routes: applying an update rewrites the binary this
// process is running from, so it is an owner-only operation.

func writeUpdateJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

func writeUpdateError(w http.ResponseWriter, code int, reason string) {
	writeUpdateJSON(w, code, map[string]any{"error": reason})
}

// handleUpdateStatus reports whether an update exists and whether this build
// can install it. update.Check never fails: a release-check error surfaces in
// the payload's error field rather than as a 500.
//
// AuthMiddleware protects this route at mux registration.
func (s *Server) handleUpdateStatus(w http.ResponseWriter, r *http.Request) {
	st, _ := update.Check(r.Context(), s.version)
	writeUpdateJSON(w, http.StatusOK, st)
}

// handleUpdateApply downloads, verifies, and installs the latest release, then
// restarts the process so the new binary takes effect.
//
// The 200 is written and flushed BEFORE the restart is scheduled: once the
// process is replaced the connection dies, so the client would otherwise never
// learn whether the update succeeded.
//
// AuthMiddleware protects this route at mux registration.
func (s *Server) handleUpdateApply(w http.ResponseWriter, r *http.Request) {
	// Claim the update slot first so two concurrent clients cannot both reach
	// the binary rewrite.
	if !s.updating.CompareAndSwap(false, true) {
		writeUpdateError(w, http.StatusConflict, "an update is already in progress")
		return
	}
	// Released on every failure path. On success the flag deliberately stays
	// set: the process is about to be replaced and must not start a second
	// update in the window before that happens.
	applied := false
	defer func() {
		if !applied {
			s.updating.Store(false)
		}
	}()

	// Check hands back the release it resolved, so the install below reuses
	// that exact release instead of fetching it again.
	st, rel := update.Check(r.Context(), s.version)
	if !st.CanUpdate {
		reason := st.Reason
		if reason == "" {
			reason = st.Error
		}
		if reason == "" {
			reason = "already up to date"
		}
		writeUpdateError(w, http.StatusConflict, reason)
		return
	}
	if rel == nil {
		// Unreachable while Check keeps its contract (CanUpdate implies a
		// resolved release). Guarded anyway: a nil deref here would take the
		// whole server down rather than fail one request.
		log.Printf("update_handler: CanUpdate with no resolved release")
		writeUpdateError(w, http.StatusInternalServerError, "could not resolve the latest release")
		return
	}

	if err := update.Apply(r.Context(), rel); err != nil {
		// The wrapped message (asset name, checksum digests, paths) is safe to
		// return here: this surface is owner-only and auth-protected, and the
		// detail is what makes a failed update diagnosable.
		log.Printf("update_handler: apply %s: %v", rel.Tag, err)
		writeUpdateError(w, http.StatusInternalServerError, err.Error())
		return
	}

	applied = true
	writeUpdateJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"version": strings.TrimPrefix(rel.Tag, "v"),
	})
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}

	// Restart out of band, after a short grace period, so the response above
	// actually reaches the browser before this process goes away.
	go func() {
		time.Sleep(500 * time.Millisecond)
		if err := update.Restart(); err != nil {
			log.Printf("update_handler: restart after update: %v", err)
		}
	}()
}
