package sessiond

import (
	"fmt"
	"math"
	"strconv"
	"time"
)

// recoveryRegistryPlan is a closed, metadata-only reconstruction input. It is
// intentionally distinct from Registry, Workspace, Pane, recovery launch
// requests, and strategy interfaces: constructing this value starts nothing.
type recoveryRegistryPlan struct {
	storeGeneration             RecoveryStoreGeneration
	workspaceAllocator          recoveryWorkspaceAllocatorPlan
	recoveryGenerationAllocator recoveryGenerationAllocatorPlan

	workspaces []recoveryWorkspacePlan
	panes      []recoveryPanePlan
	layouts    []recoveryLayoutPlan
	captures   []recoveryCapturePlan
	claims     []recoveryClaimPlan
	attempts   []recoveryAttemptPlan
	outcomes   []recoveryOutcomePlan
	history    []recoveryHistoryPlan
}

type recoveryWorkspaceAllocatorPlan struct {
	floor     int
	highWater int
	next      int
}

type recoveryPaneAllocatorPlan struct {
	floor     RecoveryPaneID
	highWater RecoveryPaneID
	next      RecoveryPaneID
}

type recoveryGenerationAllocatorPlan struct {
	floor     RecoveryGeneration
	highWater RecoveryGeneration
	next      RecoveryGeneration
}

type recoveryWorkspacePlan struct {
	id            RecoveryWorkspaceID
	name          string
	hasActivePane bool
	activePane    RecoveryPaneRef
	paneAllocator recoveryPaneAllocatorPlan
}

// recoveryPanePlan has only structural shell-safe metadata. In particular it
// has no process, executable, argv, environment, command, URL, or runtime
// pointer.
type recoveryPanePlan struct {
	ref              RecoveryPaneRef
	surface          RecoverySurfaceKind
	columns          uint32
	rows             uint32
	title            string
	workingDirectory RecoveryWorkingDirectory
}

// recoveryLayoutPlan removes pointer-bearing RecoveryLayout fields while
// retaining the fully validated frozen geometry and workspace-qualified views.
type recoveryLayoutPlan struct {
	workspaceID RecoveryWorkspaceID
	breakpoint  string
	activeGroup string
	root        recoveryLayoutNodePlan
}

type recoveryLayoutNodePlan struct {
	kind          RecoveryLayoutNodeKind
	geometry      RecoveryLayoutGeometry
	ratio         uint32
	orientation   RecoveryLayoutOrientation
	children      []recoveryLayoutNodePlan
	groupID       string
	views         []RecoveryPaneRef
	hasActiveView bool
	activeView    RecoveryPaneRef
}

// recoveryCapturePlan retains exact captured metadata as inert data only. It
// has no executable, argv, environment, claim, strategy callback, or method
// that can turn this record into a launch request.
type recoveryCapturePlan struct {
	pane                  RecoveryPaneRef
	strategyID            RecoveryStrategyID
	source                RecoveryCaptureSource
	sessionID             RecoveryOpaqueSessionID
	workingDirectory      RecoveryWorkingDirectoryBinding
	rootProcessGeneration RecoveryRootProcessGeneration
	captureEpoch          RecoveryCaptureEpoch
	observedAt            time.Time
	capturedAt            time.Time
}

// recoveryFencePlan is inert coordination metadata, not a RecoveryFence
// authority object.
type recoveryFencePlan struct {
	pane                  RecoveryPaneRef
	generation            RecoveryGeneration
	rootProcessGeneration RecoveryRootProcessGeneration
	strategyID            RecoveryStrategyID
	captureEpoch          RecoveryCaptureEpoch
}

type recoveryClaimPlan struct {
	fence     recoveryFencePlan
	state     RecoveryClaimState
	claimedAt time.Time
}

type recoveryAttemptPlan struct {
	fence     recoveryFencePlan
	ordinal   uint8
	state     RecoveryAttemptState
	startedAt time.Time
	updatedAt time.Time
}

