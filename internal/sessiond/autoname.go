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
// one. acceptsRefinedDerivedName treats anything that is not literally
// originDerived as a person's choice, so all of those cases fail in the same
// safe direction.
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

// acceptsRefinedDerivedName decides one deriver write against the name already
// in place, for a surface where one derived name may legitimately be replaced
// by a better derived one. That surface is the pane title, and only the pane
// title: a pane is named from its launch argv the moment it spawns (tier 0,
// autolabel.go) and the session's own declared label refines that guess a
// second or two later (tier 1), so a rule that refused the second write would
// freeze every tab on the argv guess forever.
//
// It answers two questions at once:
//
//   - May the deriver touch this at all? Only an empty name (nobody has
//     claimed it) or a name the deriver itself wrote last time.
//   - Would touching it change anything? If the name already reads exactly
//     what the deriver was going to write, this is a no-op, and saying so is
//     what keeps a once-a-second pass silent. Every caller broadcasts if and
//     only if this returned true, so a steady state costs zero messages.
//
// Workspaces have no tier 0 name and so have nothing to refine; they take the
// stricter acceptsFirstDerivedName below.
func acceptsRefinedDerivedName(current string, origin nameOrigin, next string) bool {
	if next == "" || next == current {
		// Nothing to say, or already said. An empty derived name never
		// clears an existing one: absence means "I have nothing better",
		// not "make it blank".
		return false
	}
	return current == "" || origin == originDerived
}

// acceptsFirstDerivedName is the same decision for a surface whose derived name
// is written at most once and is never replaced by another derived name. That
// surface is the workspace name, and the one clause that differs is that the
// current name must be EMPTY: not empty-or-derived, just empty.
//
// It takes no provenance because it has no use for one. "Empty" is strictly
// stronger than "empty or derived" -- a name a person typed and a name this
// daemon already wrote are both non-empty, and both are declined, for reasons
// applyDerivedNames spells out. Provenance is still recorded on the write,
// because it is what tells a restored snapshot who chose the name that is
// there; it just no longer decides anything for a workspace.
//
// An empty offer still never clears an existing name: absence means "I have
// nothing better", not "make it blank". And because the only name this accepts
// into is an empty one, the second tick carrying the same label finds a
// non-empty name and declines, which is what keeps the once-a-second pass
// silent here too.
func acceptsFirstDerivedName(current, next string) bool {
	return next != "" && current == ""
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
//  2. A second offer of a label that has already been applied changes nothing
//     and says nothing. A pane compares against the exact value about to be
//     written, so re-writing it is a no-op; a workspace writes only into an
//     empty name, so by the next tick there is nothing to write into at all.
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

	// Workspace names. A workspace usually IS one task, so naming it after
	// that task is right -- but it is right exactly once. A workspace's
	// derived name is written when the workspace has no name at all and is
	// never replaced by another derived name; renameWorkspaceDerived enforces
	// that, under the lock that owns the field, by accepting only an empty
	// name (acceptsFirstDerivedName).
	//
	// Write-once rather than re-derive, because the label's whole job is to be
	// a stable thing to aim at. Somebody who remembers a workspace as "auth
	// redirect" and comes back to find it renamed after itself cannot find it;
	// the rename is silent, and the thing they are searching for no longer
	// exists. A slightly stale name costs far less: it still reads as the
	// topic the workspace began as, and one double-click replaces it. Unlike a
	// pane there is nothing lost either way, because a workspace has no
	// spawn-time guess to refine -- the only derived name it can ever have is
	// a session's label, which is itself derived once and never recomputed.
	//
	// The one-session condition below is a condition on the write, not a
	// permanent freeze: while a workspace holds two sessions there is no
	// honest answer to "which one is this workspace about", so nothing is
	// written; but a workspace that was never named while it held two is still
	// nameless when one of them leaves, and naming it then is its FIRST name,
	// not a re-derivation. Naming a nameless workspace destroys nothing, so it
	// stays allowed.
	//
	// What is counted here is sessions that published state, not labelled
	// ones. rows comes straight from the session-state spool (collect in
	// sessionstore.go), so a pane running a bare shell publishes nothing and
	// never appears here at all; but a session whose Label is empty -- because
	// labelling is turned off, the label call failed, or its first prompt has
	// not finished yet -- does appear, and counting it is deliberate rather
	// than an oversight. It is a second piece of work in the workspace
	// whatever it ends up being called, and the workspace is genuinely
	// ambiguous because of it.
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
