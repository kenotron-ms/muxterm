package sessiond

import (
	"reflect"
	"testing"
)

func TestRegistryAddAndGetWorkspace(t *testing.T) {
	r := NewRegistry()

	id1 := r.AddWorkspace("alpha", "")
	id2 := r.AddWorkspace("", "")

	if id1 == id2 {
		t.Fatalf("expected unique workspace ids, both were %q", id1)
	}

	if !r.Has(id1) {
		t.Fatalf("Has(%q) = false, want true", id1)
	}
	if r.Has("nope") {
		t.Fatalf("Has(\"nope\") = true, want false")
	}

	ws, ok := r.Get(id1)
	if !ok {
		t.Fatalf("Get(%q) ok = false, want true", id1)
	}
	if ws.Name != "alpha" {
		t.Fatalf("ws.Name = %q, want %q", ws.Name, "alpha")
	}
	if ws.ID != id1 {
		t.Fatalf("ws.ID = %q, want %q", ws.ID, id1)
	}

	ws2, ok := r.Get(id2)
	if !ok {
		t.Fatalf("Get(%q) ok = false, want true", id2)
	}
	if ws2.Name != "" {
		t.Fatalf("ws2.Name = %q, want empty (unnamed)", ws2.Name)
	}

	if _, ok := r.Get("missing"); ok {
		t.Fatalf("Get(\"missing\") ok = true, want false")
	}
}

func TestRegistryPaneIDsAreWorkspaceLocal(t *testing.T) {
	r := NewRegistry()
	a := r.AddWorkspace("a", "")
	b := r.AddWorkspace("b", "")

	id, ok := r.AllocPaneID(a)
	if !ok || id != 1 {
		t.Fatalf("first AllocPaneID(a) = (%d, %v), want (1, true)", id, ok)
	}
	id, ok = r.AllocPaneID(a)
	if !ok || id != 2 {
		t.Fatalf("second AllocPaneID(a) = (%d, %v), want (2, true)", id, ok)
	}

	// Independent across workspaces: b also starts at 1.
	id, ok = r.AllocPaneID(b)
	if !ok || id != 1 {
		t.Fatalf("first AllocPaneID(b) = (%d, %v), want (1, true)", id, ok)
	}

	if _, ok := r.AllocPaneID("unknown"); ok {
		t.Fatalf("AllocPaneID(unknown) ok = true, want false")
	}
}

func TestRegistryPutGetRemovePane(t *testing.T) {
	r := NewRegistry()
	ws := r.AddWorkspace("w", "")

	id1, _ := r.AllocPaneID(ws)
	id2, _ := r.AllocPaneID(ws)
	p1 := &Pane{LocalID: id1}
	p2 := &Pane{LocalID: id2}

	if !r.PutPane(ws, p1) {
		t.Fatalf("PutPane(ws, p1) = false, want true")
	}
	if !r.PutPane(ws, p2) {
		t.Fatalf("PutPane(ws, p2) = false, want true")
	}
	if r.PutPane("unknown", p1) {
		t.Fatalf("PutPane(unknown, p1) = true, want false")
	}

	ids := r.PaneIDs(ws)
	if !reflect.DeepEqual(ids, []int{1, 2}) {
		t.Fatalf("PaneIDs(ws) = %v, want [1 2]", ids)
	}

	got, ok := r.Pane(ws, id1)
	if !ok || got != p1 {
		t.Fatalf("Pane(ws, %d) = (%v, %v), want (p1, true)", id1, got, ok)
	}
	if _, ok := r.Pane(ws, 999); ok {
		t.Fatalf("Pane(ws, 999) ok = true, want false")
	}
	if _, ok := r.Pane("unknown", id1); ok {
		t.Fatalf("Pane(unknown, %d) ok = true, want false", id1)
	}

	removed, remaining, ok := r.RemovePane(ws, id1)
	if !ok || removed != p1 || remaining != 1 {
		t.Fatalf("RemovePane(ws, %d) = (%v, %d, %v), want (p1, 1, true)", id1, removed, remaining, ok)
	}

	if _, _, ok := r.RemovePane(ws, id1); ok {
		t.Fatalf("second RemovePane(ws, %d) ok = true, want false", id1)
	}

	if _, _, ok := r.RemovePane("unknown", id2); ok {
		t.Fatalf("RemovePane(unknown, %d) ok = true, want false", id2)
	}
}

