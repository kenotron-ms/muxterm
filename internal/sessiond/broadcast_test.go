package sessiond

import (
	"testing"
	"time"
)

func TestBroadcastAllExistsAndIsSafeWithNoSubs(t *testing.T) {
	srv, err := NewServer(t.TempDir() + "/sessiond.sock")
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	// With no subscribers, broadcastAll must be a safe no-op (no panic).
	srv.broadcastAll(&Message{Type: TypeWorkspaceList})
}

// TestServerBroadcastsWorkspaceListOnCreate verifies that creating a workspace
// from one connection pushes an updated workspace list to every other attached
// connection live, with no reconnect (the "doesn't appear in dropdown until
// reload" bug).
func TestServerBroadcastsWorkspaceListOnCreate(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	// Observer: list workspaces, then attach to the cold-start default.
	observer := dialMust(t, socketPath)
	writeControlMust(t, observer, &Message{Type: TypeListWorkspaces, CID: 1})
	list := readControlUntil(t, observer, TypeWorkspaceList)
	if len(list.Workspaces) != 1 {
		t.Fatalf("cold-start workspace count = %d, want 1", len(list.Workspaces))
	}
	defaultID := list.Workspaces[0].WorkspaceID

	writeControlMust(t, observer, &Message{Type: TypeAttach, WorkspaceID: defaultID, CID: 2})
	readControlUntil(t, observer, TypeComposition)

	// Creator: a separate connection creates a new workspace.
	creator := dialMust(t, socketPath)
	writeControlMust(t, creator, &Message{Type: TypeCreateWorkspace, Name: "made-by-creator", CID: 3})
	readControlUntil(t, creator, TypeWorkspaceCreated)

	// The observer must receive an updated workspace list live, without
	// reconnecting.
	evt := readControlUntil(t, observer, TypeWorkspaceList)
	if len(evt.Workspaces) != 2 {
		t.Fatalf("broadcast workspace count = %d, want 2", len(evt.Workspaces))
	}
}

// TestBroadcastAllReachesUnattachedConnections verifies that broadcastAll
// reaches connections that have never attached to any workspace, not just
// those in the workspace subscriber sets.
func TestBroadcastAllReachesUnattachedConnections(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	// Client A: list workspaces then attach to the cold-start default.
	a := dialMust(t, socketPath)
	writeControlMust(t, a, &Message{Type: TypeListWorkspaces, CID: 1})
	list := readControlUntil(t, a, TypeWorkspaceList)
	defaultID := list.Workspaces[0].WorkspaceID
	writeControlMust(t, a, &Message{Type: TypeAttach, WorkspaceID: defaultID, CID: 2})
	readControlUntil(t, a, TypeComposition)

	// Client B: connects but never attaches to any workspace.
	b := dialMust(t, socketPath)

	// Creator: creates a new workspace, which triggers broadcastAll.
	creator := dialMust(t, socketPath)
	writeControlMust(t, creator, &Message{Type: TypeCreateWorkspace, Name: "new-ws", CID: 3})
	readControlUntil(t, creator, TypeWorkspaceCreated)

	// Both A (attached) and B (unattached) must receive an updated workspace
	// list with 2 workspaces.
	evtA := readControlUntil(t, a, TypeWorkspaceList)
	if len(evtA.Workspaces) != 2 {
		t.Fatalf("A broadcast workspace count = %d, want 2", len(evtA.Workspaces))
	}
	evtB := readControlUntil(t, b, TypeWorkspaceList)
	if len(evtB.Workspaces) != 2 {
		t.Fatalf("B broadcast workspace count = %d, want 2", len(evtB.Workspaces))
	}
}

// TestRenameWorkspaceBroadcastsListToCrossWorkspaceClient verifies that
// renaming a workspace triggers a broadcastAll(workspace-list) so clients
// attached to OTHER workspaces also receive the updated list immediately.
func TestRenameWorkspaceBroadcastsListToCrossWorkspaceClient(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	// Client A: create ws1 and attach to it.
	a := newTClient(t, socketPath)
	a.send(&Message{Type: TypeCreateWorkspace, CID: 1, Name: "ws1"})
	ws1ID := a.waitCtrl(TypeWorkspaceCreated).WorkspaceID
	a.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: ws1ID})
	a.waitCtrl(TypeComposition)

	// Client B: create ws2 and attach to it (a different workspace than A).
	b := newTClient(t, socketPath)
	b.send(&Message{Type: TypeCreateWorkspace, CID: 3, Name: "ws2"})
	ws2ID := b.waitCtrl(TypeWorkspaceCreated).WorkspaceID
	b.send(&Message{Type: TypeAttach, CID: 4, WorkspaceID: ws2ID})
	b.waitCtrl(TypeComposition)

	// A renames ws1; this must trigger broadcastAll(workspace-list).
	a.send(&Message{Type: TypeRenameWorkspace, CID: 5, WorkspaceID: ws1ID, Name: "ws1-renamed"})

	// B must receive a TypeWorkspaceList where the ws1 entry has Name=="ws1-renamed".
	// Drain any earlier (non-matching) TypeWorkspaceList messages with a deadline.
	deadline := time.After(5 * time.Second)
	for {
		select {
		case msg, ok := <-b.ctrl:
			if !ok {
				t.Fatal("connection closed while waiting for workspace-list with renamed ws1")
			}
			if msg.Type != TypeWorkspaceList {
				continue
			}
			for _, ws := range msg.Workspaces {
				if ws.WorkspaceID == ws1ID && ws.Name == "ws1-renamed" {
					return // success: B sees the renamed workspace
				}
			}
		case <-deadline:
			t.Fatal("timeout: B did not receive workspace-list with ws1 renamed to \"ws1-renamed\"")
		}
	}
}
