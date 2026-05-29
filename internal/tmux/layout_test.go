package tmux

import (
	"testing"
)

func TestParseLayout_SinglePane(t *testing.T) {
	// tmux layout string for a single pane: checksum,WxH,X,Y,paneID
	node, err := ParseLayout("5686,200x50,0,0,55")
	if err != nil {
		t.Fatalf("ParseLayout returned error: %v", err)
	}
	if node.Type != PaneNode {
		t.Errorf("Type: got %v, want PaneNode", node.Type)
	}
	if node.Width != 200 {
		t.Errorf("Width: got %d, want 200", node.Width)
	}
	if node.Height != 50 {
		t.Errorf("Height: got %d, want 50", node.Height)
	}
	if node.XOff != 0 {
		t.Errorf("XOff: got %d, want 0", node.XOff)
	}
	if node.YOff != 0 {
		t.Errorf("YOff: got %d, want 0", node.YOff)
	}
	if node.PaneID != 55 {
		t.Errorf("PaneID: got %d, want 55", node.PaneID)
	}
}

func TestParseLayout_HorizontalSplit(t *testing.T) {
	// Horizontal split: two panes side by side using {children}
	node, err := ParseLayout("c89d,200x50,0,0{100x50,0,0,55,99x50,101,0,56}")
	if err != nil {
		t.Fatalf("ParseLayout returned error: %v", err)
	}
	if node.Type != HSplit {
		t.Errorf("Type: got %v, want HSplit", node.Type)
	}
	if node.Width != 200 || node.Height != 50 {
		t.Errorf("Dimensions: got %dx%d, want 200x50", node.Width, node.Height)
	}
	if len(node.Children) != 2 {
		t.Fatalf("Children count: got %d, want 2", len(node.Children))
	}

	// First child: 100x50 at 0,0 pane 55
	c0 := node.Children[0]
	if c0.Type != PaneNode {
		t.Errorf("Child[0] Type: got %v, want PaneNode", c0.Type)
	}
	if c0.Width != 100 || c0.Height != 50 {
		t.Errorf("Child[0] Dimensions: got %dx%d, want 100x50", c0.Width, c0.Height)
	}
	if c0.XOff != 0 || c0.YOff != 0 {
		t.Errorf("Child[0] Offset: got %d,%d, want 0,0", c0.XOff, c0.YOff)
	}
	if c0.PaneID != 55 {
		t.Errorf("Child[0] PaneID: got %d, want 55", c0.PaneID)
	}

	// Second child: 99x50 at 101,0 pane 56
	c1 := node.Children[1]
	if c1.Type != PaneNode {
		t.Errorf("Child[1] Type: got %v, want PaneNode", c1.Type)
	}
	if c1.Width != 99 || c1.Height != 50 {
		t.Errorf("Child[1] Dimensions: got %dx%d, want 99x50", c1.Width, c1.Height)
	}
	if c1.XOff != 101 || c1.YOff != 0 {
		t.Errorf("Child[1] Offset: got %d,%d, want 101,0", c1.XOff, c1.YOff)
	}
	if c1.PaneID != 56 {
		t.Errorf("Child[1] PaneID: got %d, want 56", c1.PaneID)
	}
}

func TestParseLayout_VerticalSplit(t *testing.T) {
	// Vertical split: two panes stacked using [children]
	node, err := ParseLayout("0d8b,200x50,0,0[200x25,0,0,46,200x24,0,26,47]")
	if err != nil {
		t.Fatalf("ParseLayout returned error: %v", err)
	}
	if node.Type != VSplit {
		t.Errorf("Type: got %v, want VSplit", node.Type)
	}
	if node.Width != 200 || node.Height != 50 {
		t.Errorf("Dimensions: got %dx%d, want 200x50", node.Width, node.Height)
	}
	if len(node.Children) != 2 {
		t.Fatalf("Children count: got %d, want 2", len(node.Children))
	}

	// First child: 200x25 at 0,0 pane 46
	c0 := node.Children[0]
	if c0.Type != PaneNode {
		t.Errorf("Child[0] Type: got %v, want PaneNode", c0.Type)
	}
	if c0.PaneID != 46 {
		t.Errorf("Child[0] PaneID: got %d, want 46", c0.PaneID)
	}

	// Second child: 200x24 at 0,26 pane 47
	c1 := node.Children[1]
	if c1.Type != PaneNode {
		t.Errorf("Child[1] Type: got %v, want PaneNode", c1.Type)
	}
	if c1.YOff != 26 {
		t.Errorf("Child[1] YOff: got %d, want 26", c1.YOff)
	}
	if c1.PaneID != 47 {
		t.Errorf("Child[1] PaneID: got %d, want 47", c1.PaneID)
	}
}

func TestParseLayout_NestedSplits(t *testing.T) {
	// Horizontal split where second child is a vertical split
	node, err := ParseLayout("e759,200x50,0,0{100x50,0,0,55,99x50,101,0[99x25,101,0,56,99x24,101,26,57]}")
	if err != nil {
		t.Fatalf("ParseLayout returned error: %v", err)
	}
	if node.Type != HSplit {
		t.Errorf("Type: got %v, want HSplit", node.Type)
	}
	if len(node.Children) != 2 {
		t.Fatalf("Children count: got %d, want 2", len(node.Children))
	}

	// First child is a leaf pane
	c0 := node.Children[0]
	if c0.Type != PaneNode {
		t.Errorf("Child[0] Type: got %v, want PaneNode", c0.Type)
	}
	if c0.PaneID != 55 {
		t.Errorf("Child[0] PaneID: got %d, want 55", c0.PaneID)
	}

	// Second child is a VSplit with two children
	c1 := node.Children[1]
	if c1.Type != VSplit {
		t.Errorf("Child[1] Type: got %v, want VSplit", c1.Type)
	}
	if len(c1.Children) != 2 {
		t.Fatalf("Child[1] Children count: got %d, want 2", len(c1.Children))
	}
	if c1.Children[0].PaneID != 56 {
		t.Errorf("Child[1].Children[0] PaneID: got %d, want 56", c1.Children[0].PaneID)
	}
	if c1.Children[1].PaneID != 57 {
		t.Errorf("Child[1].Children[1] PaneID: got %d, want 57", c1.Children[1].PaneID)
	}
}

func TestParseLayout_PaneIDs(t *testing.T) {
	// Nested layout: panes 55, 56, 57 in left-to-right, top-to-bottom order
	node, err := ParseLayout("e759,200x50,0,0{100x50,0,0,55,99x50,101,0[99x25,101,0,56,99x24,101,26,57]}")
	if err != nil {
		t.Fatalf("ParseLayout returned error: %v", err)
	}

	ids := node.PaneIDs()
	if len(ids) != 3 {
		t.Fatalf("PaneIDs count: got %d, want 3", len(ids))
	}
	expected := []int{55, 56, 57}
	for i, want := range expected {
		if ids[i] != want {
			t.Errorf("PaneIDs[%d]: got %d, want %d", i, ids[i], want)
		}
	}
}

func TestParseLayout_InvalidInputs(t *testing.T) {
	cases := []struct {
		name  string
		input string
	}{
		{"empty string", ""},
		{"not a layout", "not-a-layout"},
		{"no pane ID or children", "abcd,200x50,0,0"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseLayout(tc.input)
			if err == nil {
				t.Errorf("ParseLayout(%q) should return error", tc.input)
			}
		})
	}
}