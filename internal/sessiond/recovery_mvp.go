package sessiond

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"sync"
	"unicode/utf8"

	"github.com/creack/pty"
)

const (
	recoveryMVPDefaultColumns = 80
	recoveryMVPDefaultRows    = 24
	recoveryMVPDefaultTitle   = "Terminal"
)

var (
	errRecoveryMVPStartup  = errors.New("sessiond: recovery startup failed")
	errRecoveryMVPMutation = errors.New("sessiond: recovery persistence unavailable")
)

// recoveryMVP is the one daemon-owned serialization point for the narrow
// shell-recovery slice. Its durable snapshot is advanced before any matching
// registry mutation or browser-visible output. Recovered history is immutable
// for this daemon generation: it is literal display data from the prior daemon,
// never terminal input or VT state.
type recoveryMVP struct {
	mu sync.Mutex

	store       RecoveryStore
	snapshot    RecoverySnapshot
	closed      bool
	storeClosed bool

	partials     map[RecoveryPaneRef]recoveryMVPPartialLine
	history      map[RecoveryPaneRef]RecoveredHistoryLiteral
	historyFault bool
}

type recoveryMVPPartialLine struct {
	data      []byte
	truncated bool
}

type recoveryMVPPreparedPane struct {
	ref  RecoveryPaneRef
	pane *Pane
}

type recoveryMVPSinglePaneDockviewGrid struct {
	root        json.RawMessage
	orientation string
	width       uint64
	height      uint64
	groupID     string
}

func newRecoveryMVP(
	store RecoveryStore,
	snapshot RecoverySnapshot,
	history []recoveryHistoryPlan,
) (*recoveryMVP, error) {
	if store == nil {
		return nil, errRecoveryMVPStartup
	}
	literals, err := recoveryMVPHistoricalLiterals(history)
	if err != nil {
		return nil, errRecoveryMVPStartup
	}
	return &recoveryMVP{
		store:    store,
		snapshot: snapshot,
		partials: make(map[RecoveryPaneRef]recoveryMVPPartialLine),
		history:  literals,
	}, nil
}

// bootstrapDefault establishes the one cold-start workspace and terminal pane
// before the ordinary socket is bound. The workspace and pane are committed in
// order; an incomplete failed bootstrap is never published through the socket.
func (m *recoveryMVP) bootstrapDefault(s *Server) error {
	workspaceID, err := m.createWorkspace(s, "", "")
	if err != nil {
		return err
	}
	_, pane, err := m.createDefaultPane(
		s,
		workspaceID,
		recoveryMVPDefaultColumns,
		recoveryMVPDefaultRows,
	)
	if err != nil {
		// A default workspace has no browser-visible lifetime before the socket
		// binds, so remove its first committed record if the paired initial pane
		// could not become durable. The prior empty structural state remains the
		// next startup's authority.
		_ = m.discardEmptyWorkspace(s, workspaceID)
		return err
	}
	pane.startCurrentRoot()
	return nil
}

// restore reconstructs only terminal panes from the fully validated inert plan.
// It starts every replacement shell with delivery stopped, makes the complete
// registry visible as one state transition, then starts delivery. Browser panes
// and command persistence are intentionally outside this MVP and fail closed
// rather than being silently dropped.
func (m *recoveryMVP) restore(s *Server, plan recoveryRegistryPlan) error {
	panesByWorkspace := make(map[RecoveryWorkspaceID][]RecoveryPane, len(plan.workspaces))
	for _, pane := range plan.panes {
		if pane.surface != RecoverySurfaceTerminal {
			return errRecoveryMVPStartup
		}
		if pane.columns == 0 || pane.rows == 0 ||
			pane.columns > uint32(^uint16(0)) || pane.rows > uint32(^uint16(0)) {
			return errRecoveryMVPStartup
		}
		panesByWorkspace[pane.ref.WorkspaceID] = append(
			panesByWorkspace[pane.ref.WorkspaceID],
			recoveryMVPPaneFromPlan(pane),
		)
	}

	layoutsByWorkspace := make(map[RecoveryWorkspaceID]map[string]string, len(plan.workspaces))
	for _, layoutPlan := range plan.layouts {
		layout := recoveryMVPLayoutFromPlan(layoutPlan)
		encoded, err := encodeRecoveryDockviewLayout(layout, panesByWorkspace[layout.WorkspaceID])
		if err != nil {
			return errRecoveryMVPStartup
		}
		layouts := layoutsByWorkspace[layout.WorkspaceID]
		if layouts == nil {
			layouts = make(map[string]string)
			layoutsByWorkspace[layout.WorkspaceID] = layouts
		}
		layouts[layout.Breakpoint] = string(encoded)
	}

	prepared := make([]recoveryMVPPreparedPane, 0, len(plan.panes))
	cleanup := func() {
		for _, candidate := range prepared {
			candidate.pane.Close()
		}
	}
	for _, panePlan := range plan.panes {
		pane, err := recoveryMVPNewDefaultPaneStopped(
			int(panePlan.ref.PaneID),
			int(panePlan.columns),
			int(panePlan.rows),
			m.callbacks(s, string(panePlan.ref.WorkspaceID)),
		)
		if err != nil {
			cleanup()
			return errRecoveryMVPStartup
		}
		pane.SetTitle(panePlan.title)
		prepared = append(prepared, recoveryMVPPreparedPane{ref: panePlan.ref, pane: pane})
	}

	registry := s.reg
	registry.mu.Lock()
	if len(registry.workspaces) != 0 {
		registry.mu.Unlock()
		cleanup()
		return errRecoveryMVPStartup
	}
	for _, workspacePlan := range plan.workspaces {
		workspace := &Workspace{
			ID:         string(workspacePlan.id),
			Name:       workspacePlan.name,
			Panes:      make(map[int]*Pane),
			Layouts:    make(map[string]string),
			nextPaneID: int(workspacePlan.paneAllocator.highWater),
		}
		for breakpoint, layout := range layoutsByWorkspace[workspacePlan.id] {
			workspace.Layouts[breakpoint] = layout
		}
		registry.nextWorkspaceGeneration++
		workspace.generation = registry.nextWorkspaceGeneration
		registry.workspaces[workspace.ID] = workspace
	}
	for _, candidate := range prepared {
		workspace := registry.workspaces[string(candidate.ref.WorkspaceID)]
		if workspace == nil {
			registry.mu.Unlock()
			cleanup()
			return errRecoveryMVPStartup
		}
		workspace.Panes[int(candidate.ref.PaneID)] = candidate.pane
		workspace.membershipGeneration++
		registry.nextPaneGeneration++
		candidate.pane.targetGeneration = registry.nextPaneGeneration
	}
	registry.nextWSID = plan.workspaceAllocator.highWater
	registry.mu.Unlock()

	// The root process has existed privately until now; only this transition
	// allows it to invoke callbacks or publish bytes to a subscriber.
	for _, candidate := range prepared {
		candidate.pane.startCurrentRoot()
	}
	return nil
}

