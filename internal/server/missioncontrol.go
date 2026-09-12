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
	TurnID                    string `json:"turn_id"`
	ApprovalID                string `json:"approval_id"`
	Approved                  *bool  `json:"approved"`
	AttentionID               string `json:"attention_id"`
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
	cancel  func()
	runtime *missioncontrol.Runtime
}

type missionControlResult struct {
	Type                    string                     `json:"type"`
	ProtocolVersion         int                        `json:"protocol_version"`
	Op                      string                     `json:"op"`
	RequestID               string                     `json:"request_id,omitempty"`
	OK                      bool                       `json:"ok"`
	Code                    string                     `json:"code,omitempty"`
	Error                   string                     `json:"error,omitempty"`
	Enabled                 bool                       `json:"enabled"`
	Capabilities            any                        `json:"capabilities,omitempty"`
	Threads                 []missioncontrol.Thread    `json:"threads,omitempty"`
	Workspaces              []missionControlWorkspace  `json:"workspaces,omitempty"`
	Thread                  *missioncontrol.Thread     `json:"thread,omitempty"`
	DraftRef                string                     `json:"draft_ref,omitempty"`
	History                 json.RawMessage            `json:"history,omitempty"`
	ThreadSeq               uint64                     `json:"thread_seq"`
	ReplayEvents            []missionControlEvent      `json:"replay_events"`
	CoveredTurnIDs          []string                   `json:"covered_turn_ids"`
	ReplaySuppressedTurnIDs []string                   `json:"replay_suppressed_turn_ids,omitempty"`
	Active                  *missioncontrol.TurnState  `json:"active,omitempty"`
	Pending                 []missioncontrol.TurnState `json:"pending"`
	Gap                     bool                       `json:"gap"`
	Todo                    json.RawMessage            `json:"todo,omitempty"`
	Goal                    json.RawMessage            `json:"goal,omitempty"`
	Context                 json.RawMessage            `json:"context,omitempty"`
	Summaries               []missioncontrol.Summary   `json:"summaries,omitempty"`
	Attention               []missioncontrol.Attention `json:"attention,omitempty"`
	TurnID                  string                     `json:"turn_id,omitempty"`
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
	// This answers whether the v2 text-preview gate was configured, rather
	// than whether the catalog happened to open.  Callers use it to deny
	// legacy/voice fallbacks when initialization failed closed.
	return h.missionControlTextPreview
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
	case "missioncontrol-summaries":
		c.missionControlSummaries(msg)
	case "missioncontrol-detail":
		c.missionControlDetail(msg)
	case "missioncontrol-attention":
		c.missionControlAttention(msg)
	case "missioncontrol-attention-ack":
		c.missionControlAttentionAck(msg)
	case "missioncontrol-migration-preview":
		c.missionControlMigrationPreview(msg)
	case "missioncontrol-approval":
		c.missionControlApproval(msg)
	case "missioncontrol-cancel":
		c.missionControlCancel(msg)
	case "missioncontrol-reset":
		c.missionControlReset(msg)
	case "missioncontrol-archive":
		c.missionControlArchive(msg)
	case "missioncontrol-voice":
		c.sendMissionControlResult(missionControlFailure(msg, "unsupported_operation", "voice is unavailable in text preview"))
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
	if !c.hub.missionControlTextEnabled() {
		// Disabled is a successful capability negotiation, not a failed
		// configured preview. The browser must retain the legacy conversation.
		c.sendMissionControlResult(missionControlResult{
			Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion,
			Op: "capabilities", RequestID: msg.RequestID, OK: true, Enabled: false,
			Capabilities: map[string]bool{"text_threads": false, "voice": false, "approval": false},
		})
		return
	}
	if _, err := c.hub.missionControlCatalog(); err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "catalog_unavailable", err.Error()))
		return
	}
	if _, err := c.hub.missionControlRouterForText(); err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "runtime_unavailable", err.Error()))
		return
	}
	c.sendMissionControlResult(missionControlResult{
		Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion,
		Op: "capabilities", RequestID: msg.RequestID, OK: true, Enabled: true,
		Capabilities: map[string]bool{
			"text_threads": true, "voice": false, "approval": true,
			"cancel": true, "reset": true, "archive": true, "detail_read_only": true,
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

// missionControlSummaries is a read-only provenance query. It never changes
// selection, starts a root, or places the summaries into an unrelated root.
func (c *Client) missionControlSummaries(msg missionControlClientMessage) {
	catalog, err := c.hub.missionControlCatalog()
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "catalog_unavailable", err.Error()))
		return
	}
	summaries, err := catalog.Summaries(20)
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "summary_unavailable", err.Error()))
		return
	}
	c.sendMissionControlResult(missionControlResult{Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion, Op: "summaries", RequestID: msg.RequestID, OK: true, Summaries: summaries})
}

