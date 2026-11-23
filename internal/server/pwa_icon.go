package server

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"strconv"
	"strings"

	muxcfg "github.com/kenotron-ms/muxterm/internal/config"
)

var pwaCharms = []string{"hourglass", "key", "lantern", "rocket"}
var pwaColors = []string{"coral", "indigo", "ochre", "plum", "teal"}

// A deterministic default differentiates unconfigured servers without writing
// the config file at startup. Once chosen, the explicit pair is persisted.
func resolvedAppIcon(choice muxcfg.AppIconConfig, configPath, redirectURI string) muxcfg.AppIconConfig {
	if validAppIcon(choice) {
		return choice
	}
	digest := sha256.Sum256([]byte(configPath + "\x00" + redirectURI))
	return muxcfg.AppIconConfig{
		Charm: pwaCharms[int(digest[0])%len(pwaCharms)],
		Color: pwaColors[int(digest[1])%len(pwaColors)],
	}
}

func validAppIcon(choice muxcfg.AppIconConfig) bool {
	charm, color := false, false
	for _, name := range pwaCharms {
		charm = charm || choice.Charm == name
	}
	for _, name := range pwaColors {
		color = color || choice.Color == name
	}
	return charm && color
}

func appIconVersion(choice muxcfg.AppIconConfig) string {
	return choice.Charm + "-" + choice.Color
}

func parseAppIconVersion(version string) (muxcfg.AppIconConfig, bool) {
	for _, charm := range pwaCharms {
		prefix := charm + "-"
		if strings.HasPrefix(version, prefix) {
			choice := muxcfg.AppIconConfig{Charm: charm, Color: strings.TrimPrefix(version, prefix)}
			return choice, validAppIcon(choice)
		}
	}
	return muxcfg.AppIconConfig{}, false
}

func (s *Server) selectedAppIcon() muxcfg.AppIconConfig {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	return s.cfg.AppIcon
}

func appIconAssetPath(choice muxcfg.AppIconConfig, filename string) string {
	return fmt.Sprintf("pwa/variants/%s/%s/%s", choice.Charm, choice.Color, filename)
}

func (s *Server) appIconAssetsAvailable(choice muxcfg.AppIconConfig) error {
	if s.pwaStaticFS == nil || !validAppIcon(choice) {
		return fmt.Errorf("app icon assets unavailable")
	}
	for _, name := range []string{"icon.svg", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"} {
		if _, err := fs.Stat(s.pwaStaticFS, appIconAssetPath(choice, name)); err != nil {
			return fmt.Errorf("app icon asset %s unavailable: %w", name, err)
		}
	}
	return nil
}

func (s *Server) handlePWAManifest(w http.ResponseWriter, _ *http.Request) {
	choice := s.selectedAppIcon()
	version := appIconVersion(choice)
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
	case "favicon.svg":
		name = "icon.svg"
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
	choice := s.selectedAppIcon()
	if version := r.URL.Query().Get("v"); version != "" {
		var ok bool
		choice, ok = parseAppIconVersion(version)
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-store")
	}
	if s.pwaStaticFS == nil {
		http.Error(w, "app icon assets unavailable", http.StatusServiceUnavailable)
		return
	}
	data, err := fs.ReadFile(s.pwaStaticFS, appIconAssetPath(choice, name))
	if err != nil {
		http.Error(w, "app icon assets unavailable", http.StatusServiceUnavailable)
		return
	}
	if strings.HasSuffix(name, ".svg") {
		w.Header().Set("Content-Type", "image/svg+xml")
	} else {
		w.Header().Set("Content-Type", "image/png")
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(data)
}