func recoveryMVPPaneFromPlan(plan recoveryPanePlan) RecoveryPane {
	return RecoveryPane{
		Ref:              plan.ref,
		Surface:          plan.surface,
		Columns:          plan.columns,
		Rows:             plan.rows,
		Title:            plan.title,
		WorkingDirectory: plan.workingDirectory,
	}
}

func recoveryMVPLayoutFromPlan(plan recoveryLayoutPlan) RecoveryLayout {
	return RecoveryLayout{
		WorkspaceID: plan.workspaceID,
		Breakpoint:  plan.breakpoint,
		ActiveGroup: plan.activeGroup,
		Root:        recoveryMVPLayoutNodeFromPlan(plan.root),
	}
}

func recoveryMVPLayoutNodeFromPlan(plan recoveryLayoutNodePlan) RecoveryLayoutNode {
	node := RecoveryLayoutNode{
		Kind:        plan.kind,
		Geometry:    plan.geometry,
		Ratio:       plan.ratio,
		Orientation: plan.orientation,
		GroupID:     plan.groupID,
		Views:       append([]RecoveryPaneRef(nil), plan.views...),
	}
	if plan.hasActiveView {
		active := plan.activeView
		node.ActiveView = &active
	}
	if len(plan.children) != 0 {
		node.Children = make([]RecoveryLayoutNode, len(plan.children))
		for index, child := range plan.children {
			node.Children[index] = recoveryMVPLayoutNodeFromPlan(child)
		}
	}
	return node
}

func (m *recoveryMVP) callbacks(s *Server, workspaceID string) PaneCallbacks {
	return PaneCallbacks{
		OnData: func(localID int, data []byte) {
			m.handleTerminalData(s, workspaceID, localID, data)
		},
		OnExit: func(localID int, root PaneRootIdentity, exitCode int, runtimeMilliseconds int64) {
			m.handlePaneRootExit(s, workspaceID, localID, root, exitCode, runtimeMilliseconds)
		},
		OnPrompt: func(localID int, msg *Message) {
			msg.WorkspaceID = workspaceID
			msg.PaneID = localID
			s.broadcast(workspaceID, msg)
		},
	}
}

// handlePaneRootExit durably removes only the registry pane whose exact current
// root emitted the callback. The callback already holds pane.deliveryMu, so this
// method must not reenter pane lifecycle or I/O. Publication occurs only after
// the recovery and registry locks are released.
func (m *recoveryMVP) handlePaneRootExit(
	s *Server,
	workspaceID string,
	paneID int,
	root PaneRootIdentity,
	exitCode int,
	runtimeMilliseconds int64,
) {
	m.mu.Lock()
	registry := s.reg
	registry.mu.Lock()
	workspace := registry.workspaces[workspaceID]
	if workspace == nil {
		registry.mu.Unlock()
		m.mu.Unlock()
		return
	}
	pane := workspace.Panes[paneID]
	if pane == nil {
		registry.mu.Unlock()
		m.mu.Unlock()
		return
	}
	currentRoot, current := pane.CurrentRootIdentity()
	if !current || currentRoot != root {
		registry.mu.Unlock()
		m.mu.Unlock()
		return
	}

	ref := RecoveryPaneRef{
		WorkspaceID: RecoveryWorkspaceID(workspaceID),
		PaneID:      RecoveryPaneID(paneID),
	}
	layoutBreakpoints := make([]string, 0, len(m.snapshot.Layouts))
	for _, layout := range m.snapshot.Layouts {
		if recoveryLayoutNodeReferencesPane(layout.Root, ref) {
			layoutBreakpoints = append(layoutBreakpoints, layout.Breakpoint)
		}
	}
	if err := m.commitLocked(RecoveryMutation{
		Kind:    RecoveryMutationDeletePane,
		PaneRef: &ref,
	}); err != nil {
		registry.mu.Unlock()
		m.mu.Unlock()
		log.Printf("sessiond recovery: pane exit persistence failed")
		return
	}

	for _, breakpoint := range layoutBreakpoints {
		delete(workspace.Layouts, breakpoint)
	}
	registry.removePaneLocked(workspaceID, paneID)
	registry.mu.Unlock()
	m.mu.Unlock()

	code := exitCode
	s.broadcast(workspaceID, &Message{
		Type:            TypePaneClosed,
		WorkspaceID:     workspaceID,
		PaneID:          paneID,
		ProcessExitCode: &code,
		RuntimeMs:       runtimeMilliseconds,
	})
}

