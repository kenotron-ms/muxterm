package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/kenotron-ms/muxterm/internal/missioncontrol"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

const (
	missionControlProtocolVersion  = 2
	missionControlResultType       = "missioncontrol-result"
	missionControlEventType        = "missioncontrol-event"
	missionControlRequestQueueSize = 8
	missionControlPromptMaxBytes   = 128 << 10
	missionControlHistoryTurns     = 50
	missionControlBootWait         = 2 * time.Minute
)

type missionControlClientMessage struct {
	Type                      string `json:"type"`
	ProtocolVersion           int    `json:"protocol_version"`
	RequestID                 string `json:"request_id"`
	Kind                      string `json:"kind"`
	WorkspaceID               string `json:"workspace_id"`
	ThreadID                  string `json:"thread_id"`
	ExpectedRuntimeGeneration uint64 `json:"expected_runtime_generation"`
	DraftRef                  string `json:"draft_ref"`
	Text                      string `json:"text"`
	ClientRef                 string `json:"client_ref"`
}

type missionControlIdentityDaemon interface {
	MissionControlIdentity() (sessiond.MissionControlIdentity, error)
	ListWorkspacesWithin(timeout time.Duration) ([]sessiond.WorkspaceInfo, error)
}

type missionControlSelection struct {
	threadID   string
	generation uint64
	draftRef   string
}

type missionControlSubscription struct {
	cancel func()
}

type missionControlResult struct {
	Type            string                    `json:"type"`
	ProtocolVersion int                       `json:"protocol_version"`
	Op              string                    `json:"op"`
	RequestID       string                    `json:"request_id,omitempty"`
	OK              bool                      `json:"ok"`
	Code            string                    `json:"code,omitempty"`
	Error           string                    `json:"error,omitempty"`
	Enabled         bool                      `json:"enabled"`
	Capabilities    any                       `json:"capabilities,omitempty"`
	Threads         []missioncontrol.Thread   `json:"threads,omitempty"`
	Workspaces      []missionControlWorkspace `json:"workspaces,omitempty"`
	Thread          *missioncontrol.Thread    `json:"thread,omitempty"`
	DraftRef        string                    `json:"draft_ref,omitempty"`
	History         json.RawMessage           `json:"history,omitempty"`
	ThreadSeq       uint64                    `json:"thread_seq,omitempty"`
	ReplayEvents    []missionControlEvent     `json:"replay_events"`
	CoveredTurnIDs  []string                  `json:"covered_turn_ids"`
	TurnID          string                    `json:"turn_id,omitempty"`
}

type missionControlWorkspace struct {
	WorkspaceID       string `json:"workspace_id"`
	Label             string `json:"label"`
	MachineID         string `json:"machine_id,omitempty"`
	WorkspaceUUID     string `json:"workspace_uuid,omitempty"`
	DaemonIncarnation string `json:"daemon_incarnation,omitempty"`
	BoundThreadID     string `json:"bound_thread_id,omitempty"`
	Code              string `json:"code,omitempty"`
	Error             string `json:"error,omitempty"`
}

// missionControlEvent is the v2 event envelope used for live WebSocket frames.
type missionControlEvent struct {
	Type              string          `json:"type"`
	ProtocolVersion   int             `json:"protocol_version"`
	ThreadID          string          `json:"thread_id"`
	RuntimeGeneration uint64          `json:"runtime_generation"`
	EventID           string          `json:"event_id"`
	ThreadSeq         uint64          `json:"thread_seq"`
	Event             json.RawMessage `json:"event"`
}

func missionControlFailure(msg missionControlClientMessage, code, detail string) missionControlResult {
	return missionControlResult{
		Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion,
		Op: strings.TrimPrefix(msg.Type, "missioncontrol-"), RequestID: msg.RequestID,
		Code: code, Error: detail,
	}
}

