package tmux

import (
	"encoding/json"
	"testing"
)

func newTestState() *TmuxState {
	return &TmuxState{
		ActiveSessionID: "$0",
		Sessions: []Session{
			{
				ID:   "$0",
				Name: "main",
				Windows: []Window{
					{
						ID:     "@0",
						Name:   "editor",
						Layout: "main-vertical",
						Active: true,
						Panes: []Pane{
							{ID: "%0", Width: 80, Height: 24, Active: true},
							{ID: "%1", Width: 80, Height: 24, Active: false},
						},
					},
					{
						ID:     "@1",
						Name:   "shell",
						Layout: "even-horizontal",
						Active: false,
						Panes: []Pane{
							{ID: "%2", Width: 120, Height: 40, Active: true},
						},
					},
				},
			},
			{
				ID:   "$1",
				Name: "secondary",
				Windows: []Window{
					{
						ID:     "@2",
						Name:   "logs",
						Layout: "tiled",
						Active: true,
						Panes: []Pane{
							{ID: "%3", Width: 60, Height: 20, Active: true},
						},
					},
				},
			},
		},
	}
}

func TestTmuxState_JSONRoundTrip(t *testing.T) {
	original := newTestState()

	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	var decoded TmuxState
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}

	// Verify top-level fields
	if decoded.ActiveSessionID != original.ActiveSessionID {
		t.Errorf("ActiveSessionID: got %q, want %q", decoded.ActiveSessionID, original.ActiveSessionID)
	}
	if len(decoded.Sessions) != len(original.Sessions) {
		t.Fatalf("Sessions count: got %d, want %d", len(decoded.Sessions), len(original.Sessions))
	}

	// Verify session fields
	s := decoded.Sessions[0]
	if s.ID != "$0" || s.Name != "main" {
		t.Errorf("Session[0]: got ID=%q Name=%q, want ID=$0 Name=main", s.ID, s.Name)
	}
	if len(s.Windows) != 2 {
		t.Fatalf("Session[0] windows: got %d, want 2", len(s.Windows))
	}

	// Verify window fields
	w := s.Windows[0]
	if w.ID != "@0" || w.Name != "editor" || w.Layout != "main-vertical" || !w.Active {
		t.Errorf("Window[0]: got ID=%q Name=%q Layout=%q Active=%v", w.ID, w.Name, w.Layout, w.Active)
	}
	if len(w.Panes) != 2 {
		t.Fatalf("Window[0] panes: got %d, want 2", len(w.Panes))
	}

	// Verify pane fields
	p := w.Panes[0]
	if p.ID != "%0" || p.Width != 80 || p.Height != 24 || !p.Active {
		t.Errorf("Pane[0]: got ID=%q Width=%d Height=%d Active=%v", p.ID, p.Width, p.Height, p.Active)
	}
}

func TestTmuxState_FindSession(t *testing.T) {
	state := newTestState()

	// Find existing session
	s := state.FindSession("$0")
	if s == nil {
		t.Fatal("FindSession($0) returned nil")
	}
	if s.Name != "main" {
		t.Errorf("FindSession($0).Name: got %q, want %q", s.Name, "main")
	}

	// Find second session
	s2 := state.FindSession("$1")
	if s2 == nil {
		t.Fatal("FindSession($1) returned nil")
	}
	if s2.Name != "secondary" {
		t.Errorf("FindSession($1).Name: got %q, want %q", s2.Name, "secondary")
	}

	// Find non-existent session
	if state.FindSession("$99") != nil {
		t.Error("FindSession($99) should return nil")
	}
}

func TestTmuxState_FindWindow(t *testing.T) {
	state := newTestState()

	// Find window in first session
	w := state.FindWindow("@0")
	if w == nil {
		t.Fatal("FindWindow(@0) returned nil")
	}
	if w.Name != "editor" {
		t.Errorf("FindWindow(@0).Name: got %q, want %q", w.Name, "editor")
	}

	// Find window in second session
	w2 := state.FindWindow("@2")
	if w2 == nil {
		t.Fatal("FindWindow(@2) returned nil")
	}
	if w2.Name != "logs" {
		t.Errorf("FindWindow(@2).Name: got %q, want %q", w2.Name, "logs")
	}

	// Find non-existent window
	if state.FindWindow("@99") != nil {
		t.Error("FindWindow(@99) should return nil")
	}
}