// createWorkspace commits the planned identity before it becomes a registry
// entry or any caller can receive its success response.
func (m *recoveryMVP) createWorkspace(s *Server, name, clientRef string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return "", errRecoveryMVPMutation
	}

	registry := s.reg
	registry.mu.Lock()
	defer registry.mu.Unlock()
	if registry.nextWSID == int(^uint(0)>>1) {
		return "", errRecoveryMVPMutation
	}
	nextID := registry.nextWSID + 1
	workspaceID := fmt.Sprintf("w%d", nextID)
	recoveryWorkspaceID := RecoveryWorkspaceID(workspaceID)
	if err := m.commitLocked(RecoveryMutation{
		Kind:      RecoveryMutationSetWorkspace,
		Workspace: &RecoveryWorkspace{ID: recoveryWorkspaceID, Name: name},
	}); err != nil {
		return "", errRecoveryMVPMutation
	}

	registry.nextWSID = nextID
	registry.nextWorkspaceGeneration++
	registry.workspaces[workspaceID] = &Workspace{
		ID:         workspaceID,
		Name:       name,
		ClientRef:  clientRef,
		Panes:      make(map[int]*Pane),
		Layouts:    make(map[string]string),
		generation: registry.nextWorkspaceGeneration,
	}
	return workspaceID, nil
}

func (m *recoveryMVP) discardEmptyWorkspace(s *Server, workspaceID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return errRecoveryMVPMutation
	}
	registry := s.reg
	registry.mu.Lock()
	defer registry.mu.Unlock()
	workspace := registry.workspaces[workspaceID]
	if workspace == nil || len(workspace.Panes) != 0 {
		return errRecoveryMVPMutation
	}
	id := RecoveryWorkspaceID(workspaceID)
	if err := m.commitLocked(RecoveryMutation{
		Kind:        RecoveryMutationDeleteWorkspace,
		WorkspaceID: &id,
	}); err != nil {
		return errRecoveryMVPMutation
	}
	delete(registry.workspaces, workspaceID)
	return nil
}

// createDefaultPane keeps its root private until its qualified RecoveryPane is
// durable and its registry identity has been installed. NewPane's normal
// immediate delivery start would allow the shell to race this boundary.
func (m *recoveryMVP) createDefaultPane(
	s *Server,
	workspaceID string,
	cols, rows int,
) (int, *Pane, error) {
	if !recoveryMVPValidDimensions(cols, rows) {
		return 0, nil, errRecoveryMVPMutation
	}

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return 0, nil, errRecoveryMVPMutation
	}
	registry := s.reg
	registry.mu.Lock()
	workspace := registry.workspaces[workspaceID]
	if workspace == nil || workspace.nextPaneID == int(^uint(0)>>1) {
		registry.mu.Unlock()
		m.mu.Unlock()
		return 0, nil, errRecoveryMVPMutation
	}
	localID := workspace.nextPaneID + 1
	if uint64(localID) >= uint64(^RecoveryPaneID(0)) {
		registry.mu.Unlock()
		m.mu.Unlock()
		return 0, nil, errRecoveryMVPMutation
	}

	pane, err := recoveryMVPNewDefaultPaneStopped(localID, cols, rows, m.callbacks(s, workspaceID))
	if err != nil {
		registry.mu.Unlock()
		m.mu.Unlock()
		return 0, nil, errRecoveryMVPMutation
	}
	ref := RecoveryPaneRef{
		WorkspaceID: RecoveryWorkspaceID(workspaceID),
		PaneID:      RecoveryPaneID(localID),
	}
	model := RecoveryPane{
		Ref:     ref,
		Surface: RecoverySurfaceTerminal,
		Columns: uint32(cols),
		Rows:    uint32(rows),
		Title:   recoveryMVPDefaultTitle,
	}
	if err := m.commitLocked(RecoveryMutation{
		Kind: RecoveryMutationSetPane,
		Pane: &model,
	}); err != nil {
		registry.mu.Unlock()
		m.mu.Unlock()
		pane.Close()
		return 0, nil, errRecoveryMVPMutation
	}

	workspace.nextPaneID = localID
	registry.nextPaneGeneration++
	pane.targetGeneration = registry.nextPaneGeneration
	workspace.Panes[localID] = pane
	workspace.membershipGeneration++
	registry.mu.Unlock()
	m.mu.Unlock()

	return localID, pane, nil
}

func recoveryMVPNewDefaultPaneStopped(
	localID, cols, rows int,
	callbacks PaneCallbacks,
) (*Pane, error) {
	home, err := safeRecoveryHome()
	if err != nil {
		return nil, errRecoveryMVPStartup
	}
	launch, err := preparePaneLaunch(nil)
	if err != nil {
		return nil, errRecoveryMVPStartup
	}
	generation, err := nextPaneRootGeneration()
	if err != nil {
		if launch.cleanup != nil {
			launch.cleanup()
		}
		return nil, errRecoveryMVPStartup
	}
	env := append([]string(nil), os.Environ()...)
	env = append(env, "TERM=xterm-256color")
	env = append(env, launch.env...)
	root, err := startPaneRoot(
		generation,
		validatedPaneLaunchOptions{
			argv: clonePaneLaunchStrings(launch.argv),
			cwd:  home,
			env:  clonePaneLaunchStrings(env),
		},
		launch.source,
		launch.token,
		launch.cleanup,
		cols,
		rows,
	)
	if err != nil {
		return nil, errRecoveryMVPStartup
	}
	pane := newPaneFromRoot(localID, cols, rows, NewVTBuffer(cols, rows), callbacks, root)
	pane.Title = recoveryMVPDefaultTitle
	return pane, nil
}

