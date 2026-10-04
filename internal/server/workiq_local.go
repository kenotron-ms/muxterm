package server

import (
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
)

// The marker enables Microsoft's installed Work IQ CLI in new SDK chats.
// Work IQ owns its sign-in and credentials; muxterm stores no Microsoft token.
func workIQLocalMarker() string {
	return filepath.Join(sdkDataDir(), "connections", "workiq-local-enabled")
}

func (s *Server) handleWorkIQLocal(w http.ResponseWriter, r *http.Request) {
	marker := workIQLocalMarker()
	_, installedErr := exec.LookPath("workiq")
	_, enabledErr := os.Stat(marker)
	if enabledErr != nil && !errors.Is(enabledErr, os.ErrNotExist) {
		http.Error(w, "Microsoft connection settings could not be read", http.StatusInternalServerError)
		return
	}
	switch r.Method {
	case http.MethodPost:
		if installedErr != nil {
			http.Error(w, "Install the official Work IQ CLI in muxterm's PATH first", http.StatusConflict)
			return
		}
		if err := os.MkdirAll(filepath.Dir(marker), 0700); err != nil {
			http.Error(w, "Microsoft connection settings could not be saved", http.StatusInternalServerError)
			return
		}
		if err := os.WriteFile(marker, []byte("enabled\n"), 0600); err != nil {
			http.Error(w, "Microsoft connection settings could not be saved", http.StatusInternalServerError)
			return
		}
	case http.MethodDelete:
		if err := os.Remove(marker); err != nil && !errors.Is(err, os.ErrNotExist) {
			http.Error(w, "Microsoft connection settings could not be removed", http.StatusInternalServerError)
			return
		}
	}
	writeSDKJSON(w, http.StatusOK, map[string]any{
		"installed": installedErr == nil,
		"enabled":   r.Method != http.MethodDelete && (r.Method == http.MethodPost || enabledErr == nil),
	})
}
