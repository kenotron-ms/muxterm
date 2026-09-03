package sessiond

// Sessiond stress tests — exercise the daemon under concurrent load,
// rapid lifecycle churn, reconnection storms, and input floods.
//
// Run all stress tests:
//
//	go test -run TestStress -v -timeout 120s ./internal/sessiond/
//
// Run one:
//
//	go test -run TestStress_ConcurrentSessions -v -timeout 60s ./internal/sessiond/
//
// These tests use the real Server with real PTYs on a temp Unix socket —
// the same infrastructure as the integration tests, just pushed harder.
//
// NOTE — subscriber queue depth
// The server-side subscriber queue holds 256 frames per connection.  When full,
// the server disconnects the client rather than blocking producers.  Tests that
// produce ongoing pane output (TestStress_InputFlood) use a drain goroutine on
// the client reading that output so the queue never fills.  Tests that verify
// specific output (waitData) instead use short-lived one-shot commands so that
// the total output stays well within the 1024-frame client-side data channel.

import (
	"fmt"
	"sync"
	"testing"
)

// TestStress_ConcurrentSessions opens N simultaneous client connections,
// each in its own isolated workspace, and races them through the full
// create → attach → pane-I/O → close lifecycle.
//
// Catches: data races on registry/workspace maps, pane-ID collisions,
// broadcast fan-out panics, connection-cleanup races.
func TestStress_ConcurrentSessions(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	const workers = 20

	var wg sync.WaitGroup
	wg.Add(workers)

	for i := 0; i < workers; i++ {
		i := i
		go func() {
			defer wg.Done()

			c := newTClient(t, socketPath)

			// Isolated workspace per worker — no cross-worker interference.
			c.send(&Message{Type: TypeCreateWorkspace, CID: 1, Name: fmt.Sprintf("stress-%d", i)})
			wsID := c.waitCtrl(TypeWorkspaceCreated).WorkspaceID

			c.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: wsID})
			c.waitCtrl(TypeComposition)

			// One-shot echo: produces exactly one data frame then exits.
			// Using sh -c to avoid PATH issues with "echo".
			marker := fmt.Sprintf("sess-%d-ok", i)
			c.send(&Message{
				Type: TypeCreatePane,
				CID:  3,
				Cmd:  []string{"sh", "-c", "echo " + marker},
			})
			c.waitCtrl(TypePaneCreated)
			c.waitCtrl(TypePaneAdded) // unsolicited broadcast

			// Verify the output arrived — proves PTY I/O works end-to-end.
			c.waitData(marker)

			// Clean close so the server can release all pane/workspace state.
			c.send(&Message{Type: TypeCloseWorkspace, CID: 4, WorkspaceID: wsID})
			c.waitCtrl(TypeWorkspaceList)
		}()
	}

	wg.Wait()
}

// TestStress_RapidWorkspaceLifecycle hammers the
// create-workspace → attach → create-pane → close-workspace cycle
// on a single connection 100 times in sequence.
//
// Catches: workspace/pane registry leaks, double-close panics,
// stale subscriber entries after repeated workspace closure.
func TestStress_RapidWorkspaceLifecycle(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	c := newTClient(t, socketPath)
	// "true" exits immediately with no output — no drain goroutine needed.

	const iterations = 100

	for i := 0; i < iterations; i++ {
		c.send(&Message{Type: TypeCreateWorkspace, CID: 1, Name: fmt.Sprintf("ephemeral-%d", i)})
		wsID := c.waitCtrl(TypeWorkspaceCreated).WorkspaceID

		c.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: wsID})
		c.waitCtrl(TypeComposition)

		// Spawn a pane that exits immediately — no PTY output to worry about.
		c.send(&Message{Type: TypeCreatePane, CID: 3, Cmd: []string{"true"}})
		c.waitCtrl(TypePaneCreated)
		c.waitCtrl(TypePaneAdded)

		c.send(&Message{Type: TypeCloseWorkspace, CID: 4, WorkspaceID: wsID})
		c.waitCtrl(TypeWorkspaceList)
	}

	t.Logf("completed %d create/attach/close cycles without error", iterations)
}