func (h *Hub) setMissionControl(catalog *missioncontrol.Store, router *missioncontrol.Router, enabled bool, err error) {
	h.mu.Lock()
	h.missionControl = catalog
	h.missionControlRouter = router
	h.missionControlTextPreview = enabled
	h.missionControlErr = err
	h.mu.Unlock()
}

func (h *Hub) missionControlCatalog() (*missioncontrol.Store, error) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.missionControl != nil {
		return h.missionControl, nil
	}
	if h.missionControlErr != nil {
		return nil, fmt.Errorf("mission control catalog unavailable: %w", h.missionControlErr)
	}
	return nil, errors.New("mission control threads v2 is disabled")
}

func (h *Hub) missionControlTextEnabled() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.missionControlTextPreview && h.missionControlRouter != nil
}

func (h *Hub) missionControlRouterForText() (*missioncontrol.Router, error) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.missionControlTextPreview && h.missionControlRouter != nil {
		return h.missionControlRouter, nil
	}
	return nil, errors.New("mission control text preview is disabled")
}

func isMissionControlMessage(typ string) bool {
	return strings.HasPrefix(typ, "missioncontrol-")
}

func (c *Client) enqueueMissionControlMessage(data []byte) {
	request := append([]byte(nil), data...)
	select {
	case c.missionControlRequests <- request:
	case <-c.ctx.Done():
	default:
		c.sendMissionControlResult(missionControlResult{
			Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion,
			Code: "busy", Error: "mission control request queue is full",
		})
	}
}

func (c *Client) missionControlWorker() {
	for {
		select {
		case <-c.ctx.Done():
			return
		case request := <-c.missionControlRequests:
			c.handleMissionControlMessage(request)
		}
	}
}

// handleMissionControlMessage executes exclusively on the bounded per-client
// worker. Cold sidecar boot and daemon identity calls therefore cannot stall
// terminal WebSocket reads.
func (c *Client) handleMissionControlMessage(data []byte) {
	var msg missionControlClientMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "bad_request", "invalid mission control request"))
		return
	}
	if msg.ProtocolVersion == 0 {
		c.handleLegacyMissionControlCatalog(msg)
		return
	}
	if msg.ProtocolVersion != missionControlProtocolVersion {
		c.sendMissionControlResult(missionControlFailure(msg, "protocol_version_required", "Mission Control text requests require protocol_version=2"))
		return
	}
	if !validMissionControlRequestID(msg.RequestID) {
		c.sendMissionControlResult(missionControlFailure(msg, "invalid_request_id", "request_id must be a UUID"))
		return
	}
	switch msg.Type {
	case "missioncontrol-capabilities":
		c.missionControlCapabilities(msg)
	case "missioncontrol-list":
		c.missionControlList(msg)
	case "missioncontrol-select":
		c.missionControlSelect(msg)
	case "missioncontrol-turn":
		c.missionControlTurn(msg)
	case "missioncontrol-history":
		c.missionControlHistory(msg)
	case "missioncontrol-approval", "missioncontrol-cancel", "missioncontrol-reset", "missioncontrol-voice":
		c.sendMissionControlResult(missionControlFailure(msg, "unsupported_operation", "approval, cancel, reset, and voice are unavailable in text preview"))
	default:
		c.sendMissionControlResult(missionControlFailure(msg, "unsupported_operation", "unsupported Mission Control operation"))
	}
}

