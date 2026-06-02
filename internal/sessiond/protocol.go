// Package sessiond defines the session daemon control protocol.
package sessiond

// Message is the single control envelope. Every request, reply, event, and
// error is this struct with a different Type. The JSON tags are FROZEN per the
// v1 wire protocol contract (see
// docs/plans/2026-06-01-session-persistence-design.md) and must never change.
type Message struct {
	Type        string          `json:"type"`
	CID         uint64          `json:"cid,omitempty"`         // request/reply correlation, 0 = unsolicited event
	WorkspaceID string          `json:"workspaceId,omitempty"` //
	Name        string          `json:"name,omitempty"`        //
	PaneID      int             `json:"paneId,omitempty"`      // workspace-local
	Cols        int             `json:"cols,omitempty"`        //
	Rows        int             `json:"rows,omitempty"`        //
	Cmd         []string        `json:"cmd,omitempty"`         // argv, empty => default $SHELL
	Title       string          `json:"title,omitempty"`       //
	Workspaces  []WorkspaceInfo `json:"workspaces,omitempty"`  //
	Panes       []PaneInfo      `json:"panes,omitempty"`       //
	Code        string          `json:"code,omitempty"`        // error code
	Error       string          `json:"error,omitempty"`       // human-readable error text
}

// WorkspaceInfo is one entry in a workspace-list reply.
type WorkspaceInfo struct {
	WorkspaceID string `json:"workspaceId"`
	Name        string `json:"name,omitempty"`
	PaneCount   int    `json:"paneCount"`
}

// PaneInfo is one entry in a composition reply or pane-added event.
type PaneInfo struct {
	PaneID int    `json:"paneId"`
	Cols   int    `json:"cols"`
	Rows   int    `json:"rows"`
	Title  string `json:"title,omitempty"`
}
