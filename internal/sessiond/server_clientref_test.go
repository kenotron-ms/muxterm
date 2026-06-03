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

// TestCreatePaneEchoesClientRefOnPaneAdded verifies that the create-pane handler
// stamps the request's client-minted ref onto the authoritative pane-added
// broadcast while still carrying a real server-assigned PaneID.
func TestCreatePaneEchoesClientRefOnPaneAdded(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	c := newTClient(t, socketPath)
	c.send(&Message{Type: TypeCreateWorkspace, CID: 1, Name: "dev"})
	created := c.waitCtrl(TypeWorkspaceCreated)

	c.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: created.WorkspaceID})
	c.waitCtrl(TypeComposition)

	c.send(&Message{Type: TypeCreatePane, CID: 3, ClientRef: "tmp-pane-1"})
	added := c.waitCtrl(TypePaneAdded)

	if added.ClientRef != "tmp-pane-1" {
		t.Fatalf("added.ClientRef = %q, want %q", added.ClientRef, "tmp-pane-1")
	}
	if added.PaneID == 0 {
		t.Fatalf("added.PaneID = %d, want a real positive server-assigned id", added.PaneID)
	}
}