// handleLegacyMissionControlCatalog keeps the compatibility-floor catalog
// vocabulary read/metadata-only. It deliberately exposes no selection, turn,
// history, or voice fallback to an unversioned caller.
func (c *Client) handleLegacyMissionControlCatalog(msg missionControlClientMessage) {
	if msg.Type != "missioncontrol-catalog" && msg.Type != "missioncontrol-bind" && msg.Type != "missioncontrol-archive" {
		c.sendLegacyMissionControlResult(false, "unsupported_operation", "legacy Mission Control supports catalog metadata only", nil, nil)
		return
	}
	catalog, err := c.hub.missionControlCatalog()
	if err != nil {
		c.sendLegacyMissionControlResult(false, "missioncontrol_disabled", err.Error(), nil, nil)
		return
	}
	switch msg.Type {
	case "missioncontrol-archive":
		if c.hub.missionControlTextEnabled() {
			c.sendLegacyMissionControlResult(false, "unsupported_operation", "archive is unavailable while Mission Control text preview is enabled", nil, nil)
			return
		}
		if !validMissionControlRequestID(msg.ThreadID) {
			c.sendLegacyMissionControlResult(false, "target_required", "archive requires an explicit UUID thread_id", nil, nil)
			return
		}
		thread, err := catalog.Archive(msg.ThreadID)
		if err != nil {
			c.sendLegacyMissionControlResult(false, "archive_refused", err.Error(), nil, nil)
			return
		}
		c.sendLegacyMissionControlResult(true, "", "", &thread, nil)
	case "missioncontrol-catalog":
		if msg.WorkspaceID == "" {
			thread, err := catalog.Lobby()
			if err != nil {
				c.sendLegacyMissionControlResult(false, "catalog_unavailable", err.Error(), nil, nil)
				return
			}
			c.sendLegacyMissionControlResult(true, "", "", &thread, nil)
			return
		}
		thread, found, err := c.missionControlLookupLive(catalog, msg.WorkspaceID)
		if err != nil {
			c.sendLegacyMissionControlResult(false, "target_unavailable", err.Error(), nil, nil)
			return
		}
		if !found {
			c.sendLegacyMissionControlResult(true, "", "", nil, nil)
			return
		}
		_, binding, _, _ := catalog.Thread(thread.ID)
		c.sendLegacyMissionControlResult(true, "", "", &thread, &binding)
	case "missioncontrol-bind":
		if msg.WorkspaceID == "" {
			c.sendLegacyMissionControlResult(false, "target_required", "binding requires an explicit workspace_id", nil, nil)
			return
		}
		thread, err := c.missionControlBindLive(catalog, msg.WorkspaceID)
		if err != nil {
			c.sendLegacyMissionControlResult(false, "binding_refused", err.Error(), nil, nil)
			return
		}
		_, binding, _, _ := catalog.Thread(thread.ID)
		c.sendLegacyMissionControlResult(true, "", "", &thread, &binding)
	}
}

func (c *Client) sendLegacyMissionControlResult(ok bool, code, detail string, thread *missioncontrol.Thread, binding *missioncontrol.Binding) {
	frame := struct {
		Type    string                  `json:"type"`
		OK      bool                    `json:"ok"`
		Code    string                  `json:"code,omitempty"`
		Error   string                  `json:"error,omitempty"`
		Thread  *missioncontrol.Thread  `json:"thread,omitempty"`
		Binding *missioncontrol.Binding `json:"binding,omitempty"`
	}{Type: "missioncontrol-catalog-result", OK: ok, Code: code, Error: detail, Thread: thread, Binding: binding}
	data, err := json.Marshal(frame)
	if err != nil {
		log.Printf("missioncontrol: encode legacy response: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("missioncontrol: legacy response write error: %v", err)
	}
}

func validMissionControlRequestID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil
}

func (c *Client) missionControlCapabilities(msg missionControlClientMessage) {
	enabled := c.hub.missionControlTextEnabled()
	c.sendMissionControlResult(missionControlResult{
		Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion,
		Op: "capabilities", RequestID: msg.RequestID, OK: true, Enabled: enabled,
		Capabilities: map[string]bool{
			"text_threads": enabled, "voice": false, "approval": false, "cancel": false, "reset": false,
		},
	})
}