// recoveryOutcomePlan keeps outcome flags only as historical facts nested in
// their original coordination record. The plan exposes no pane-level retry or
// selection eligibility and has no action-capable method.
type recoveryOutcomePlan struct {
	fence           recoveryFencePlan
	state           RecoveryOutcomeState
	status          RecoveryStatus
	detailCode      RecoveryDetailCode
	failureCode     RecoveryFailureCode
	historyBoundary bool
	canRetry        bool
	canSelect       bool
	completedAt     time.Time
}

type recoveryHistoryPlan struct {
	pane  RecoveryPaneRef
	lines []string
}

type recoveryPlannerRunKey struct {
	pane       RecoveryPaneRef
	generation RecoveryGeneration
}

type recoveryPlannerLayoutKey struct {
	workspaceID RecoveryWorkspaceID
	breakpoint  string
}

// planRecoveryRegistry converts a loaded durable result into one complete,
// deterministic, inert reconstruction plan. Validation always completes before
// the plan is returned; errors return the zero plan rather than a partial one.
func planRecoveryRegistry(loaded RecoveryLoadResult) (recoveryRegistryPlan, error) {
	if loaded.Snapshot.Generation == RecoveryStoreGeneration(math.MaxUint64) {
		return recoveryRegistryPlan{}, fmt.Errorf(
			"%w: recovery store generation leaves no fresh allocation",
			ErrRecoveryStoreInvalid,
		)
	}
	if loaded.Snapshot.Generation == 0 {
		if !recoveryPlannerSnapshotCollectionsEmpty(loaded.Snapshot) || len(loaded.History) != 0 {
			return recoveryRegistryPlan{}, fmt.Errorf(
				"%w: generation-zero recovery state must be completely empty",
				ErrRecoveryStoreInvalid,
			)
		}
		return recoveryRegistryPlan{}, nil
	}

	snapshot, err := canonicalRecoverySnapshot(loaded.Snapshot)
	if err != nil {
		return recoveryRegistryPlan{}, err
	}

	workspaceAllocator, err := recoveryPlannerWorkspaceAllocator(snapshot.Workspaces)
	if err != nil {
		return recoveryRegistryPlan{}, err
	}
	workspaceByID := make(map[RecoveryWorkspaceID]RecoveryWorkspace, len(snapshot.Workspaces))
	workspacePanes := make(map[RecoveryWorkspaceID][]RecoveryPane, len(snapshot.Workspaces))
	maxPaneByWorkspace := make(map[RecoveryWorkspaceID]RecoveryPaneID, len(snapshot.Workspaces))
	for _, workspace := range snapshot.Workspaces {
		if err := validateRecoveryWorkspaceID(workspace.ID); err != nil {
			return recoveryRegistryPlan{}, err
		}
		if _, duplicate := workspaceByID[workspace.ID]; duplicate {
			return recoveryRegistryPlan{}, fmt.Errorf("%w: duplicate workspace", ErrRecoveryStoreInvalid)
		}
		workspaceByID[workspace.ID] = workspace
		maxPaneByWorkspace[workspace.ID] = 0
	}

	maximumPaneID := recoveryPlannerMaximumPaneID()
	paneByRef := make(map[RecoveryPaneRef]RecoveryPane, len(snapshot.Panes))
	for _, pane := range snapshot.Panes {
		canonical, err := canonicalRecoveryPane(pane)
		if err != nil {
			return recoveryRegistryPlan{}, err
		}
		if canonical.Surface == RecoverySurfaceTerminal &&
			(canonical.Columns > math.MaxUint16 || canonical.Rows > math.MaxUint16) {
			return recoveryRegistryPlan{}, fmt.Errorf(
				"%w: terminal dimensions exceed the uint16 PTY bound",
				ErrRecoveryStoreInvalid,
			)
		}
		if _, known := workspaceByID[canonical.Ref.WorkspaceID]; !known {
			return recoveryRegistryPlan{}, fmt.Errorf("%w: pane references a missing workspace", ErrRecoveryStoreInvalid)
		}
		if uint64(canonical.Ref.PaneID) >= maximumPaneID {
			return recoveryRegistryPlan{}, fmt.Errorf(
				"%w: pane ID leaves no representable fresh allocation",
				ErrRecoveryStoreInvalid,
			)
		}
		if _, duplicate := paneByRef[canonical.Ref]; duplicate {
			return recoveryRegistryPlan{}, fmt.Errorf("%w: duplicate qualified pane", ErrRecoveryStoreInvalid)
		}
		paneByRef[canonical.Ref] = canonical
		workspacePanes[canonical.Ref.WorkspaceID] = append(
			workspacePanes[canonical.Ref.WorkspaceID],
			canonical,
		)
		if canonical.Ref.PaneID > maxPaneByWorkspace[canonical.Ref.WorkspaceID] {
			maxPaneByWorkspace[canonical.Ref.WorkspaceID] = canonical.Ref.PaneID
		}
	}

	workspaces := make([]recoveryWorkspacePlan, len(snapshot.Workspaces))
	for index, workspace := range snapshot.Workspaces {
		if workspace.ActivePane != nil {
			if workspace.ActivePane.WorkspaceID != workspace.ID {
				return recoveryRegistryPlan{}, fmt.Errorf("%w: active pane is outside workspace", ErrRecoveryStoreInvalid)
			}
			if _, known := paneByRef[*workspace.ActivePane]; !known {
				return recoveryRegistryPlan{}, fmt.Errorf("%w: active pane references a missing pane", ErrRecoveryStoreInvalid)
			}
		}
		highWater := maxPaneByWorkspace[workspace.ID]
		workspaces[index] = recoveryWorkspacePlan{
			id:            workspace.ID,
			name:          workspace.Name,
			paneAllocator: recoveryPlannerPaneAllocator(highWater),
		}
		if workspace.ActivePane != nil {
			workspaces[index].hasActivePane = true
			workspaces[index].activePane = *workspace.ActivePane
		}
	}

	panes := make([]recoveryPanePlan, len(snapshot.Panes))
	for index, pane := range snapshot.Panes {
		panes[index] = recoveryPanePlan{
			ref:              pane.Ref,
			surface:          pane.Surface,
			columns:          pane.Columns,
			rows:             pane.Rows,
			title:            pane.Title,
			workingDirectory: pane.WorkingDirectory,
		}
	}

	layouts := make([]recoveryLayoutPlan, len(snapshot.Layouts))
	layoutKeys := make(map[recoveryPlannerLayoutKey]struct{}, len(snapshot.Layouts))
	for index, layout := range snapshot.Layouts {
		if _, known := workspaceByID[layout.WorkspaceID]; !known {
			return recoveryRegistryPlan{}, fmt.Errorf("%w: layout references a missing workspace", ErrRecoveryStoreInvalid)
		}
		key := recoveryPlannerLayoutKey{
			workspaceID: layout.WorkspaceID,
			breakpoint:  layout.Breakpoint,
		}
		if _, duplicate := layoutKeys[key]; duplicate {
			return recoveryRegistryPlan{}, fmt.Errorf("%w: duplicate layout", ErrRecoveryStoreInvalid)
		}
		layoutKeys[key] = struct{}{}
		canonical, err := canonicalRecoveryDockviewLayout(layout, workspacePanes[layout.WorkspaceID])
		if err != nil {
			return recoveryRegistryPlan{}, err
		}
		layouts[index] = recoveryPlannerLayout(canonical)
	}

	captures, captureKeys, err := recoveryPlannerCaptures(snapshot.Captures, paneByRef)
	if err != nil {
		return recoveryRegistryPlan{}, err
	}
	claims, claimsByFence, runFences, highWater, err := recoveryPlannerClaims(snapshot.Claims, captureKeys)
	if err != nil {
		return recoveryRegistryPlan{}, err
	}
	attempts, highWater, err := recoveryPlannerAttempts(
		snapshot.Attempts,
		captureKeys,
		claimsByFence,
		runFences,
		highWater,
	)
	if err != nil {
		return recoveryRegistryPlan{}, err
	}
	outcomes, highWater, err := recoveryPlannerOutcomes(
		snapshot.Outcomes,
		captureKeys,
		claimsByFence,
		runFences,
		highWater,
	)
	if err != nil {
		return recoveryRegistryPlan{}, err
	}
	history, err := recoveryPlannerHistory(loaded.History, paneByRef)
	if err != nil {
		return recoveryRegistryPlan{}, err
	}

	plan := recoveryRegistryPlan{
		storeGeneration:             snapshot.Generation,
		workspaceAllocator:          workspaceAllocator,
		recoveryGenerationAllocator: recoveryPlannerGenerationAllocator(highWater),
		workspaces:                  workspaces,
		panes:                       panes,
		layouts:                     layouts,
		captures:                    captures,
		claims:                      claims,
		attempts:                    attempts,
		outcomes:                    outcomes,
		history:                     history,
	}
	return plan, nil
}