// missionControlDetail is an explicit browser read request, not a model tool.
// It does not require selection and cannot alter selection, draft state,
// subscriptions, or root lifecycle. It only reads an already-live, current
// runtime after exact generation and live identity attestation.
func (c *Client) missionControlDetail(msg missionControlClientMessage) {
	router, err := c.hub.missionControlRouterForText()
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "missioncontrol_disabled", err.Error()))
		return
	}
	if !validMissionControlRequestID(msg.ThreadID) || msg.ExpectedRuntimeGeneration == 0 {
		c.sendMissionControlResult(missionControlFailure(msg, "detail_refused", "detail requires UUID thread_id and expected_runtime_generation"))
		return
	}
	catalog, err := c.hub.missionControlCatalog()
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "detail_unavailable", err.Error()))
		return
	}
	thread, _, found, err := catalog.Thread(msg.ThreadID)
	if err != nil || !found || thread.Lifecycle != "active" || thread.RuntimeGeneration != msg.ExpectedRuntimeGeneration {
		c.sendMissionControlResult(missionControlFailure(msg, "detail_stale", "thread is unknown, inactive, or has a different runtime generation"))
		return
	}
	if err := c.missionControlAttestDetailLive(catalog, thread); err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "detail_stale", err.Error()))
		return
	}
	runtime := router.Runtime(msg.ThreadID)
	if runtime == nil || runtime.Thread.RuntimeGeneration != msg.ExpectedRuntimeGeneration {
		c.sendMissionControlResult(missionControlFailure(msg, "detail_unavailable", "thread runtime is not live; detail never starts an evicted root"))
		return
	}
	ctx, cancel := context.WithTimeout(c.ctx, missionControlBootWait)
	defer cancel()
	snapshot, err := runtime.Snapshot(ctx, missionControlHistoryTurns)
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "detail_unavailable", err.Error()))
		return
	}
	thread = runtime.Thread
	c.sendMissionControlResult(missionControlResult{
		Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion, Op: "detail",
		RequestID: msg.RequestID, OK: true, Thread: &thread, History: snapshot.History,
		ThreadSeq: snapshot.ThreadSeq, ReplayEvents: missionControlReplayEvents(thread, snapshot.ReplayEvents),
		CoveredTurnIDs: snapshot.CoveredTurnIDs, Active: snapshot.Active, Pending: snapshot.Pending,
		ReplaySuppressedTurnIDs: snapshot.ReplaySuppressedTurnIDs,
		Gap:                     snapshot.Gap, Todo: snapshot.Todo, Goal: snapshot.Goal, Context: snapshot.Context,
	})
}