func (c *Client) missionControlList(msg missionControlClientMessage) {
	if !c.hub.missionControlTextEnabled() {
		c.sendMissionControlResult(missionControlFailure(msg, "missioncontrol_disabled", "mission control text preview is disabled"))
		return
	}
	catalog, err := c.hub.missionControlCatalog()
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "missioncontrol_disabled", err.Error()))
		return
	}
	threads, err := catalog.List()
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "catalog_unavailable", err.Error()))
		return
	}
	c.sendMissionControlResult(missionControlResult{
		Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion, Op: "list",
		RequestID: msg.RequestID, OK: true, Threads: threads, Workspaces: c.missionControlWorkspaces(catalog),
	})
}

// missionControlWorkspaces inventories only already-connected daemon links.
// It never invents a target from a name, current focus, or local fallback.
func (c *Client) missionControlWorkspaces(catalog *missioncontrol.Store) []missionControlWorkspace {
	var out []missionControlWorkspace
	for _, sess := range c.sessionsSnapshot() {
		daemon := sess.daemon()
		if daemon == nil {
			continue
		}
		identityClient, ok := daemon.(missionControlIdentityDaemon)
		if !ok {
			out = append(out, missionControlWorkspace{WorkspaceID: sess.host.ID, Code: "identity_unsupported", Error: "connected daemon does not support stable identity"})
			continue
		}
		identity, err := identityClient.MissionControlIdentity()
		if err != nil || !validMissionControlRequestID(identity.MachineID) || !validMissionControlRequestID(identity.DaemonIncarnation) {
			out = append(out, missionControlWorkspace{WorkspaceID: sess.host.ID, Code: "identity_unavailable", Error: "connected daemon identity could not be verified"})
			continue
		}
		workspaces, err := identityClient.ListWorkspacesWithin(sessiond.MissionControlReplyTimeout)
		if err != nil {
			out = append(out, missionControlWorkspace{WorkspaceID: sess.host.ID, MachineID: identity.MachineID, DaemonIncarnation: identity.DaemonIncarnation, Code: "target_unavailable", Error: "connected daemon workspace list could not be verified"})
			continue
		}
		for _, workspace := range workspaces {
			entry := missionControlWorkspace{
				WorkspaceID: nsID(sess.host.ID, workspace.WorkspaceID), Label: workspace.Name,
				MachineID: identity.MachineID, WorkspaceUUID: workspace.WorkspaceUUID,
				DaemonIncarnation: identity.DaemonIncarnation,
			}
			if !validMissionControlRequestID(workspace.WorkspaceUUID) {
				entry.Code, entry.Error = "identity_unbound", "workspace has no stable identity"
			} else if thread, _, found, lookupErr := catalog.Lookup(identity.MachineID, sess.host.ID, workspace.WorkspaceUUID); lookupErr != nil {
				entry.Code, entry.Error = "binding_refused", lookupErr.Error()
			} else if found {
				entry.BoundThreadID = thread.ID
			}
			out = append(out, entry)
		}
	}
	return out
}