func recoveryPlannerSnapshotCollectionsEmpty(snapshot RecoverySnapshot) bool {
	return len(snapshot.Workspaces) == 0 &&
		len(snapshot.Panes) == 0 &&
		len(snapshot.Layouts) == 0 &&
		len(snapshot.Captures) == 0 &&
		len(snapshot.Claims) == 0 &&
		len(snapshot.Attempts) == 0 &&
		len(snapshot.Outcomes) == 0
}

func recoveryPlannerWorkspaceAllocator(
	workspaces []RecoveryWorkspace,
) (recoveryWorkspaceAllocatorPlan, error) {
	maximum := recoveryPlannerMaximumInt()
	var highWater uint64
	for _, workspace := range workspaces {
		number, generated, err := recoveryPlannerGeneratedWorkspaceNumber(workspace.ID)
		if err != nil {
			return recoveryWorkspaceAllocatorPlan{}, err
		}
		if !generated {
			continue
		}
		if number >= maximum {
			return recoveryWorkspaceAllocatorPlan{}, fmt.Errorf(
				"%w: generated workspace ID leaves no representable fresh allocation",
				ErrRecoveryStoreInvalid,
			)
		}
		if number > highWater {
			highWater = number
		}
	}
	return recoveryWorkspaceAllocatorPlan{
		floor:     0,
		highWater: int(highWater),
		next:      int(highWater + 1),
	}, nil
}

