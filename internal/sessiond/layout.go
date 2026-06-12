package sessiond

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// dockNode represents a single node in the dockview grid tree.
// Data is decoded lazily based on Type.
type dockNode struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
	Size float64         `json:"size"`
}

// dockLeaf is the data payload for a leaf node.
type dockLeaf struct {
	ID         string   `json:"id"`
	Views      []string `json:"views"`
	ActiveView string   `json:"activeView"`
}

// dockPanel is one entry in the panels map.
type dockPanel struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// dockGrid is the top-level dockview layout JSON.
type dockGrid struct {
	Grid struct {
		Root        dockNode `json:"root"`
		Orientation string   `json:"orientation"`
	} `json:"grid"`
	Panels      map[string]dockPanel `json:"panels"`
	ActiveGroup string               `json:"activeGroup"`
}

// ASCIILayout parses a dockview layout JSON string and renders an ASCII box
// diagram. panes provides PaneInfo for each known pane id; active is the
// active pane id (-1 = none). Returns "" on empty or malformed input.
func ASCIILayout(layout string, panes []PaneInfo, active int) string {
	if strings.TrimSpace(layout) == "" {
		return ""
	}
	var g dockGrid
	if err := json.Unmarshal([]byte(layout), &g); err != nil {
		return ""
	}
	// Index panes by id.
	paneByID := make(map[int]PaneInfo, len(panes))
	for _, p := range panes {
		paneByID[p.PaneID] = p
	}
	leaves := collectLeaves(&g.Grid.Root)
	if len(leaves) == 0 {
		return ""
	}
	var sb strings.Builder
	for _, leaf := range leaves {
		sb.WriteString(renderGroup(leaf, paneByID, active))
		sb.WriteString("\n")
	}
	if active >= 0 {
		fmt.Fprintf(&sb, "active: %d\n", active)
	}
	return sb.String()
}

// collectLeaves performs a depth-first traversal and returns all leaf dockLeaf values.
func collectLeaves(node *dockNode) []dockLeaf {
	if node == nil {
		return nil
	}
	switch node.Type {
	case "leaf":
		var leaf dockLeaf
		if err := json.Unmarshal(node.Data, &leaf); err != nil {
			return nil
		}
		return []dockLeaf{leaf}
	case "branch":
		var children []dockNode
		if err := json.Unmarshal(node.Data, &children); err != nil {
			return nil
		}
		var result []dockLeaf
		for i := range children {
			result = append(result, collectLeaves(&children[i])...)
		}
		return result
	default:
		return nil
	}
}

// renderGroup renders a single group (leaf) as an ASCII box with a tab bar.
func renderGroup(leaf dockLeaf, paneByID map[int]PaneInfo, activePaneID int) string {
	// Build tab labels: "[id]* kind" where * marks the active pane.
	type tabEntry struct {
		label       string
		browserPath string
	}
	tabs := make([]tabEntry, 0, len(leaf.Views))
	for _, viewStr := range leaf.Views {
		id, err := strconv.Atoi(viewStr)
		if err != nil {
			continue
		}
		info, ok := paneByID[id]
		var kind string
		if ok {
			if info.Title != "" {
				kind = info.Title
			} else {
				kind = info.SurfaceKind
			}
		} else {
			kind = viewStr
		}
		marker := ""
		if id == activePaneID {
			marker = "*"
		}
		label := fmt.Sprintf("[%d]%s %s", id, marker, kind)
		bp := ""
		if ok && info.SurfaceKind == "browser" && viewStr == leaf.ActiveView {
			bp = info.BrowserPath
		}
		tabs = append(tabs, tabEntry{label: label, browserPath: bp})
	}

	// Build tab bar line by joining labels with " | ".
	labels := make([]string, len(tabs))
	for i, t := range tabs {
		labels[i] = t.label
	}
	tabLine := strings.Join(labels, " | ")

	// Build the content hint from the active view's browser path (if any).
	contentHint := ""
	for _, t := range tabs {
		if t.browserPath != "" {
			contentHint = t.browserPath
			break
		}
	}

	// Determine box width: max of tab line and content hint lengths, minimum 4.
	width := 4
	if len(tabLine) > width {
		width = len(tabLine)
	}
	if len(contentHint) > width {
		width = len(contentHint)
	}

	// Draw the box using box-drawing characters.
	// ┌──────────┐
	// │ tab bar  │
	// ├──────────┤  (only if contentHint is non-empty)
	// │ content  │  (only if contentHint is non-empty)
	// └──────────┘
	bar := strings.Repeat("─", width)
	var sb strings.Builder
	fmt.Fprintf(&sb, "┌%s┐\n", bar)
	fmt.Fprintf(&sb, "│%-*s│\n", width, tabLine)
	if contentHint != "" {
		fmt.Fprintf(&sb, "├%s┤\n", bar)
		fmt.Fprintf(&sb, "│%-*s│\n", width, contentHint)
	}
	fmt.Fprintf(&sb, "└%s┘", bar)
	return sb.String()
}