func (c *Client) missionControlSelect(msg missionControlClientMessage) {
	router, err := c.hub.missionControlRouterForText()
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "missioncontrol_disabled", err.Error()))
		return
	}
	catalog, err := c.hub.missionControlCatalog()
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "catalog_unavailable", err.Error()))
		return
	}
	targets := 0
	if msg.Kind == "lobby" {
		targets++
	}
	if msg.WorkspaceID != "" {
		targets++
	}
	if msg.ThreadID != "" {
		targets++
	}
	if targets != 1 {
		c.sendMissionControlResult(missionControlFailure(msg, "target_required", "select requires exactly one explicit lobby, workspace_id, or thread_id target"))
		return
	}
	var thread missioncontrol.Thread
	if msg.Kind == "lobby" {
		thread, err = catalog.Lobby()
	} else if msg.WorkspaceID != "" {
		thread, err = c.missionControlBindLive(catalog, msg.WorkspaceID)
	} else {
		thread, err = c.missionControlResolveLiveThread(catalog, msg.ThreadID)
	}
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "target_unavailable", err.Error()))
		return
	}
	runtime, err := router.Ensure(c.ctx, thread.ID)
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "runtime_unavailable", err.Error()))
		return
	}
	thread = runtime.Thread
	ctx, cancel := context.WithTimeout(c.ctx, missionControlBootWait)
	defer cancel()
	snapshot, events, stop, err := runtime.SubscribeSnapshot(ctx, missionControlHistoryTurns)
	if err != nil {
		code := "history_unavailable"
		if errors.Is(err, missioncontrol.ErrThreadBusySnapshot) {
			code = "thread_busy_snapshot"
		}
		c.sendMissionControlResult(missionControlFailure(msg, code, err.Error()))
		return
	}
	c.attachMissionControlSubscription(runtime, events, stop)
	draftRef := uuid.New().String()
	c.missionControlMu.Lock()
	c.missionControlSelection = missionControlSelection{threadID: thread.ID, generation: thread.RuntimeGeneration, draftRef: draftRef}
	c.missionControlMu.Unlock()
	c.sendMissionControlResult(missionControlResult{
		Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion, Op: "select",
		RequestID: msg.RequestID, OK: true, Thread: &thread, DraftRef: draftRef,
		History: snapshot.History, ThreadSeq: snapshot.ThreadSeq,
		ReplayEvents: []missionControlEvent{}, CoveredTurnIDs: snapshot.CoveredTurnIDs,
	})
}

func (c *Client) missionControlHistory(msg missionControlClientMessage) {
	router, err := c.hub.missionControlRouterForText()
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "missioncontrol_disabled", err.Error()))
		return
	}
	if !validMissionControlRequestID(msg.ThreadID) || msg.ExpectedRuntimeGeneration == 0 {
		c.sendMissionControlResult(missionControlFailure(msg, "bad_request", "history requires a UUID thread_id and expected runtime generation"))
		return
	}
	runtime := router.Runtime(msg.ThreadID)
	if runtime == nil || runtime.Thread.RuntimeGeneration != msg.ExpectedRuntimeGeneration {
		c.sendMissionControlResult(missionControlFailure(msg, "stale_runtime", "select the thread again before reading its history"))
		return
	}
	if !c.hasMissionControlSubscription(msg.ThreadID) {
		c.sendMissionControlResult(missionControlFailure(msg, "selection_required", "history requires prior select/subscription authority on this connection"))
		return
	}
	if err := c.missionControlValidateLive(runtime.Thread); err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "stale_live_incarnation", err.Error()))
		return
	}
	ctx, cancel := context.WithTimeout(c.ctx, missionControlBootWait)
	defer cancel()
	snapshot, err := runtime.Snapshot(ctx, missionControlHistoryTurns)
	if err != nil {
		code := "history_unavailable"
		if errors.Is(err, missioncontrol.ErrThreadBusySnapshot) {
			code = "thread_busy_snapshot"
		}
		c.sendMissionControlResult(missionControlFailure(msg, code, err.Error()))
		return
	}
	thread := runtime.Thread
	c.sendMissionControlResult(missionControlResult{
		Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion, Op: "history",
		RequestID: msg.RequestID, OK: true, Thread: &thread,
		History: snapshot.History, ThreadSeq: snapshot.ThreadSeq,
		ReplayEvents: []missionControlEvent{}, CoveredTurnIDs: snapshot.CoveredTurnIDs,
	})
}

