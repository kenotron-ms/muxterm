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

// ActivePaneFromLayout returns the pane id the client will make active when it
// restores this layout, and whether one was found.
//
// dockview persists the selection: activeGroup names the focused group and each
// leaf's activeView names the focused tab within it. Since view ids are pane ids
// (see renderGroup's strconv.Atoi), reading them back gives the daemon the one
// thing it otherwise cannot know -- which pane a workspace is "on" -- without
// inventing a second, drifting source of truth.
//
// Returns 0,false on empty or malformed input, or when activeView is not a pane
// id. Callers must have a fallback.
func ActivePaneFromLayout(layout string) (int, bool) {
	if strings.TrimSpace(layout) == "" {
		return 0, false
	}
	var g dockGrid
	if err := json.Unmarshal([]byte(layout), &g); err != nil {
		return 0, false
	}
	leaves := collectLeaves(&g.Grid.Root)
	if len(leaves) == 0 {
		return 0, false
	}

	// Prefer the focused group. A single-group layout often omits activeGroup,
	// and a stale id can survive a group being closed, so fall back to the
	// first leaf rather than giving up.
	active := leaves[0]
	if g.ActiveGroup != "" {
		for _, leaf := range leaves {
			if leaf.ID == g.ActiveGroup {
				active = leaf
				break
			}
		}
	}

	view := active.ActiveView
	if view == "" && len(active.Views) > 0 {
		view = active.Views[0]
	}
	id, err := strconv.Atoi(view)
	if err != nil {
		return 0, false
	}
	return id, true
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
		label string
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
				// Every pane is a terminal; an untitled pane still needs a
				// non-empty label so the diagram never renders a blank kind.
				kind = "terminal"
			}
		} else {
			kind = viewStr
		}
		marker := ""
		if id == activePaneID {
			marker = "*"
		}
		label := fmt.Sprintf("[%d]%s %s", id, marker, kind)
		tabs = append(tabs, tabEntry{label: label})
	}

	// Build tab bar line by joining labels with " | ".
	labels := make([]string, len(tabs))
	for i, t := range tabs {
		labels[i] = t.label
	}
	tabLine := strings.Join(labels, " | ")

	// Determine box width: max of tab line length, minimum 4.
	width := 4
	if len(tabLine) > width {
		width = len(tabLine)
	}

	// Draw the box using box-drawing characters.
	// ┌──────────┐
	// │ tab bar  │
	// └──────────┘
	bar := strings.Repeat("─", width)
	var sb strings.Builder
	fmt.Fprintf(&sb, "┌%s┐\n", bar)
	fmt.Fprintf(&sb, "│%-*s│\n", width, tabLine)
	fmt.Fprintf(&sb, "└%s┘", bar)
	return sb.String()
}
