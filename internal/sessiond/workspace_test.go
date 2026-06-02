package sessiond

import (
	"testing"
)

func TestEnsureDefaultColdStartCreatesUnnamed(t *testing.T) {
	r := NewRegistry()

	ws := r.EnsureDefault()
	if ws == nil {
		t.Fatalf("EnsureDefault() = nil, want a workspace")
	}
	if ws.Name != "" {
		t.Fatalf("ws.Name = %q, want empty (unnamed)", ws.Name)
	}
	if len(r.List()) != 1 {
		t.Fatalf("workspace count = %d, want 1", len(r.List()))
	}
	if !r.Has(ws.ID) {
		t.Fatalf("Has(%q) = false, want true", ws.ID)
	}
}

func TestEnsureDefaultNoOpWhenNonEmpty(t *testing.T) {
	r := NewRegistry()
	id := r.AddWorkspace("alpha", "")

	ws := r.EnsureDefault()
	if ws == nil {
		t.Fatalf("EnsureDefault() = nil, want existing workspace")
	}
	if ws.ID != id {
		t.Fatalf("EnsureDefault() returned %q, want existing %q", ws.ID, id)
	}
	if len(r.List()) != 1 {
		t.Fatalf("workspace count = %d, want 1 (no new default)", len(r.List()))
	}
}

func TestRenameWorkspace(t *testing.T) {
	r := NewRegistry()
	id := r.AddWorkspace("old", "")

	if !r.RenameWorkspace(id, "prod") {
		t.Fatalf("RenameWorkspace(%q, \"prod\") = false, want true", id)
	}
	ws, _ := r.Get(id)
	if ws.Name != "prod" {
		t.Fatalf("ws.Name = %q, want %q", ws.Name, "prod")
	}

	if !r.RenameWorkspace(id, "") {
		t.Fatalf("RenameWorkspace(%q, \"\") = false, want true", id)
	}
	ws, _ = r.Get(id)
	if ws.Name != "" {
		t.Fatalf("ws.Name = %q, want empty", ws.Name)
	}

	if r.RenameWorkspace("unknown", "x") {
		t.Fatalf("RenameWorkspace(unknown, ...) = true, want false")
	}
}

func TestReapIfEmpty(t *testing.T) {
	r := NewRegistry()
	a := r.AddWorkspace("a", "")
	b := r.AddWorkspace("b", "")

	// Give a a pane so it is non-empty.
	pid, _ := r.AllocPaneID(a)
	r.PutPane(a, &Pane{LocalID: pid})

	removed, def := r.ReapIfEmpty(a)
	if removed || def != nil {
		t.Fatalf("ReapIfEmpty(a non-empty) = (%v, %v), want (false, nil)", removed, def)
	}
	if !r.Has(a) {
		t.Fatalf("workspace a removed despite being non-empty")
	}

	// b is empty; reaping it succeeds. Registry is not left empty (a survives).
	removed, def = r.ReapIfEmpty(b)
	if !removed || def != nil {
		t.Fatalf("ReapIfEmpty(b empty) = (%v, %v), want (true, nil)", removed, def)
	}
	if r.Has(b) {
		t.Fatalf("workspace b still present after reap")
	}

	if removed, def := r.ReapIfEmpty("unknown"); removed || def != nil {
		t.Fatalf("ReapIfEmpty(unknown) = (%v, %v), want (false, nil)", removed, def)
	}
}

func TestReapLastWorkspaceRecreatesDefault(t *testing.T) {
	r := NewRegistry()
	only := r.AddWorkspace("only", "")

	removed, def := r.ReapIfEmpty(only)
	if !removed {
		t.Fatalf("ReapIfEmpty(only) removed = false, want true")
	}
	if def == nil {
		t.Fatalf("ReapIfEmpty(only) recreatedDefault = nil, want fresh default")
	}
	if def.Name != "" {
		t.Fatalf("recreatedDefault.Name = %q, want empty (unnamed)", def.Name)
	}
	if r.Has(only) {
		t.Fatalf("workspace only still present after reap")
	}
	if len(r.List()) != 1 {
		t.Fatalf("workspace count = %d, want 1 (default recreated)", len(r.List()))
	}
	if !r.Has(def.ID) {
		t.Fatalf("recreated default %q not in registry", def.ID)
	}
}

func TestCloseWorkspaceReturnsPanes(t *testing.T) {
	r := NewRegistry()
	a := r.AddWorkspace("a", "")
	b := r.AddWorkspace("b", "")

	pid, _ := r.AllocPaneID(a)
	p := &Pane{LocalID: pid}
	r.PutPane(a, p)

	// Closing a while b survives: no recreated default.
	panes, def, ok := r.CloseWorkspace(a)
	if !ok {
		t.Fatalf("CloseWorkspace(a) ok = false, want true")
	}
	if def != nil {
		t.Fatalf("CloseWorkspace(a) recreatedDefault = %v, want nil (b survives)", def)
	}
	if len(panes) != 1 || panes[0] != p {
		t.Fatalf("CloseWorkspace(a) panes = %v, want [p]", panes)
	}
	if r.Has(a) {
		t.Fatalf("workspace a still present after close")
	}
	if !r.Has(b) {
		t.Fatalf("workspace b removed despite surviving close of a")
	}

	if _, _, ok := r.CloseWorkspace("unknown"); ok {
		t.Fatalf("CloseWorkspace(unknown) ok = true, want false")
	}
}