func (c *Client) missionControlTurn(msg missionControlClientMessage) {
	router, err := c.hub.missionControlRouterForText()
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "missioncontrol_disabled", err.Error()))
		return
	}
	text := strings.TrimSpace(msg.Text)
	if !validMissionControlRequestID(msg.ThreadID) || msg.ExpectedRuntimeGeneration == 0 || !validMissionControlRequestID(msg.DraftRef) || text == "" || len(text) > missionControlPromptMaxBytes {
		c.sendMissionControlResult(missionControlFailure(msg, "bad_request", "turn requires selected UUID thread_id, generation, draft_ref, and bounded non-empty text"))
		return
	}
	c.missionControlMu.Lock()
	selection := c.missionControlSelection
	c.missionControlMu.Unlock()
	if selection.threadID != msg.ThreadID || selection.generation != msg.ExpectedRuntimeGeneration || selection.draftRef != msg.DraftRef {
		c.sendMissionControlResult(missionControlFailure(msg, "draft_ref_invalid", "draft_ref is not bound to this connection's selected thread and generation"))
		return
	}
	runtime := router.Runtime(msg.ThreadID)
	if runtime == nil || runtime.Thread.RuntimeGeneration != msg.ExpectedRuntimeGeneration {
		c.sendMissionControlResult(missionControlFailure(msg, "stale_runtime", "select the thread again before submitting"))
		return
	}
	// Revalidate the live workspace immediately before durable admission.
	if err := c.missionControlValidateLive(runtime.Thread); err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "stale_live_incarnation", err.Error()))
		return
	}
	payload, _ := json.Marshal(struct {
		Thread     string `json:"thread_id"`
		Generation uint64 `json:"generation"`
		Text       string `json:"text"`
	}{msg.ThreadID, msg.ExpectedRuntimeGeneration, text})
	catalog, err := c.hub.missionControlCatalog()
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "catalog_unavailable", err.Error()))
		return
	}
	admission, duplicate, err := catalog.Admit(msg.RequestID, msg.ThreadID, msg.ExpectedRuntimeGeneration, payload)
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "admission_refused", err.Error()))
		return
	}
	if duplicate {
		if admission.DispatchState == "admitted" || admission.DispatchState == "unknown" {
			c.sendMissionControlResult(missionControlFailure(msg, "admission_unknown", "request was durably admitted before restart or interruption and will not be replayed automatically"))
			return
		}
		c.sendMissionControlResult(missionControlResult{Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion, Op: "turn", RequestID: msg.RequestID, OK: true, TurnID: admission.TurnID})
		return
	}
	// A second address validation fences a race between durable admission and
	// tool-capable dispatch. This preview has no mutating tools either way.
	if err := c.missionControlValidateLive(runtime.Thread); err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "stale_live_incarnation", err.Error()))
		return
	}
	turn, err := runtime.Submit(msg.RequestID, text, msg.ClientRef)
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "dispatch_uncertain", err.Error()))
		return
	}
	c.sendMissionControlResult(missionControlResult{Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion, Op: "turn", RequestID: msg.RequestID, OK: true, TurnID: turn.ID})
}

func (c *Client) missionControlBindLive(catalog *missioncontrol.Store, workspaceID string) (missioncontrol.Thread, error) {
	hostID, liveWorkspaceID := splitID(workspaceID)
	if liveWorkspaceID == "" || (hostID == "" && workspaceID != liveWorkspaceID) {
		return missioncontrol.Thread{}, errors.New("workspace_id must name one live workspace")
	}
	sess, ok := c.session(hostID)
	if !ok || sess.daemon() == nil {
		return missioncontrol.Thread{}, errors.New("target host is not connected; no local fallback was attempted")
	}
	identityClient, ok := sess.daemon().(missionControlIdentityDaemon)
	if !ok {
		return missioncontrol.Thread{}, errors.New("target daemon does not support stable identity")
	}
	identity, err := identityClient.MissionControlIdentity()
	if err != nil || !validMissionControlRequestID(identity.MachineID) || !validMissionControlRequestID(identity.DaemonIncarnation) {
		return missioncontrol.Thread{}, errors.New("target daemon identity could not be verified")
	}
	workspaces, err := identityClient.ListWorkspacesWithin(sessiond.MissionControlReplyTimeout)
	if err != nil {
		return missioncontrol.Thread{}, errors.New("target workspace could not be verified")
	}
	for _, workspace := range workspaces {
		if workspace.WorkspaceID == liveWorkspaceID {
			if !validMissionControlRequestID(workspace.WorkspaceUUID) {
				return missioncontrol.Thread{}, errors.New("target workspace has no stable identity and remains unbound")
			}
			thread, _, err := catalog.BindWorkspace(identity.MachineID, identity.DaemonIncarnation, hostID, liveWorkspaceID, workspace.WorkspaceUUID, workspace.Name)
			return thread, err
		}
	}
	return missioncontrol.Thread{}, errors.New("target workspace was not found; no current-focus fallback was attempted")
}

