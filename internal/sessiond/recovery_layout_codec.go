package sessiond

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math/bits"
	"sort"
	"strconv"
	"unicode/utf8"
)

// recoveryDockviewNode is the strict wire shape before it is converted into
// the closed RecoveryLayout model. It deliberately contains no arbitrary
// component data or browser state.
type recoveryDockviewNode struct {
	kind       string
	size       uint64
	groupID    string
	views      []RecoveryPaneRef
	activeView RecoveryPaneRef
	children   []recoveryDockviewNode
}

type recoveryDockviewGrid struct {
	root        recoveryDockviewNode
	orientation RecoveryLayoutOrientation
	width       uint32
	height      uint32
}

type recoveryDockviewPanel struct {
	id               RecoveryPaneID
	title            string
	contentComponent string
}

type recoveryDockviewDecodeState struct {
	workspaceID RecoveryWorkspaceID
	nodes       int
	groups      map[string]struct{}
	views       map[RecoveryPaneRef]struct{}
}

type recoveryDockviewRectangularState struct {
	workspaceID RecoveryWorkspaceID
	panes       map[RecoveryPaneRef]RecoveryPane
	nodes       int
	groups      map[string]struct{}
	views       map[RecoveryPaneRef]struct{}
}

// decodeRecoveryDockviewLayout converts the deliberately small supported
// Dockview grammar into the frozen RecoveryLayout representation. It never
// accepts generic Dockview component state.
func decodeRecoveryDockviewLayout(
	workspaceID RecoveryWorkspaceID,
	breakpoint string,
	data []byte,
	panes []RecoveryPane,
) (RecoveryLayout, error) {
	if len(data) == 0 || len(data) > RecoveryStoreMaxLayoutBytes || !utf8.Valid(data) {
		return RecoveryLayout{}, fmt.Errorf("%w: dockview layout is not bounded UTF-8 JSON", ErrRecoveryStoreInvalid)
	}
	if err := validateRecoveryWorkspaceID(workspaceID); err != nil {
		return RecoveryLayout{}, err
	}
	if err := validateRecoveryStoreText(
		breakpoint,
		RecoveryStoreMaxBreakpointBytes,
		"dockview layout breakpoint",
		false,
	); err != nil {
		return RecoveryLayout{}, err
	}

	suppliedPanesByRef, err := recoveryDockviewPaneIndex(workspaceID, panes)
	if err != nil {
		return RecoveryLayout{}, err
	}

	var gridData json.RawMessage
	var panelsData json.RawMessage
	var activeGroup string
	var haveGrid, havePanels, haveActiveGroup bool
	if err := recoveryDockviewParseOne(data, "dockview layout", func(decoder *json.Decoder) error {
		return recoveryDockviewObject(
			decoder,
			"dockview layout",
			recoveryDockviewTopKey,
			func(key string) error {
				switch key {
				case "grid":
					value, err := recoveryDockviewRawValue(decoder, "dockview grid")
					if err != nil {
						return err
					}
					gridData = value
					haveGrid = true
				case "panels":
					value, err := recoveryDockviewRawValue(decoder, "dockview panels")
					if err != nil {
						return err
					}
					panelsData = value
					havePanels = true
				case "activeGroup":
					value, err := recoveryDockviewString(decoder, "dockview active group")
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
		return RecoveryLayout{}, err
	}
	if !haveGrid || !havePanels {
		return RecoveryLayout{}, fmt.Errorf("%w: dockview layout requires grid and panels", ErrRecoveryStoreInvalid)
	}

	state := recoveryDockviewDecodeState{
		workspaceID: workspaceID,
		groups:      make(map[string]struct{}),
		views:       make(map[RecoveryPaneRef]struct{}),
	}
	grid, err := recoveryDockviewDecodeGrid(gridData, &state)
	if err != nil {
		return RecoveryLayout{}, err
	}
	panelsByRef, err := recoveryDockviewDecodePanels(panelsData, workspaceID, suppliedPanesByRef)
	if err != nil {
		return RecoveryLayout{}, err
	}
	if len(panelsByRef) != len(state.views) || len(panelsByRef) != len(suppliedPanesByRef) {
		return RecoveryLayout{}, fmt.Errorf("%w: supplied pane, dockview panel, and view sets differ", ErrRecoveryStoreInvalid)
	}
	for pane := range state.views {
		if _, ok := panelsByRef[pane]; !ok {
			return RecoveryLayout{}, fmt.Errorf("%w: dockview view has no matching panel", ErrRecoveryStoreInvalid)
		}
		if _, ok := suppliedPanesByRef[pane]; !ok {
			return RecoveryLayout{}, fmt.Errorf("%w: dockview view has no matching supplied pane", ErrRecoveryStoreInvalid)
		}
	}
	for pane := range panelsByRef {
		if _, ok := state.views[pane]; !ok {
			return RecoveryLayout{}, fmt.Errorf("%w: dockview panel has no matching view", ErrRecoveryStoreInvalid)
		}
		if _, ok := suppliedPanesByRef[pane]; !ok {
			return RecoveryLayout{}, fmt.Errorf("%w: dockview panel has no matching supplied pane", ErrRecoveryStoreInvalid)
		}
	}
	for pane := range suppliedPanesByRef {
		if _, ok := state.views[pane]; !ok {
			return RecoveryLayout{}, fmt.Errorf("%w: supplied pane has no matching dockview view", ErrRecoveryStoreInvalid)
		}
		if _, ok := panelsByRef[pane]; !ok {
			return RecoveryLayout{}, fmt.Errorf("%w: supplied pane has no matching dockview panel", ErrRecoveryStoreInvalid)
		}
	}
	if haveActiveGroup {
		if err := validateRecoveryStoreText(
			activeGroup,
			RecoveryStoreMaxLayoutGroupBytes,
			"dockview active group",
			true,
		); err != nil {
			return RecoveryLayout{}, err
		}
		if _, ok := state.groups[activeGroup]; !ok {
			return RecoveryLayout{}, fmt.Errorf("%w: dockview active group is missing", ErrRecoveryStoreInvalid)
		}
	}

	rootGeometry := RecoveryLayoutGeometry{
		Width:  grid.width,
		Height: grid.height,
	}
	root, err := recoveryDockviewFreezeNode(
		grid.root,
		rootGeometry,
		uint32(RecoveryStoreLayoutRatioScale),
		grid.orientation,
	)
	if err != nil {
		return RecoveryLayout{}, err
	}
	layout := RecoveryLayout{
		WorkspaceID: workspaceID,
		Breakpoint:  breakpoint,
		Root:        root,
	}
	if haveActiveGroup {
		layout.ActiveGroup = activeGroup
	}
	return canonicalRecoveryDockviewLayout(layout, panes)
}

// encodeRecoveryDockviewLayout validates the frozen model before producing a
// deterministic closed Dockview document. Titles and components always come
// from pane metadata rather than any wire value retained by the model.
func encodeRecoveryDockviewLayout(layout RecoveryLayout, panes []RecoveryPane) ([]byte, error) {
	canonical, err := canonicalRecoveryDockviewLayout(layout, panes)
	if err != nil {
		return nil, err
	}
	panesByRef, err := recoveryDockviewPaneIndex(canonical.WorkspaceID, panes)
	if err != nil {
		return nil, err
	}

	views := make([]RecoveryPaneRef, 0)
	recoveryDockviewCollectLayoutViews(canonical.Root, &views)
	sort.Slice(views, func(left, right int) bool {
		return recoveryPaneRefLess(views[left], views[right])
	})

	var output bytes.Buffer
	output.WriteString(`{"grid":{"root":`)
	if err := recoveryDockviewWriteNode(&output, canonical.Root); err != nil {
		return nil, err
	}
	output.WriteString(`,"orientation":`)
	orientation := RecoveryLayoutHorizontal
	if canonical.Root.Kind == RecoveryLayoutNodeSplit {
		orientation = canonical.Root.Orientation
	} else {
		// RecoveryLayout has no root-group orientation; a single leaf is HORIZONTAL.
	}
	if err := recoveryDockviewWriteQuoted(&output, recoveryDockviewWireOrientation(orientation)); err != nil {
		return nil, err
	}
	output.WriteString(`,"width":`)
	output.WriteString(strconv.FormatUint(uint64(canonical.Root.Geometry.Width), 10))
	output.WriteString(`,"height":`)
	output.WriteString(strconv.FormatUint(uint64(canonical.Root.Geometry.Height), 10))
	output.WriteString(`},"panels":{`)
	for index, paneRef := range views {
		if index > 0 {
			output.WriteByte(',')
		}
		pane, ok := panesByRef[paneRef]
		if !ok {
			return nil, fmt.Errorf("%w: dockview layout panel metadata is missing", ErrRecoveryStoreInvalid)
		}
		id := strconv.FormatUint(uint64(paneRef.PaneID), 10)
		if err := recoveryDockviewWriteQuoted(&output, id); err != nil {
			return nil, err
		}
		output.WriteString(`:{"id":`)
		if err := recoveryDockviewWriteQuoted(&output, id); err != nil {
			return nil, err
		}
		output.WriteString(`,"title":`)
		if err := recoveryDockviewWriteQuoted(&output, pane.Title); err != nil {
			return nil, err
		}
		output.WriteString(`,"contentComponent":`)
		if err := recoveryDockviewWriteQuoted(&output, string(pane.Surface)); err != nil {
			return nil, err
		}
		output.WriteByte('}')
	}
	output.WriteByte('}')
	if canonical.ActiveGroup != "" {
		output.WriteString(`,"activeGroup":`)
		if err := recoveryDockviewWriteQuoted(&output, canonical.ActiveGroup); err != nil {
			return nil, err
		}
	}
	output.WriteByte('}')

	if output.Len() > RecoveryStoreMaxLayoutBytes {
		return nil, fmt.Errorf("%w: encoded dockview layout exceeds its byte bound", ErrRecoveryStoreInvalid)
	}
	return append([]byte(nil), output.Bytes()...), nil
}

func recoveryDockviewDecodeGrid(
	data []byte,
	state *recoveryDockviewDecodeState,
) (recoveryDockviewGrid, error) {
	var rootData json.RawMessage
	var orientation string
	var width, height uint64
	var haveRoot, haveOrientation, haveWidth, haveHeight bool
	if err := recoveryDockviewParseOne(data, "dockview grid", func(decoder *json.Decoder) error {
		return recoveryDockviewObject(
			decoder,
			"dockview grid",
			recoveryDockviewGridKey,
			func(key string) error {
				switch key {
				case "root":
					value, err := recoveryDockviewRawValue(decoder, "dockview grid root")
					if err != nil {
						return err
					}
					rootData = value
					haveRoot = true
				case "orientation":
					value, err := recoveryDockviewString(decoder, "dockview grid orientation")
					if err != nil {
						return err
					}
					orientation = value
					haveOrientation = true
				case "width":
					value, err := recoveryDockviewPositiveNumber(decoder, "dockview grid width")
					if err != nil {
						return err
					}
					width = value
					haveWidth = true
				case "height":
					value, err := recoveryDockviewPositiveNumber(decoder, "dockview grid height")
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
		return recoveryDockviewGrid{}, err
	}
	if !haveRoot || !haveOrientation {
		return recoveryDockviewGrid{}, fmt.Errorf("%w: dockview grid requires root and orientation", ErrRecoveryStoreInvalid)
	}
	if haveWidth != haveHeight {
		return recoveryDockviewGrid{}, fmt.Errorf("%w: dockview grid width and height must appear together", ErrRecoveryStoreInvalid)
	}
	frozenOrientation, err := recoveryDockviewFrozenOrientation(orientation)
	if err != nil {
		return recoveryDockviewGrid{}, err
	}
	root, err := recoveryDockviewDecodeNode(rootData, 1, state)
	if err != nil {
		return recoveryDockviewGrid{}, err
	}

	var geometryWidth, geometryHeight uint32
	if haveWidth {
		geometryWidth, err = recoveryDockviewExtent(width, "dockview grid width")
		if err != nil {
			return recoveryDockviewGrid{}, err
		}
		geometryHeight, err = recoveryDockviewExtent(height, "dockview grid height")
		if err != nil {
			return recoveryDockviewGrid{}, err
		}
	} else {
		geometryWidth, err = recoveryDockviewExtent(root.size, "dockview root size")
		if err != nil {
			return recoveryDockviewGrid{}, err
		}
		geometryHeight = geometryWidth
	}
	return recoveryDockviewGrid{
		root:        root,
		orientation: frozenOrientation,
		width:       geometryWidth,
		height:      geometryHeight,
	}, nil
}

func recoveryDockviewDecodeNode(
	data []byte,
	depth int,
	state *recoveryDockviewDecodeState,
) (recoveryDockviewNode, error) {
	if depth > recoveryStoreMaxLayoutDepth {
		return recoveryDockviewNode{}, fmt.Errorf("%w: dockview layout exceeds its nesting bound", ErrRecoveryStoreInvalid)
	}
	state.nodes++
	if state.nodes > recoveryStoreMaxLayoutNodes {
		return recoveryDockviewNode{}, fmt.Errorf("%w: dockview layout exceeds its node bound", ErrRecoveryStoreInvalid)
	}

	var nodeType string
	var nodeData json.RawMessage
	var size uint64
	var haveType, haveData, haveSize bool
	if err := recoveryDockviewParseOne(data, "dockview node", func(decoder *json.Decoder) error {
		return recoveryDockviewObject(
			decoder,
			"dockview node",
			recoveryDockviewNodeKey,
			func(key string) error {
				switch key {
				case "type":
					value, err := recoveryDockviewString(decoder, "dockview node type")
					if err != nil {
						return err
					}
					nodeType = value
					haveType = true
				case "data":
					value, err := recoveryDockviewRawValue(decoder, "dockview node data")
					if err != nil {
						return err
					}
					nodeData = value
					haveData = true
				case "size":
					value, err := recoveryDockviewPositiveNumber(decoder, "dockview node size")
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
		return recoveryDockviewNode{}, err
	}
	if !haveType || !haveData || !haveSize {
		return recoveryDockviewNode{}, fmt.Errorf("%w: dockview node requires type, data, and size", ErrRecoveryStoreInvalid)
	}

	node := recoveryDockviewNode{kind: nodeType, size: size}
	switch nodeType {
	case "leaf":
		groupID, views, activeView, err := recoveryDockviewDecodeLeaf(nodeData, state.workspaceID)
		if err != nil {
			return recoveryDockviewNode{}, err
		}
		if _, duplicate := state.groups[groupID]; duplicate {
			return recoveryDockviewNode{}, fmt.Errorf("%w: duplicate dockview group ID", ErrRecoveryStoreInvalid)
		}
		if len(state.groups) >= RecoveryStoreMaxPanes {
			return recoveryDockviewNode{}, fmt.Errorf("%w: dockview groups exceed their pane bound", ErrRecoveryStoreInvalid)
		}
		if len(views) > RecoveryStoreMaxPanes-len(state.views) {
			return recoveryDockviewNode{}, fmt.Errorf("%w: dockview views exceed their pane bound", ErrRecoveryStoreInvalid)
		}
		leafViews := make(map[RecoveryPaneRef]struct{}, len(views))
		for _, pane := range views {
			if _, duplicate := state.views[pane]; duplicate {
				return recoveryDockviewNode{}, fmt.Errorf("%w: duplicate dockview view", ErrRecoveryStoreInvalid)
			}
			if _, duplicate := leafViews[pane]; duplicate {
				return recoveryDockviewNode{}, fmt.Errorf("%w: duplicate dockview view", ErrRecoveryStoreInvalid)
			}
			leafViews[pane] = struct{}{}
		}
		activeFound := false
		for _, pane := range views {
			if pane == activeView {
				activeFound = true
			}
		}
		if !activeFound {
			return recoveryDockviewNode{}, fmt.Errorf("%w: dockview active view is not in its group", ErrRecoveryStoreInvalid)
		}
		state.groups[groupID] = struct{}{}
		for _, pane := range views {
			state.views[pane] = struct{}{}
		}
		node.groupID = groupID
		node.views = append([]RecoveryPaneRef(nil), views...)
		node.activeView = activeView
	case "branch":
		children, err := recoveryDockviewDecodeBranch(nodeData, depth, state)
		if err != nil {
			return recoveryDockviewNode{}, err
		}
		node.children = children
	default:
		return recoveryDockviewNode{}, fmt.Errorf("%w: dockview node type is invalid", ErrRecoveryStoreInvalid)
	}
	return node, nil
}

func recoveryDockviewDecodeLeaf(
	data []byte,
	workspaceID RecoveryWorkspaceID,
) (string, []RecoveryPaneRef, RecoveryPaneRef, error) {
	var groupID string
	var viewsData json.RawMessage
	var activeView string
	var haveID, haveViews, haveActiveView bool
	if err := recoveryDockviewParseOne(data, "dockview leaf", func(decoder *json.Decoder) error {
		return recoveryDockviewObject(
			decoder,
			"dockview leaf",
			recoveryDockviewLeafKey,
			func(key string) error {
				switch key {
				case "id":
					value, err := recoveryDockviewString(decoder, "dockview group ID")
					if err != nil {
						return err
					}
					groupID = value
					haveID = true
				case "views":
					value, err := recoveryDockviewRawValue(decoder, "dockview views")
					if err != nil {
						return err
					}
					viewsData = value
					haveViews = true
				case "activeView":
					value, err := recoveryDockviewString(decoder, "dockview active view")
					if err != nil {
						return err
					}
					activeView = value
					haveActiveView = true
				}
				return nil
			},
		)
	}); err != nil {
		return "", nil, RecoveryPaneRef{}, err
	}
	if !haveID || !haveViews || !haveActiveView {
		return "", nil, RecoveryPaneRef{}, fmt.Errorf("%w: dockview leaf requires id, views, and active view", ErrRecoveryStoreInvalid)
	}
	if err := validateRecoveryStoreText(groupID, RecoveryStoreMaxLayoutGroupBytes, "dockview group ID", true); err != nil {
		return "", nil, RecoveryPaneRef{}, err
	}
	views, err := recoveryDockviewDecodeViews(viewsData, workspaceID)
	if err != nil {
		return "", nil, RecoveryPaneRef{}, err
	}
	if len(views) == 0 {
		return "", nil, RecoveryPaneRef{}, fmt.Errorf("%w: dockview leaf has no views", ErrRecoveryStoreInvalid)
	}
	activePaneID, err := recoveryDockviewPaneID(activeView, "dockview active view")
	if err != nil {
		return "", nil, RecoveryPaneRef{}, err
	}
	return groupID, views, RecoveryPaneRef{
		WorkspaceID: workspaceID,
		PaneID:      activePaneID,
	}, nil
}

func recoveryDockviewDecodeViews(data []byte, workspaceID RecoveryWorkspaceID) ([]RecoveryPaneRef, error) {
	views := make([]RecoveryPaneRef, 0)
	if err := recoveryDockviewParseOne(data, "dockview views", func(decoder *json.Decoder) error {
		token, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("%w: decode dockview views: %v", ErrRecoveryStoreInvalid, err)
		}
		delimiter, ok := token.(json.Delim)
		if !ok || delimiter != '[' {
			return fmt.Errorf("%w: dockview views must be an array", ErrRecoveryStoreInvalid)
		}
		for decoder.More() {
			if len(views) == RecoveryStoreMaxPanes {
				return fmt.Errorf("%w: dockview views exceed their pane bound", ErrRecoveryStoreInvalid)
			}
			value, err := recoveryDockviewString(decoder, "dockview view ID")
			if err != nil {
				return err
			}
			paneID, err := recoveryDockviewPaneID(value, "dockview view ID")
			if err != nil {
				return err
			}
			views = append(views, RecoveryPaneRef{
				WorkspaceID: workspaceID,
				PaneID:      paneID,
			})
		}
		token, err = decoder.Token()
		if err != nil {
			return fmt.Errorf("%w: decode dockview views terminator: %v", ErrRecoveryStoreInvalid, err)
		}
		delimiter, ok = token.(json.Delim)
		if !ok || delimiter != ']' {
			return fmt.Errorf("%w: dockview views are not an array", ErrRecoveryStoreInvalid)
		}
		return nil
	}); err != nil {
		return nil, err
	}
	return views, nil
}

func recoveryDockviewDecodeBranch(
	data []byte,
	depth int,
	state *recoveryDockviewDecodeState,
) ([]recoveryDockviewNode, error) {
	children := make([]recoveryDockviewNode, 0)
	if err := recoveryDockviewParseOne(data, "dockview branch", func(decoder *json.Decoder) error {
		token, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("%w: decode dockview branch: %v", ErrRecoveryStoreInvalid, err)
		}
		delimiter, ok := token.(json.Delim)
		if !ok || delimiter != '[' {
			return fmt.Errorf("%w: dockview branch data must be an array", ErrRecoveryStoreInvalid)
		}
		for decoder.More() {
			if len(children) == RecoveryStoreMaxPanes {
				return fmt.Errorf("%w: dockview branch exceeds its child bound", ErrRecoveryStoreInvalid)
			}
			raw, err := recoveryDockviewRawValue(decoder, "dockview branch child")
			if err != nil {
				return err
			}
			child, err := recoveryDockviewDecodeNode(raw, depth+1, state)
			if err != nil {
				return err
			}
			children = append(children, child)
		}
		token, err = decoder.Token()
		if err != nil {
			return fmt.Errorf("%w: decode dockview branch terminator: %v", ErrRecoveryStoreInvalid, err)
		}
		delimiter, ok = token.(json.Delim)
		if !ok || delimiter != ']' {
			return fmt.Errorf("%w: dockview branch data is not an array", ErrRecoveryStoreInvalid)
		}
		return nil
	}); err != nil {
		return nil, err
	}
	if len(children) < 2 {
		return nil, fmt.Errorf("%w: dockview branch requires at least two children", ErrRecoveryStoreInvalid)
	}
	return children, nil
}

func recoveryDockviewDecodePanels(
	data []byte,
	workspaceID RecoveryWorkspaceID,
	panes map[RecoveryPaneRef]RecoveryPane,
) (map[RecoveryPaneRef]struct{}, error) {
	panels := make(map[RecoveryPaneRef]struct{})
	if err := recoveryDockviewParseOne(data, "dockview panels", func(decoder *json.Decoder) error {
		token, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("%w: decode dockview panels: %v", ErrRecoveryStoreInvalid, err)
		}
		delimiter, ok := token.(json.Delim)
		if !ok || delimiter != '{' {
			return fmt.Errorf("%w: dockview panels must be an object", ErrRecoveryStoreInvalid)
		}
		for decoder.More() {
			token, err := decoder.Token()
			if err != nil {
				return fmt.Errorf("%w: decode dockview panel key: %v", ErrRecoveryStoreInvalid, err)
			}
			key, ok := token.(string)
			if !ok {
				return fmt.Errorf("%w: dockview panel key is not a string", ErrRecoveryStoreInvalid)
			}
			paneID, err := recoveryDockviewPaneID(key, "dockview panel map key")
			if err != nil {
				return err
			}
			paneRef := RecoveryPaneRef{WorkspaceID: workspaceID, PaneID: paneID}
			if _, duplicate := panels[paneRef]; duplicate {
				return fmt.Errorf("%w: duplicate dockview panel key", ErrRecoveryStoreInvalid)
			}
			if len(panels) == RecoveryStoreMaxPanes {
				return fmt.Errorf("%w: dockview panels exceed their pane bound", ErrRecoveryStoreInvalid)
			}
			raw, err := recoveryDockviewRawValue(decoder, "dockview panel")
			if err != nil {
				return err
			}
			panel, err := recoveryDockviewDecodePanel(raw)
			if err != nil {
				return err
			}
			if panel.id != paneID {
				return fmt.Errorf("%w: dockview panel key and ID differ", ErrRecoveryStoreInvalid)
			}
			pane, ok := panes[paneRef]
			if !ok {
				return fmt.Errorf("%w: dockview panel references an unknown pane", ErrRecoveryStoreInvalid)
			}
			if panel.title != pane.Title || panel.contentComponent != string(pane.Surface) {
				return fmt.Errorf("%w: dockview panel metadata does not match pane metadata", ErrRecoveryStoreInvalid)
			}
			panels[paneRef] = struct{}{}
		}
		token, err = decoder.Token()
		if err != nil {
			return fmt.Errorf("%w: decode dockview panels terminator: %v", ErrRecoveryStoreInvalid, err)
		}
		delimiter, ok = token.(json.Delim)
		if !ok || delimiter != '}' {
			return fmt.Errorf("%w: dockview panels are not an object", ErrRecoveryStoreInvalid)
		}
		return nil
	}); err != nil {
		return nil, err
	}
	return panels, nil
}

func recoveryDockviewDecodePanel(data []byte) (recoveryDockviewPanel, error) {
	var id, title, contentComponent string
	var haveID, haveTitle, haveContentComponent bool
	if err := recoveryDockviewParseOne(data, "dockview panel", func(decoder *json.Decoder) error {
		return recoveryDockviewObject(
			decoder,
			"dockview panel",
			recoveryDockviewPanelKey,
			func(key string) error {
				switch key {
				case "id":
					value, err := recoveryDockviewString(decoder, "dockview panel ID")
					if err != nil {
						return err
					}
					id = value
					haveID = true
				case "title":
					value, err := recoveryDockviewString(decoder, "dockview panel title")
					if err != nil {
						return err
					}
					title = value
					haveTitle = true
				case "contentComponent":
					value, err := recoveryDockviewString(decoder, "dockview panel content component")
					if err != nil {
						return err
					}
					contentComponent = value
					haveContentComponent = true
				}
				return nil
			},
		)
	}); err != nil {
		return recoveryDockviewPanel{}, err
	}
	if !haveID || !haveTitle || !haveContentComponent {
		return recoveryDockviewPanel{}, fmt.Errorf("%w: dockview panel requires id, title, and content component", ErrRecoveryStoreInvalid)
	}
	paneID, err := recoveryDockviewPaneID(id, "dockview panel ID")
	if err != nil {
		return recoveryDockviewPanel{}, err
	}
	return recoveryDockviewPanel{
		id:               paneID,
		title:            title,
		contentComponent: contentComponent,
	}, nil
}

func recoveryDockviewFreezeNode(
	node recoveryDockviewNode,
	geometry RecoveryLayoutGeometry,
	ratio uint32,
	orientation RecoveryLayoutOrientation,
) (RecoveryLayoutNode, error) {
	switch node.kind {
	case "leaf":
		active := node.activeView
		return RecoveryLayoutNode{
			Kind:       RecoveryLayoutNodeGroup,
			Geometry:   geometry,
			Ratio:      ratio,
			GroupID:    node.groupID,
			Views:      append([]RecoveryPaneRef(nil), node.views...),
			ActiveView: &active,
		}, nil
	case "branch":
		weights := make([]uint64, len(node.children))
		for index, child := range node.children {
			weights[index] = child.size
		}
		ratios, err := recoveryDockviewApportion(weights, uint64(RecoveryStoreLayoutRatioScale))
		if err != nil {
			return RecoveryLayoutNode{}, err
		}
		axis := uint64(geometry.Width)
		if orientation == RecoveryLayoutVertical {
			axis = uint64(geometry.Height)
		}
		extents, err := recoveryDockviewApportion(ratios, axis)
		if err != nil {
			return RecoveryLayoutNode{}, err
		}
		out := RecoveryLayoutNode{
			Kind:        RecoveryLayoutNodeSplit,
			Geometry:    geometry,
			Ratio:       ratio,
			Orientation: orientation,
			Children:    make([]RecoveryLayoutNode, len(node.children)),
		}
		cursorX, cursorY := uint64(geometry.X), uint64(geometry.Y)
		childOrientation := recoveryDockviewOppositeOrientation(orientation)
		for index, child := range node.children {
			childGeometry := geometry
			if orientation == RecoveryLayoutHorizontal {
				childGeometry.X = uint32(cursorX)
				childGeometry.Width = uint32(extents[index])
				cursorX += extents[index]
			} else {
				childGeometry.Y = uint32(cursorY)
				childGeometry.Height = uint32(extents[index])
				cursorY += extents[index]
			}
			frozen, err := recoveryDockviewFreezeNode(
				child,
				childGeometry,
				uint32(ratios[index]),
				childOrientation,
			)
			if err != nil {
				return RecoveryLayoutNode{}, err
			}
			out.Children[index] = frozen
		}
		return out, nil
	default:
		return RecoveryLayoutNode{}, fmt.Errorf("%w: dockview node type is invalid", ErrRecoveryStoreInvalid)
	}
}

// canonicalRecoveryDockviewLayout applies both the existing closed-model
// checks and the stricter deterministic rectangle partition checks.
func canonicalRecoveryDockviewLayout(layout RecoveryLayout, panes []RecoveryPane) (RecoveryLayout, error) {
	canonical, err := canonicalRecoveryLayout(layout)
	if err != nil {
		return RecoveryLayout{}, err
	}
	if err := validateRecoveryLayoutRectangularCanonical(canonical, panes); err != nil {
		return RecoveryLayout{}, err
	}
	return canonical, nil
}

// validateRecoveryLayoutRectangular validates a frozen layout independently of
// the Dockview wire decoder so reconstruction cannot accept a loose rectangle.
func validateRecoveryLayoutRectangular(layout RecoveryLayout, panes []RecoveryPane) error {
	canonical, err := canonicalRecoveryLayout(layout)
	if err != nil {
		return err
	}
	return validateRecoveryLayoutRectangularCanonical(canonical, panes)
}

func validateRecoveryLayoutRectangularCanonical(layout RecoveryLayout, panes []RecoveryPane) error {
	panesByRef, err := recoveryDockviewPaneIndex(layout.WorkspaceID, panes)
	if err != nil {
		return err
	}
	if layout.Root.Geometry.X != 0 || layout.Root.Geometry.Y != 0 {
		return fmt.Errorf("%w: layout root is not at the origin", ErrRecoveryStoreInvalid)
	}
	if layout.Root.Ratio != RecoveryStoreLayoutRatioScale {
		return fmt.Errorf("%w: layout root ratio must equal its scale", ErrRecoveryStoreInvalid)
	}

	state := recoveryDockviewRectangularState{
		workspaceID: layout.WorkspaceID,
		panes:       panesByRef,
		groups:      make(map[string]struct{}),
		views:       make(map[RecoveryPaneRef]struct{}),
	}
	orientation := RecoveryLayoutHorizontal
	if layout.Root.Kind == RecoveryLayoutNodeSplit {
		orientation = layout.Root.Orientation
	}
	if err := state.validateNode(layout.Root, layout.Root.Geometry, orientation, 1); err != nil {
		return err
	}
	if len(state.views) != len(state.panes) {
		return fmt.Errorf("%w: supplied pane and layout view sets differ", ErrRecoveryStoreInvalid)
	}
	for pane := range state.views {
		if _, ok := state.panes[pane]; !ok {
			return fmt.Errorf("%w: layout view has no matching supplied pane", ErrRecoveryStoreInvalid)
		}
	}
	for pane := range state.panes {
		if _, ok := state.views[pane]; !ok {
			return fmt.Errorf("%w: supplied pane has no matching layout view", ErrRecoveryStoreInvalid)
		}
	}
	if layout.ActiveGroup != "" {
		if _, ok := state.groups[layout.ActiveGroup]; !ok {
			return fmt.Errorf("%w: active layout group is missing", ErrRecoveryStoreInvalid)
		}
	}
	return nil
}

func (state *recoveryDockviewRectangularState) validateNode(
	node RecoveryLayoutNode,
	expectedGeometry RecoveryLayoutGeometry,
	expectedOrientation RecoveryLayoutOrientation,
	depth int,
) error {
	if depth > recoveryStoreMaxLayoutDepth {
		return fmt.Errorf("%w: layout exceeds its nesting bound", ErrRecoveryStoreInvalid)
	}
	state.nodes++
	if state.nodes > recoveryStoreMaxLayoutNodes {
		return fmt.Errorf("%w: layout exceeds its node bound", ErrRecoveryStoreInvalid)
	}
	if node.Geometry != expectedGeometry {
		return fmt.Errorf("%w: layout geometry is not a contiguous partition", ErrRecoveryStoreInvalid)
	}
	if err := validateRecoveryLayoutGeometry(node.Geometry); err != nil {
		return err
	}
	if node.Ratio == 0 || node.Ratio > RecoveryStoreLayoutRatioScale {
		return fmt.Errorf("%w: layout ratio is outside its bounded scale", ErrRecoveryStoreInvalid)
	}

	switch node.Kind {
	case RecoveryLayoutNodeSplit:
		if node.Orientation != expectedOrientation {
			return fmt.Errorf("%w: layout branch orientations do not alternate", ErrRecoveryStoreInvalid)
		}
		if len(node.Children) < 2 || len(node.Children) > RecoveryStoreMaxPanes {
			return fmt.Errorf("%w: split layout child count is invalid", ErrRecoveryStoreInvalid)
		}
		if node.GroupID != "" || len(node.Views) != 0 || node.ActiveView != nil {
			return fmt.Errorf("%w: split layout contains group fields", ErrRecoveryStoreInvalid)
		}
		weights := make([]uint64, len(node.Children))
		var total uint64
		for index, child := range node.Children {
			if child.Ratio == 0 || child.Ratio > RecoveryStoreLayoutRatioScale {
				return fmt.Errorf("%w: split child ratio is outside its bounded scale", ErrRecoveryStoreInvalid)
			}
			weights[index] = uint64(child.Ratio)
			next, carry := bits.Add64(total, weights[index], 0)
			if carry != 0 || next > RecoveryStoreLayoutRatioScale {
				return fmt.Errorf("%w: split child ratios overflow their scale", ErrRecoveryStoreInvalid)
			}
			total = next
		}
		if total != RecoveryStoreLayoutRatioScale {
			return fmt.Errorf("%w: split child ratios do not sum to their scale", ErrRecoveryStoreInvalid)
		}
		axis := uint64(node.Geometry.Width)
		if node.Orientation == RecoveryLayoutVertical {
			axis = uint64(node.Geometry.Height)
		}
		extents, err := recoveryDockviewApportion(weights, axis)
		if err != nil {
			return err
		}
		cursorX, cursorY := uint64(node.Geometry.X), uint64(node.Geometry.Y)
		childOrientation := recoveryDockviewOppositeOrientation(node.Orientation)
		for index, child := range node.Children {
			expected := node.Geometry
			if node.Orientation == RecoveryLayoutHorizontal {
				expected.X = uint32(cursorX)
				expected.Width = uint32(extents[index])
				cursorX += extents[index]
			} else {
				expected.Y = uint32(cursorY)
				expected.Height = uint32(extents[index])
				cursorY += extents[index]
			}
			if err := state.validateNode(child, expected, childOrientation, depth+1); err != nil {
				return err
			}
		}
		return nil
	case RecoveryLayoutNodeGroup:
		if node.Orientation != "" || len(node.Children) != 0 {
			return fmt.Errorf("%w: group layout contains split fields", ErrRecoveryStoreInvalid)
		}
		if err := validateRecoveryStoreText(node.GroupID, RecoveryStoreMaxLayoutGroupBytes, "layout group ID", true); err != nil {
			return err
		}
		if _, duplicate := state.groups[node.GroupID]; duplicate {
			return fmt.Errorf("%w: duplicate layout group ID", ErrRecoveryStoreInvalid)
		}
		if len(node.Views) == 0 || len(node.Views) > RecoveryStoreMaxPanes {
			return fmt.Errorf("%w: layout group view count is invalid", ErrRecoveryStoreInvalid)
		}
		if node.ActiveView == nil {
			return fmt.Errorf("%w: layout group has no active view", ErrRecoveryStoreInvalid)
		}
		activeFound := false
		for _, pane := range node.Views {
			if err := pane.validateRecoveryContract(); err != nil {
				return invalidRecoveryStoreValue("layout view", err)
			}
			if pane.WorkspaceID != state.workspaceID {
				return fmt.Errorf("%w: layout view is outside its workspace", ErrRecoveryStoreInvalid)
			}
			if _, known := state.panes[pane]; !known {
				return fmt.Errorf("%w: layout view references an unknown pane", ErrRecoveryStoreInvalid)
			}
			if _, duplicate := state.views[pane]; duplicate {
				return fmt.Errorf("%w: duplicate pane view in layout", ErrRecoveryStoreInvalid)
			}
			if pane == *node.ActiveView {
				activeFound = true
			}
			state.views[pane] = struct{}{}
		}
		if !activeFound {
			return fmt.Errorf("%w: active layout view is not in its group", ErrRecoveryStoreInvalid)
		}
		state.groups[node.GroupID] = struct{}{}
		return nil
	default:
		return fmt.Errorf("%w: layout node kind is invalid", ErrRecoveryStoreInvalid)
	}
}

func recoveryDockviewPaneIndex(
	workspaceID RecoveryWorkspaceID,
	panes []RecoveryPane,
) (map[RecoveryPaneRef]RecoveryPane, error) {
	if err := validateRecoveryWorkspaceID(workspaceID); err != nil {
		return nil, err
	}
	if len(panes) > RecoveryStoreMaxPanes {
		return nil, fmt.Errorf("%w: pane metadata exceeds its pane bound", ErrRecoveryStoreInvalid)
	}
	index := make(map[RecoveryPaneRef]RecoveryPane, len(panes))
	for _, pane := range panes {
		canonical, err := canonicalRecoveryPane(pane)
		if err != nil {
			return nil, err
		}
		if canonical.Ref.WorkspaceID != workspaceID {
			return nil, fmt.Errorf("%w: pane metadata is outside its workspace", ErrRecoveryStoreInvalid)
		}
		if _, duplicate := index[canonical.Ref]; duplicate {
			return nil, fmt.Errorf("%w: duplicate pane metadata", ErrRecoveryStoreInvalid)
		}
		index[canonical.Ref] = canonical
	}
	return index, nil
}

func recoveryDockviewApportion(weights []uint64, target uint64) ([]uint64, error) {
	if len(weights) == 0 || target == 0 || uint64(len(weights)) > target {
		return nil, fmt.Errorf("%w: layout cannot apportion positive child sizes", ErrRecoveryStoreInvalid)
	}
	var denominator uint64
	for _, weight := range weights {
		if weight == 0 {
			return nil, fmt.Errorf("%w: layout child size is zero", ErrRecoveryStoreInvalid)
		}
		next, carry := bits.Add64(denominator, weight, 0)
		if carry != 0 {
			return nil, fmt.Errorf("%w: layout child sizes overflow", ErrRecoveryStoreInvalid)
		}
		denominator = next
	}
	if denominator == 0 {
		return nil, fmt.Errorf("%w: layout child sizes are empty", ErrRecoveryStoreInvalid)
	}

	type remainder struct {
		index int
		value uint64
	}
	shares := make([]uint64, len(weights))
	remainders := make([]remainder, len(weights))
	var allocated uint64
	for index, weight := range weights {
		high, low := bits.Mul64(weight, target)
		if high >= denominator {
			return nil, fmt.Errorf("%w: layout ratio multiplication overflows", ErrRecoveryStoreInvalid)
		}
		share, value := bits.Div64(high, low, denominator)
		next, carry := bits.Add64(allocated, share, 0)
		if carry != 0 || next > target {
			return nil, fmt.Errorf("%w: layout ratio allocation overflows", ErrRecoveryStoreInvalid)
		}
		allocated = next
		shares[index] = share
		remainders[index] = remainder{index: index, value: value}
	}
	remaining := target - allocated
	if remaining > uint64(len(remainders)) {
		return nil, fmt.Errorf("%w: layout ratio allocation is not a largest remainder partition", ErrRecoveryStoreInvalid)
	}
	sort.Slice(remainders, func(left, right int) bool {
		if remainders[left].value != remainders[right].value {
			return remainders[left].value > remainders[right].value
		}
		return remainders[left].index < remainders[right].index
	})
	for index := 0; index < int(remaining); index++ {
		shares[remainders[index].index]++
	}
	for _, share := range shares {
		if share == 0 {
			return nil, fmt.Errorf("%w: layout ratio cannot represent every child positively", ErrRecoveryStoreInvalid)
		}
	}
	return shares, nil
}

func recoveryDockviewCollectLayoutViews(node RecoveryLayoutNode, views *[]RecoveryPaneRef) {
	if node.Kind == RecoveryLayoutNodeGroup {
		*views = append(*views, node.Views...)
		return
	}
	for _, child := range node.Children {
		recoveryDockviewCollectLayoutViews(child, views)
	}
}

func recoveryDockviewWriteNode(output *bytes.Buffer, node RecoveryLayoutNode) error {
	switch node.Kind {
	case RecoveryLayoutNodeGroup:
		output.WriteString(`{"type":"leaf","data":{"id":`)
		if err := recoveryDockviewWriteQuoted(output, node.GroupID); err != nil {
			return err
		}
		output.WriteString(`,"views":[`)
		for index, pane := range node.Views {
			if index > 0 {
				output.WriteByte(',')
			}
			if err := recoveryDockviewWriteQuoted(output, strconv.FormatUint(uint64(pane.PaneID), 10)); err != nil {
				return err
			}
		}
		output.WriteString(`],"activeView":`)
		if node.ActiveView == nil {
			return fmt.Errorf("%w: layout group has no active view", ErrRecoveryStoreInvalid)
		}
		if err := recoveryDockviewWriteQuoted(output, strconv.FormatUint(uint64(node.ActiveView.PaneID), 10)); err != nil {
			return err
		}
		output.WriteString(`},"size":`)
		output.WriteString(strconv.FormatUint(uint64(node.Ratio), 10))
		output.WriteByte('}')
		return nil
	case RecoveryLayoutNodeSplit:
		output.WriteString(`{"type":"branch","data":[`)
		for index, child := range node.Children {
			if index > 0 {
				output.WriteByte(',')
			}
			if err := recoveryDockviewWriteNode(output, child); err != nil {
				return err
			}
		}
		output.WriteString(`],"size":`)
		output.WriteString(strconv.FormatUint(uint64(node.Ratio), 10))
		output.WriteByte('}')
		return nil
	default:
		return fmt.Errorf("%w: layout node kind is invalid", ErrRecoveryStoreInvalid)
	}
}

func recoveryDockviewWriteQuoted(output *bytes.Buffer, value string) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("%w: encode dockview string: %v", ErrRecoveryStoreInvalid, err)
	}
	output.Write(encoded)
	return nil
}

func recoveryDockviewParseOne(data []byte, scope string, parse func(*json.Decoder) error) error {
	if len(data) == 0 || len(data) > RecoveryStoreMaxLayoutBytes || !utf8.Valid(data) {
		return fmt.Errorf("%w: %s is not bounded UTF-8 JSON", ErrRecoveryStoreInvalid, scope)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := parse(decoder); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("%w: %s has a trailing JSON value", ErrRecoveryStoreInvalid, scope)
		}
		return fmt.Errorf("%w: decode trailing %s value: %v", ErrRecoveryStoreInvalid, scope, err)
	}
	return nil
}

func recoveryDockviewObject(
	decoder *json.Decoder,
	scope string,
	allowed func(string) bool,
	visit func(string) error,
) error {
	token, err := decoder.Token()
	if err != nil {
		return fmt.Errorf("%w: decode %s: %v", ErrRecoveryStoreInvalid, scope, err)
	}
	delimiter, ok := token.(json.Delim)
	if !ok || delimiter != '{' {
		return fmt.Errorf("%w: %s must be an object", ErrRecoveryStoreInvalid, scope)
	}
	seen := make(map[string]struct{})
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("%w: decode %s key: %v", ErrRecoveryStoreInvalid, scope, err)
		}
		key, ok := token.(string)
		if !ok {
			return fmt.Errorf("%w: %s key is not a string", ErrRecoveryStoreInvalid, scope)
		}
		if _, duplicate := seen[key]; duplicate {
			return fmt.Errorf("%w: duplicate %s key %q", ErrRecoveryStoreInvalid, scope, key)
		}
		seen[key] = struct{}{}
		if !allowed(key) {
			return fmt.Errorf("%w: unknown %s key %q", ErrRecoveryStoreInvalid, scope, key)
		}
		if err := visit(key); err != nil {
			return err
		}
	}
	token, err = decoder.Token()
	if err != nil {
		return fmt.Errorf("%w: decode %s terminator: %v", ErrRecoveryStoreInvalid, scope, err)
	}
	delimiter, ok = token.(json.Delim)
	if !ok || delimiter != '}' {
		return fmt.Errorf("%w: %s is not an object", ErrRecoveryStoreInvalid, scope)
	}
	return nil
}

func recoveryDockviewRawValue(decoder *json.Decoder, field string) (json.RawMessage, error) {
	var value json.RawMessage
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("%w: decode %s: %v", ErrRecoveryStoreInvalid, field, err)
	}
	return value, nil
}

func recoveryDockviewString(decoder *json.Decoder, field string) (string, error) {
	token, err := decoder.Token()
	if err != nil {
		return "", fmt.Errorf("%w: decode %s: %v", ErrRecoveryStoreInvalid, field, err)
	}
	value, ok := token.(string)
	if !ok {
		return "", fmt.Errorf("%w: %s must be a string", ErrRecoveryStoreInvalid, field)
	}
	return value, nil
}

func recoveryDockviewPositiveNumber(decoder *json.Decoder, field string) (uint64, error) {
	token, err := decoder.Token()
	if err != nil {
		return 0, fmt.Errorf("%w: decode %s: %v", ErrRecoveryStoreInvalid, field, err)
	}
	value, ok := token.(json.Number)
	if !ok {
		return 0, fmt.Errorf("%w: %s must be a positive integer", ErrRecoveryStoreInvalid, field)
	}
	return recoveryDockviewPositiveDecimal(string(value), ^uint64(0), field)
}

func recoveryDockviewPaneID(value string, field string) (RecoveryPaneID, error) {
	parsed, err := recoveryDockviewPositiveDecimal(value, uint64(^RecoveryPaneID(0)), field)
	if err != nil {
		return 0, err
	}
	return RecoveryPaneID(parsed), nil
}

func recoveryDockviewPositiveDecimal(value string, maximum uint64, field string) (uint64, error) {
	if len(value) == 0 || value[0] < '1' || value[0] > '9' {
		return 0, fmt.Errorf("%w: %s is not a canonical positive decimal", ErrRecoveryStoreInvalid, field)
	}
	for index := 1; index < len(value); index++ {
		if value[index] < '0' || value[index] > '9' {
			return 0, fmt.Errorf("%w: %s is not a canonical positive decimal", ErrRecoveryStoreInvalid, field)
		}
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil || parsed == 0 || parsed > maximum {
		return 0, fmt.Errorf("%w: %s overflows its positive integer bound", ErrRecoveryStoreInvalid, field)
	}
	return parsed, nil
}

func recoveryDockviewExtent(value uint64, field string) (uint32, error) {
	if value == 0 || value > RecoveryStoreMaxLayoutExtent {
		return 0, fmt.Errorf("%w: %s exceeds the layout extent", ErrRecoveryStoreInvalid, field)
	}
	return uint32(value), nil
}

func recoveryDockviewFrozenOrientation(value string) (RecoveryLayoutOrientation, error) {
	switch value {
	case "HORIZONTAL":
		return RecoveryLayoutHorizontal, nil
	case "VERTICAL":
		return RecoveryLayoutVertical, nil
	default:
		return "", fmt.Errorf("%w: dockview orientation is invalid", ErrRecoveryStoreInvalid)
	}
}

func recoveryDockviewWireOrientation(value RecoveryLayoutOrientation) string {
	if value == RecoveryLayoutVertical {
		return "VERTICAL"
	}
	return "HORIZONTAL"
}

func recoveryDockviewOppositeOrientation(value RecoveryLayoutOrientation) RecoveryLayoutOrientation {
	if value == RecoveryLayoutVertical {
		return RecoveryLayoutHorizontal
	}
	return RecoveryLayoutVertical
}

func recoveryDockviewTopKey(key string) bool {
	switch key {
	case "grid", "panels", "activeGroup":
		return true
	default:
		return false
	}
}

func recoveryDockviewGridKey(key string) bool {
	switch key {
	case "root", "orientation", "width", "height":
		return true
	default:
		return false
	}
}

func recoveryDockviewNodeKey(key string) bool {
	switch key {
	case "type", "data", "size":
		return true
	default:
		return false
	}
}

func recoveryDockviewLeafKey(key string) bool {
	switch key {
	case "id", "views", "activeView":
		return true
	default:
		return false
	}
}

func recoveryDockviewPanelKey(key string) bool {
	switch key {
	case "id", "title", "contentComponent":
		return true
	default:
		return false
	}
}