func TestTmuxState_FindPane(t *testing.T) {
	state := newTestState()

	// Find pane in first window
	p := state.FindPane("%0")
	if p == nil {
		t.Fatal("FindPane(%0) returned nil")
	}
	if p.Width != 80 || p.Height != 24 {
		t.Errorf("FindPane(%%0): got %dx%d, want 80x24", p.Width, p.Height)
	}

	// Find pane in second session
	p2 := state.FindPane("%3")
	if p2 == nil {
		t.Fatal("FindPane(%3) returned nil")
	}
	if p2.Width != 60 || p2.Height != 20 {
		t.Errorf("FindPane(%%3): got %dx%d, want 60x20", p2.Width, p2.Height)
	}

	// Find non-existent pane
	if state.FindPane("%99") != nil {
		t.Error("FindPane(%99) should return nil")
	}
}

func TestTmuxState_ApplySessionChanged(t *testing.T) {
	state := newTestState()

	// Apply a new session that doesn't exist yet
	state.ApplySessionChanged("$5", "newsession")

	if state.ActiveSessionID != "$5" {
		t.Errorf("ActiveSessionID: got %q, want %q", state.ActiveSessionID, "$5")
	}

	s := state.FindSession("$5")
	if s == nil {
		t.Fatal("new session $5 not found after ApplySessionChanged")
	}
	if s.Name != "newsession" {
		t.Errorf("session name: got %q, want %q", s.Name, "newsession")
	}
}

func TestTmuxState_ApplySessionChanged_Existing(t *testing.T) {
	state := newTestState()
	origLen := len(state.Sessions)

	// Switch to existing session $1
	state.ApplySessionChanged("$1", "renamed-secondary")

	if state.ActiveSessionID != "$1" {
		t.Errorf("ActiveSessionID: got %q, want %q", state.ActiveSessionID, "$1")
	}

	// Should not create a duplicate
	if len(state.Sessions) != origLen {
		t.Errorf("Sessions count: got %d, want %d (no duplicate)", len(state.Sessions), origLen)
	}

	// Name should be updated
	s := state.FindSession("$1")
	if s == nil {
		t.Fatal("session $1 not found")
	}
	if s.Name != "renamed-secondary" {
		t.Errorf("session name: got %q, want %q", s.Name, "renamed-secondary")
	}
}

func TestTmuxState_ApplyWindowAdd(t *testing.T) {
	state := newTestState()

	// Active session is $0, which has 2 windows
	state.ApplyWindowAdd("@5")

	s := state.FindSession("$0")
	if s == nil {
		t.Fatal("active session $0 not found")
	}
	if len(s.Windows) != 3 {
		t.Fatalf("Windows count: got %d, want 3", len(s.Windows))
	}
	if s.Windows[2].ID != "@5" {
		t.Errorf("new window ID: got %q, want %q", s.Windows[2].ID, "@5")
	}

	// Adding the same window again should not duplicate
	state.ApplyWindowAdd("@5")
	s = state.FindSession("$0")
	if len(s.Windows) != 3 {
		t.Errorf("Windows count after dup add: got %d, want 3", len(s.Windows))
	}
}

func TestTmuxState_ApplyWindowClose(t *testing.T) {
	state := newTestState()

	// Close window @1 from session $0
	state.ApplyWindowClose("@1")

	s := state.FindSession("$0")
	if s == nil {
		t.Fatal("session $0 not found")
	}
	if len(s.Windows) != 1 {
		t.Fatalf("Windows count in $0: got %d, want 1", len(s.Windows))
	}
	if s.Windows[0].ID != "@0" {
		t.Errorf("remaining window ID: got %q, want %q", s.Windows[0].ID, "@0")
	}

	// Window @2 in session $1 should be unaffected
	s1 := state.FindSession("$1")
	if s1 == nil {
		t.Fatal("session $1 not found")
	}
	if len(s1.Windows) != 1 {
		t.Errorf("Windows count in $1: got %d, want 1", len(s1.Windows))
	}
}