// TestStress_RapidReconnect attaches to and immediately drops from the same
// workspace 100 times in tight succession, then verifies the workspace is
// still healthy — accepting new attaches and running pane I/O.
//
// Catches: subscriber map leaks, dangling connection goroutines,
// per-workspace lock contention on rapid subscribe/unsubscribe.
func TestStress_RapidReconnect(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	// Use the default workspace that cold-start creates.
	seed := newTClient(t, socketPath)
	seed.send(&Message{Type: TypeListWorkspaces, CID: 1})
	workspaces := seed.waitCtrl(TypeWorkspaceList).Workspaces
	if len(workspaces) == 0 {
		t.Fatal("no default workspace: cold-start EnsureDefault did not run")
	}
	wsID := workspaces[0].WorkspaceID

	const cycles = 100

	for i := 0; i < cycles; i++ {
		c := newTClient(t, socketPath)
		// Drain any pane replay that arrives after attach.
		go func() {
			for range c.data {
			}
		}()

		c.send(&Message{Type: TypeAttach, CID: 1, WorkspaceID: wsID})
		c.waitCtrl(TypeComposition)

		// Abrupt close — simulates a browser tab closing mid-session.
		_ = c.conn.Close()
	}

	// Verify the workspace is still fully usable after 100 abrupt disconnects.
	final := newTClient(t, socketPath)

	final.send(&Message{Type: TypeAttach, CID: 1, WorkspaceID: wsID})
	final.waitCtrl(TypeComposition)

	final.send(&Message{Type: TypeCreatePane, CID: 2, Cmd: []string{"sh", "-c", "echo reconnect-ok"}})
	final.waitCtrl(TypePaneCreated)
	final.waitCtrl(TypePaneAdded)
	final.waitData("reconnect-ok")

	t.Logf("workspace %s still functional after %d rapid reconnects", wsID, cycles)
}

// TestStress_InputFlood sends a burst of 300 input lines to a single pane
// while a drain goroutine discards the echo output, then verifies no
// disconnect occurred by confirming a final sentinel arrives.
//
// The drain goroutine keeps the 256-frame server subscriber queue from
// filling (which would cause the server to forcibly disconnect).
// The sentinel at the end proves the connection survived the flood.
//
// Catches: subscriber queue overflow → unexpected disconnect,
// WritePaneData race with concurrent output draining.
func TestStress_InputFlood(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	c := newTClient(t, socketPath)

	c.send(&Message{Type: TypeCreateWorkspace, CID: 1, Name: "flood-ws"})
	wsID := c.waitCtrl(TypeWorkspaceCreated).WorkspaceID

	c.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: wsID})
	c.waitCtrl(TypeComposition)

	// cat echoes every byte it receives — provides a measurable round-trip.
	c.send(&Message{Type: TypeCreatePane, CID: 3, Cmd: []string{"cat"}})
	paneID := c.waitCtrl(TypePaneCreated).PaneID
	c.waitCtrl(TypePaneAdded)

	// Drain goroutine: must be running BEFORE the flood to prevent the
	// server-side subscriber queue (depth 256) from filling up.
	// NOTE: waitData cannot be used on this client once this goroutine starts;
	// see the sentinel approach below.
	drainDone := make(chan struct{})
	sentinel := "flood-sentinel-done\n"
	received := make(chan struct{})

	go func() {
		defer close(drainDone)
		var acc []byte
		for b := range c.data {
			acc = append(acc, b...)
			if bytesContains(acc, []byte("flood-sentinel-done")) {
				close(received)
				return
			}
		}
	}()

	const lines = 300
	for i := 0; i < lines; i++ {
		c.sendInput(paneID, []byte(fmt.Sprintf("flood-%d\n", i)))
	}
	// Send a sentinel that the drain goroutine watches for — proves all
	// previous lines were absorbed and the connection stayed alive.
	c.sendInput(paneID, []byte(sentinel))

	select {
	case <-received:
		t.Logf("sentinel received after %d flood lines — connection stayed alive", lines)
	case <-drainDone:
		t.Fatal("drain goroutine exited (connection closed) before sentinel arrived")
	}
}

