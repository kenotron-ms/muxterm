package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"

	muxcfg "github.com/kenotron-ms/muxterm/internal/config"
)

// handleGetConfig returns the current resolved configuration as JSON.
// AuthMiddleware protects this route at mux registration.
func (s *Server) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	s.cfgMu.RLock()
	cfg := s.cfg
	s.cfgMu.RUnlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(cfg) //nolint:errcheck
}

// handlePatchConfig acknowledges only a validated, persisted, read-back-verified
// update. AuthMiddleware protects this route at mux registration.
func (s *Server) handlePatchConfig(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "changes: cannot read request: "+err.Error(), http.StatusBadRequest)
		return
	}
	patch, err := muxcfg.ParsePatch(data)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Serialize the entire read/merge/write/verify/publish operation, including
	// broadcasts, so concurrent updates cannot overwrite or publish out of order.
	s.cfgMu.Lock()
	defer s.cfgMu.Unlock()
	if _, err := patch.Apply(s.cfg); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if s.configPath == "" {
		http.Error(w, fmt.Sprintf("%s: persistence unavailable; no config path configured", patch), http.StatusInternalServerError)
		return
	}
	// Read the latest disk config to preserve owner edits, including lane policy
	// when it is omitted. Explicit lane changes are applied AFTER this read.
	base, malformed, err := muxcfg.LoadStrictServer(s.configPath)
	if err != nil || malformed {
		http.Error(w, fmt.Sprintf("%s: cannot update unreadable config file", patch), http.StatusInternalServerError)
		return
	}
	newCfg, err := patch.Apply(base)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := muxcfg.Write(s.configPath, newCfg); err != nil {
		http.Error(w, fmt.Sprintf("%s: persistence failed: %v", patch, err), http.StatusInternalServerError)
		return
	}
	// LoadStrictServer treats a missing file as defaults. Check existence too:
	// disappearance must not pass verification merely by matching a default.
	if _, err := os.Stat(s.configPath); err != nil {
		http.Error(w, fmt.Sprintf("%s: write verification failed: %v", patch, err), http.StatusInternalServerError)
		return
	}
	persisted, malformed, err := muxcfg.LoadStrictServer(s.configPath)
	if err != nil || malformed {
		http.Error(w, fmt.Sprintf("%s: write verification failed: unreadable config file", patch), http.StatusInternalServerError)
		return
	}
	if err := patch.Verify(persisted); err != nil {
		http.Error(w, "write verification failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	s.cfg = persisted
	s.hub.BroadcastConfig(persisted)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(persisted) //nolint:errcheck
}
