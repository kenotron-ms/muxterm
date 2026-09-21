package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

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

// handlePatchConfig acknowledges only validated, persisted and verified changes.
// AuthMiddleware protects this route at mux registration.
func (s *Server) handlePatchConfig(w http.ResponseWriter, r *http.Request) {
	var patch map[string]json.RawMessage
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&patch); err != nil {
		http.Error(w, "changes: invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		http.Error(w, "changes: expected a single JSON object", http.StatusBadRequest)
		return
	}
	// Serialize the entire read/merge/write/readback/publish transaction, including
	// the broadcast, so two API writers cannot persist or publish out of order.
	s.cfgMu.Lock()
	defer s.cfgMu.Unlock()
	if _, err := muxcfg.ApplyPatch(s.cfg, patch); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	fail := func(err error) {
		keys := make([]string, 0, len(patch))
		for key := range patch {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		http.Error(w, fmt.Sprintf("changes [%s]: %v", strings.Join(keys, ", "), err), http.StatusInternalServerError)
	}
	if s.configPath == "" {
		fail(fmt.Errorf("persistence unavailable: no config path"))
		return
	}
	disk, malformed, err := muxcfg.LoadStrictServer(s.configPath)
	if err != nil || malformed {
		fail(fmt.Errorf("cannot read config %s (malformed=%t, error=%v); write refused", s.configPath, malformed, err))
		return
	}
	base := s.cfg
	// Preserve disk-owned state edited since serve started. Explicit lane changes
	// are applied AFTER this refresh; omitted lane changes retain the disk value.
	base.Lanes = disk.Lanes
	next, err := muxcfg.ApplyPatch(base, patch)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := muxcfg.Write(s.configPath, next); err != nil {
		fail(err)
		return
	}
	if err := muxcfg.VerifyWrittenPatch(s.configPath, patch); err != nil {
		fail(fmt.Errorf("write verification failed; disk may have changed: %w", err))
		return
	}
	s.cfg = next
	s.hub.BroadcastConfig(next)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(next) //nolint:errcheck
}

// GetCurrentConfig returns a copy of the server's current resolved config.
func (s *Server) GetCurrentConfig() muxcfg.Config {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	return s.cfg
}
