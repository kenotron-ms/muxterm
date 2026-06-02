package sessiond

import "testing"

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