func recoveryPlannerGeneratedWorkspaceNumber(id RecoveryWorkspaceID) (uint64, bool, error) {
	value := string(id)
	if len(value) < 2 || value[0] != 'w' || value[1] < '1' || value[1] > '9' {
		return 0, false, nil
	}
	for index := 2; index < len(value); index++ {
		if value[index] < '0' || value[index] > '9' {
			return 0, false, nil
		}
	}
	number, err := strconv.ParseUint(value[1:], 10, 64)
	if err != nil {
		return 0, false, fmt.Errorf("%w: generated workspace ID overflows", ErrRecoveryStoreInvalid)
	}
	return number, true, nil
}

func recoveryPlannerPaneAllocator(highWater RecoveryPaneID) recoveryPaneAllocatorPlan {
	return recoveryPaneAllocatorPlan{
		floor:     0,
		highWater: highWater,
		next:      highWater + 1,
	}
}

func recoveryPlannerGenerationAllocator(highWater RecoveryGeneration) recoveryGenerationAllocatorPlan {
	return recoveryGenerationAllocatorPlan{
		floor:     0,
		highWater: highWater,
		next:      highWater + 1,
	}
}

func recoveryPlannerMaximumInt() uint64 {
	return uint64(^uint(0) >> 1)
}

func recoveryPlannerMaximumPaneID() uint64 {
	maximum := uint64(^RecoveryPaneID(0))
	if platformMaximum := recoveryPlannerMaximumInt(); platformMaximum < maximum {
		return platformMaximum
	}
	return maximum
}

