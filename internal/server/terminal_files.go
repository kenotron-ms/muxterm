package server

import (
	"net/http"
	"os"
)

// Terminal Files uses the same bounded, read-only viewer handlers as chat
// Files, with the serve process's home directory as its root.
func terminalHomeRoot(w http.ResponseWriter) (*os.Root, string, bool) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		http.Error(w, "Home folder unavailable", http.StatusNotFound)
		return nil, "", false
	}
	root, err := os.OpenRoot(home)
	if err != nil {
		http.Error(w, "Home folder unavailable", http.StatusNotFound)
		return nil, "", false
	}
	return root, home, true
}

func (s *Server) handleTerminalFiles(w http.ResponseWriter, r *http.Request) {
	root, home, ok := terminalHomeRoot(w)
	if !ok {
		return
	}
	defer root.Close()
	w.Header().Set("Cache-Control", "no-store")
	serveUtilityFiles(w, r, root, home)
}

func (s *Server) handleTerminalSearch(w http.ResponseWriter, r *http.Request) {
	root, _, ok := terminalHomeRoot(w)
	if !ok {
		return
	}
	defer root.Close()
	w.Header().Set("Cache-Control", "no-store")
	serveUtilitySearch(w, r, root)
}

func (s *Server) handleTerminalFile(w http.ResponseWriter, r *http.Request) {
	root, _, ok := terminalHomeRoot(w)
	if !ok {
		return
	}
	defer root.Close()
	serveUtilityFile(w, r, root, false)
}

func (s *Server) handleTerminalRaw(w http.ResponseWriter, r *http.Request) {
	root, _, ok := terminalHomeRoot(w)
	if !ok {
		return
	}
	defer root.Close()
	serveUtilityFile(w, r, root, true)
}
