package sessiond

import (
	"errors"
	"fmt"
	"sort"
)

// The PROJECT is muxterm's unit of containment.
//
// Every session belongs to exactly one project, always. There is no null case,
// no `project_id IS NULL`, and no orphan is representable -- a session with no
// real project belongs to the INBOX, a fixed reserved container that ships with
// the daemon and cannot be removed.
//
// That is the whole point of the design, and it is what makes the invariant
// cheap. "Unassigned" is a CONTAINER, never a STATE: the absence of an
// assignment record already means Inbox, so there is nothing to migrate, no
// nullable column to defend, and no code path anywhere that has to ask whether
// a session has a parent.
//
// A workspace is NOT a project and is not demoted by this file. Workspaces,
// panes and the machine tree keep working exactly as they did; the project
// layer sits alongside them. A machine is an ATTRIBUTE of a session saying
// where it runs, not a level of containment.
//
// DEFERRED, deliberately, and not present here: project creation, naming,
// renaming, deletion, settings, shared context, per-project folders, and
// cross-machine project identity. See ProjectRegistry for exactly what a
// future project-creation feature has to add.

// ProjectID is a project's identity.
//
// It is a DISTINCT type rather than a bare string on purpose. Every seam that
// carries one -- the wire row, the durable assignment store, the control
// protocol, the MCP projection -- is then checked by the compiler, so a
// workspace id, a session id or a machine name cannot be passed where a project
// is meant. The invariants below hang off this type, which means they travel
// with the value instead of living in a comment somebody has to remember.
type ProjectID string

// InboxProjectID is the reserved, fixed id of the Inbox.
//
// RESERVED means: this exact string is owned by the daemon, is the same on
// every machine and in every installation, and is never handed out to a
// user-created project. It is the value every session resolves to when nothing
// else has claimed it.
const InboxProjectID ProjectID = "inbox"

// InboxProjectName is what the Inbox is called on screen. The container is
// called "Inbox" -- not "Unfiled", not "Uncategorized", not "No project".
// Those name an absence; this names a place.
const InboxProjectName = "Inbox"

// Errors returned when a caller attempts something the Inbox's invariants
// forbid. They are sentinel values so the API boundary can map them to a
// protocol error code without matching on message text.
var (
	// ErrProjectReserved is returned by any mutation that would rename or
	// delete a reserved project. Invariants (b) and (c).
	ErrProjectReserved = errors.New("sessiond: reserved project cannot be renamed or deleted")
	// ErrUnknownProject is returned when a caller names a project that does
	// not exist. Filing a session into a project that is not there must fail
	// loudly rather than silently dropping the session somewhere plausible.
	ErrUnknownProject = errors.New("sessiond: unknown project")
)

// Reserved reports whether this id belongs to a daemon-owned container.
//
// It is COMPUTED FROM THE ID, never stored as a field. A stored flag could be
// set to false on a value that still carries the Inbox's id -- by a decoder
// reading an old file, by a future refactor, by a caller building a struct
// literal -- and the invariant would evaporate exactly where it matters. As a
// method on the id there is no such value: reserved-ness is not data that can
// disagree with itself.
func (p ProjectID) Reserved() bool {
	return p == InboxProjectID
}

// IsZero reports whether the id is the empty string.
//
// Nothing in a published row is ever allowed to be in this state; it exists so
// the normalizer below can recognise unset input coming in from a decoder, an
// older file, or a caller that did not set the field.
func (p ProjectID) IsZero() bool { return p == "" }

// String renders the id for logs and errors.
func (p ProjectID) String() string { return string(p) }

// ResolveProjectID turns ANY input -- empty, unknown, whitespace, a value from
// a file written by an older daemon -- into a project id that exists.
//
// This is the single function that makes a null parent unrepresentable. It is
// total: there is no input for which it fails or returns an empty id, so every
// caller gets a usable container and no caller has to write a fallback. Unknown
// input resolves to the Inbox rather than erroring because this is the READ
// path -- a row whose stored project was removed must still appear somewhere,
// and the Inbox is the place it belongs. The WRITE path (projectAssignments.
// Assign) is strict and rejects an unknown project outright.
func ResolveProjectID(raw string, known func(ProjectID) bool) ProjectID {
	id := ProjectID(raw)
	if id.IsZero() {
		return InboxProjectID
	}
	if known != nil && !known(id) {
		return InboxProjectID
	}
	return id
}

// Project is one container, as published to a client.
//
// It is a SLOT, not an entity. The Inbox in particular has no settings, no
// shared context, no folder on disk and no lifecycle -- invariant (e). Nothing
// here carries any of those, and a future project that does acquire them must
// add them without making the Inbox carry them too.
type Project struct {
	// ID is the project's identity. For the Inbox this is InboxProjectID on
	// every machine and in every installation.
	ID ProjectID `json:"id"`
	// Name is the display name. "Inbox" for the Inbox, always, because a
	// reserved project cannot be renamed.
	Name string `json:"name"`
	// Reserved is the daemon telling a client that this container cannot be
	// renamed or deleted, so a UI can decline to offer either rather than
	// offering an action that is going to be refused. It is derived from ID
	// at marshal time by ProjectRegistry, never stored.
	Reserved bool `json:"reserved"`
}