// missionControlAttestDetailLive is deliberately read-only. Unlike selection
// and turn admission, it never rebinds a workspace or updates catalog
// observation metadata while verifying an explicit Viewer detail request.
func (c *Client) missionControlAttestDetailLive(catalog *missioncontrol.Store, thread missioncontrol.Thread) error {
	if thread.Kind == "lobby" {
		return nil
	}
	_, binding, found, err := catalog.Thread(thread.ID)
	if err != nil || !found || binding.ThreadID != thread.ID {
		return errors.New("thread binding is unavailable or ambiguous")
	}
	sess, ok := c.session(binding.HostID)
	if !ok || sess.daemon() == nil {
		return errors.New("bound daemon is unavailable; no local fallback was attempted")
	}
	identityClient, ok := sess.daemon().(missionControlIdentityDaemon)
	if !ok {
		return errors.New("bound daemon does not support stable identity")
	}
	identity, err := identityClient.MissionControlIdentity()
	if err != nil || identity.MachineID != thread.MachineID || identity.DaemonIncarnation != binding.DaemonIncarnation {
		return errors.New("bound daemon incarnation is stale or unavailable")
	}
	workspaces, err := identityClient.ListWorkspacesWithin(sessiond.MissionControlReplyTimeout)
	if err != nil {
		return errors.New("bound workspace list is unavailable")
	}
	for _, workspace := range workspaces {
		if workspace.WorkspaceID == binding.LiveWorkspaceID && workspace.WorkspaceUUID == thread.WorkspaceUUID {
			return nil
		}
	}
	return errors.New("bound workspace UUID is no longer live")
}

func (c *Client) missionControlAttention(msg missionControlClientMessage) {
	catalog, err := c.hub.missionControlCatalog()
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "catalog_unavailable", err.Error()))
		return
	}
	attention, err := catalog.Attention()
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "attention_unavailable", err.Error()))
		return
	}
	c.sendMissionControlResult(missionControlResult{Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion, Op: "attention", RequestID: msg.RequestID, OK: true, Attention: attention})
}

func (c *Client) missionControlAttentionAck(msg missionControlClientMessage) {
	catalog, err := c.hub.missionControlCatalog()
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "catalog_unavailable", err.Error()))
		return
	}
	record, err := catalog.AcknowledgeAttention(msg.AttentionID)
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "attention_refused", err.Error()))
		return
	}
	c.sendMissionControlResult(missionControlResult{Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion, Op: "attention-ack", RequestID: msg.RequestID, OK: true, Attention: []missioncontrol.Attention{record}})
}

// Migration preview over the WebSocket remains catalog-only inventory. Full
// migration/rollback source-binding preview requires explicit CLI flags, so
// this route never guesses a legacy store directory or session ID.
func (c *Client) missionControlMigrationPreview(msg missionControlClientMessage) {
	preview, err := missioncontrol.PreviewMigration(missioncontrol.PreviewOptions{
		Operation: "migration", CatalogPath: missioncontrol.DefaultPath(),
	})
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "preview_unavailable", err.Error()))
		return
	}
	c.sendMissionControlResult(missionControlResult{
		Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion, Op: "migration-preview",
		RequestID: msg.RequestID, OK: true, Capabilities: preview,
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
	runtime, err := router.Ensure(thread.ID)
	if err != nil {
		code := "runtime_unavailable"
		if errors.Is(err, missioncontrol.ErrWorkerCap) {
			code = "worker_capacity"
		}
		c.sendMissionControlResult(missionControlFailure(msg, code, err.Error()))
		return
	}
	thread = runtime.Thread
	ctx, cancel := context.WithTimeout(c.ctx, missionControlBootWait)
	defer cancel()
	c.ensureMissionControlSubscription(runtime)
	snapshot, err := runtime.Snapshot(ctx, missionControlHistoryTurns)
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "history_unavailable", err.Error()))
		return
	}
	draftRef := uuid.New().String()
	c.missionControlMu.Lock()
	c.missionControlSelection = missionControlSelection{threadID: thread.ID, generation: thread.RuntimeGeneration, draftRef: draftRef}
	c.missionControlMu.Unlock()
	c.sendMissionControlResult(missionControlResult{
		Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion, Op: "select",
		RequestID: msg.RequestID, OK: true, Thread: &thread, DraftRef: draftRef,
		History: snapshot.History, ThreadSeq: snapshot.ThreadSeq,
		ReplayEvents:   missionControlReplayEvents(thread, snapshot.ReplayEvents),
		CoveredTurnIDs: snapshot.CoveredTurnIDs, Active: snapshot.Active, Pending: snapshot.Pending, Gap: snapshot.Gap,
		ReplaySuppressedTurnIDs: snapshot.ReplaySuppressedTurnIDs,
		Todo:                    snapshot.Todo, Goal: snapshot.Goal, Context: snapshot.Context,
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
		c.sendMissionControlResult(missionControlFailure(msg, "history_unavailable", err.Error()))
		return
	}
	thread := runtime.Thread
	c.sendMissionControlResult(missionControlResult{
		Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion, Op: "history",
		RequestID: msg.RequestID, OK: true, Thread: &thread,
		History: snapshot.History, ThreadSeq: snapshot.ThreadSeq,
		ReplayEvents:   missionControlReplayEvents(thread, snapshot.ReplayEvents),
		CoveredTurnIDs: snapshot.CoveredTurnIDs, Active: snapshot.Active, Pending: snapshot.Pending, Gap: snapshot.Gap,
		ReplaySuppressedTurnIDs: snapshot.ReplaySuppressedTurnIDs,
		Todo:                    snapshot.Todo, Goal: snapshot.Goal, Context: snapshot.Context,
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
		if admission.DispatchState == "not_dispatched" {
			c.sendMissionControlResult(missionControlFailure(msg, "dispatch_refused", admission.Refusal))
			return
		}
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
		if _, markErr := catalog.MarkNotDispatched(msg.RequestID, msg.ThreadID, msg.ExpectedRuntimeGeneration, err.Error()); markErr != nil {
			c.sendMissionControlResult(missionControlFailure(msg, "dispatch_uncertain", markErr.Error()))
			return
		}
		c.sendMissionControlResult(missionControlFailure(msg, "dispatch_refused", err.Error()))
		return
	}
	turn, err := runtime.Submit(msg.RequestID, text, msg.ClientRef)
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "dispatch_uncertain", err.Error()))
		return
	}
	c.sendMissionControlResult(missionControlResult{Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion, Op: "turn", RequestID: msg.RequestID, OK: true, TurnID: turn.ID})
}