func recoveryMVPValidDimensions(cols, rows int) bool {
	return cols > 0 && rows > 0 && cols <= int(^uint16(0)) && rows <= int(^uint16(0))
}

func (m *recoveryMVP) renamePane(s *Server, workspaceID string, paneID int, name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return errRecoveryMVPMutation
	}

	registry := s.reg
	registry.mu.Lock()
	defer registry.mu.Unlock()
	workspace := registry.workspaces[workspaceID]
	if workspace == nil {
		return errRecoveryMVPMutation
	}
	pane := workspace.Panes[paneID]
	if pane == nil || pane.SurfaceKind == "browser" {
		return errRecoveryMVPMutation
	}
	ref := RecoveryPaneRef{
		WorkspaceID: RecoveryWorkspaceID(workspaceID),
		PaneID:      RecoveryPaneID(paneID),
	}
	model, ok := m.paneLocked(ref)
	if !ok {
		return errRecoveryMVPMutation
	}
	model.Title = name
	if err := m.commitLocked(RecoveryMutation{
		Kind: RecoveryMutationSetPane,
		Pane: &model,
	}); err != nil {
		return errRecoveryMVPMutation
	}
	pane.SetTitle(name)
	return nil
}

// resizePane keeps the PTY size and the in-memory dimensions private behind the
// pane delivery boundary while it makes the durable candidate authoritative.
// A failed durable commit restores the preflight PTY size and publishes neither
// the candidate dimensions nor a resize event.
func (m *recoveryMVP) resizePane(
	s *Server,
	workspaceID string,
	paneID, cols, rows int,
) (PaneInfo, bool, error) {
	if !recoveryMVPValidDimensions(cols, rows) {
		return PaneInfo{}, false, errRecoveryMVPMutation
	}
	pane, ok := s.reg.Pane(workspaceID, paneID)
	if !ok || pane == nil {
		return PaneInfo{}, false, errRecoveryMVPMutation
	}

	// Pane callbacks acquire deliveryMu before recoveryMVP.mu. Preserve that
	// order here so a completed output line cannot deadlock against a resize.
	pane.deliveryMu.Lock()
	defer pane.deliveryMu.Unlock()
	pane.mu.Lock()
	if pane.finalClosed || pane.SurfaceKind == "browser" {
		pane.mu.Unlock()
		return PaneInfo{}, false, errRecoveryMVPMutation
	}
	before := PaneInfo{
		PaneID:      pane.LocalID,
		Cols:        pane.cols,
		Rows:        pane.rows,
		Title:       pane.Title,
		SurfaceKind: pane.SurfaceKind,
	}
	root := pane.root
	pane.mu.Unlock()
	if before.Cols == cols && before.Rows == rows {
		return before, false, nil
	}

	// PTY sizing is intentionally preflighted while delivery is stopped. If
	// persistence rejects the candidate, restore the prior ephemeral size before
	// releasing output delivery.
	if root != nil && root.ptmx != nil {
		if err := pty.Setsize(root.ptmx, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)}); err != nil {
			return PaneInfo{}, false, errRecoveryMVPMutation
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		recoveryMVPRestorePTYSize(root, before.Cols, before.Rows)
		return PaneInfo{}, false, errRecoveryMVPMutation
	}
	registry := s.reg
	registry.mu.Lock()
	defer registry.mu.Unlock()
	workspace := registry.workspaces[workspaceID]
	if workspace == nil || workspace.Panes[paneID] != pane {
		recoveryMVPRestorePTYSize(root, before.Cols, before.Rows)
		return PaneInfo{}, false, errRecoveryMVPMutation
	}
	ref := RecoveryPaneRef{
		WorkspaceID: RecoveryWorkspaceID(workspaceID),
		PaneID:      RecoveryPaneID(paneID),
	}
	model, ok := m.paneLocked(ref)
	if !ok {
		recoveryMVPRestorePTYSize(root, before.Cols, before.Rows)
		return PaneInfo{}, false, errRecoveryMVPMutation
	}
	model.Columns = uint32(cols)
	model.Rows = uint32(rows)
	if err := m.commitLocked(RecoveryMutation{
		Kind: RecoveryMutationSetPane,
		Pane: &model,
	}); err != nil {
		recoveryMVPRestorePTYSize(root, before.Cols, before.Rows)
		return PaneInfo{}, false, errRecoveryMVPMutation
	}

	pane.mu.Lock()
	pane.cols = cols
	pane.rows = rows
	pane.mu.Unlock()
	if pane.buf != nil {
		pane.buf.Resize(cols, rows)
	}
	before.Cols = cols
	before.Rows = rows
	return before, true, nil
}

