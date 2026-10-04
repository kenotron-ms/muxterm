package server

import "slices"

// Google Workspace publishes one remote service per product. Keep each preset
// fixed to its official endpoint, least-privilege read scopes, and reviewed
// read-only tools. Newly discovered tools remain disabled until reviewed.
type googleConnectionPreset struct {
	Name      string
	Endpoint  string
	Scopes    []string
	ReadTools []string
}

var googleConnectionPresets = map[string]googleConnectionPreset{
	"gmail": {
		Name: "Gmail", Endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
		Scopes:    []string{"https://www.googleapis.com/auth/gmail.readonly"},
		ReadTools: []string{"get_message", "get_thread", "list_drafts", "list_labels", "search_threads"},
	},
	"google-drive": {
		Name: "Google Drive", Endpoint: "https://drivemcp.googleapis.com/mcp/v1",
		Scopes:    []string{"https://www.googleapis.com/auth/drive.readonly"},
		ReadTools: []string{"download_file_content", "get_file_metadata", "get_file_permissions", "list_recent_files", "read_file_content", "search_files"},
	},
	"google-calendar": {
		Name: "Google Calendar", Endpoint: "https://calendarmcp.googleapis.com/mcp/v1",
		Scopes: []string{
			"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
			"https://www.googleapis.com/auth/calendar.events.readonly",
			"https://www.googleapis.com/auth/calendar.events.freebusy",
		},
		ReadTools: []string{"get_event", "list_calendars", "list_events", "search_events", "suggest_time"},
	},
	"google-docs": {
		Name: "Google Docs", Endpoint: "https://docsmcp.googleapis.com/mcp/v1",
		Scopes:    []string{"https://www.googleapis.com/auth/documents.readonly", "https://www.googleapis.com/auth/drive.readonly"},
		ReadTools: []string{"read_doc"},
	},
	"google-sheets": {
		Name: "Google Sheets", Endpoint: "https://sheetsmcp.googleapis.com/mcp/v1",
		Scopes:    []string{"https://www.googleapis.com/auth/spreadsheets.readonly", "https://www.googleapis.com/auth/drive.readonly"},
		ReadTools: []string{"get_values", "get_spreadsheet"},
	},
	"google-slides": {
		Name: "Google Slides", Endpoint: "https://slidesmcp.googleapis.com/mcp/v1",
		Scopes:    []string{"https://www.googleapis.com/auth/presentations.readonly", "https://www.googleapis.com/auth/drive.readonly"},
		ReadTools: []string{"read_presentation"},
	},
}

func presetAllowsRemoteTool(c remoteConnection, name string) bool {
	if c.Provider == "" {
		return true
	}
	preset, ok := googleConnectionPresets[c.Provider]
	return ok && c.Endpoint == preset.Endpoint && slices.Contains(preset.ReadTools, name)
}
