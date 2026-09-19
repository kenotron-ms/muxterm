package server

import (
	"encoding/json"
	"log"
	"net/http"

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

// handlePatchConfig accepts a partial config JSON body, merges it with the
// current config, writes it to disk (if configPath is set), updates the hub's
// stored config, and broadcasts the update to all connected WebSocket clients.
//
// AuthMiddleware protects this route at mux registration.
func (s *Server) handlePatchConfig(w http.ResponseWriter, r *http.Request) {
	var partial muxcfg.Config
	if err := json.NewDecoder(r.Body).Decode(&partial); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	newCfg := s.applyConfigUpdate(partial)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(newCfg) //nolint:errcheck
}

// applyConfigUpdate merges partial into the current config, persists to disk,
// updates the hub, and broadcasts to all clients. Returns the merged config.
// Extracted so tests and MCP tools can call it directly without HTTP overhead.
func (s *Server) applyConfigUpdate(partial muxcfg.Config) muxcfg.Config {
	s.cfgMu.Lock()
	newCfg := muxcfg.Merge(s.cfg, partial)
	// Lane policy is owned on disk and read by sessiond at launch time. A
	// preference save must not roll back an edit made since serve started.
	// Refuse to overwrite an unreadable file: substituting defaults here
	// would silently erase the owner's approval policy.
	canPersist := true
	if s.configPath != "" {
		disk, malformed, err := muxcfg.LoadStrictServer(s.configPath)
		if err != nil || malformed {
			canPersist = false
			log.Printf("config_handler: preserving unreadable config %s; preference update will not be persisted", s.configPath)
		} else {
			newCfg.Lanes = disk.Lanes
		}
	}
	s.cfg = newCfg
	s.cfgMu.Unlock()

	// Persist to disk when a config path is configured. Log errors but do not
	// fail — the optimistic in-memory update is already applied.
	if s.configPath != "" && canPersist {
		if err := muxcfg.Write(s.configPath, newCfg); err != nil {
			log.Printf("config_handler: write %s: %v", s.configPath, err)
		}
	}

	// Broadcast the update to all connected browser clients.
	s.hub.BroadcastConfig(newCfg)

	return newCfg
}

// GetCurrentConfig returns a copy of the server's current resolved config.
// Used by MCP tools that need the full config without going through HTTP.
func (s *Server) GetCurrentConfig() muxcfg.Config {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	return s.cfg
}

// ApplyConfigUpdate is the exported counterpart of applyConfigUpdate, allowing
// the MCP server to trigger config changes without a real HTTP round-trip.
func (s *Server) ApplyConfigUpdate(partial muxcfg.Config) muxcfg.Config {
	return s.applyConfigUpdate(partial)
}