func recoveryMVPRestorePTYSize(root *paneRoot, cols, rows int) {
	if root == nil || root.ptmx == nil || !recoveryMVPValidDimensions(cols, rows) {
		return
	}
	_ = pty.Setsize(root.ptmx, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
}

func (m *recoveryMVP) saveWideLayout(s *Server, workspaceID, layoutData string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return errRecoveryMVPMutation
	}

	registry := s.reg
	registry.mu.Lock()
	defer registry.mu.Unlock()
	workspace := registry.workspaces[workspaceID]
	if workspace == nil {
		return errRecoveryMVPMutation
	}
	recoveryWorkspaceID := RecoveryWorkspaceID(workspaceID)
	panes := m.panesForWorkspaceLocked(recoveryWorkspaceID)
	wireLayout := []byte(layoutData)
	layout, err := decodeRecoveryDockviewLayout(
		recoveryWorkspaceID,
		"wide",
		wireLayout,
		panes,
	)
	if err != nil && len(panes) == 1 {
		wireLayout, err = recoveryMVPAdaptSinglePaneDockviewLayout(
			recoveryWorkspaceID,
			wireLayout,
			panes[0],
		)
		if err == nil {
			layout, err = decodeRecoveryDockviewLayout(
				recoveryWorkspaceID,
				"wide",
				wireLayout,
				panes,
			)
		}
	}
	if err != nil {
		return errRecoveryMVPMutation
	}
	encoded, err := encodeRecoveryDockviewLayout(layout, panes)
	if err != nil {
		return errRecoveryMVPMutation
	}
	if err := m.commitLocked(RecoveryMutation{
		Kind:   RecoveryMutationSetLayout,
		Layout: &layout,
	}); err != nil {
		return errRecoveryMVPMutation
	}
	workspace.Layouts["wide"] = string(encoded)
	return nil
}

// recoveryMVPAdaptSinglePaneDockviewLayout accepts only the extra presentation
// shape emitted by Dockview for one pane: a unary root branch and the known tab
// renderer field. It validates that shape token-by-token before reducing it to
// the strict recovery codec's closed grammar.
func recoveryMVPAdaptSinglePaneDockviewLayout(
	workspaceID RecoveryWorkspaceID,
	data []byte,
	pane RecoveryPane,
) ([]byte, error) {
	canonicalPane, err := canonicalRecoveryPane(pane)
	if err != nil {
		return nil, err
	}
	if canonicalPane.Ref.WorkspaceID != workspaceID {
		return nil, fmt.Errorf("%w: one-pane dockview layout is outside its workspace", ErrRecoveryStoreInvalid)
	}

	var gridData, panelsData json.RawMessage
	var activeGroup string
	var haveGrid, havePanels, haveActiveGroup bool
	if err := recoveryDockviewParseOne(data, "one-pane dockview layout", func(decoder *json.Decoder) error {
		return recoveryDockviewObject(
			decoder,
			"one-pane dockview layout",
			recoveryDockviewTopKey,
			func(key string) error {
				switch key {
				case "grid":
					value, err := recoveryDockviewRawValue(decoder, "one-pane dockview grid")
					if err != nil {
						return err
					}
					gridData = value
					haveGrid = true
				case "panels":
					value, err := recoveryDockviewRawValue(decoder, "one-pane dockview panels")
					if err != nil {
						return err
					}
					panelsData = value
					havePanels = true
				case "activeGroup":
					value, err := recoveryDockviewString(decoder, "one-pane dockview active group")
					if err != nil {
						return err
					}
					activeGroup = value
					haveActiveGroup = true
				}
				return nil
			},
		)
	}); err != nil {
		return nil, err
	}
	if !haveGrid || !havePanels || !haveActiveGroup {
		return nil, fmt.Errorf("%w: one-pane dockview layout requires grid, panels, and active group", ErrRecoveryStoreInvalid)
	}

	grid, err := recoveryMVPDecodeSinglePaneDockviewGrid(gridData, workspaceID, canonicalPane.Ref)
	if err != nil {
		return nil, err
	}
	if err := recoveryMVPValidateSinglePaneDockviewPanels(panelsData, canonicalPane); err != nil {
		return nil, err
	}
	if activeGroup != grid.groupID {
		return nil, fmt.Errorf("%w: one-pane dockview active group differs from its leaf", ErrRecoveryStoreInvalid)
	}

	paneID := fmt.Sprintf("%d", canonicalPane.Ref.PaneID)
	var output bytes.Buffer
	output.WriteString(`{"grid":{"root":`)
	output.Write(grid.root)
	output.WriteString(`,"orientation":`)
	if err := recoveryDockviewWriteQuoted(&output, grid.orientation); err != nil {
		return nil, err
	}
	output.WriteString(`,"width":`)
	fmt.Fprintf(&output, "%d", grid.width)
	output.WriteString(`,"height":`)
	fmt.Fprintf(&output, "%d", grid.height)
	output.WriteString(`},"panels":{`)
	if err := recoveryDockviewWriteQuoted(&output, paneID); err != nil {
		return nil, err
	}
	output.WriteString(`:{"id":`)
	if err := recoveryDockviewWriteQuoted(&output, paneID); err != nil {
		return nil, err
	}
	output.WriteString(`,"title":`)
	if err := recoveryDockviewWriteQuoted(&output, canonicalPane.Title); err != nil {
		return nil, err
	}
	output.WriteString(`,"contentComponent":`)
	if err := recoveryDockviewWriteQuoted(&output, string(canonicalPane.Surface)); err != nil {
		return nil, err
	}
	output.WriteString(`}},"activeGroup":`)
	if err := recoveryDockviewWriteQuoted(&output, activeGroup); err != nil {
		return nil, err
	}
	output.WriteByte('}')
	if output.Len() > RecoveryStoreMaxLayoutBytes {
		return nil, fmt.Errorf("%w: adapted one-pane dockview layout exceeds its byte bound", ErrRecoveryStoreInvalid)
	}
	return append([]byte(nil), output.Bytes()...), nil
}