func recoveryPlannerCaptures(
	captures []ExactSessionCapture,
	panes map[RecoveryPaneRef]RecoveryPane,
) ([]recoveryCapturePlan, map[RecoveryCaptureKey]struct{}, error) {
	plans := make([]recoveryCapturePlan, len(captures))
	keys := make(map[RecoveryCaptureKey]struct{}, len(captures))
	for index, source := range captures {
		capture := canonicalExactSessionCapture(source)
		if err := capture.validateRecoveryContract(); err != nil {
			return nil, nil, invalidRecoveryStoreValue("capture", err)
		}
		pane, known := panes[capture.Pane]
		if !known {
			return nil, nil, fmt.Errorf("%w: capture references a missing pane", ErrRecoveryStoreInvalid)
		}
		if pane.Surface != RecoverySurfaceTerminal {
			return nil, nil, fmt.Errorf("%w: browser pane has a strategy capture", ErrRecoveryStoreInvalid)
		}
		key := recoveryCaptureKeyForCapture(capture)
		if _, duplicate := keys[key]; duplicate {
			return nil, nil, fmt.Errorf("%w: duplicate capture", ErrRecoveryStoreInvalid)
		}
		keys[key] = struct{}{}
		plans[index] = recoveryCapturePlan{
			pane:                  capture.Pane,
			strategyID:            capture.StrategyID,
			source:                capture.Source,
			sessionID:             capture.SessionID,
			workingDirectory:      capture.WorkingDirectory,
			rootProcessGeneration: capture.RootGeneration,
			captureEpoch:          capture.CaptureEpoch,
			observedAt:            capture.ObservedAt,
			capturedAt:            capture.CapturedAt,
		}
	}
	return plans, keys, nil
}

func recoveryPlannerClaims(
	claims []RecoveryClaim,
	captures map[RecoveryCaptureKey]struct{},
) (
	[]recoveryClaimPlan,
	map[RecoveryFence]RecoveryClaimState,
	map[recoveryPlannerRunKey]RecoveryFence,
	RecoveryGeneration,
	error,
) {
	plans := make([]recoveryClaimPlan, len(claims))
	claimsByFence := make(map[RecoveryFence]RecoveryClaimState, len(claims))
	runFences := make(map[recoveryPlannerRunKey]RecoveryFence)
	var highWater RecoveryGeneration
	for index, source := range claims {
		claim := canonicalRecoveryClaim(source)
		if err := claim.validateRecoveryContract(); err != nil {
			return nil, nil, nil, 0, invalidRecoveryStoreValue("claim", err)
		}
		var err error
		highWater, err = recoveryPlannerRecordFence(claim.Fence, captures, runFences, highWater)
		if err != nil {
			return nil, nil, nil, 0, err
		}
		if _, duplicate := claimsByFence[claim.Fence]; duplicate {
			return nil, nil, nil, 0, fmt.Errorf("%w: duplicate claim", ErrRecoveryStoreInvalid)
		}
		claimsByFence[claim.Fence] = claim.State
		plans[index] = recoveryClaimPlan{
			fence:     recoveryPlannerFence(claim.Fence),
			state:     claim.State,
			claimedAt: claim.ClaimedAt,
		}
	}
	return plans, claimsByFence, runFences, highWater, nil
}

func recoveryPlannerAttempts(
	attempts []RecoveryAttempt,
	captures map[RecoveryCaptureKey]struct{},
	claims map[RecoveryFence]RecoveryClaimState,
	runFences map[recoveryPlannerRunKey]RecoveryFence,
	highWater RecoveryGeneration,
) ([]recoveryAttemptPlan, RecoveryGeneration, error) {
	plans := make([]recoveryAttemptPlan, len(attempts))
	keys := make(map[RecoveryAttemptKey]struct{}, len(attempts))
	counts := make(map[recoveryPlannerRunKey]int)
	for index, source := range attempts {
		attempt := canonicalRecoveryAttempt(source)
		if err := attempt.validateRecoveryContract(); err != nil {
			return nil, 0, invalidRecoveryStoreValue("attempt", err)
		}
		var err error
		highWater, err = recoveryPlannerRecordFence(attempt.Fence, captures, runFences, highWater)
		if err != nil {
			return nil, 0, err
		}
		claimState, claimed := claims[attempt.Fence]
		if !claimed {
			return nil, 0, fmt.Errorf("%w: attempt references a missing claim", ErrRecoveryStoreInvalid)
		}
		if attempt.State != RecoveryAttemptStateFinished && claimState != RecoveryClaimStateClaimed {
			return nil, 0, fmt.Errorf(
				"%w: non-finished attempt is not authorized by claim state %q",
				ErrRecoveryStoreInvalid,
				claimState,
			)
		}
		key := RecoveryAttemptKey{Fence: attempt.Fence, Ordinal: attempt.Ordinal}
		if _, duplicate := keys[key]; duplicate {
			return nil, 0, fmt.Errorf("%w: duplicate attempt", ErrRecoveryStoreInvalid)
		}
		keys[key] = struct{}{}
		runKey := recoveryPlannerRunKey{pane: attempt.Fence.Pane, generation: attempt.Fence.Generation}
		if counts[runKey] >= int(RecoveryMaxAutomaticAttempts) {
			return nil, 0, fmt.Errorf("%w: recovery run exceeds automatic attempt bound", ErrRecoveryStoreInvalid)
		}
		counts[runKey]++
		plans[index] = recoveryAttemptPlan{
			fence:     recoveryPlannerFence(attempt.Fence),
			ordinal:   attempt.Ordinal,
			state:     attempt.State,
			startedAt: attempt.StartedAt,
			updatedAt: attempt.UpdatedAt,
		}
	}
	return plans, highWater, nil
}

