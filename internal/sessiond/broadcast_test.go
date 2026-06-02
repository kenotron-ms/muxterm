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