func recoveryMVPDecodeSinglePaneDockviewGrid(
	data []byte,
	workspaceID RecoveryWorkspaceID,
	paneRef RecoveryPaneRef,
) (recoveryMVPSinglePaneDockviewGrid, error) {
	var rootData json.RawMessage
	var orientation string
	var width, height uint64
	var haveRoot, haveOrientation, haveWidth, haveHeight bool
	if err := recoveryDockviewParseOne(data, "one-pane dockview grid", func(decoder *json.Decoder) error {
		return recoveryDockviewObject(
			decoder,
			"one-pane dockview grid",
			recoveryDockviewGridKey,
			func(key string) error {
				switch key {
				case "root":
					value, err := recoveryDockviewRawValue(decoder, "one-pane dockview root")
					if err != nil {
						return err
					}
					rootData = value
					haveRoot = true
				case "orientation":
					value, err := recoveryDockviewString(decoder, "one-pane dockview orientation")
					if err != nil {
						return err
					}
					orientation = value
					haveOrientation = true
				case "width":
					value, err := recoveryDockviewPositiveNumber(decoder, "one-pane dockview width")
					if err != nil {
						return err
					}
					width = value
					haveWidth = true
				case "height":
					value, err := recoveryDockviewPositiveNumber(decoder, "one-pane dockview height")
					if err != nil {
						return err
					}
					height = value
					haveHeight = true
				}
				return nil
			},
		)
	}); err != nil {
		return recoveryMVPSinglePaneDockviewGrid{}, err
	}
	if !haveRoot || !haveOrientation || !haveWidth || !haveHeight {
		return recoveryMVPSinglePaneDockviewGrid{}, fmt.Errorf(
			"%w: one-pane dockview grid requires root, orientation, width, and height",
			ErrRecoveryStoreInvalid,
		)
	}
	if _, err := recoveryDockviewFrozenOrientation(orientation); err != nil {
		return recoveryMVPSinglePaneDockviewGrid{}, err
	}
	if _, err := recoveryDockviewExtent(width, "one-pane dockview width"); err != nil {
		return recoveryMVPSinglePaneDockviewGrid{}, err
	}
	if _, err := recoveryDockviewExtent(height, "one-pane dockview height"); err != nil {
		return recoveryMVPSinglePaneDockviewGrid{}, err
	}

	leafData, err := recoveryMVPUnwrapSinglePaneDockviewRoot(rootData)
	if err != nil {
		return recoveryMVPSinglePaneDockviewGrid{}, err
	}
	state := recoveryDockviewDecodeState{
		workspaceID: workspaceID,
		groups:      make(map[string]struct{}),
		views:       make(map[RecoveryPaneRef]struct{}),
	}
	leaf, err := recoveryDockviewDecodeNode(leafData, 1, &state)
	if err != nil {
		return recoveryMVPSinglePaneDockviewGrid{}, err
	}
	if leaf.kind != "leaf" || len(leaf.views) != 1 || leaf.views[0] != paneRef || leaf.activeView != paneRef {
		return recoveryMVPSinglePaneDockviewGrid{}, fmt.Errorf(
			"%w: one-pane dockview leaf does not match its pane",
			ErrRecoveryStoreInvalid,
		)
	}
	return recoveryMVPSinglePaneDockviewGrid{
		root:        leafData,
		orientation: orientation,
		width:       width,
		height:      height,
		groupID:     leaf.groupID,
	}, nil
}

func recoveryMVPUnwrapSinglePaneDockviewRoot(data []byte) (json.RawMessage, error) {
	var nodeType string
	var branchData json.RawMessage
	var size uint64
	var haveType, haveData, haveSize bool
	if err := recoveryDockviewParseOne(data, "one-pane dockview root", func(decoder *json.Decoder) error {
		return recoveryDockviewObject(
			decoder,
			"one-pane dockview root",
			recoveryDockviewNodeKey,
			func(key string) error {
				switch key {
				case "type":
					value, err := recoveryDockviewString(decoder, "one-pane dockview root type")
					if err != nil {
						return err
					}
					nodeType = value
					haveType = true
				case "data":
					value, err := recoveryDockviewRawValue(decoder, "one-pane dockview root data")
					if err != nil {
						return err
					}
					branchData = value
					haveData = true
				case "size":
					value, err := recoveryDockviewPositiveNumber(decoder, "one-pane dockview root size")
					if err != nil {
						return err
					}
					size = value
					haveSize = true
				}
				return nil
			},
		)
	}); err != nil {
		return nil, err
	}
	if !haveType || !haveData || !haveSize || nodeType != "branch" {
		return nil, fmt.Errorf("%w: one-pane dockview root must be a sized branch", ErrRecoveryStoreInvalid)
	}
	if _, err := recoveryDockviewExtent(size, "one-pane dockview root size"); err != nil {
		return nil, err
	}

	var child json.RawMessage
	if err := recoveryDockviewParseOne(branchData, "one-pane dockview branch", func(decoder *json.Decoder) error {
		token, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("%w: decode one-pane dockview branch: %v", ErrRecoveryStoreInvalid, err)
		}
		delimiter, ok := token.(json.Delim)
		if !ok || delimiter != '[' || !decoder.More() {
			return fmt.Errorf("%w: one-pane dockview branch must contain one child", ErrRecoveryStoreInvalid)
		}
		value, err := recoveryDockviewRawValue(decoder, "one-pane dockview branch child")
		if err != nil {
			return err
		}
		child = value
		if decoder.More() {
			return fmt.Errorf("%w: one-pane dockview branch must contain one child", ErrRecoveryStoreInvalid)
		}
		token, err = decoder.Token()
		if err != nil {
			return fmt.Errorf("%w: decode one-pane dockview branch terminator: %v", ErrRecoveryStoreInvalid, err)
		}
		delimiter, ok = token.(json.Delim)
		if !ok || delimiter != ']' {
			return fmt.Errorf("%w: one-pane dockview branch is not an array", ErrRecoveryStoreInvalid)
		}
		return nil
	}); err != nil {
		return nil, err
	}
	return child, nil
}

