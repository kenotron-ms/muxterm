package tmux

import (
	"fmt"
	"sync"
)

// TmuxState represents the in-memory state of a tmux server.
type TmuxState struct {
	mu              sync.RWMutex `json:"-"`
	Sessions        []Session    `json:"sessions"`
	ActiveSessionID string       `json:"activeSessionId"`
}

// Session represents a tmux session.
type Session struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Windows []Window `json:"windows"`
}

// Window represents a tmux window within a session.
type Window struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Layout string `json:"layout"`
	Active bool   `json:"active"`
	Panes  []Pane `json:"panes"`
}

// Pane represents a tmux pane within a window.
type Pane struct {
	ID     string `json:"id"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Active bool   `json:"active"`
}

// FindSession returns a pointer to the session with the given ID, or nil if not found.
func (s *TmuxState) FindSession(id string) *Session {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for i := range s.Sessions {
		if s.Sessions[i].ID == id {
			return &s.Sessions[i]
		}
	}
	return nil
}

// FindWindow returns a pointer to the window with the given ID, or nil if not found.
func (s *TmuxState) FindWindow(id string) *Window {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for i := range s.Sessions {
		for j := range s.Sessions[i].Windows {
			if s.Sessions[i].Windows[j].ID == id {
				return &s.Sessions[i].Windows[j]
			}
		}
	}
	return nil
}

// PanesForWindow returns the IDs of all panes in a given window.
func (s *TmuxState) WindowForPane(paneID string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for i := range s.Sessions {
		for j := range s.Sessions[i].Windows {
			for k := range s.Sessions[i].Windows[j].Panes {
				if s.Sessions[i].Windows[j].Panes[k].ID == paneID {
					return s.Sessions[i].Windows[j].ID
				}
			}
		}
	}
	return ""
}

// FindPane returns a pointer to the pane with the given ID, or nil if not found.
func (s *TmuxState) FindPane(id string) *Pane {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for i := range s.Sessions {
		for j := range s.Sessions[i].Windows {
			for k := range s.Sessions[i].Windows[j].Panes {
				if s.Sessions[i].Windows[j].Panes[k].ID == id {
					return &s.Sessions[i].Windows[j].Panes[k]
				}
			}
		}
	}
	return nil
}

// activeSessionLocked returns the active session pointer. Caller must hold the lock.
func (s *TmuxState) activeSessionLocked() *Session {
	for i := range s.Sessions {
		if s.Sessions[i].ID == s.ActiveSessionID {
			return &s.Sessions[i]
		}
	}
	return nil
}

// ApplySessionChanged sets the active session ID, creates the session if it
// doesn't exist, and updates the name if it does.
func (s *TmuxState) ApplySessionChanged(sessionID, name string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.ActiveSessionID = sessionID

	for i := range s.Sessions {
		if s.Sessions[i].ID == sessionID {
			s.Sessions[i].Name = name
			return
		}
	}

	s.Sessions = append(s.Sessions, Session{
		ID:   sessionID,
		Name: name,
	})
}

// ApplyWindowAdd adds a window to the active session. No duplicates are added.
func (s *TmuxState) ApplyWindowAdd(windowID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	sess := s.activeSessionLocked()
	if sess == nil {
		return
	}

	for _, w := range sess.Windows {
		if w.ID == windowID {
			return
		}
	}

	sess.Windows = append(sess.Windows, Window{ID: windowID})
}

// ApplyWindowClose removes a window from all sessions using in-place filter.
func (s *TmuxState) ApplyWindowClose(windowID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.Sessions {
		filtered := s.Sessions[i].Windows[:0]
		for _, w := range s.Sessions[i].Windows {
			if w.ID != windowID {
				filtered = append(filtered, w)
			}
		}
		s.Sessions[i].Windows = filtered
	}
}

// ApplyWindowRenamed finds a window across all sessions and updates its name.
func (s *TmuxState) ApplyWindowRenamed(windowID, name string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.Sessions {
		for j := range s.Sessions[i].Windows {
			if s.Sessions[i].Windows[j].ID == windowID {
				s.Sessions[i].Windows[j].Name = name
				return
			}
		}
	}
}

// ApplyLayoutChange updates a window's layout string and rebuilds its pane list.
func (s *TmuxState) ApplyLayoutChange(windowID, layout string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.Sessions {
		for j := range s.Sessions[i].Windows {
			if s.Sessions[i].Windows[j].ID == windowID {
				s.Sessions[i].Windows[j].Layout = layout
				rebuildPanesFromLayout(&s.Sessions[i].Windows[j])
				return
			}
		}
	}
}

// ApplySessionWindowChanged sets Active=true on the matching window and
// false on all others in that session.
func (s *TmuxState) ApplySessionWindowChanged(sessionID, windowID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.Sessions {
		if s.Sessions[i].ID == sessionID {
			for j := range s.Sessions[i].Windows {
				s.Sessions[i].Windows[j].Active = s.Sessions[i].Windows[j].ID == windowID
			}
			return
		}
	}
}

// ApplyWindowPaneChanged sets Active=true on the matching pane and
// false on all others in that window.
func (s *TmuxState) ApplyWindowPaneChanged(windowID, paneID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.Sessions {
		for j := range s.Sessions[i].Windows {
			if s.Sessions[i].Windows[j].ID == windowID {
				for k := range s.Sessions[i].Windows[j].Panes {
					s.Sessions[i].Windows[j].Panes[k].Active = s.Sessions[i].Windows[j].Panes[k].ID == paneID
				}
				return
			}
		}
	}
}

// ApplySessionRenamed renames the active session.
func (s *TmuxState) ApplySessionRenamed(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	sess := s.activeSessionLocked()
	if sess == nil {
		return
	}
	sess.Name = name
}

// PanesForWindow returns the pane IDs belonging to the given window ID,
// or nil if the window is not found.
func (s *TmuxState) PanesForWindow(windowID string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, session := range s.Sessions {
		for _, window := range session.Windows {
			if window.ID == windowID {
				ids := make([]string, len(window.Panes))
				for i, p := range window.Panes {
					ids[i] = p.ID
				}
				return ids
			}
		}
	}
	return nil
}

// ActiveSessionName returns the name of the active session, or "" if unknown.
func (s *TmuxState) ActiveSessionName() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, session := range s.Sessions {
		if session.ID == s.ActiveSessionID {
			return session.Name
		}
	}
	return ""
}

// ForEachPane calls fn once for every pane ID across all sessions and windows,
// holding the read lock for the duration. Used by the server to iterate panes
// without exposing the internal slice.
func (s *TmuxState) ForEachPane(fn func(paneID string)) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, session := range s.Sessions {
		for _, window := range session.Windows {
			for _, pane := range window.Panes {
				fn(pane.ID)
			}
		}
	}
}

// findLayoutNode finds a leaf node in the layout tree by pane ID.
func findLayoutNode(n *LayoutNode, paneID int) *LayoutNode {
	if n.Type == PaneNode && n.PaneID == paneID {
		return n
	}
	for _, child := range n.Children {
		if found := findLayoutNode(child, paneID); found != nil {
			return found
		}
	}
	return nil
}

// rebuildPanesFromLayout parses the window's layout string and rebuilds
// the pane list with updated dimensions while preserving existing pane data.
func rebuildPanesFromLayout(w *Window) {
	root, err := ParseLayout(w.Layout)
	if err != nil {
		return
	}

	// Build map of existing panes for preserving state
	existing := make(map[string]Pane)
	for _, p := range w.Panes {
		existing[p.ID] = p
	}

	ids := root.PaneIDs()
	panes := make([]Pane, 0, len(ids))
	for _, id := range ids {
		paneIDStr := fmt.Sprintf("%%%d", id)
		node := findLayoutNode(root, id)

		p := Pane{
			ID:     paneIDStr,
			Width:  node.Width,
			Height: node.Height,
		}

		// Preserve existing pane data (Active state)
		if ep, ok := existing[paneIDStr]; ok {
			p.Active = ep.Active
		}

		panes = append(panes, p)
	}

	w.Panes = panes
}