func (c *Client) selectedRuntime(router *missioncontrol.Router, msg missionControlClientMessage, requireTurn bool) (*missioncontrol.Runtime, error) {
	if !validMissionControlRequestID(msg.ThreadID) || msg.ExpectedRuntimeGeneration == 0 || (requireTurn && msg.TurnID == "") {
		return nil, errors.New("thread_id, expected_runtime_generation, and exact control target are required")
	}
	c.missionControlMu.Lock()
	selection := c.missionControlSelection
	c.missionControlMu.Unlock()
	if selection.threadID != msg.ThreadID || selection.generation != msg.ExpectedRuntimeGeneration {
		return nil, errors.New("control target is not selected on this connection")
	}
	runtime := router.Runtime(msg.ThreadID)
	if runtime == nil || runtime.Thread.RuntimeGeneration != msg.ExpectedRuntimeGeneration {
		return nil, errors.New("thread runtime is stale")
	}
	if err := c.missionControlValidateLive(runtime.Thread); err != nil {
		return nil, err
	}
	return runtime, nil
}

func (c *Client) missionControlCancel(msg missionControlClientMessage) {
	router, err := c.hub.missionControlRouterForText()
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "missioncontrol_disabled", err.Error()))
		return
	}
	runtime, err := c.selectedRuntime(router, msg, true)
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "control_refused", err.Error()))
		return
	}
	if err := runtime.Cancel(msg.TurnID); err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "cancel_refused", err.Error()))
		return
	}
	c.sendMissionControlResult(missionControlResult{Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion, Op: "cancel", RequestID: msg.RequestID, OK: true, Thread: &runtime.Thread, TurnID: msg.TurnID})
}

func (c *Client) missionControlApproval(msg missionControlClientMessage) {
	router, err := c.hub.missionControlRouterForText()
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "missioncontrol_disabled", err.Error()))
		return
	}
	if msg.Approved == nil || msg.ApprovalID == "" {
		c.sendMissionControlResult(missionControlFailure(msg, "bad_request", "approval requires exact approval_id and approved decision"))
		return
	}
	runtime, err := c.selectedRuntime(router, msg, true)
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "control_refused", err.Error()))
		return
	}
	if err := runtime.Approve(msg.TurnID, msg.ApprovalID, *msg.Approved); err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "approval_refused", err.Error()))
		return
	}
	c.sendMissionControlResult(missionControlResult{Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion, Op: "approval", RequestID: msg.RequestID, OK: true, Thread: &runtime.Thread, TurnID: msg.TurnID})
}