// ProjectRegistry holds every project this daemon knows about.
//
// In this slice it holds EXACTLY ONE, the Inbox, and there is deliberately no
// Create method -- project creation is out of scope. What matters is that the
// shape is already plural: a map keyed by id, an All() that sorts reserved
// containers first, a known() predicate, and mutations that check
// ProjectID.Reserved() rather than comparing against the Inbox by hand.
//
// WHAT A FUTURE PROJECT-CREATION FEATURE HAS TO ADD, and nothing more:
//
//   - A Create(name) method here, minting a non-reserved id and calling
//     persist. (This registry is in-memory only today because its one member
//     is a constant; a created project needs a durable file, which follows
//     triggerStore's pattern exactly.)
//   - Rename and Delete already exist below and already refuse reserved ids,
//     so they need no change.
//   - A protocol verb pair for create/rename/delete, alongside the
//     assign-session and list-projects verbs that already exist.
//   - Delete must re-file its sessions, which is one call to
//     projectAssignments.ReassignAll(from, InboxProjectID).
//
// It does NOT have to touch SessionState, the session schema, the spool, the
// assignment store's schema, the stamping seam, or the sidebar's row
// rendering. Moving a session to a real project is CHANGING A PARENT -- one
// value in one map -- not a schema migration. That is the whole reason
// project_id is non-null from the first commit.
type ProjectRegistry struct {
	projects map[ProjectID]Project
}

// NewProjectRegistry returns the registry every daemon starts with: the Inbox,
// and nothing else.
//
// The Inbox is CONSTRUCTED HERE rather than loaded from disk, and that is
// invariant (a) and (b) working together. There is no file to delete, corrupt,
// or forget to write, so there is no sequence of events -- a wiped data dir, a
// failed write, a first run, a restore from an old backup -- after which a
// daemon comes up without an Inbox. A session always has somewhere to be.
func NewProjectRegistry() *ProjectRegistry {
	return &ProjectRegistry{
		projects: map[ProjectID]Project{
			InboxProjectID: {ID: InboxProjectID, Name: InboxProjectName},
		},
	}
}

// Known reports whether id names a project that exists. Passed to
// ResolveProjectID as the read-path predicate.
func (r *ProjectRegistry) Known(id ProjectID) bool {
	_, ok := r.projects[id]
	return ok
}

// All returns every project, reserved containers first and then by name.
//
// Reserved-first is the ordering the destination list and the sidebar both
// use, so the Inbox keeps its place at the top once real projects exist rather
// than sorting itself into the middle of them alphabetically.
//
// Reserved is derived from the id on the way out. A client therefore cannot
// receive a project whose reserved flag disagrees with its id.
func (r *ProjectRegistry) All() []Project {
	out := make([]Project, 0, len(r.projects))
	for _, p := range r.projects {
		p.Reserved = p.ID.Reserved()
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Reserved != out[j].Reserved {
			return out[i].Reserved
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// Get returns one project by id.
func (r *ProjectRegistry) Get(id ProjectID) (Project, bool) {
	p, ok := r.projects[id]
	if !ok {
		return Project{}, false
	}
	p.Reserved = p.ID.Reserved()
	return p, true
}

// Rename changes a project's display name.
//
// Invariant (c): the Inbox CANNOT BE RENAMED, and this is where that is
// enforced rather than in a comment. The check is ProjectID.Reserved(), so it
// will keep holding for any future reserved container without this function
// being revisited.
//
// There is no caller in this slice -- project renaming is deferred. It exists
// now so the refusal is real and can be executed and captured, and so a future
// rename feature inherits the invariant instead of having to remember it.
func (r *ProjectRegistry) Rename(id ProjectID, name string) error {
	if id.Reserved() {
		return fmt.Errorf("%w: %q cannot be renamed", ErrProjectReserved, id)
	}
	p, ok := r.projects[id]
	if !ok {
		return fmt.Errorf("%w: %q", ErrUnknownProject, id)
	}
	p.Name = name
	r.projects[id] = p
	return nil
}

// Delete removes a project.
//
// Invariant (b): the Inbox CANNOT BE DELETED. Same enforcement as Rename, same
// reason, and the same reason it exists with no caller yet.
//
// Invariant (d) is the other half of this: the Inbox is the SOLE home for
// sessions that belong to no real project, so deleting any other project must
// re-file its sessions into the Inbox rather than leaving them pointing at
// something that is gone. A deleted project's sessions resolve back to the
// Inbox anyway via ResolveProjectID's unknown-id branch, so the invariant holds
// even if a future caller forgets the explicit re-file.
func (r *ProjectRegistry) Delete(id ProjectID) error {
	if id.Reserved() {
		return fmt.Errorf("%w: %q cannot be deleted", ErrProjectReserved, id)
	}
	if _, ok := r.projects[id]; !ok {
		return fmt.Errorf("%w: %q", ErrUnknownProject, id)
	}
	delete(r.projects, id)
	return nil
}
