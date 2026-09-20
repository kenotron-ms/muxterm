package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"reflect"

	"github.com/BurntSushi/toml"
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

// handlePatchConfig acknowledges only validated, persisted changes. The lock
// orders merge, write, readback and broadcast so concurrent saves cannot publish
// stale config or verify another request's write.
func (s *Server) handlePatchConfig(w http.ResponseWriter, r *http.Request) {
	var changes map[string]json.RawMessage
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&changes); err != nil || changes == nil {
		http.Error(w, "invalid config: expected a JSON object", http.StatusBadRequest)
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		http.Error(w, "invalid config: expected one JSON object", http.StatusBadRequest)
		return
	}
	s.cfgMu.Lock()
	defer s.cfgMu.Unlock()
	// Validate even when persistence is unavailable, to name offending keys.
	if _, err := muxcfg.Patch(s.cfg, changes); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if s.configPath == "" {
		http.Error(w, "config persistence unavailable: no config path", http.StatusInternalServerError)
		return
	}
	base := s.cfg
	disk, err := readConfigForWrite(s.configPath, true)
	if err != nil {
		http.Error(w, "cannot read config before write: "+err.Error(), http.StatusInternalServerError)
		return
	}
	// Preserve owner edits when the request omits lanes, but let an explicit
	// lanes patch override the current disk policy.
	base.Lanes = disk.Lanes
	next, err := muxcfg.Patch(base, changes)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := muxcfg.VerifyPatch(next, changes); err != nil {
		http.Error(w, "config merge failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if err := muxcfg.Write(s.configPath, next); err != nil {
		http.Error(w, "config persistence failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	persisted, err := readConfigForWrite(s.configPath, false)
	if err == nil {
		err = muxcfg.VerifyPatch(persisted, changes)
	}
	if err == nil && !reflect.DeepEqual(next, persisted) {
		err = fmt.Errorf("persisted config differs from merged config")
	}
	if err != nil {
		http.Error(w, "config write verification failed (disk may have changed): "+err.Error(), http.StatusInternalServerError)
		return
	}
	s.cfg = persisted
	s.hub.BroadcastConfig(persisted)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(persisted) //nolint:errcheck
}

// Unlike startup's forgiving loader, a write must not mistake a missing or
// malformed readback for defaults and acknowledge it as persisted.
func readConfigForWrite(path string, allowMissing bool) (muxcfg.Config, error) {
	cfg := muxcfg.Defaults()
	data, err := os.ReadFile(path)
	if allowMissing && os.IsNotExist(err) {
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}
	_, err = toml.Decode(string(data), &cfg)
	return cfg, err
}

// GetCurrentConfig returns the configuration served by get_config.
func (s *Server) GetCurrentConfig() muxcfg.Config {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	return s.cfg
}
