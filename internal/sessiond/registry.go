package sessiond

import (
	"fmt"
	"sort"
	"sync"
)

// Workspace is one daemon-managed workspace. Its panes use workspace-local ids
// allocated by the Registry, independent of any other workspace.
type Workspace struct {
	ID         string            // daemon-allocated, e.g. "w1"
	Name       string            // optional label; "" means unnamed
	ClientRef  string            // client-minted optimistic-create correlation id; "" when none
	Panes      map[int]*Pane     // keyed by workspace-local pane id
	Layouts    map[string]string // breakpoint label -> opaque dockview layout JSON
	nextPaneID int

	// nameOrigin says whether Name was chosen by a person or derived by the
	// daemon. Guarded by Registry.mu like every other field here, and read
	// only through the setters in workspace.go. See autoname.go.
	nameOrigin nameOrigin

	// generation identifies this workspace instance even if an id were ever
	// reused. membershipGeneration advances on every pane-map mutation. Both are
	// daemon-owned close-ticket bindings and never cross the wire.
	generation           uint64
	membershipGeneration uint64
}

// Registry is the single source of truth for workspaces and their panes. All
// access is serialized by mu so concurrent control connections see a consistent
// view.
type Registry struct {
	mu                      sync.Mutex
	workspaces              map[string]*Workspace
	nextWSID                int
	nextWorkspaceGeneration uint64
	nextPaneGeneration      uint64

	// Active and retired close tickets are protected by the same mutex as the
	// registry so target assessment, ticket validation, and registry mutation
	// form one serialized transaction. Each value binds even a large workspace
	// through a fixed-size digest rather than retaining its complete pane snapshot.
	// Retired tickets preserve reassessment-only bindings through a short,
	// independently bounded grace period.
	closeTickets        map[string]closeTicket
	retiredCloseTickets map[string]retiredCloseTicket
	closeTicketSequence uint64
}

// NewRegistry returns an empty Registry ready for use.
func NewRegistry() *Registry {
	return &Registry{
		workspaces:          make(map[string]*Workspace),
		closeTickets:        make(map[string]closeTicket),
		retiredCloseTickets: make(map[string]retiredCloseTicket),
	}
}

// addWorkspaceLocked allocates a new workspace id, inserts the workspace, and
// returns its id. The caller must hold r.mu. It is shared by AddWorkspace and
// the lifecycle helpers in workspace.go.
//
// A name supplied at creation is explicit: the only caller that passes a
// non-empty one is a client acting on somebody's create-workspace request, and
// the cold-start/reap defaults pass "" -- which the deriver may fill in later
// precisely because it is empty, whatever its provenance says.
func (r *Registry) addWorkspaceLocked(name, clientRef string) string {
	r.nextWSID++
	r.nextWorkspaceGeneration++
	id := fmt.Sprintf("w%d", r.nextWSID)
	r.workspaces[id] = &Workspace{
		ID:         id,
		Name:       name,
		nameOrigin: originExplicit,
		ClientRef:  clientRef,
		Panes:      make(map[int]*Pane),
		Layouts:    make(map[string]string),
		generation: r.nextWorkspaceGeneration,
	}
	return id
}

// AddWorkspace creates a new workspace with the given name and returns its
// daemon-allocated id.
func (r *Registry) AddWorkspace(name, clientRef string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.addWorkspaceLocked(name, clientRef)
}

// Get returns the workspace for id and whether it exists.
func (r *Registry) Get(id string) (*Workspace, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[id]
	return ws, ok
}

// Has reports whether a workspace with id exists.
func (r *Registry) Has(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.workspaces[id]
	return ok
}

// List returns a deterministic snapshot of all workspaces, sorted by
// WorkspaceID.
func (r *Registry) List() []WorkspaceInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]WorkspaceInfo, 0, len(r.workspaces))
	for _, ws := range r.workspaces {
		out = append(out, WorkspaceInfo{
			WorkspaceID: ws.ID,
			Name:        ws.Name,
			ClientRef:   ws.ClientRef,
			PaneCount:   len(ws.Panes),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].WorkspaceID < out[j].WorkspaceID
	})
	return out
}

// AllocPaneID reserves and returns the next workspace-local pane id (starting at
// 1) for wsID. The second return is false for an unknown workspace.
func (r *Registry) AllocPaneID(wsID string) (int, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok {
		return 0, false
	}
	ws.nextPaneID++
	return ws.nextPaneID, true
}

// PutPane inserts p into wsID keyed by p.LocalID. It returns false for an
// unknown workspace.
func (r *Registry) PutPane(wsID string, p *Pane) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok || p == nil {
		return false
	}
	r.nextPaneGeneration++
	p.targetGeneration = r.nextPaneGeneration
	ws.Panes[p.LocalID] = p
	ws.membershipGeneration++
	return true
}

// Pane returns the pane paneID within wsID and whether it exists.
func (r *Registry) Pane(wsID string, paneID int) (*Pane, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok {
		return nil, false
	}
	p, ok := ws.Panes[paneID]
	return p, ok
}

