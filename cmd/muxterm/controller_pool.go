package main

import (
	"os"
	"sync"

	"github.com/user/muxterm/internal/tmux"
)

// attachFunc is a function that attaches to a named tmux session in control mode.
// It returns a Controller, the PTY file, the events channel, a cleanup function,
// and an error. The cleanup function must be called when the session is no longer needed.
type attachFunc func(sessionName string) (*tmux.Controller, *os.File, chan tmux.Event, func(), error)

// controllerSession holds all resources associated with one attached tmux session.
type controllerSession struct {
	name    string
	ctrl    *tmux.Controller
	ptmx    *os.File
	events  chan tmux.Event
	cleanup func()
}

// controllerPool is the heart of the multi-session phase. It keys live control
// connections by session name and exposes the same active-session methods that
// sessionManager had (controller, pty, requestRecreate, rememberSize, size) so
// that controllerAdapter is a near-no-op swap later. It also adds multi-session
// methods (ensure, get, remove, names, setActive, activeName, requestSwitch).
//
// The attach func is injectable so tests can provide a fake without a real PTY.
type controllerPool struct {
	mu        sync.RWMutex
	attach    attachFunc
	sessions  map[string]*controllerSession
	active    string
	owner     map[string]string // paneID -> sessionName
	lastCols  int
	lastRows  int
	recreate  chan struct{} // non-blocking signal to (re)attach a session
	switchReq chan string   // non-blocking request to switch the active session
}

// newControllerPool creates a controllerPool using the provided attach function.
// Maps and buffered channels are initialized; channels have capacity 1 so that
// requestRecreate / requestSwitch are non-blocking when a request is already queued.
func newControllerPool(attach attachFunc) *controllerPool {
	return &controllerPool{
		attach:    attach,
		sessions:  make(map[string]*controllerSession),
		owner:     make(map[string]string),
		recreate:  make(chan struct{}, 1),
		switchReq: make(chan string, 1),
	}
}

// ensure returns the session for name, attaching it first if necessary.
// It uses the double-check pattern to avoid duplicate attaches under concurrent callers:
//  1. Read-lock check — fast path when already attached.
//  2. Attach outside any lock — potentially slow I/O.
//  3. Write-lock check — another goroutine may have attached while we were attaching;
//     if so, discard our fresh attach and return theirs.
//
// ensure does NOT start an event reader — that is the caller's responsibility.
func (p *controllerPool) ensure(name string) (*controllerSession, error) {
	// Fast path: already attached.
	p.mu.RLock()
	s := p.sessions[name]
	p.mu.RUnlock()
	if s != nil {
		return s, nil
	}

	// Attach outside the lock to avoid holding it during PTY allocation.
	ctrl, ptmx, events, cleanup, err := p.attach(name)
	if err != nil {
		return nil, err
	}

	// Write-lock double-check: another goroutine may have won the race.
	p.mu.Lock()
	defer p.mu.Unlock()
	if existing := p.sessions[name]; existing != nil {
		cleanup() // discard ours
		return existing, nil
	}
	s = &controllerSession{
		name:    name,
		ctrl:    ctrl,
		ptmx:    ptmx,
		events:  events,
		cleanup: cleanup,
	}
	p.sessions[name] = s
	return s, nil
}

// get returns the session for name under read lock.
// Returns nil if the session has not been attached.
func (p *controllerPool) get(name string) *controllerSession {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.sessions[name]
}

// remove cleans up the named session, releases pane ownership for any panes it
// owns, and clears the active name if it pointed to this session.
func (p *controllerPool) remove(name string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	s := p.sessions[name]
	if s == nil {
		return
	}
	s.cleanup()
	delete(p.sessions, name)
	for paneID, owner := range p.owner {
		if owner == name {
			delete(p.owner, paneID)
		}
	}
	if p.active == name {
		p.active = ""
	}
}

// names returns a slice of all currently attached session names.
// The order is unspecified (Go map iteration).
func (p *controllerPool) names() []string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	result := make([]string, 0, len(p.sessions))
	for name := range p.sessions {
		result = append(result, name)
	}
	return result
}

// setActive sets the active session name under write lock.
func (p *controllerPool) setActive(name string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.active = name
}

// activeName returns the active session name under read lock.
func (p *controllerPool) activeName() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.active
}

// controller returns the active session's Controller, or nil if there is no
// active session or the active name is not attached.
func (p *controllerPool) controller() *tmux.Controller {
	p.mu.RLock()
	defer p.mu.RUnlock()
	s := p.sessions[p.active]
	if s == nil {
		return nil
	}
	return s.ctrl
}

// activeController is an alias for controller(), matching the sessionManager API.
func (p *controllerPool) activeController() *tmux.Controller {
	return p.controller()
}

// pty returns the active session's PTY file, or nil if there is no active session.
func (p *controllerPool) pty() *os.File {
	p.mu.RLock()
	defer p.mu.RUnlock()
	s := p.sessions[p.active]
	if s == nil {
		return nil
	}
	return s.ptmx
}

// rememberSize records the browser's terminal size so a future re-attach can
// immediately size the new session to match. Non-positive dimensions are ignored.
func (p *controllerPool) rememberSize(cols, rows int) {
	if cols <= 0 || rows <= 0 {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.lastCols, p.lastRows = cols, rows
}

// size returns the last remembered terminal size, or (0, 0) if never set.
func (p *controllerPool) size() (cols, rows int) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.lastCols, p.lastRows
}

// requestRecreate asks the supervisor to (re)attach a session. Non-blocking:
// if a request is already queued, this is a no-op.
func (p *controllerPool) requestRecreate() {
	select {
	case p.recreate <- struct{}{}:
	default:
	}
}

// requestSwitch requests a switch to the named session. Non-blocking:
// if a switch is already pending, this is a no-op.
func (p *controllerPool) requestSwitch(name string) {
	select {
	case p.switchReq <- name:
	default:
	}
}

// claimPane attempts to assign ownership of paneID to name (first-attached-wins).
// Write-locked. Returns true if name already owned paneID or successfully claimed it.
// Returns false if paneID is owned by a different session.
func (p *controllerPool) claimPane(name, paneID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if existing, ok := p.owner[paneID]; ok {
		return existing == name
	}
	p.owner[paneID] = name
	return true
}

// ownsPane reports whether name is the registered owner of paneID.
// Read-locked.
func (p *controllerPool) ownsPane(name, paneID string) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.owner[paneID] == name
}