func recoveryPlannerOutcomes(
	outcomes []RecoveryOutcome,
	captures map[RecoveryCaptureKey]struct{},
	claims map[RecoveryFence]RecoveryClaimState,
	runFences map[recoveryPlannerRunKey]RecoveryFence,
	highWater RecoveryGeneration,
) ([]recoveryOutcomePlan, RecoveryGeneration, error) {
	plans := make([]recoveryOutcomePlan, len(outcomes))
	fences := make(map[RecoveryFence]struct{}, len(outcomes))
	for index, source := range outcomes {
		outcome := canonicalRecoveryOutcome(source)
		if err := outcome.validateRecoveryContract(); err != nil {
			return nil, 0, invalidRecoveryStoreValue("outcome", err)
		}
		var err error
		highWater, err = recoveryPlannerRecordFence(outcome.Fence, captures, runFences, highWater)
		if err != nil {
			return nil, 0, err
		}
		if _, claimed := claims[outcome.Fence]; !claimed {
			return nil, 0, fmt.Errorf("%w: outcome references a missing claim", ErrRecoveryStoreInvalid)
		}
		if _, duplicate := fences[outcome.Fence]; duplicate {
			return nil, 0, fmt.Errorf("%w: duplicate outcome", ErrRecoveryStoreInvalid)
		}
		fences[outcome.Fence] = struct{}{}
		plans[index] = recoveryOutcomePlan{
			fence:           recoveryPlannerFence(outcome.Fence),
			state:           outcome.State,
			status:          outcome.Status,
			detailCode:      outcome.DetailCode,
			failureCode:     outcome.FailureCode,
			historyBoundary: outcome.HistoryBoundary,
			canRetry:        outcome.CanRetry,
			canSelect:       outcome.CanSelect,
			completedAt:     outcome.CompletedAt,
		}
	}
	return plans, highWater, nil
}

func recoveryPlannerRecordFence(
	fence RecoveryFence,
	captures map[RecoveryCaptureKey]struct{},
	runFences map[recoveryPlannerRunKey]RecoveryFence,
	highWater RecoveryGeneration,
) (RecoveryGeneration, error) {
	if err := fence.validateRecoveryContract(); err != nil {
		return 0, invalidRecoveryStoreValue("recovery fence", err)
	}
	if _, captured := captures[RecoveryCaptureKey{
		Pane:           fence.Pane,
		StrategyID:     fence.StrategyID,
		RootGeneration: fence.RootProcessGeneration,
		CaptureEpoch:   fence.CaptureEpoch,
	}]; !captured {
		return 0, fmt.Errorf("%w: coordination record references a missing capture", ErrRecoveryStoreInvalid)
	}
	if fence.Generation == RecoveryGeneration(math.MaxUint64) {
		return 0, fmt.Errorf("%w: recovery generation leaves no fresh allocation", ErrRecoveryStoreInvalid)
	}
	key := recoveryPlannerRunKey{pane: fence.Pane, generation: fence.Generation}
	if prior, exists := runFences[key]; exists && prior != fence {
		return 0, fmt.Errorf("%w: recovery run has competing fences", ErrRecoveryStoreInvalid)
	}
	runFences[key] = fence
	if fence.Generation > highWater {
		highWater = fence.Generation
	}
	return highWater, nil
}

