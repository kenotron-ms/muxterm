package server

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
)

// Each chat backdrop has a matching, generated raster launcher icon. The
// server-persisted theme is authoritative for every browser and install.
var pwaBackdrops = []string{
	"none", "contours", "ridgeline", "botanical", "arcade", "orbits",
	"rainfall", "confetti", "dunes", "fan", "citylights", "petals",
	"geometry", "night-grid", "wayfarer", "skybound", "moon-keep",
}

func validPwaBackdrop(backdrop string) bool {
	for _, name := range pwaBackdrops {
		if backdrop == name {
			return true
		}
	}
	return false
}

func resolvedPwaBackdrop(backdrop string) string {
	if validPwaBackdrop(backdrop) {
		return backdrop
	}
	return "contours"
}

func (s *Server) selectedPwaBackdrop() string {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	return resolvedPwaBackdrop(s.cfg.Theme.Backdrop)
}

func pwaIconAssetPath(backdrop, filename string) string {
	return fmt.Sprintf("pwa/backdrops/%s/%s", backdrop, filename)
}

// The link's v= parameter prompts browser manifest reinspection. Historical
// versioned icon URLs remain available after a backdrop change.
func (s *Server) handlePWAManifest(w http.ResponseWriter, _ *http.Request) {
	version := s.selectedPwaBackdrop()
	icons := []map[string]string{
		{"src": "pwa/icon-192.png?v=" + version, "sizes": "192x192", "type": "image/png", "purpose": "any"},
		{"src": "pwa/icon-512.png?v=" + version, "sizes": "512x512", "type": "image/png", "purpose": "any"},
		{"src": "pwa/icon-maskable-512.png?v=" + version, "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
	}
	manifest := map[string]any{
		"name": "muxterm", "short_name": "muxterm",
		"description": "A terminal multiplexer in your browser.",
		"id":          "/", "start_url": "/", "scope": "/",
		"display": "standalone", "display_override": []string{"window-controls-overlay"},
		"orientation": "any", "background_color": "#1a1b26", "theme_color": "#1a1b26",
		"icons": icons,
	}
	w.Header().Set("Content-Type", "application/manifest+json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_ = json.NewEncoder(w).Encode(manifest)
}

func (s *Server) handlePWAIcon(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/")
	switch name {
	case "favicon-32.png", "apple-touch-icon.png":
	case "pwa/icon-192.png":
		name = "icon-192.png"
	case "pwa/icon-512.png":
		name = "icon-512.png"
	case "pwa/icon-maskable-512.png":
		name = "icon-maskable-512.png"
	default:
		http.NotFound(w, r)
		return
	}
	backdrop := s.selectedPwaBackdrop()
	if version := r.URL.Query().Get("v"); version != "" {
		if !validPwaBackdrop(version) {
			http.NotFound(w, r)
			return
		}
		backdrop = version
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-store")
	}
	if s.pwaStaticFS == nil {
		http.Error(w, "app icon assets unavailable", http.StatusServiceUnavailable)
		return
	}
	data, err := fs.ReadFile(s.pwaStaticFS, pwaIconAssetPath(backdrop, name))
	if err != nil {
		http.Error(w, "app icon assets unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(data)
}
