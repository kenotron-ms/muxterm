package sessiond

import "sort"

// EnsureDefault guarantees that at least one workspace exists and returns it.
//
// On an empty registry it creates a single unnamed default workspace ("") and
// returns it. Otherwise it returns the lowest-id existing workspace (ids sorted
// as strings) and creates nothing. This implements the cold-start rule so the
// first attach always lands somewhere.
func (r *Registry) EnsureDefault() *Workspace {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.workspaces) == 0 {
		id := r.addWorkspaceLocked("", "")
		return r.workspaces[id]
	}
	return r.workspaces[r.lowestIDLocked()]
}

// RenameWorkspace sets (or clears, when name == "") the display label of the
// workspace identified by id. There is no uniqueness check because ids are the
// key. It returns false for an unknown id.
func (r *Registry) RenameWorkspace(id, name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[id]
	if !ok {
		return false
	}
	ws.Name = name
	return true
}

// ReapIfEmpty removes the workspace wsID iff it has no panes (tmux-parity
// auto-reap). If the removal leaves the registry empty, it creates and returns a
// fresh unnamed default as recreatedDefault so the next attach always lands
// somewhere. It returns (removed, recreatedDefault); recreatedDefault is nil
// unless a default was made. It returns (false, nil) for an unknown or non-empty
// workspace.
func (r *Registry) ReapIfEmpty(wsID string) (bool, *Workspace) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok || len(ws.Panes) != 0 {
		return false, nil
	}
	delete(r.workspaces, wsID)
	return true, r.recreateDefaultIfEmptyLocked()
}

// CloseWorkspace removes the workspace id and returns its panes so the caller
// can kill them; the Registry never touches PTYs. If the removal empties the
// registry, it creates and returns a fresh unnamed default as recreatedDefault.
// It returns (nil, nil, false) for an unknown workspace.
func (r *Registry) CloseWorkspace(id string) (panes []*Pane, recreatedDefault *Workspace, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, exists := r.workspaces[id]
	if !exists {
		return nil, nil, false
	}
	panes = make([]*Pane, 0, len(ws.Panes))
	ids := make([]int, 0, len(ws.Panes))
	for pid := range ws.Panes {
		ids = append(ids, pid)
	}
	sort.Ints(ids)
	for _, pid := range ids {
		panes = append(panes, ws.Panes[pid])
	}
	delete(r.workspaces, id)
	return panes, r.recreateDefaultIfEmptyLocked(), true
}

// lowestIDLocked returns the lowest workspace id sorted as a string. The caller
// must hold r.mu and the registry must be non-empty.
func (r *Registry) lowestIDLocked() string {
	ids := make([]string, 0, len(r.workspaces))
	for id := range r.workspaces {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids[0]
}

// recreateDefaultIfEmptyLocked creates a fresh unnamed default workspace when
// the registry is empty and returns it, or nil if at least one workspace
// remains. The caller must hold r.mu.
func (r *Registry) recreateDefaultIfEmptyLocked() *Workspace {
	if len(r.workspaces) != 0 {
		return nil
	}
	id := r.addWorkspaceLocked("", "")
	return r.workspaces[id]
}
