package mcp

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

func displayName(name, fallback string) string {
	if strings.TrimSpace(name) == "" {
		return fallback
	}
	return name
}

// Match duplicate numbering in the browser's daemon-ordered workspace list.
// Include it in the fallback label too, so a later close retains the distinction.
func workspaceReferenceLabel(ws sessiond.WorkspaceInfo, inventory []sessiond.WorkspaceInfo) string {
	name := displayName(ws.Name, "Unnamed workspace")
	count, ordinal := 0, 0
	for _, item := range inventory {
		if displayName(item.Name, "Unnamed workspace") == name {
			count++
			if item.WorkspaceID == ws.WorkspaceID {
				ordinal = count
			}
		}
	}
	if count > 1 {
		return fmt.Sprintf("%s · %d", name, ordinal)
	}
	return name
}

func referenceMarkdown(kind, uuid string, pane int, machine, name, status string) string {
	path := url.PathEscape(uuid)
	if kind == "pane" {
		path += fmt.Sprintf("/%d", pane)
	}
	label := strings.NewReplacer("\\", "\\\\", "[", "\\[", "]", "\\]", "\n", " ", "\r", " ").Replace(name)
	return fmt.Sprintf("[%s](muxterm:%s/%s?machine=%s&status=%s)", label, kind, path, url.QueryEscape(machine), status)
}

// Enrich at the common sessiond-tool boundary, including nested fleet/trigger
// rows. Snapshot without attaching (an attach would replay output and change
// tool routing). A failed name lookup must never turn a successful action into
// a tool failure that the model might retry. The pre-call snapshot retains names
// for a close or a lane that exits before the action reply is decorated.
func (c *Client) withReferenceNames(fn func(*Client, map[string]any) (string, error), args map[string]any) (string, error) {
	var before []sessiond.WorkspaceInfo
	// Only actions addressed to an existing target can remove its name.
	_, hasWorkspace := args["workspace_id"]
	_, hasPane := args["pane_id"]
	if hasWorkspace || hasPane {
		before, _ = c.conn.ListWorkspacesWithin(2 * time.Second)
	}
	result, err := fn(c, args)
	if err != nil {
		return result, err
	}
	// No lookup for text/file/config results that carry no structural handles.
	if !strings.Contains(result, `"workspace_id":`) && !strings.Contains(result, `"pane_id":`) {
		return result, nil
	}
	var value any
	if json.Unmarshal([]byte(result), &value) != nil {
		return result, nil
	}
	after, lookupErr := c.conn.ListWorkspacesWithin(2 * time.Second)
	live := make(map[string]sessiond.WorkspaceInfo)
	known := make(map[string]sessiond.WorkspaceInfo)
	for _, ws := range before {
		known[ws.WorkspaceID] = ws
	}
	for _, ws := range after {
		known[ws.WorkspaceID] = ws
		live[ws.WorkspaceID] = ws
	}
	var enrich func(any)
	enrich = func(v any) {
		switch row := v.(type) {
		case []any:
			for _, child := range row {
				enrich(child)
			}
		case map[string]any:
			// Visit the original nested rows before adding reference strings.
			for _, child := range row {
				enrich(child)
			}
			wsID, _ := row["workspace_id"].(string)
			pane, hasPane := row["pane_id"].(float64)
			if wsID == "" && hasPane {
				wsID = c.Workspace()
				row["workspace_id"] = wsID
			}
			if wsID == "" {
				return
			}
			ws, knownWS := known[wsID]
			_, liveWS := live[wsID]
			status := "closed"
			if liveWS {
				status = "live"
			}
			if lookupErr != nil {
				status = "unavailable"
			}
			name, _ := row["workspace_name"].(string)
			name = displayName(name, "Unavailable workspace")
			uuid := "gone"
			if knownWS {
				name = displayName(ws.Name, "Unnamed workspace")
				uuid = ws.WorkspaceUUID
			}
			if uuid == "" {
				uuid = "gone"
				status = "unavailable"
			}
			row["workspace_name"] = name
			row["workspace_status"] = status
			label := name
			if knownWS {
				inventory := after
				if !liveWS {
					inventory = before
				}
				label = workspaceReferenceLabel(ws, inventory)
			}
			row["workspace_ref"] = referenceMarkdown("workspace", uuid, 0, c.Machine(), label, status)
			if hasPane {
				paneName, _ := row["pane_name"].(string)
				if row["kind"] == "terminal" {
					paneName, _ = row["name"].(string)
				}
				paneName = displayName(paneName, "Unavailable pane")
				paneStatus := status
				if liveWS && ws.Panes == nil {
					paneStatus = "unavailable"
				}
				found := false
				for _, p := range ws.Panes {
					if p.PaneID == int(pane) {
						paneName = displayName(p.Title, "Unnamed pane")
						found = true
						break
					}
				}
				// A just-closed pane can still be named by the pre-call inventory.
				if !found {
					for _, old := range before {
						if old.WorkspaceID == wsID {
							for _, p := range old.Panes {
								if p.PaneID == int(pane) {
									paneName = displayName(p.Title, "Unnamed pane")
								}
							}
						}
					}
					if lookupErr == nil && !(liveWS && ws.Panes == nil) {
						paneStatus = "closed"
					}
				}
				row["pane_name"] = paneName
				row["pane_status"] = paneStatus
				paneLabel := paneName
				count, ordinal := 0, 0
				for _, p := range ws.Panes {
					if displayName(p.Title, "Unnamed pane") == paneName {
						count++
						if p.PaneID == int(pane) {
							ordinal = count
						}
					}
				}
				if count > 1 {
					paneLabel += fmt.Sprintf(" · %d", ordinal)
				}
				paneLabel += " · " + label
				row["pane_ref"] = referenceMarkdown("pane", uuid, int(pane), c.Machine(), paneLabel, paneStatus)
			}
			if ref, ok := row["reference_pane"].(float64); ok {
				name := "Unavailable pane"
				for _, p := range ws.Panes {
					if p.PaneID == int(ref) {
						name = displayName(p.Title, "Unnamed pane")
					}
				}
				row["reference_pane_name"] = name
			}
			// get_layout's ASCII representation carries numeric handles: supply the
			// inventory alongside it so every handle has a name without another call.
			if _, ok := row["layout"]; ok {
				panes := make([]any, 0, len(ws.Panes))
				for _, p := range ws.Panes {
					panes = append(panes, map[string]any{"workspace_id": wsID, "pane_id": float64(p.PaneID)})
				}
				enrich(panes)
				row["panes"] = panes
			}
		}
	}
	enrich(value)
	return jsonText(value), nil
}