func TestRegistryListReportsWorkspaceInfo(t *testing.T) {
	r := NewRegistry()
	a := r.AddWorkspace("alpha", "")
	b := r.AddWorkspace("beta", "")

	pid, _ := r.AllocPaneID(a)
	r.PutPane(a, &Pane{LocalID: pid})

	list := r.List()
	want := []WorkspaceInfo{
		{WorkspaceID: a, Name: "alpha", PaneCount: 1},
		{WorkspaceID: b, Name: "beta", PaneCount: 0},
	}
	if !reflect.DeepEqual(list, want) {
		t.Fatalf("List() = %+v, want %+v", list, want)
	}
}

func TestRegistryPaneInfosReportsFrozenPaneInfo(t *testing.T) {
	r := NewRegistry()
	ws := r.AddWorkspace("w", "")

	pid, _ := r.AllocPaneID(ws)
	r.PutPane(ws, &Pane{LocalID: pid, Title: "shell", cols: 80, rows: 24})

	infos := r.PaneInfos(ws)
	want := []PaneInfo{{PaneID: 1, Cols: 80, Rows: 24, Title: "shell"}}
	if !reflect.DeepEqual(infos, want) {
		t.Fatalf("PaneInfos(ws) = %+v, want %+v", infos, want)
	}

	if r.PaneInfos("unknown") != nil {
		t.Fatalf("PaneInfos(unknown) = non-nil, want nil")
	}
}

// TestRegistrySaveLayoutRoundTrip saves a layout blob for a known workspace/breakpoint
// and verifies Layout returns it; a different breakpoint returns ""; an unknown
// workspace returns "".
func TestRegistrySaveLayoutRoundTrip(t *testing.T) {
	r := NewRegistry()
	ws := r.AddWorkspace("w", "")

	const blob = `{"panels":[]}`

	if !r.SaveLayout(ws, "desktop", blob) {
		t.Fatal("SaveLayout(known ws, non-empty breakpoint) = false, want true")
	}

	got := r.Layout(ws, "desktop")
	if got != blob {
		t.Fatalf("Layout(ws, \"desktop\") = %q, want %q", got, blob)
	}

	// Different breakpoint returns "".
	if got := r.Layout(ws, "mobile"); got != "" {
		t.Fatalf("Layout(ws, \"mobile\") = %q, want \"\" (no layout saved for mobile)", got)
	}

	// Unknown workspace returns "".
	if got := r.Layout("bogus", "desktop"); got != "" {
		t.Fatalf("Layout(\"bogus\", \"desktop\") = %q, want \"\" (unknown workspace)", got)
	}
}

// TestRegistrySaveLayoutFailureCases verifies SaveLayout returns false for an unknown
// workspace and for an empty breakpoint; an empty layout string is allowed (clear).
func TestRegistrySaveLayoutFailureCases(t *testing.T) {
	r := NewRegistry()
	ws := r.AddWorkspace("w", "")

	// Unknown workspace.
	if r.SaveLayout("bogus", "desktop", "blob") {
		t.Fatal("SaveLayout(unknown ws, ...) = true, want false")
	}

	// Empty breakpoint.
	if r.SaveLayout(ws, "", "blob") {
		t.Fatal("SaveLayout(known ws, \"\", ...) = true, want false (empty breakpoint rejected)")
	}

	// Empty layout string is allowed (acts as a clear).
	if !r.SaveLayout(ws, "desktop", "") {
		t.Fatal("SaveLayout(known ws, breakpoint, \"\") = false, want true (empty layout is allowed)")
	}
	if got := r.Layout(ws, "desktop"); got != "" {
		t.Fatalf("Layout after SaveLayout(empty) = %q, want \"\"", got)
	}
}

