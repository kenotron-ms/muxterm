package sessiond

import "testing"

// TestCreateWorkspaceEchoesClientRefInList verifies that the create-workspace
// handler threads the client-minted correlation ref into both the
// workspace-created reply and the authoritative List() snapshot.
func TestCreateWorkspaceEchoesClientRefInList(t *testing.T) {
	srv, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	c := newTClient(t, socketPath)
	c.send(&Message{Type: TypeCreateWorkspace, CID: 1, Name: "dev", ClientRef: "tmp-ws-1"})

	created := c.waitCtrl(TypeWorkspaceCreated)
	if created.ClientRef != "tmp-ws-1" {
		t.Fatalf("created.ClientRef = %q, want %q", created.ClientRef, "tmp-ws-1")
	}

	var found bool
	for _, info := range srv.Registry().List() {
		if info.WorkspaceID == created.WorkspaceID {
			found = true
			if info.ClientRef != "tmp-ws-1" {
				t.Fatalf("List() entry ClientRef = %q, want %q", info.ClientRef, "tmp-ws-1")
			}
		}
	}
	if !found {
		t.Fatalf("new workspace %q not present in List()", created.WorkspaceID)
	}
}