func (c *Client) missionControlLookupLive(catalog *missioncontrol.Store, workspaceID string) (missioncontrol.Thread, bool, error) {
	hostID, liveWorkspaceID := splitID(workspaceID)
	if liveWorkspaceID == "" || (hostID == "" && workspaceID != liveWorkspaceID) {
		return missioncontrol.Thread{}, false, errors.New("workspace_id must name one live workspace")
	}
	sess, ok := c.session(hostID)
	if !ok || sess.daemon() == nil {
		return missioncontrol.Thread{}, false, errors.New("target host is not connected; no local fallback was attempted")
	}
	identityClient, ok := sess.daemon().(missionControlIdentityDaemon)
	if !ok {
		return missioncontrol.Thread{}, false, errors.New("target daemon does not support stable identity")
	}
	identity, err := identityClient.MissionControlIdentity()
	if err != nil || !validMissionControlRequestID(identity.MachineID) || !validMissionControlRequestID(identity.DaemonIncarnation) {
		return missioncontrol.Thread{}, false, errors.New("target daemon identity could not be verified")
	}
	workspaces, err := identityClient.ListWorkspacesWithin(sessiond.MissionControlReplyTimeout)
	if err != nil {
		return missioncontrol.Thread{}, false, errors.New("target workspace could not be verified")
	}
	for _, workspace := range workspaces {
		if workspace.WorkspaceID == liveWorkspaceID {
			if !validMissionControlRequestID(workspace.WorkspaceUUID) {
				return missioncontrol.Thread{}, false, errors.New("target workspace has no stable identity and remains unbound")
			}
			thread, _, found, err := catalog.Lookup(identity.MachineID, hostID, workspace.WorkspaceUUID)
			return thread, found, err
		}
	}
	return missioncontrol.Thread{}, false, errors.New("target workspace was not found; no current-focus fallback was attempted")
}

func (c *Client) missionControlResolveLiveThread(catalog *missioncontrol.Store, threadID string) (missioncontrol.Thread, error) {
	if !validMissionControlRequestID(threadID) {
		return missioncontrol.Thread{}, errors.New("thread_id must be a UUID")
	}
	thread, binding, found, err := catalog.Thread(threadID)
	if err != nil || !found {
		return missioncontrol.Thread{}, errors.New("thread is unknown")
	}
	if thread.Lifecycle != "active" {
		return missioncontrol.Thread{}, errors.New("thread is archived; explicitly bind its live workspace to reactivate it")
	}
	if thread.Kind == "lobby" {
		return thread, nil
	}
	sess, ok := c.session(binding.HostID)
	if !ok || sess.daemon() == nil {
		return missioncontrol.Thread{}, errors.New("bound daemon is unavailable; no local fallback was attempted")
	}
	identityClient, ok := sess.daemon().(missionControlIdentityDaemon)
	if !ok {
		return missioncontrol.Thread{}, errors.New("bound daemon does not support stable identity")
	}
	identity, err := identityClient.MissionControlIdentity()
	if err != nil || identity.MachineID != thread.MachineID || !validMissionControlRequestID(identity.DaemonIncarnation) {
		return missioncontrol.Thread{}, errors.New("bound daemon identity is stale or unavailable")
	}
	workspaces, err := identityClient.ListWorkspacesWithin(sessiond.MissionControlReplyTimeout)
	if err != nil {
		return missioncontrol.Thread{}, errors.New("bound workspace list is unavailable")
	}
	for _, workspace := range workspaces {
		if workspace.WorkspaceUUID == thread.WorkspaceUUID {
			bound, _, err := catalog.BindWorkspace(identity.MachineID, identity.DaemonIncarnation, binding.HostID, workspace.WorkspaceID, workspace.WorkspaceUUID, workspace.Name)
			return bound, err
		}
	}
	return missioncontrol.Thread{}, errors.New("bound workspace UUID is no longer live")
}