// TestRegistryRenamePaneSetsTitle verifies RenamePane updates the pane's title
// as seen through PaneInfos.
func TestRegistryRenamePaneSetsTitle(t *testing.T) {
	r := NewRegistry()
	ws := r.AddWorkspace("w", "")
	pid, _ := r.AllocPaneID(ws)
	r.PutPane(ws, &Pane{LocalID: pid, cols: 80, rows: 24})

	if !r.RenamePane(ws, pid, "my-title") {
		t.Fatal("RenamePane(known ws, known pane, name) = false, want true")
	}

	infos := r.PaneInfos(ws)
	if len(infos) != 1 {
		t.Fatalf("PaneInfos len = %d, want 1", len(infos))
	}
	if infos[0].Title != "my-title" {
		t.Fatalf("PaneInfos[0].Title = %q, want %q", infos[0].Title, "my-title")
	}
}

// TestRegistryRenamePaneFailureCases verifies RenamePane returns false for an
// unknown workspace and for an unknown pane.
func TestRegistryRenamePaneFailureCases(t *testing.T) {
	r := NewRegistry()
	ws := r.AddWorkspace("w", "")
	pid, _ := r.AllocPaneID(ws)
	r.PutPane(ws, &Pane{LocalID: pid})

	// Unknown workspace.
	if r.RenamePane("bogus", pid, "title") {
		t.Fatal("RenamePane(unknown ws, ...) = true, want false")
	}

	// Unknown pane.
	if r.RenamePane(ws, 999, "title") {
		t.Fatal("RenamePane(known ws, unknown pane, ...) = true, want false")
	}
}

// TestRegistry_BrowserPane_PutAndGet verifies that a browser pane can
// be put into the registry and retrieved with the correct SurfaceKind.
func TestRegistry_BrowserPane_PutAndGet(t *testing.T) {
	r := NewRegistry()
	wsID := r.AddWorkspace("w", "")
	localID, _ := r.AllocPaneID(wsID)
	p := NewBrowserPane(localID)
	r.PutPane(wsID, p)

	got, ok := r.Pane(wsID, localID)
	if !ok {
		t.Fatalf("Pane(%q, %d) not found after PutPane", wsID, localID)
	}
	if got.SurfaceKind != "browser" {
		t.Fatalf("SurfaceKind = %q, want \"browser\"", got.SurfaceKind)
	}
}

// TestRegistry_BrowserPane_Replay verifies that a browser pane returns
// nil replay data (no buffer).
func TestRegistry_BrowserPane_Replay(t *testing.T) {
	r := NewRegistry()
	wsID := r.AddWorkspace("w", "")
	localID, _ := r.AllocPaneID(wsID)
	p := NewBrowserPane(localID)
	r.PutPane(wsID, p)

	got, ok := r.Pane(wsID, localID)
	if !ok {
		t.Fatalf("Pane not found")
	}
	if data := got.Replay(); data != nil {
		t.Fatalf("Replay() = %v, want nil (browser pane has no buffer)", data)
	}
}

// TestRegistry_BrowserPane_RemovePane verifies that a browser pane can
// be removed from the registry.
func TestRegistry_BrowserPane_RemovePane(t *testing.T) {
	r := NewRegistry()
	wsID := r.AddWorkspace("w", "")
	localID, _ := r.AllocPaneID(wsID)
	p := NewBrowserPane(localID)
	r.PutPane(wsID, p)

	removed, remaining, ok := r.RemovePane(wsID, localID)
	if !ok {
		t.Fatal("RemovePane returned ok=false, want true")
	}
	if removed != p {
		t.Fatal("RemovePane returned wrong pane")
	}
	if remaining != 0 {
		t.Fatalf("remaining = %d, want 0", remaining)
	}
}