func recoveryMVPValidateSinglePaneDockviewPanels(data []byte, pane RecoveryPane) error {
	expectedID := fmt.Sprintf("%d", pane.Ref.PaneID)
	count := 0
	if err := recoveryDockviewParseOne(data, "one-pane dockview panels", func(decoder *json.Decoder) error {
		token, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("%w: decode one-pane dockview panels: %v", ErrRecoveryStoreInvalid, err)
		}
		delimiter, ok := token.(json.Delim)
		if !ok || delimiter != '{' {
			return fmt.Errorf("%w: one-pane dockview panels must be an object", ErrRecoveryStoreInvalid)
		}
		for decoder.More() {
			if count != 0 {
				return fmt.Errorf("%w: one-pane dockview panels must contain one panel", ErrRecoveryStoreInvalid)
			}
			token, err := decoder.Token()
			if err != nil {
				return fmt.Errorf("%w: decode one-pane dockview panel key: %v", ErrRecoveryStoreInvalid, err)
			}
			key, ok := token.(string)
			if !ok || key != expectedID {
				return fmt.Errorf("%w: one-pane dockview panel key differs from its pane", ErrRecoveryStoreInvalid)
			}
			raw, err := recoveryDockviewRawValue(decoder, "one-pane dockview panel")
			if err != nil {
				return err
			}
			if err := recoveryMVPValidateSinglePaneDockviewPanel(raw, expectedID, pane); err != nil {
				return err
			}
			count++
		}
		token, err = decoder.Token()
		if err != nil {
			return fmt.Errorf("%w: decode one-pane dockview panels terminator: %v", ErrRecoveryStoreInvalid, err)
		}
		delimiter, ok = token.(json.Delim)
		if !ok || delimiter != '}' {
			return fmt.Errorf("%w: one-pane dockview panels are not an object", ErrRecoveryStoreInvalid)
		}
		return nil
	}); err != nil {
		return err
	}
	if count != 1 {
		return fmt.Errorf("%w: one-pane dockview panels must contain one panel", ErrRecoveryStoreInvalid)
	}
	return nil
}

func recoveryMVPValidateSinglePaneDockviewPanel(data []byte, expectedID string, pane RecoveryPane) error {
	var id, title, contentComponent, tabComponent string
	var haveID, haveTitle, haveContentComponent, haveTabComponent bool
	if err := recoveryDockviewParseOne(data, "one-pane dockview panel", func(decoder *json.Decoder) error {
		return recoveryDockviewObject(
			decoder,
			"one-pane dockview panel",
			func(key string) bool {
				switch key {
				case "id", "title", "contentComponent", "tabComponent":
					return true
				default:
					return false
				}
			},
			func(key string) error {
				value, err := recoveryDockviewString(decoder, "one-pane dockview panel field")
				if err != nil {
					return err
				}
				switch key {
				case "id":
					id = value
					haveID = true
				case "title":
					title = value
					haveTitle = true
				case "contentComponent":
					contentComponent = value
					haveContentComponent = true
				case "tabComponent":
					tabComponent = value
					haveTabComponent = true
				}
				return nil
			},
		)
	}); err != nil {
		return err
	}
	if !haveID || !haveTitle || !haveContentComponent || !haveTabComponent {
		return fmt.Errorf("%w: one-pane dockview panel is incomplete", ErrRecoveryStoreInvalid)
	}
	if id != expectedID ||
		title != pane.Title ||
		contentComponent != string(pane.Surface) ||
		tabComponent != "mux-intent-tab" {
		return fmt.Errorf("%w: one-pane dockview panel metadata does not match its pane", ErrRecoveryStoreInvalid)
	}
	return nil
}

func (m *recoveryMVP) paneLocked(ref RecoveryPaneRef) (RecoveryPane, bool) {
	for _, pane := range m.snapshot.Panes {
		if pane.Ref == ref {
			return pane, true
		}
	}
	return RecoveryPane{}, false
}