func recoveryPlannerFence(fence RecoveryFence) recoveryFencePlan {
	return recoveryFencePlan{
		pane:                  fence.Pane,
		generation:            fence.Generation,
		rootProcessGeneration: fence.RootProcessGeneration,
		strategyID:            fence.StrategyID,
		captureEpoch:          fence.CaptureEpoch,
	}
}

func recoveryPlannerHistory(
	history []RecoveryHistorySegment,
	panes map[RecoveryPaneRef]RecoveryPane,
) ([]recoveryHistoryPlan, error) {
	if len(history) > RecoveryStoreMaxHistorySegments {
		return nil, fmt.Errorf("%w: history exceeds its segment bound", ErrRecoveryStoreInvalid)
	}
	options := RecoveryStoreOptions{
		MaxHistoryLineBytes:       RecoveryStoreMaxHistoryLineBytes,
		MaxHistoryLinesPerSegment: RecoveryStoreMaxHistoryLinesPerSegment,
		MaxHistorySegmentBytes:    RecoveryStoreMaxHistorySegmentBytes,
		MaxHistorySegments:        RecoveryStoreMaxHistorySegments,
		MaxHistoryTotalBytes:      RecoveryStoreMaxHistoryTotalBytes,
	}
	options, err := normalizedRecoveryStoreOptions(options)
	if err != nil {
		return nil, err
	}

	plans := make([]recoveryHistoryPlan, len(history))
	totalBytes := 0
	totalLines := 0
	for index, segment := range history {
		if err := validateRecoveryHistorySegment(segment, options); err != nil {
			return nil, err
		}
		pane, known := panes[segment.Pane]
		if !known {
			return nil, fmt.Errorf("%w: history references a missing pane", ErrRecoveryStoreInvalid)
		}
		if pane.Surface != RecoverySurfaceTerminal {
			return nil, fmt.Errorf("%w: browser pane has terminal history", ErrRecoveryStoreInvalid)
		}
		segmentBytes := 0
		for _, line := range segment.Lines {
			segmentBytes += len(line)
		}
		if segmentBytes > RecoveryStoreMaxHistoryTotalBytes-totalBytes ||
			len(segment.Lines) > RecoveryStoreMaxHistoryLinesPerSegment ||
			totalLines > RecoveryStoreMaxHistorySegments*RecoveryStoreMaxHistoryLinesPerSegment-len(segment.Lines) {
			return nil, fmt.Errorf("%w: history exceeds its aggregate bound", ErrRecoveryStoreInvalid)
		}
		totalBytes += segmentBytes
		totalLines += len(segment.Lines)
		plans[index] = recoveryHistoryPlan{
			pane:  segment.Pane,
			lines: append([]string(nil), segment.Lines...),
		}
	}
	return plans, nil
}

func recoveryPlannerLayout(layout RecoveryLayout) recoveryLayoutPlan {
	return recoveryLayoutPlan{
		workspaceID: layout.WorkspaceID,
		breakpoint:  layout.Breakpoint,
		activeGroup: layout.ActiveGroup,
		root:        recoveryPlannerLayoutNode(layout.Root),
	}
}

func recoveryPlannerLayoutNode(node RecoveryLayoutNode) recoveryLayoutNodePlan {
	out := recoveryLayoutNodePlan{
		kind:        node.Kind,
		geometry:    node.Geometry,
		ratio:       node.Ratio,
		orientation: node.Orientation,
		groupID:     node.GroupID,
		views:       append([]RecoveryPaneRef(nil), node.Views...),
	}
	if node.ActiveView != nil {
		out.hasActiveView = true
		out.activeView = *node.ActiveView
	}
	if len(node.Children) != 0 {
		out.children = make([]recoveryLayoutNodePlan, len(node.Children))
		for index, child := range node.Children {
			out.children[index] = recoveryPlannerLayoutNode(child)
		}
	}
	return out
}
