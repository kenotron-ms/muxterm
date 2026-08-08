// internal/server/ai_handler.go
package server

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"github.com/kenotron-ms/muxterm/internal/ai"
)

// The /api/ai/* family is deliberately one-way: the key goes IN via PUT, and
// only a derived, non-reversible Status ever comes back OUT. No route here
// returns the key, and nothing here logs a request body.
//
// AuthMiddleware protects every route at mux registration, exactly like the
// config and tunnel routes.

func writeAIJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

func writeAIError(w http.ResponseWriter, code int, reason string) {
	writeAIJSON(w, code, map[string]any{"error": reason})
}

// handleAIStatus returns the capability status. Never the key.
// AuthMiddleware protects this route at mux registration.
func (s *Server) handleAIStatus(w http.ResponseWriter, _ *http.Request) {
	writeAIJSON(w, http.StatusOK, s.ai.Status())
}

// handleAIPutKey stores a new key and publishes the resulting status.
//
// A persistence failure returns 500 and does NOT broadcast: the user must not
// see "enabled" for a key that did not reach disk.
//
// AuthMiddleware protects this route at mux registration.
func (s *Server) handleAIPutKey(w http.ResponseWriter, r *http.Request) {
	var body struct {
		APIKey string `json:"apiKey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeAIError(w, http.StatusBadRequest, "invalid_json")
		return
	}

	status, err := s.ai.SaveKey(body.APIKey)
	switch {
	case errors.Is(err, ai.ErrInvalidKey):
		writeAIError(w, http.StatusBadRequest, "invalid_key")
		return
	case err != nil:
		// The error carries a path, never the key (see internal/ai/keystore.go).
		log.Printf("ai_handler: save key: %v", err)
		writeAIError(w, http.StatusInternalServerError, "save_failed")
		return
	}

	s.hub.BroadcastAIStatus(status)
	writeAIJSON(w, http.StatusOK, status)
}

// handleAIDeleteKey clears the stored key. Idempotent.
//
// A clear failure returns 500 and does NOT broadcast, mirroring the save
// path's disk-write-failure behavior.
//
// AuthMiddleware protects this route at mux registration.
func (s *Server) handleAIDeleteKey(w http.ResponseWriter, _ *http.Request) {
	status, err := s.ai.ClearKey()
	if err != nil {
		log.Printf("ai_handler: clear key: %v", err)
		writeAIError(w, http.StatusInternalServerError, "clear_failed")
		return
	}

	s.hub.BroadcastAIStatus(status)
	writeAIJSON(w, http.StatusOK, status)
}

// handleAIPing makes a minimal live call to Anthropic. It is the authoritative
// key-validity check and a permanent user-facing "Test connection" affordance.
//
// The response body carries a status code and request id only -- never
// provider error text, which is the one place a key could plausibly be
// echoed back.
//
// AuthMiddleware protects this route at mux registration.
func (s *Server) handleAIPing(w http.ResponseWriter, r *http.Request) {
	_, err := s.ai.Ping(r.Context())
	switch {
	case err == nil:
		writeAIJSON(w, http.StatusOK, map[string]any{"ok": true})
	case errors.Is(err, ai.ErrDisabled):
		writeAIError(w, http.StatusServiceUnavailable, "ai_disabled")
	default:
		var pe *ai.ProviderError
		if errors.As(err, &pe) {
			writeAIJSON(w, http.StatusBadGateway, map[string]any{
				"error":     "provider_error",
				"status":    pe.StatusCode,
				"requestId": pe.RequestID,
			})
			return
		}
		writeAIError(w, http.StatusBadGateway, "provider_error")
	}
}