func (m *recoveryMVP) hasPane(workspaceID string, paneID int) bool {
	if paneID <= 0 || uint64(paneID) > uint64(^RecoveryPaneID(0)) {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.paneLocked(RecoveryPaneRef{
		WorkspaceID: RecoveryWorkspaceID(workspaceID),
		PaneID:      RecoveryPaneID(paneID),
	})
	return ok
}

func (m *recoveryMVP) panesForWorkspaceLocked(workspaceID RecoveryWorkspaceID) []RecoveryPane {
	panes := make([]RecoveryPane, 0)
	for _, pane := range m.snapshot.Panes {
		if pane.Ref.WorkspaceID == workspaceID {
			panes = append(panes, pane)
		}
	}
	return panes
}

// commitLocked applies the candidate locally first so a malformed candidate
// cannot become a journal mutation. The store is then the only authority for
// advancing the generation; the cached snapshot changes only after its commit.
func (m *recoveryMVP) commitLocked(mutation RecoveryMutation) error {
	if m.closed {
		return errRecoveryMVPMutation
	}
	candidate, err := ApplyRecoveryMutation(m.snapshot, mutation)
	if err != nil {
		return errRecoveryMVPMutation
	}
	committed, err := m.store.Commit(m.snapshot.Generation, mutation)
	if err != nil || committed.Generation != candidate.Generation {
		if err == nil {
			m.closed = true
		}
		return errRecoveryMVPMutation
	}
	m.snapshot = candidate
	return nil
}

// handleTerminalData records completed LF-delimited lines before exposing the
// chunk which completed them. Fragments remain live so prompts and typed input
// stay usable, while the retained per-pane line prefix can never exceed the
// store's hard line ceiling.
func (m *recoveryMVP) handleTerminalData(s *Server, workspaceID string, paneID int, data []byte) {
	if len(data) == 0 {
		return
	}
	ref := RecoveryPaneRef{
		WorkspaceID: RecoveryWorkspaceID(workspaceID),
		PaneID:      RecoveryPaneID(paneID),
	}

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		s.broadcastPaneData(workspaceID, paneID, data)
		return
	}
	partial := m.partials[ref]
	completed := make([]string, 0)
	maximum := DefaultRecoveryStoreOptions().MaxHistoryLineBytes
	for _, value := range data {
		if value == '\n' {
			// FlushHistory owns sanitization. The input is a completed line
			// boundary, never a persisted raw PTY frame.
			completed = append(completed, string(partial.data))
			partial.data = nil
			partial.truncated = false
			continue
		}
		if !partial.truncated {
			if len(partial.data) < maximum {
				partial.data = append(partial.data, value)
			} else {
				partial.truncated = true
			}
		}
	}
	m.partials[ref] = partial

	if len(completed) != 0 && !m.historyFault {
		if _, err := m.store.FlushHistory(ref, completed); err != nil {
			m.historyFault = true
			log.Printf("sessiond recovery: history persistence failed")
		}
	}
	m.mu.Unlock()
	s.broadcastPaneData(workspaceID, paneID, data)
}

func (m *recoveryMVP) enqueueRecoveredHistory(c *conn, workspaceID string, paneIDs []int) {
	for _, paneID := range paneIDs {
		history, ok := m.history[RecoveryPaneRef{
			WorkspaceID: RecoveryWorkspaceID(workspaceID),
			PaneID:      RecoveryPaneID(paneID),
		}]
		if !ok || history.Text == "" {
			continue
		}
		copy := history
		c.sub.enqueueControl(&Message{
			Type:             TypeRecoveredHistory,
			RecoveredHistory: &copy,
		})
	}
}

func (m *recoveryMVP) close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.storeClosed {
		return nil
	}
	m.closed = true
	m.storeClosed = true
	return m.store.Close()
}

func recoveryMVPHistoricalLiterals(
	history []recoveryHistoryPlan,
) (map[RecoveryPaneRef]RecoveredHistoryLiteral, error) {
	linesByPane := make(map[RecoveryPaneRef][]string)
	for _, segment := range history {
		linesByPane[segment.pane] = append(linesByPane[segment.pane], segment.lines...)
	}
	literals := make(map[RecoveryPaneRef]RecoveredHistoryLiteral, len(linesByPane))
	for pane, lines := range linesByPane {
		literal, ok := recoveryMVPHistoricalLiteral(pane, lines)
		if !ok {
			continue
		}
		if err := ValidateRecoveryContract(literal); err != nil {
			return nil, errRecoveryMVPStartup
		}
		literals[pane] = literal
	}
	return literals, nil
}

// recoveryMVPHistoricalLiteral turns complete, already-sanitized store lines
// into the stricter browser event bound. It retains a contiguous newest suffix
// and never splits an encoded UTF-8 rune.
func recoveryMVPHistoricalLiteral(
	pane RecoveryPaneRef,
	lines []string,
) (RecoveredHistoryLiteral, bool) {
	selected := make([]string, 0, RecoveryMaxRecoveredHistoryLines)
	bytesUsed := 0
	truncated := false
	for index := len(lines) - 1; index >= 0; index-- {
		if len(selected) == RecoveryMaxRecoveredHistoryLines {
			truncated = true
			break
		}
		line := SanitizeRecoveryHistoryLine(lines[index])
		available := RecoveryMaxRecoveredHistoryBytes - bytesUsed - 1 // trailing LF
		if available < 0 {
			truncated = true
			break
		}
		if len(line) > available {
			if len(selected) == 0 && available > 0 {
				line = recoveryMVPTrimUTF8Suffix(line, available)
				selected = append(selected, line)
				bytesUsed += len(line) + 1
			}
			truncated = true
			break
		}
		selected = append(selected, line)
		bytesUsed += len(line) + 1
	}
	if len(selected) == 0 {
		return RecoveredHistoryLiteral{}, false
	}

	text := make([]byte, 0, bytesUsed)
	for index := len(selected) - 1; index >= 0; index-- {
		text = append(text, selected[index]...)
		text = append(text, '\n')
	}
	if len(selected) != len(lines) {
		truncated = true
	}
	return RecoveredHistoryLiteral{
		Pane:      pane,
		Text:      string(text),
		Truncated: truncated,
	}, true
}

func recoveryMVPTrimUTF8Suffix(value string, maximum int) string {
	if maximum <= 0 || value == "" {
		return ""
	}
	if len(value) <= maximum {
		return value
	}
	start := len(value) - maximum
	for start < len(value) && !utf8.RuneStart(value[start]) {
		start++
	}
	if start == len(value) {
		return ""
	}
	return value[start:]
}