// PaneIDs returns a deterministic sorted snapshot of the pane ids in wsID, or
// nil for an unknown workspace.
func (r *Registry) PaneIDs(wsID string) []int {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok {
		return nil
	}
	ids := make([]int, 0, len(ws.Panes))
	for id := range ws.Panes {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	return ids
}

// PaneInfos returns a deterministic sorted snapshot of frozen PaneInfo values
// for wsID's panes (built via Pane.Info()), or nil for an unknown workspace.
//
// Pane.Info() takes the pane's own mu while r.mu is held; this is safe because
// Pane.Info() never calls back into the Registry, so there is no lock cycle.
func (r *Registry) PaneInfos(wsID string) []PaneInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok {
		return nil
	}
	ids := make([]int, 0, len(ws.Panes))
	for id := range ws.Panes {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	infos := make([]PaneInfo, 0, len(ids))
	for _, id := range ids {
		infos = append(infos, ws.Panes[id].Info())
	}
	return infos
}

// SaveLayout stores an opaque layout blob for (wsID, breakpoint). Returns false
// for an unknown workspace or an empty breakpoint. An empty layout is allowed
// (acts as a clear).
func (r *Registry) SaveLayout(wsID, breakpoint, layout string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok || breakpoint == "" {
		return false
	}
	if ws.Layouts == nil {
		ws.Layouts = make(map[string]string)
	}
	ws.Layouts[breakpoint] = layout
	return true
}

// Layout returns the stored layout blob for (wsID, breakpoint), or "" if none.
func (r *Registry) Layout(wsID, breakpoint string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok || ws.Layouts == nil {
		return ""
	}
	return ws.Layouts[breakpoint]
}

// RenamePane sets the title of a pane. Returns false for an unknown workspace
// or pane.
//
// This is the public rename verb: whoever reaches it (browser dblclick, CLI,
// MCP) is stating a title deliberately, so the title becomes explicit and the
// deriver leaves it alone from here on. Names the daemon works out for itself
// take renamePaneDerived instead.
func (r *Registry) RenamePane(wsID string, paneID int, name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok {
		return false
	}
	p, ok := ws.Panes[paneID]
	if !ok {
		return false
	}
	p.SetTitle(name)
	return true
}

// renamePaneDerived offers a daemon-derived title to a pane and reports
// whether the pane's title actually CHANGED -- false for an unknown workspace
// or pane, for a pane a person has already named, and for a title that is
// already exactly this.
//
// The return value is the whole contract: callers broadcast only on true, so
// re-offering the same label every second costs nothing. Pane.setTitleDerived
// takes the pane's own mu while r.mu is held, which is the same order
// PaneInfos already uses and is safe for the same reason -- Pane never calls
// back into Registry.
func (r *Registry) renamePaneDerived(wsID string, paneID int, name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok {
		return false
	}
	p, ok := ws.Panes[paneID]
	if !ok {
		return false
	}
	return p.setTitleDerived(name)
}

// RemovePane deletes paneID from wsID and returns the removed pane, the number
// of panes remaining in the workspace, and whether the removal happened.
func (r *Registry) RemovePane(wsID string, paneID int) (*Pane, int, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.removePaneLocked(wsID, paneID)
}

// removePaneLocked is RemovePane's serialized mutation for close transactions
// that already hold r.mu.
func (r *Registry) removePaneLocked(wsID string, paneID int) (*Pane, int, bool) {
	ws, ok := r.workspaces[wsID]
	if !ok {
		return nil, 0, false
	}
	p, ok := ws.Panes[paneID]
	if !ok {
		return nil, len(ws.Panes), false
	}
	delete(ws.Panes, paneID)
	ws.membershipGeneration++
	return p, len(ws.Panes), true
}

// workspaceLiveView is a point-in-time, read-only view of one workspace's
// identity, layout, and live panes, captured under Registry's lock. Pane
// values are the live *Pane pointers (not copies): Pane's own methods
// (Replay, Info, etc.) are independently synchronized, so callers may safely
// invoke them after the registry lock is released. Used only by the
// session-restore snapshot writer (see snapshot.go).
type workspaceLiveView struct {
	ID   string
	Name string
	// NameOrigin travels with Name because the snapshot writer persists both:
	// a name restored without its provenance is a name the deriver is free to
	// overwrite on the next tick, which is how a crash-recovery restart would
	// otherwise eat a rename somebody typed before the crash.
	NameOrigin nameOrigin
	Layout     map[string]string
	Panes      []*Pane
}

// snapshotView returns a deterministic, point-in-time view of every
// workspace and its live panes, sorted by workspace id then pane id. It
// takes only a brief hold of r.mu; the (potentially slow) per-pane
// inspection work callers perform afterward (Replay(), /proc reads, etc.)
// happens outside this lock, so it never blocks live registry mutations for
// the duration of a full snapshot walk.
func (r *Registry) snapshotView() []workspaceLiveView {
	r.mu.Lock()
	defer r.mu.Unlock()

	ids := make([]string, 0, len(r.workspaces))
	for id := range r.workspaces {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	out := make([]workspaceLiveView, 0, len(ids))
	for _, id := range ids {
		ws := r.workspaces[id]

		paneIDs := make([]int, 0, len(ws.Panes))
		for pid := range ws.Panes {
			paneIDs = append(paneIDs, pid)
		}
		sort.Ints(paneIDs)
		panes := make([]*Pane, 0, len(paneIDs))
		for _, pid := range paneIDs {
			panes = append(panes, ws.Panes[pid])
		}

		layout := make(map[string]string, len(ws.Layouts))
		for k, v := range ws.Layouts {
			layout[k] = v
		}

		out = append(out, workspaceLiveView{ID: id, Name: ws.Name, NameOrigin: ws.nameOrigin, Layout: layout, Panes: panes})
	}
	return out
}
