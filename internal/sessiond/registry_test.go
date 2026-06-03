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
