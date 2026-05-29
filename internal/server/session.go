package server

// SessionInfo describes a single tmux session for the session picker.
type SessionInfo struct {
	Name    string `json:"name"`
	Windows int    `json:"windows"`
}

// SessionListMessage is sent to WS clients when multiple tmux sessions exist,
// allowing the client to pick which session to attach to.
type SessionListMessage struct {
	Sessions []SessionInfo `json:"sessions"`
}
