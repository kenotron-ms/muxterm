package sessiond

// Naming panes and workspaces from what the sessions inside them say about
// themselves.
//
// Two halves live in this file, and the first exists to keep the second
// honest. A display name is either something a person asked for or something
// this daemon guessed, and those two must never be confused, because the
// fan-out below runs once a second: without a provenance marker, somebody who
// double-clicks a tab and types a name watches the deriver overwrite it a
// second later, and again a second after that, and there is no way for them to
// win. With one, a rename is final and the deriver never asks again.
//
// The label itself is produced elsewhere and merely distributed here. Tier 0 is
// derived in Go from the pane's launch argv at spawn (autolabel.go); tier 1 is
// declared by the session's own harness hook on the session-state wire
// (SessionState.Label) and refines tier 0 exactly once. Neither is recomputed
// afterwards -- a tab whose name keeps moving is a tab you cannot find twice.
// See docs/designs/2026-09-05-auto-naming-from-session-design.md.

// nameOrigin records WHO chose a display name.
//
// The zero value is deliberately neither constant, and everything that can
// produce a name without stating a provenance lands on it: a struct literal
// written before this field existed, a snapshot from a daemon that never wrote
// one. acceptsDerivedName treats anything that is not literally originDerived
// as a person's choice, so all of those cases fail in the same safe direction.
//
// That direction is the whole point. Declining to re-derive a name that really
// was derived leaves a slightly stale but perfectly usable tab, and the user
// can rename it in one double-click. Overwriting a name a person typed
// destroys a decision nobody can recover, and does it every second until they
// give up.
type nameOrigin string

const (
	// originDerived marks a name this daemon produced on the user's behalf:
	// the spawn-time label from a pane's argv, or a session's declared Label
	// arriving later. Only these may ever be written over.
	originDerived nameOrigin = "derived"

	// originExplicit marks a name that was asked for through a public rename
	// verb -- the browser's dblclick, `muxterm pane rename`, or MCP
	// rename_pane. An agent driving MCP is being exactly as deliberate as a
	// human at a keyboard, so it counts the same and gets the same protection.
	originExplicit nameOrigin = "explicit"
)

// acceptsDerivedName decides one deriver write against the name already in
// place. It is the single rule behind both the pane title and the workspace
// name, and it answers two questions at once:
//
//   - May the deriver touch this at all? Only an empty name (nobody has
//     claimed it) or a name the deriver itself wrote last time.
//   - Would touching it change anything? If the name already reads exactly
//     what the deriver was going to write, this is a no-op, and saying so is
//     what keeps a once-a-second pass silent. Every caller broadcasts if and
//     only if this returned true, so a steady state costs zero messages.
func acceptsDerivedName(current string, origin nameOrigin, next string) bool {
	if next == "" || next == current {
		// Nothing to say, or already said. An empty derived name never
		// clears an existing one: absence means "I have nothing better",
		// not "make it blank".
		return false
	}
	return current == "" || origin == originDerived
}

// nameOriginFromSnapshot reads a provenance marker back off disk.
//
// Only the literal "derived" restores as derived. A snapshot written before
// this field existed carries "" and comes back explicit, which is both the
// safe guess and very likely the true one: until this increment, the only
// thing that could set a pane title or a workspace name at all was a rename
// verb, so a name in an old snapshot is a name somebody typed. Guessing the
// other way would let a crash-recovery restart silently hand a person's
// deliberate rename back to the deriver.
func nameOriginFromSnapshot(recorded string) nameOrigin {
	if nameOrigin(recorded) == originDerived {
		return originDerived
	}
	return originExplicit
}

// applyDerivedNames puts each session's declared label onto the pane it runs in
// and, when the workspace is that one session, onto the workspace too.
//
// It is called once per session-state tick with the rows that tick collected,
// which is the join already done: collect resolved every session to its
// (workspaceID, paneID) via the owners map, so nothing here has to look
// anything up. No lock is held on entry, and none is held across a broadcast --
// the registry setters take and release their own, then the broadcast takes
// Server.mu, preserving the established Server -> Registry order.
//
// Idempotence is the property that matters most, because this runs every
// second and a workspace rename re-broadcasts the whole workspace list to every
// connected client. Three things together guarantee a silent steady state:
//
//  1. Both setters are compare-and-set under the lock that owns the field and
//     report whether they actually changed it; a broadcast happens only on a
//     true return.
//  2. The comparison is against the exact value about to be written, so the
//     second tick carrying a label that has already been applied changes
//     nothing and says nothing.
//  3. The row that names a pane is chosen deterministically. Rows arrive in a
//     stable order (collect sorts by workspace, pane, session id), and only the
//     first labelled row per pane is allowed to write -- so in the odd case of
//     two labelled sessions sharing one pane, the same one wins on every tick
//     instead of the two taking turns renaming it forever.
func (s *Server) applyDerivedNames(rows []SessionState) {
	// Pane titles. A pane belongs to the session running in it, so every
	// labelled row gets to name its own pane.
	named := make(map[paneRef]bool, len(rows))
	for _, r := range rows {
		if r.Label == "" {
			continue
		}
		ref := paneRef{workspaceID: r.WorkspaceID, paneID: r.PaneID}
		if named[ref] {
			continue // an earlier row already spoke for this pane; see (3) above
		}
		named[ref] = true
		if s.reg.renamePaneDerived(ref.workspaceID, ref.paneID, r.Label) {
			// The same event the public rename verb emits, and the same one
			// the browser already repaints tabs from.
			s.broadcast(ref.workspaceID, &Message{Type: TypePaneRenamed, PaneID: ref.paneID, Name: r.Label})
		}
	}

	// Workspace names, and only for a workspace that holds exactly one
	// session. A workspace usually IS one task, so naming it after that task
	// is right; the moment it holds a second, there is no honest answer to
	// "which one is this workspace about" and the correct move is to stop
	// touching it permanently. It keeps the name it started with, which still
	// reads as the topic it began as. No voting, no re-derivation, and no
	// workspace renaming itself out from under somebody who is using it.
	sessions := make(map[string]int, len(rows))
	for _, r := range rows {
		sessions[r.WorkspaceID]++
	}
	renamed := false
	for _, r := range rows {
		if r.Label == "" || sessions[r.WorkspaceID] != 1 {
			continue
		}
		if s.reg.renameWorkspaceDerived(r.WorkspaceID, r.Label) {
			renamed = true
		}
	}
	if renamed {
		// One list broadcast for the whole tick, however many workspaces were
		// named in it: the list is a whole-state document, so sending it twice
		// tells nobody anything the first one did not.
		s.broadcastWorkspaceList()
	}
}
