package sessiond

import (
	"strings"
	"testing"
)

// TestASCIILayout tests the ASCIILayout function with various inputs.
// Pane fixture: {1 terminal},{2 terminal},{3 editor}
func TestASCIILayout(t *testing.T) {
	panes := []PaneInfo{
		{PaneID: 1, Title: "terminal"},
		{PaneID: 2, Title: "terminal"},
		{PaneID: 3, Title: "editor"},
	}

	// Single leaf with one pane, views: ["1"]
	singleLeafJSON := `{
		"grid": {
			"root": {
				"type": "leaf",
				"data": {"id": "g1", "views": ["1"], "activeView": "1"},
				"size": 800
			},
			"orientation": "HORIZONTAL"
		},
		"panels": {
			"1": {"id": "1", "title": "terminal", "contentComponent": "terminal"}
		},
		"activeGroup": "g1"
	}`

	// Two-pane horizontal split (branch with two leaf children: pane 1 and pane 3)
	twoPaneSplitJSON := `{
		"grid": {
			"root": {
				"type": "branch",
				"data": [
					{
						"type": "leaf",
						"data": {"id": "g1", "views": ["1"], "activeView": "1"},
						"size": 400
					},
					{
						"type": "leaf",
						"data": {"id": "g3", "views": ["3"], "activeView": "3"},
						"size": 400
					}
				],
				"size": 800
			},
			"orientation": "HORIZONTAL"
		},
		"panels": {
			"1": {"id": "1", "title": "terminal", "contentComponent": "terminal"},
			"3": {"id": "3", "title": "editor", "contentComponent": "terminal"}
		},
		"activeGroup": "g1"
	}`

	// Multi-tab group: single leaf with views ["1","2"]
	multiTabJSON := `{
		"grid": {
			"root": {
				"type": "leaf",
				"data": {"id": "g1", "views": ["1", "2"], "activeView": "1"},
				"size": 800
			},
			"orientation": "HORIZONTAL"
		},
		"panels": {
			"1": {"id": "1", "title": "terminal", "contentComponent": "terminal"},
			"2": {"id": "2", "title": "terminal", "contentComponent": "terminal"}
		},
		"activeGroup": "g1"
	}`

	tests := []struct {
		name     string
		layout   string
		panes    []PaneInfo
		active   int
		wantTrim bool // if true, TrimSpace(result) should == ""
		contains []string
	}{
		{
			name:     "empty layout json",
			layout:   "",
			panes:    panes,
			active:   -1,
			wantTrim: true,
		},
		{
			name:     "malformed json",
			layout:   "{not valid json",
			panes:    panes,
			active:   -1,
			wantTrim: true,
		},
		{
			name:     "single leaf one pane",
			layout:   singleLeafJSON,
			panes:    panes,
			active:   -1,
			wantTrim: false,
			contains: []string{"[1]", "terminal"},
		},
		{
			name:     "two-pane horizontal split",
			layout:   twoPaneSplitJSON,
			panes:    panes,
			active:   -1,
			wantTrim: false,
			contains: []string{"[1]", "[3]", "terminal", "editor"},
		},
		{
			name:     "multi-tab group",
			layout:   multiTabJSON,
			panes:    panes,
			active:   -1,
			wantTrim: false,
			contains: []string{"[1]", "[2]"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ASCIILayout(tc.layout, tc.panes, tc.active)
			if tc.wantTrim {
				if strings.TrimSpace(got) != "" {
					t.Errorf("expected empty/whitespace-only result, got: %q", got)
				}
				return
			}
			for _, want := range tc.contains {
				if !strings.Contains(got, want) {
					t.Errorf("ASCIILayout result missing %q\nfull result:\n%s", want, got)
				}
			}
		})
	}
}
