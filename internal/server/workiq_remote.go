package server

import (
	"net/http"
	"time"
)

// Legacy Work IQ records remain readable and removable so existing local
// authorization is never silently discarded. New Work IQ sign-in routes are
// retired, and the remote bridge suppresses these records for new chats.
const (
	workIQRemoteID       = "workiq"
	workIQRemoteEndpoint = "https://workiq.svc.cloud.microsoft/mcp"
	workIQClientID       = "ba081686-5d24-4bc6-a0d6-d034ecffed87"
)

func workIQState() (map[string]any, error) {
	result := map[string]any{
		"mode": "remote", "endpoint": workIQRemoteEndpoint,
		"state": "disconnected", "savedAuthorization": false,
		"toolCount": 0, "discoveredTools": []remoteToolSummary{}, "allowedTools": []string{},
	}
	err := withRemoteConnections(func(records map[string]remoteConnection) error {
		record, found := records[workIQRemoteID]
		if !found || record.Provider != workIQRemoteID || record.Endpoint != workIQRemoteEndpoint || record.Token == nil {
			return nil
		}
		result["savedAuthorization"] = true
		result["state"] = "authorized"
		result["toolCount"] = record.ToolCount
		result["discoveredTools"] = record.public().DiscoveredTools
		result["allowedTools"] = record.public().AllowedTools
		if !record.CheckedAt.IsZero() {
			result["checkedAt"] = record.CheckedAt
		}
		if record.CheckError != "" {
			result["state"] = "needs-attention"
			result["error"] = record.CheckError
		} else if !record.CheckedAt.IsZero() && time.Since(record.CheckedAt) < 5*time.Minute && len(record.AllowedTools) > 0 {
			result["state"] = "ready"
		}
		return nil
	})
	return result, err
}

func (s *Server) handleWorkIQRemote(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodDelete {
		err := withRemoteConnections(func(records map[string]remoteConnection) error {
			delete(records, workIQRemoteID)
			return saveRemoteConnections(records)
		})
		if err != nil {
			http.Error(w, "Microsoft connection could not be removed", http.StatusInternalServerError)
			return
		}
	}
	state, err := workIQState()
	if err != nil {
		http.Error(w, "Microsoft connection settings could not be read", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeSDKJSON(w, http.StatusOK, state)
}