func TestTmuxState_ApplyWindowRenamed(t *testing.T) {
	state := newTestState()

	state.ApplyWindowRenamed("@2", "new-logs-name")

	w := state.FindWindow("@2")
	if w == nil {
		t.Fatal("window @2 not found")
	}
	if w.Name != "new-logs-name" {
		t.Errorf("window name: got %q, want %q", w.Name, "new-logs-name")
	}
}

func TestTmuxState_ApplyLayoutChange(t *testing.T) {
	state := newTestState()

	// Use a real tmux layout string: horizontal split with two panes
	layout := "c89d,200x50,0,0{100x50,0,0,0,99x50,101,0,1}"
	state.ApplyLayoutChange("@0", layout)

	w := state.FindWindow("@0")
	if w == nil {
		t.Fatal("window @0 not found")
	}

	// Layout string should be updated
	if w.Layout != layout {
		t.Errorf("layout: got %q, want %q", w.Layout, layout)
	}

	// Pane list should be rebuilt from layout
	if len(w.Panes) != 2 {
		t.Fatalf("Panes count: got %d, want 2", len(w.Panes))
	}

	// Pane IDs should use %N format
	if w.Panes[0].ID != "%0" {
		t.Errorf("Pane[0].ID: got %q, want %%0", w.Panes[0].ID)
	}
	if w.Panes[1].ID != "%1" {
		t.Errorf("Pane[1].ID: got %q, want %%1", w.Panes[1].ID)
	}

	// Pane dimensions should match layout
	if w.Panes[0].Width != 100 || w.Panes[0].Height != 50 {
		t.Errorf("Pane[0] dimensions: got %dx%d, want 100x50", w.Panes[0].Width, w.Panes[0].Height)
	}
	if w.Panes[1].Width != 99 || w.Panes[1].Height != 50 {
		t.Errorf("Pane[1] dimensions: got %dx%d, want 99x50", w.Panes[1].Width, w.Panes[1].Height)
	}

	// Existing pane %0 was Active=true before, should preserve that
	if !w.Panes[0].Active {
		t.Error("Pane[0] Active should be preserved as true")
	}
}

func TestTmuxState_ApplySessionWindowChanged(t *testing.T) {
	state := newTestState()

	// In session $0, window @0 is active, @1 is not
	// Switch active to @1
	state.ApplySessionWindowChanged("$0", "@1")

	s := state.FindSession("$0")
	if s == nil {
		t.Fatal("session $0 not found")
	}

	for _, w := range s.Windows {
		if w.ID == "@1" && !w.Active {
			t.Error("window @1 should be Active after switch")
		}
		if w.ID == "@0" && w.Active {
			t.Error("window @0 should not be Active after switch")
		}
	}
}

func TestTmuxState_ApplyWindowPaneChanged(t *testing.T) {
	state := newTestState()

	// In window @0, pane %0 is active, %1 is not
	// Switch active to %1
	state.ApplyWindowPaneChanged("@0", "%1")

	w := state.FindWindow("@0")
	if w == nil {
		t.Fatal("window @0 not found")
	}

	for _, p := range w.Panes {
		if p.ID == "%1" && !p.Active {
			t.Error("pane %1 should be Active after switch")
		}
		if p.ID == "%0" && p.Active {
			t.Error("pane %0 should not be Active after switch")
		}
	}
}

func TestTmuxState_ApplySessionRenamed(t *testing.T) {
	state := newTestState()

	// Active session is $0 with name "main"
	state.ApplySessionRenamed("renamed-main")

	s := state.FindSession("$0")
	if s == nil {
		t.Fatal("active session $0 not found")
	}
	if s.Name != "renamed-main" {
		t.Errorf("session name: got %q, want %q", s.Name, "renamed-main")
	}
}