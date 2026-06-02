package sessiond

import "testing"

func TestAddWorkspaceCarriesClientRefIntoList(t *testing.T) {
	r := NewRegistry()
	id := r.AddWorkspace("dev", "tmp-xyz")

	for _, info := range r.List() {
		if info.WorkspaceID == id {
			if info.ClientRef != "tmp-xyz" {
				t.Fatalf("ClientRef = %q, want %q", info.ClientRef, "tmp-xyz")
			}
			return
		}
	}
	t.Fatalf("workspace %q not found in List()", id)
}

func TestAddWorkspaceEmptyClientRef(t *testing.T) {
	r := NewRegistry()
	id := r.AddWorkspace("", "")

	for _, info := range r.List() {
		if info.WorkspaceID == id {
			if info.ClientRef != "" {
				t.Fatalf("ClientRef = %q, want empty", info.ClientRef)
			}
			return
		}
	}
	t.Fatalf("workspace %q not found in List()", id)
}