func (c *Client) missionControlReset(msg missionControlClientMessage) {
	router, err := c.hub.missionControlRouterForText()
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "missioncontrol_disabled", err.Error()))
		return
	}
	runtime, err := c.selectedRuntime(router, msg, false)
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "control_refused", err.Error()))
		return
	}
	c.hub.mu.RLock()
	voiceBusy := c.hub.missionControlVoiceBusy
	c.hub.mu.RUnlock()
	if voiceBusy != nil && voiceBusy(runtime.Thread.ID) {
		c.sendMissionControlResult(missionControlFailure(msg, "reset_refused", "reset requires a drained Mission Control voice attachment"))
		return
	}
	thread, err := router.Reset(runtime.Thread.ID)
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "reset_refused", err.Error()))
		return
	}
	// Existing selection remains deliberately stale; reset never silently
	// creates/chooses a replacement root or retargets a draft.
	c.sendMissionControlResult(missionControlResult{Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion, Op: "reset", RequestID: msg.RequestID, OK: true, Thread: &thread})
}

func (c *Client) missionControlArchive(msg missionControlClientMessage) {
	router, err := c.hub.missionControlRouterForText()
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "missioncontrol_disabled", err.Error()))
		return
	}
	runtime, err := c.selectedRuntime(router, msg, false)
	if err != nil {
		// Archive is idempotent metadata. A repeat after the first archive has
		// no live root to select, but must not pretend a different target.
		if catalog, catalogErr := c.hub.missionControlCatalog(); catalogErr == nil {
			if thread, _, found, threadErr := catalog.Thread(msg.ThreadID); threadErr == nil && found &&
				thread.RuntimeGeneration == msg.ExpectedRuntimeGeneration && thread.Lifecycle == "archived" {
				c.sendMissionControlResult(missionControlResult{Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion, Op: "archive", RequestID: msg.RequestID, OK: true, Thread: &thread})
				return
			}
		}
		c.sendMissionControlResult(missionControlFailure(msg, "control_refused", err.Error()))
		return
	}
	c.hub.mu.RLock()
	voiceBusy := c.hub.missionControlVoiceBusy
	c.hub.mu.RUnlock()
	if voiceBusy != nil && voiceBusy(runtime.Thread.ID) {
		c.sendMissionControlResult(missionControlFailure(msg, "archive_refused", "archive requires a drained Mission Control voice attachment"))
		return
	}
	thread, err := router.Archive(runtime.Thread.ID)
	if err != nil {
		c.sendMissionControlResult(missionControlFailure(msg, "archive_refused", err.Error()))
		return
	}
	c.sendMissionControlResult(missionControlResult{Type: missionControlResultType, ProtocolVersion: missionControlProtocolVersion, Op: "archive", RequestID: msg.RequestID, OK: true, Thread: &thread})
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
	if sub, ok := c.missionControlSubscriptions[runtime.Thread.ID]; ok && sub.runtime == runtime {
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
	old, exists := c.missionControlSubscriptions[runtime.Thread.ID]
	if exists && old.runtime == runtime {
		c.missionControlMu.Unlock()
		cancel()
		return
	}
	c.missionControlSubscriptions[runtime.Thread.ID] = missionControlSubscription{cancel: cancel, runtime: runtime}
	c.missionControlMu.Unlock()
	if exists {
		old.cancel()
	}
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

func missionControlReplayEvents(thread missioncontrol.Thread, events []missioncontrol.RuntimeEvent) []missionControlEvent {
	out := make([]missionControlEvent, 0, len(events))
	for _, event := range events {
		out = append(out, missionControlEvent{
			Type: missionControlEventType, ProtocolVersion: missionControlProtocolVersion,
			ThreadID: thread.ID, RuntimeGeneration: thread.RuntimeGeneration,
			EventID: event.EventID, ThreadSeq: event.ThreadSeq, Event: event.Raw,
		})
	}
	return out
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