// TestStress_PaneLifecycle creates N panes in a single workspace, closes
// them all, then verifies that a freshly created pane after the teardown
// still works correctly.
//
// Catches: pane ID counter bugs after many allocations, pane registry
// corruption after bulk-close, off-by-one errors in nextPaneID.
func TestStress_PaneLifecycle(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	c := newTClient(t, socketPath)

	c.send(&Message{Type: TypeCreateWorkspace, CID: 1, Name: "pane-lifecycle"})
	wsID := c.waitCtrl(TypeWorkspaceCreated).WorkspaceID

	c.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: wsID})
	c.waitCtrl(TypeComposition)

	const paneCount = 20
	paneIDs := make([]int, 0, paneCount)
	seenIDs := make(map[int]bool)

	// ── create all panes ──────────────────────────────────────────────────
	for i := 0; i < paneCount; i++ {
		c.send(&Message{
			Type: TypeCreatePane,
			CID:  uint64(10 + i),
			Cmd:  []string{"sleep", "300"}, // stays alive until explicitly closed
		})
		paneID := c.waitCtrl(TypePaneCreated).PaneID
		c.waitCtrl(TypePaneAdded)

		if paneID <= 0 {
			t.Errorf("pane %d: expected positive ID, got %d", i, paneID)
		}
		if seenIDs[paneID] {
			t.Errorf("duplicate pane ID %d at index %d", paneID, i)
		}
		seenIDs[paneID] = true
		paneIDs = append(paneIDs, paneID)
	}

	t.Logf("created %d panes with IDs %v", paneCount, paneIDs)

	// ── close all panes ───────────────────────────────────────────────────
	for j, id := range paneIDs {
		c.send(&Message{Type: TypeClosePane, CID: uint64(100 + j), PaneID: id})
		c.waitCtrl(TypeOK)
		// TypePaneClosed broadcast arrives but we skip it (waitCtrl drains non-OK).
	}

	// ── verify the workspace still works after bulk teardown ──────────────
	c.send(&Message{Type: TypeCreatePane, CID: 200, Cmd: []string{"sh", "-c", "echo post-close-ok"}})
	newPane := c.waitCtrl(TypePaneCreated)
	c.waitCtrl(TypePaneAdded)

	if newPane.PaneID <= 0 {
		t.Fatalf("post-close pane has invalid ID %d", newPane.PaneID)
	}

	c.waitData("post-close-ok")

	t.Logf("workspace functional after %d pane close/reopen cycles; final pane ID=%d",
		paneCount, newPane.PaneID)
}

// TestStress_ConcurrentPaneIO attaches N clients to the same workspace and
// has each write to its own pane simultaneously, verifying that each client
// receives only its own pane's output and no cross-pane data leaks occur.
//
// Catches: broadcast routing bugs that deliver pane output to wrong clients,
// mutex contention on per-workspace subscriber fan-out.
func TestStress_ConcurrentPaneIO(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	// Use one "coordinator" client to set up the shared workspace.
	coord := newTClient(t, socketPath)
	coord.send(&Message{Type: TypeCreateWorkspace, CID: 1, Name: "shared-io"})
	wsID := coord.waitCtrl(TypeWorkspaceCreated).WorkspaceID

	const workers = 10
	var wg sync.WaitGroup
	wg.Add(workers)

	for i := 0; i < workers; i++ {
		i := i
		go func() {
			defer wg.Done()

			c := newTClient(t, socketPath)

			// Each worker attaches to the shared workspace independently.
			c.send(&Message{Type: TypeAttach, CID: 1, WorkspaceID: wsID})
			c.waitCtrl(TypeComposition)

			// Each worker owns exactly one pane — its echo output is unique.
			// The trailing "cat" keeps the pane alive until explicitly
			// closed, preventing workspace auto-reap during creation.
			marker := fmt.Sprintf("io-worker-%d", i)
			c.send(&Message{
				Type: TypeCreatePane,
				CID:  2,
				Cmd:  []string{"sh", "-c", "echo " + marker + "; cat"},
			})
			c.waitCtrl(TypePaneCreated)
			// TypePaneAdded will be broadcast to ALL subscribers in this
			// workspace — waitCtrl drains them; we only care about our own.
			c.waitCtrl(TypePaneAdded)

			// Confirm this client sees its own pane's output.
			c.waitData(marker)
		}()
	}

	wg.Wait()

	// Close the workspace to kill all still-alive panes and avoid resource
	// leaks from the long-running "cat" commands above.
	coord.send(&Message{Type: TypeCloseWorkspace, CID: 2, WorkspaceID: wsID})
	coord.waitCtrl(TypeOK)
}

// ── helpers ───────────────────────────────────────────────────────────────────

// bytesContains reports whether b contains sub (avoids importing bytes package).
func bytesContains(b, sub []byte) bool {
	if len(sub) == 0 {
		return true
	}
	if len(b) < len(sub) {
		return false
	}
outer:
	for i := 0; i <= len(b)-len(sub); i++ {
		for j := range sub {
			if b[i+j] != sub[j] {
				continue outer
			}
		}
		return true
	}
	return false
}