func (c *Client) missionControlValidateLive(thread missioncontrol.Thread) error {
	if thread.Kind == "lobby" {
		return nil
	}
	catalog, err := c.hub.missionControlCatalog()
	if err != nil {
		return err
	}
	current, err := c.missionControlResolveLiveThread(catalog, thread.ID)
	if err != nil {
		return err
	}
	if current.RuntimeSessionID != thread.RuntimeSessionID || current.RuntimeGeneration != thread.RuntimeGeneration {
		return errors.New("thread runtime changed")
	}
	return nil
}

func (c *Client) ensureMissionControlSubscription(runtime *missioncontrol.Runtime) {
	c.missionControlMu.Lock()
	if c.missionControlSubscriptions == nil {
		c.missionControlSubscriptions = make(map[string]missionControlSubscription)
	}
	if _, ok := c.missionControlSubscriptions[runtime.Thread.ID]; ok {
		c.missionControlMu.Unlock()
		return
	}
	c.missionControlMu.Unlock()
	events, cancel := runtime.Subscribe(512)
	c.attachMissionControlSubscription(runtime, events, cancel)
}

func (c *Client) attachMissionControlSubscription(runtime *missioncontrol.Runtime, events <-chan missioncontrol.RuntimeEvent, cancel func()) {
	c.missionControlMu.Lock()
	if c.missionControlSubscriptions == nil {
		c.missionControlSubscriptions = make(map[string]missionControlSubscription)
	}
	if _, ok := c.missionControlSubscriptions[runtime.Thread.ID]; ok {
		c.missionControlMu.Unlock()
		cancel()
		return
	}
	c.missionControlSubscriptions[runtime.Thread.ID] = missionControlSubscription{cancel: cancel}
	c.missionControlMu.Unlock()
	go func() {
		for event := range events {
			c.sendMissionControlEvent(runtime.Thread, event)
		}
	}()
}

func (c *Client) hasMissionControlSubscription(threadID string) bool {
	c.missionControlMu.Lock()
	defer c.missionControlMu.Unlock()
	_, ok := c.missionControlSubscriptions[threadID]
	return ok
}

func (c *Client) stopMissionControl() {
	c.missionControlMu.Lock()
	subs := c.missionControlSubscriptions
	c.missionControlSubscriptions = nil
	c.missionControlMu.Unlock()
	for _, sub := range subs {
		sub.cancel()
	}
}

func (c *Client) sendMissionControlEvent(thread missioncontrol.Thread, event missioncontrol.RuntimeEvent) {
	frame := missionControlEvent{
		Type: missionControlEventType, ProtocolVersion: missionControlProtocolVersion,
		ThreadID: thread.ID, RuntimeGeneration: thread.RuntimeGeneration,
		EventID: event.EventID, ThreadSeq: event.ThreadSeq, Event: event.Raw,
	}
	data, err := json.Marshal(frame)
	if err != nil {
		log.Printf("missioncontrol: encode event: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("missioncontrol: event write: %v", err)
	}
}

func (c *Client) sendMissionControlResult(result missionControlResult) {
	if result.Type == "" {
		result.Type = missionControlResultType
	}
	if result.ProtocolVersion == 0 {
		result.ProtocolVersion = missionControlProtocolVersion
	}
	data, err := json.Marshal(result)
	if err != nil {
		log.Printf("missioncontrol: encode response: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("missioncontrol: response write error: %v", err)
	}
}
