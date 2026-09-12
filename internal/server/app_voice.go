package server

// App-global voice owns a provider bridge, never a Mission Control thread.
// Browser operations are reservations: the browser's existing handler remains
// the authority that commits navigation, drafts, and visible turn submission.

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/kenotron-ms/muxterm/internal/config"
	"github.com/kenotron-ms/muxterm/internal/mcp"
	"github.com/kenotron-ms/muxterm/internal/missioncontrol"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
	"github.com/kenotron-ms/muxterm/internal/voice"
)

const (
	appVoiceProtocol     = 1
	appVoiceOfferMax     = 256 << 10
	appVoiceOperationTTL = 10 * time.Second
	appVoiceOperationCap = 8
	appVoiceCaptureCap   = 8
	// A fixed two-bit digest tombstone never re-admits a retired input ID.
	// Collisions refuse a new input safely rather than reusing old authority.
	appVoiceInputReplayWords = 8192
	appVoiceFunctionMapCap   = 8
)

type appVoiceObservation struct {
	Revision uint64         `json:"revision"`
	Active   map[string]any `json:"active"`
}

type appVoiceOperation struct {
	ID, Action      string
	Epoch, Revision uint64
	Target          map[string]any
	Text, DraftMode string
	Correlation     voice.Correlation
	Expires         time.Time
	requestID       string
	turnID          string
	dispatchState   string
	done            chan appVoiceOperationResult
}
type appVoiceOperationResult struct {
	output string
	err    error
}

type appVoiceService struct {
	mu                             sync.Mutex
	hub                            *Hub
	provider                       *voice.Manager
	owner                          *Client
	epoch                          uint64
	control, sessionID, drainNonce string
	observation                    appVoiceObservation
	operations                     map[string]*appVoiceOperation
	captures                       map[string]*appVoiceCapture
	responses                      map[string]string
	inputs                         map[string]string
	retiredInputBits               [appVoiceInputReplayWords]uint64
	bridge                         *appVoiceBridge
	providerGeneration             uint64
	minting                        bool
}
type appVoiceCapture struct {
	inputItemID, responseID, responseNonce, continuationNonce string
	terminal, continuationPending                             bool
	calls                                                     map[string]bool
	outputCalls                                               map[string]string
	dispatchItem                                              string
}

// appVoiceBridge is minted once for one exact owner, lease epoch, and provider
// generation. It must never consult a later owner as authority for a late
// sideband callback.
type appVoiceBridge struct {
	service           *appVoiceService
	owner             *Client
	epoch, generation uint64
}

func (b *appVoiceBridge) activeLocked() bool {
	s := b.service
	return b.owner != nil && s.owner == b.owner && s.epoch == b.epoch &&
		s.providerGeneration == b.generation && s.sessionID != ""
}

// These satisfy Manager's storage shape only. Sideband dispatch recognises
// AppOperationBridge first, so app voice can never reach the legacy bridge.
func (b *appVoiceBridge) Submit(string) (voice.TurnHandle, error) {
	return nil, errors.New("app voice has no legacy bridge")
}
func (b *appVoiceBridge) Approve(string, bool, string) error {
	return errors.New("app voice has no legacy bridge")
}
func (b *appVoiceBridge) Cancel(string) error {
	return errors.New("app voice has no legacy bridge")
}
func (b *appVoiceBridge) SidebandTerminal(reason string) {
	b.service.mu.Lock()
	current := b.activeLocked()
	session := b.service.sessionID
	b.service.mu.Unlock()
	if current {
		b.service.end(b.owner, b.epoch, session, "provider_ended")
	}
}

func (b *appVoiceBridge) ObserveProviderEvent(event voice.ProviderEvent) error {
	// Provider identity is only meaningful on the server-observed call. Reject
	// any malformed function event before a browser operation is reserved.
	if event.CallID == "" {
		return errors.New("missing provider call ID")
	}
	b.service.mu.Lock()
	defer b.service.mu.Unlock()
	if !b.activeLocked() {
		return errors.New("app voice bridge lease is no longer current")
	}
	if event.Type == "response.created" && event.ResponseID != "" {
		capture := event.Metadata["app_voice_capture_id"]
		nonce := event.Metadata["app_voice_response_nonce"]
		record := b.service.captures[capture]
		if capture == "" || record == nil || nonce == "" {
			return errors.New("provider response has no committed app capture")
		}
		if record.responseID == "" {
			if nonce != record.responseNonce {
				return errors.New("provider response nonce does not match committed capture")
			}
		} else if !record.terminal || !record.continuationPending || nonce != record.continuationNonce {
			return errors.New("provider response is not the queued continuation")
		} else {
			delete(b.service.responses, record.responseID)
			record.continuationPending = false
			record.continuationNonce = ""
			record.terminal = false
			record.responseNonce = nonce
		}
		record.responseID = event.ResponseID
		b.service.responses[event.ResponseID] = capture
	}
	if (event.Type == "response.output_item.added" || event.Type == "response.output_item.done") && event.ResponseID != "" {
		capture := b.service.responses[event.ResponseID]
		record := b.service.captures[capture]
		if record == nil || record.responseID != event.ResponseID {
			return errors.New("provider output item has no current app response")
		}
		if event.OutputID != "" && event.CallRef != "" {
			if _, known := record.outputCalls[event.OutputID]; !known && len(record.outputCalls) >= appVoiceFunctionMapCap {
				return errors.New("too many provider function items for app capture")
			}
			record.outputCalls[event.OutputID] = event.CallRef
		}
	}
	if (event.Type == "response.done" || event.Type == "response.cancelled") && event.ResponseID != "" {
		if capture := b.service.responses[event.ResponseID]; capture != "" {
			if record := b.service.captures[capture]; record != nil {
				record.terminal = true
				b.service.releaseCaptureLocked(capture)
			}
		}
	}
	return nil
}
func (b *appVoiceBridge) ReserveToolCall(event voice.ProviderEvent) (voice.Correlation, error) {
	if event.CallRef == "" || event.ItemID == "" || event.ResponseID == "" {
		return voice.Correlation{}, errors.New("unmapped provider function call")
	}
	b.service.mu.Lock()
	defer b.service.mu.Unlock()
	if !b.activeLocked() {
		return voice.Correlation{}, errors.New("app voice bridge lease is no longer current")
	}
	id := b.service.responses[event.ResponseID]
	record := b.service.captures[id]
	if id == "" || record == nil || record.responseID != event.ResponseID || record.terminal {
		return voice.Correlation{}, errors.New("provider capture is unmapped")
	}
	callID := record.outputCalls[event.ItemID]
	if callID == "" || (event.CallRef != "" && event.CallRef != callID) {
		return voice.Correlation{}, errors.New("provider function call has no verified output-item mapping")
	}
	if record.dispatchItem != "" && record.dispatchItem != event.ItemID {
		// A capture admits one finite browser operation. Return the verified
		// provider function reference so Sideband can explicitly answer this
		// extra call without replacing the first call's continuation nonce.
		record.calls[event.ItemID] = true
		return voice.Correlation{ProviderCallID: callID, ProviderItemID: event.ItemID, ProviderResponseID: event.ResponseID, CaptureID: id}, errors.New("second provider function call for app capture is refused")
	}
	record.dispatchItem = event.ItemID
	record.calls[event.ItemID] = false
	return voice.Correlation{ProviderCallID: callID, ProviderItemID: event.ItemID, ProviderResponseID: event.ResponseID, CaptureID: id}, nil
}
func (b *appVoiceBridge) ResolveToolCall(event voice.ProviderEvent) (voice.Correlation, error) {
	return b.ReserveToolCall(event)
}
func (b *appVoiceBridge) ExecuteAppTool(c voice.Correlation, name string, args map[string]any) (string, error) {
	return b.service.execute(b, c, name, args)
}
func (b *appVoiceBridge) CompleteAppTool(c voice.Correlation) (map[string]string, error) {
	b.service.mu.Lock()
	defer b.service.mu.Unlock()
	if !b.activeLocked() {
		return nil, errors.New("app voice bridge lease is no longer current")
	}
	captureID := b.service.responses[c.ProviderResponseID]
	record := b.service.captures[captureID]
	if record == nil || record.responseID != c.ProviderResponseID || record.calls[c.ProviderItemID] ||
		record.outputCalls[c.ProviderItemID] != c.ProviderCallID || record.continuationPending {
		return nil, errors.New("app provider call mapping is stale")
	}
	record.calls[c.ProviderItemID] = true
	nonce, err := appVoiceRandom()
	if err != nil {
		return nil, err
	}
	// Keep the old response authority until its response.done arrives. The
	// sideband queues this continuation behind that response; only then may a
	// response.created replace the mapping.
	record.continuationNonce = nonce
	record.continuationPending = true
	return map[string]string{"app_voice_capture_id": captureID, "app_voice_response_nonce": nonce}, nil
}
func (b *appVoiceBridge) CommitAppInput(event voice.ProviderEvent) (map[string]string, bool, error) {
	if event.ItemID == "" {
		return nil, false, errors.New("provider committed input has no item ID")
	}
	id, err := appVoiceRandom()
	if err != nil {
		return nil, false, err
	}
	b.service.mu.Lock()
	defer b.service.mu.Unlock()
	if !b.activeLocked() {
		return nil, false, errors.New("app voice bridge lease is no longer current")
	}
	if _, exists := b.service.inputs[event.ItemID]; exists {
		return nil, false, nil
	}
	if b.service.retiredInputSeenLocked(event.ItemID) {
		return nil, false, nil
	}
	if len(b.service.captures) >= appVoiceCaptureCap {
		return nil, false, errors.New("app_capture_busy")
	}
	b.service.captures[id] = &appVoiceCapture{inputItemID: event.ItemID, calls: make(map[string]bool), outputCalls: make(map[string]string)}
	nonce, err := appVoiceRandom()
	if err != nil {
		delete(b.service.captures, id)
		return nil, false, err
	}
	b.service.captures[id].responseNonce = nonce
	b.service.inputs[event.ItemID] = id
	return map[string]string{"app_voice_capture_id": id, "app_voice_response_nonce": nonce}, true, nil
}
func (s *appVoiceService) releaseCaptureLocked(captureID string) {
	record := s.captures[captureID]
	if record == nil || !record.terminal || record.continuationPending {
		return
	}
	for _, done := range record.calls {
		if !done {
			return
		}
	}
	delete(s.responses, record.responseID)
	delete(s.inputs, record.inputItemID)
	delete(s.captures, captureID)
	s.retireInputLocked(record.inputItemID)
}
func (s *appVoiceService) retireInputLocked(inputID string) {
	if inputID == "" {
		return
	}
	first, second := appVoiceInputReplaySlots(inputID)
	s.retiredInputBits[first/64] |= uint64(1) << (first % 64)
	s.retiredInputBits[second/64] |= uint64(1) << (second % 64)
}
func (s *appVoiceService) retiredInputSeenLocked(inputID string) bool {
	first, second := appVoiceInputReplaySlots(inputID)
	return s.retiredInputBits[first/64]&(uint64(1)<<(first%64)) != 0 &&
		s.retiredInputBits[second/64]&(uint64(1)<<(second%64)) != 0
}
func appVoiceInputReplaySlots(inputID string) (int, int) {
	digest := sha256.Sum256([]byte(inputID))
	const slots = appVoiceInputReplayWords * 64
	first := (int(digest[0])<<16 | int(digest[1])<<8 | int(digest[2])) % slots
	second := (int(digest[3])<<16 | int(digest[4])<<8 | int(digest[5])) % slots
	return first, second
}

func (s *Server) registerAppVoiceRoutes(cfg config.VoiceConfig, protect func(http.Handler) http.Handler) {
	// This runs during Server construction, before the status route is
	// registered and before the Server is available to concurrent requests.
	// Publish s.appVoice only after every candidate gate and provider setup
	// succeeds; buildVoiceStatus reports that runtime fact, never disk intent.
	if !s.cfg.MissionControl.VoicePreview || !cfg.Enabled || cfg.Validate() != nil {
		return
	}
	mgr, err := voice.NewManager(cfg, appVoiceDisabledBridge{}, voice.DefaultKeyPath())
	if err != nil {
		log.Printf("app voice: provider unavailable: %v", err)
		return
	}
	service := &appVoiceService{hub: s.hub, provider: mgr, operations: make(map[string]*appVoiceOperation), captures: make(map[string]*appVoiceCapture), responses: make(map[string]string), inputs: make(map[string]string)}
	s.appVoice = service
	s.hub.appVoice = service
	mgr.SetOnEnded(func(sessionID, reason string) { service.end(nil, 0, sessionID, reason) })
	s.mux.Handle("POST /api/app/voice/token", protect(http.HandlerFunc(s.handleAppVoiceToken)))
	s.mux.Handle("POST /api/app/voice/sdp", protect(http.HandlerFunc(s.handleAppVoiceSDP)))
	s.mux.Handle("POST /api/app/voice/end", protect(http.HandlerFunc(s.handleAppVoiceEnd)))
}

type appVoiceDisabledBridge struct{}

func (appVoiceDisabledBridge) Submit(string) (voice.TurnHandle, error) {
	return nil, errors.New("legacy bridge disabled")
}
func (appVoiceDisabledBridge) Approve(string, bool, string) error {
	return errors.New("legacy bridge disabled")
}
func (appVoiceDisabledBridge) Cancel(string) error { return errors.New("legacy bridge disabled") }

func (s *appVoiceService) handleFrame(c *Client, raw []byte) {
	var f struct {
		Type             string         `json:"type"`
		Protocol         int            `json:"protocol_version"`
		Epoch            uint64         `json:"lease_epoch"`
		Takeover         bool           `json:"takeover"`
		Revision         uint64         `json:"revision"`
		Active           map[string]any `json:"active"`
		OperationID      string         `json:"operation_id"`
		ExpectedRevision uint64         `json:"expected_revision"`
		Status           string         `json:"status"`
		Code             string         `json:"code"`
		Error            string         `json:"error"`
		Result           map[string]any `json:"result"`
		DrainNonce       string         `json:"drain_nonce"`
	}
	if json.Unmarshal(raw, &f) != nil || f.Protocol != appVoiceProtocol {
		return
	}
	switch f.Type {
	case "app-voice-claim":
		s.claim(c, f.Takeover)
	case "app-voice-release":
		s.release(c, f.Epoch)
	case "app-voice-drain-ack":
		s.drainAck(c, f.Epoch, f.DrainNonce)
	case "app-voice-observation":
		s.observe(c, f.Epoch, f.Revision, f.Active)
	case "app-voice-operation-ack":
		s.ack(c, f)
	}
}

func (s *appVoiceService) claim(c *Client, takeover bool) {
	if !c.appVoiceAllowed {
		c.sendAppVoice(appVoiceRefusal("origin_required", "app voice requires an exact same-origin WebSocket handshake"))
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.owner != nil && s.owner != c {
		if takeover {
			if s.drainNonce == "" {
				s.drainNonce, _ = appVoiceRandom()
				s.owner.sendAppVoice(map[string]any{"type": "app-voice-drain-request", "protocol_version": 1, "lease_epoch": s.epoch, "drain_nonce": s.drainNonce, "reason": "explicit_takeover"})
			}
			c.sendAppVoice(appVoiceRefusal("takeover_drain_required", "current owner must acknowledge browser drain"))
			return
		}
		c.sendAppVoice(appVoiceRefusal("lease_active", "another browser owns app voice"))
		return
	}
	if s.owner == c {
		c.sendAppVoice(s.claimResultLocked())
		return
	}
	s.epoch++
	s.owner = c
	s.control, _ = appVoiceRandom()
	s.sessionID = ""
	s.drainNonce = ""
	s.observation = appVoiceObservation{}
	s.captures = make(map[string]*appVoiceCapture)
	s.responses = make(map[string]string)
	s.inputs = make(map[string]string)
	s.retiredInputBits = [appVoiceInputReplayWords]uint64{}
	s.bridge = nil
	s.minting = false
	c.sendAppVoice(s.claimResultLocked())
}
func (s *appVoiceService) claimResultLocked() map[string]any {
	return map[string]any{"type": "app-voice-claim-result", "protocol_version": 1, "ok": true, "lease_epoch": s.epoch, "control_token": s.control, "state": "claimed"}
}
func appVoiceRefusal(code, detail string) map[string]any {
	return map[string]any{"type": "app-voice-claim-result", "protocol_version": 1, "ok": false, "code": code, "error": detail}
}
func (s *appVoiceService) drainAck(c *Client, epoch uint64, nonce string) {
	s.mu.Lock()
	if c != s.owner || epoch != s.epoch || nonce == "" || nonce != s.drainNonce {
		s.mu.Unlock()
		return
	}
	session := s.sessionID
	s.drainNonce = ""
	s.mu.Unlock()
	if session != "" {
		s.provider.End(session)
	}
	s.end(c, epoch, session, "takeover")
}

// release is the owner-socket explicit-stop path. Unlike HTTP end it also
// fences a claimed lease whose provider mint has not yet produced a session.
func (s *appVoiceService) release(c *Client, epoch uint64) {
	s.mu.Lock()
	if c != s.owner || epoch == 0 || epoch != s.epoch {
		s.mu.Unlock()
		return
	}
	session := s.sessionID
	owner, endedEpoch := s.endLocked()
	s.mu.Unlock()
	if session != "" {
		s.provider.End(session)
	}
	if owner != nil {
		owner.sendAppVoice(map[string]any{"type": "app-voice-lease-ended", "protocol_version": 1, "lease_epoch": endedEpoch, "reason": "explicit_end"})
	}
}
func (s *appVoiceService) observe(c *Client, epoch, revision uint64, active map[string]any) {
	if !c.appVoiceAllowed || !validAppObservation(c, active) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if c != s.owner || epoch != s.epoch || revision == 0 || revision <= s.observation.Revision {
		return
	}
	s.refuseOperationsLocked("focus_changed")
	s.observation = appVoiceObservation{Revision: revision, Active: active}
}
func validAppObservation(c *Client, active map[string]any) bool {
	if active == nil {
		return false
	}
	surface, _ := active["surface"].(string)
	if surface != "mission_control" && surface != "dock" {
		return false
	}
	if workspace, _ := active["workspace_id"].(string); workspace != "" && !c.appVoiceWorkspaceKnown(workspace) {
		return false
	}
	if applet, _ := active["applet_id"].(string); applet != "" && applet != "dashboard" && applet != "files" && applet != "prs" && applet != "artifact" {
		return false
	}
	if pane, ok := active["pane_id"].(float64); ok && pane > 0 {
		workspace, _ := active["workspace_id"].(string)
		if workspace == "" || !c.appVoicePaneKnown(workspace, int(pane)) {
			return false
		}
	}
	if detail, _ := active["detail"].(string); detail != "" {
		thread, _ := active["thread_id"].(string)
		generation, _ := appVoiceUint(active["runtime_generation"])
		if detail != thread || !c.appVoiceThreadKnown(thread, generation) {
			return false
		}
	}
	if thread, _ := active["thread_id"].(string); thread != "" {
		generation, ok := appVoiceUint(active["runtime_generation"])
		if !ok || !c.appVoiceThreadKnown(thread, generation) {
			return false
		}
	}
	if composer, ok := active["composer"].(map[string]any); ok {
		channel, _ := composer["channel_id"].(string)
		threadID, _ := composer["thread_id"].(string)
		if channel == "none" {
			return threadID == ""
		}
		if channel == "legacy-cos" {
			return threadID == ""
		}
		generation, generationOK := appVoiceUint(composer["runtime_generation"])
		sessionID, _ := composer["runtime_session_id"].(string)
		incarnation, _ := composer["runtime_incarnation"].(string)
		draftRef, _ := composer["draft_ref"].(string)
		return strings.HasPrefix(channel, "thread:") && channel == "thread:"+threadID &&
			validMissionControlRequestID(threadID) && generationOK &&
			validMissionControlRequestID(sessionID) && validMissionControlRequestID(incarnation) &&
			validMissionControlRequestID(draftRef) && c.appVoiceThreadKnown(threadID, generation)
	}
	return true
}

func (s *appVoiceService) execute(bridge *appVoiceBridge, correlation voice.Correlation, name string, args map[string]any) (string, error) {
	s.mu.Lock()
	if !bridge.activeLocked() {
		s.mu.Unlock()
		return "", errors.New("app voice bridge lease is no longer current")
	}
	if name == voice.AppToolObserve {
		owner := s.owner
		revision, active := s.observation.Revision, cloneAppTarget(s.observation.Active)
		s.mu.Unlock()
		// Catalog and client reads must never happen while the service lock is
		// held: disconnect takes the inverse path through Hub.
		threads := s.appVoiceThreads()
		out, _ := json.Marshal(map[string]any{"revision": revision, "active": active, "machines": owner.appVoiceMachines(), "workspaces": owner.appVoiceWorkspaces(), "panes": owner.appVoiceKnownPanes(), "threads": threads, "fleet": owner.appVoiceFleet()})
		return string(out), nil
	}
	if name == voice.AppToolTranscript {
		s.mu.Unlock()
		machine, _ := args["machine"].(string)
		sessionID, _ := args["session_id"].(string)
		n := 0
		if raw, ok := args["last_n"]; ok {
			if parsed, ok := appVoiceUint(raw); ok {
				n = int(parsed)
			}
		}
		if machine == "" || sessionID == "" {
			return "", errors.New("machine and session_id are required")
		}
		return s.readTranscript(machine, sessionID, n)
	}
	if name != voice.AppToolNavigate && name != voice.AppToolComposerDraft && name != voice.AppToolSubmitThreadTurn {
		s.mu.Unlock()
		return "", errors.New("unknown app tool")
	}
	expected, ok := appVoiceUint(args["expected_revision"])
	if !ok || expected != s.observation.Revision {
		s.mu.Unlock()
		return "", errors.New("stale_observation")
	}
	target, ok := args["target"].(map[string]any)
	owner, active := bridge.owner, cloneAppTarget(s.observation.Active)
	s.mu.Unlock()
	if !ok || !validAppTarget(name, target) || !s.validTarget(owner, active, name, target) {
		return "", errors.New("target_mismatch")
	}
	s.mu.Lock()
	if !bridge.activeLocked() || s.owner != owner || s.observation.Revision != expected {
		s.mu.Unlock()
		return "", errors.New("stale_observation")
	}
	if len(s.operations) >= appVoiceOperationCap {
		s.mu.Unlock()
		return "", errors.New("operation_capacity")
	}
	id := uuid.New().String()
	op := &appVoiceOperation{ID: id, Epoch: s.epoch, Revision: expected, Action: appAction(name), Target: target, Correlation: correlation, Expires: time.Now().Add(appVoiceOperationTTL), done: make(chan appVoiceOperationResult, 1)}
	if text, _ := args["text"].(string); len(text) > 131072 {
		s.mu.Unlock()
		return "", errors.New("text_too_large")
	} else {
		op.Text = text
	}
	if name == voice.AppToolSubmitThreadTurn && strings.TrimSpace(op.Text) == "" {
		s.mu.Unlock()
		return "", errors.New("submit text is required")
	}
	if mode, _ := args["mode"].(string); name == voice.AppToolComposerDraft && mode != "inspect" && mode != "set" {
		s.mu.Unlock()
		return "", errors.New("draft_mode_invalid")
	} else {
		op.DraftMode = mode
	}
	s.operations[id] = op
	owner = s.owner
	s.mu.Unlock()
	owner.sendAppVoice(map[string]any{"type": "app-voice-operation", "protocol_version": 1, "operation_id": id, "lease_epoch": op.Epoch, "expected_revision": op.Revision, "action": op.Action, "target": op.Target, "text": op.Text, "draft_mode": op.DraftMode})
	select {
	case result := <-op.done:
		if result.err != nil {
			return "", result.err
		}
		return result.output, nil
	case <-time.After(appVoiceOperationTTL):
		s.mu.Lock()
		delete(s.operations, id)
		s.mu.Unlock()
		return "", errors.New("operation_expired")
	}
}

func (s *appVoiceService) appVoiceThreads() []map[string]any {
	catalog, err := s.hub.missionControlCatalog()
	if err != nil {
		return nil
	}
	rows, err := catalog.List()
	if err != nil {
		return nil
	}
	out := make([]map[string]any, 0, 128)
	for _, row := range rows {
		if len(out) == 128 {
			break
		}
		out = append(out, map[string]any{"thread_id": row.ID, "runtime_generation": row.RuntimeGeneration, "label": boundedThreadVoiceLabel(row)})
	}
	return out
}
func appAction(tool string) string {
	if tool == voice.AppToolNavigate {
		return "navigate"
	}
	if tool == voice.AppToolComposerDraft {
		return "composer_draft"
	}
	return "submit_thread_turn"
}
func appVoiceUint(v any) (uint64, bool) {
	n, ok := v.(float64)
	return uint64(n), ok && n > 0 && float64(uint64(n)) == n
}
func validAppTarget(tool string, t map[string]any) bool {
	k, _ := t["kind"].(string)
	switch tool {
	case voice.AppToolNavigate:
		return k == "workspace" || k == "thread" || k == "pane" || k == "applet" || k == "detail"
	case voice.AppToolComposerDraft:
		return k == "composer"
	case voice.AppToolSubmitThreadTurn:
		return k == "thread_turn"
	}
	return false
}

func (s *appVoiceService) validTarget(owner *Client, active map[string]any, tool string, target map[string]any) bool {
	if owner == nil {
		return false
	}
	kind, _ := target["kind"].(string)
	switch tool {
	case voice.AppToolNavigate:
		switch kind {
		case "workspace":
			id, _ := target["workspace_id"].(string)
			return id != "" && owner.appVoiceWorkspaceKnown(id)
		case "pane":
			id, _ := target["workspace_id"].(string)
			pane, _ := target["pane_id"].(float64)
			return id != "" && owner.appVoiceWorkspaceKnown(id) && pane > 0 && owner.appVoicePaneKnown(id, int(pane))
		case "applet":
			id, _ := target["applet_id"].(string)
			return id == "dashboard" || id == "files" || id == "prs" || id == "artifact"
		case "thread":
			threadID, _ := target["thread_id"].(string)
			generation, _ := appVoiceUint(target["runtime_generation"])
			if !owner.appVoiceThreadKnown(threadID, generation) {
				return false
			}
			catalog, err := s.hub.missionControlCatalog()
			if err != nil {
				return false
			}
			thread, _, found, err := catalog.Thread(threadID)
			return err == nil && found && thread.Lifecycle == "active" && thread.RuntimeGeneration == generation
		case "detail":
			threadID, _ := target["thread_id"].(string)
			detailID, _ := target["detail_id"].(string)
			generation, _ := appVoiceUint(target["runtime_generation"])
			if detailID != threadID || !owner.appVoiceThreadKnown(threadID, generation) {
				return false
			}
			catalog, err := s.hub.missionControlCatalog()
			if err != nil {
				return false
			}
			thread, _, found, err := catalog.Thread(threadID)
			return err == nil && found && thread.Lifecycle == "active" && thread.RuntimeGeneration == generation
		}
	case voice.AppToolComposerDraft:
		return appTargetsEqual(target, appComposerTarget(active))
	case voice.AppToolSubmitThreadTurn:
		if !appTargetMatchesExcept(target, appThreadTurnTarget(active), "machine_id") {
			return false
		}
		threadID, _ := target["thread_id"].(string)
		generation, _ := appVoiceUint(target["runtime_generation"])
		if !owner.appVoiceThreadKnown(threadID, generation) {
			return false
		}
		catalog, err := s.hub.missionControlCatalog()
		if err != nil {
			return false
		}
		thread, _, found, err := catalog.Thread(threadID)
		return err == nil && found && thread.Lifecycle == "active" &&
			thread.MachineID == target["machine_id"] && thread.RuntimeSessionID == target["runtime_session_id"] &&
			thread.RuntimeGeneration == generation && thread.RuntimeIncarnation == target["runtime_incarnation"]
	}
	return false
}
func cloneAppTarget(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}
func appComposerTarget(active map[string]any) map[string]any {
	composer, _ := active["composer"].(map[string]any)
	if composer == nil {
		return nil
	}
	return map[string]any{"kind": "composer", "channel_id": composer["channel_id"], "thread_id": composer["thread_id"], "runtime_generation": composer["runtime_generation"], "draft_ref": composer["draft_ref"]}
}
func appThreadTurnTarget(active map[string]any) map[string]any {
	composer, _ := active["composer"].(map[string]any)
	if composer == nil {
		return nil
	}
	threadID, _ := composer["thread_id"].(string)
	if threadID == "" {
		return nil
	}
	return map[string]any{"kind": "thread_turn", "channel_id": composer["channel_id"], "thread_id": threadID, "runtime_session_id": composer["runtime_session_id"], "runtime_generation": composer["runtime_generation"], "runtime_incarnation": composer["runtime_incarnation"], "draft_ref": composer["draft_ref"]}
}
func appTargetMatchesExcept(actual, expected map[string]any, skip string) bool {
	if expected == nil {
		return false
	}
	for key, want := range expected {
		if key != skip && actual[key] != want {
			return false
		}
	}
	return true
}
func (s *appVoiceService) ack(c *Client, f struct {
	Type             string         `json:"type"`
	Protocol         int            `json:"protocol_version"`
	Epoch            uint64         `json:"lease_epoch"`
	Takeover         bool           `json:"takeover"`
	Revision         uint64         `json:"revision"`
	Active           map[string]any `json:"active"`
	OperationID      string         `json:"operation_id"`
	ExpectedRevision uint64         `json:"expected_revision"`
	Status           string         `json:"status"`
	Code             string         `json:"code"`
	Error            string         `json:"error"`
	Result           map[string]any `json:"result"`
	DrainNonce       string         `json:"drain_nonce"`
}) {
	s.mu.Lock()
	op := s.operations[f.OperationID]
	if c != s.owner || op == nil || f.Epoch != s.epoch || f.Epoch != op.Epoch || f.ExpectedRevision != op.Revision || time.Now().After(op.Expires) {
		s.mu.Unlock()
		return
	}
	active, _ := f.Result["active"].(map[string]any)
	selected, selectedOK := f.Result["selected_target"].(map[string]any)
	navigationRevision, navigationRevisionOK := appVoiceUint(f.Result["observation_revision"])
	if op.Action == "navigate" && (!navigationRevisionOK || navigationRevision <= op.Revision || !selectedOK || !appTargetsEqual(selected, op.Target)) {
		delete(s.operations, op.ID)
		s.mu.Unlock()
		op.done <- appVoiceOperationResult{err: errors.New("navigation acknowledgement mismatch")}
		return
	}
	s.mu.Unlock()
	if op.Action == "navigate" && (!validAppObservation(c, active) || !appActiveMatchesTarget(active, op.Target)) {
		s.mu.Lock()
		if s.operations[op.ID] == op {
			delete(s.operations, op.ID)
		}
		s.mu.Unlock()
		op.done <- appVoiceOperationResult{err: errors.New("navigation acknowledgement active observation is invalid")}
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.operations[op.ID] != op || c != s.owner || s.epoch != op.Epoch {
		return
	}
	delete(s.operations, op.ID)
	if f.Status != "ok" {
		op.done <- appVoiceOperationResult{err: errors.New("operation refused: " + f.Code)}
		return
	}
	if !validAppAck(op, f.Result) {
		op.done <- appVoiceOperationResult{err: errors.New("operation acknowledgement mismatch")}
		return
	}
	if op.Action == "navigate" {
		s.observation.Revision = navigationRevision
		s.observation.Active = active
	}
	out, _ := json.Marshal(f.Result)
	op.done <- appVoiceOperationResult{output: string(out)}
}
func validAppAck(op *appVoiceOperation, result map[string]any) bool {
	if result == nil {
		return false
	}
	if op.Action == "navigate" {
		selected, ok := result["selected_target"].(map[string]any)
		_, active := result["active"].(map[string]any)
		return ok && active && appTargetsEqual(selected, op.Target)
	}
	if op.Action == "composer_draft" {
		channel, _ := result["channel_id"].(string)
		want, _ := op.Target["channel_id"].(string)
		return channel != "" && channel == want
	}
	turn, _ := result["turn_id"].(string)
	thread, _ := result["thread_id"].(string)
	want, _ := op.Target["thread_id"].(string)
	return turn != "" && thread == want && turn == op.turnID &&
		(op.dispatchState == "dispatched" || op.dispatchState == "terminal")
}
func appActiveMatchesTarget(active, target map[string]any) bool {
	kind, _ := target["kind"].(string)
	switch kind {
	case "workspace":
		return active["workspace_id"] == target["workspace_id"]
	case "pane":
		return active["workspace_id"] == target["workspace_id"] && active["pane_id"] == target["pane_id"]
	case "applet":
		return active["applet_id"] == target["applet_id"]
	case "thread":
		return active["thread_id"] == target["thread_id"] && active["runtime_generation"] == target["runtime_generation"]
	case "detail":
		return active["thread_id"] == target["thread_id"] && active["runtime_generation"] == target["runtime_generation"] && active["detail"] == target["detail_id"]
	}
	return false
}
func appTargetsEqual(a, b map[string]any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}
func (s *appVoiceService) end(c *Client, epoch uint64, session, reason string) {
	s.mu.Lock()
	if s.owner == nil || (c != nil && (c != s.owner || epoch != s.epoch)) || (session != "" && session != s.sessionID) {
		s.mu.Unlock()
		return
	}
	owner, endedEpoch := s.endLocked()
	s.mu.Unlock()
	if owner != nil {
		owner.sendAppVoice(map[string]any{"type": "app-voice-lease-ended", "protocol_version": 1, "lease_epoch": endedEpoch, "reason": reason})
	}
}
func (s *appVoiceService) endLocked() (*Client, uint64) {
	owner := s.owner
	endedEpoch := s.epoch
	s.owner = nil
	s.sessionID = ""
	s.control = ""
	s.drainNonce = ""
	s.bridge = nil
	s.minting = false
	s.refuseOperationsLocked("lease_ended")
	s.captures = make(map[string]*appVoiceCapture)
	s.responses = make(map[string]string)
	s.inputs = make(map[string]string)
	return owner, endedEpoch
}
func (s *appVoiceService) refuseOperationsLocked(code string) {
	for id, op := range s.operations {
		delete(s.operations, id)
		op.done <- appVoiceOperationResult{err: errors.New(code)}
	}
}
func (s *appVoiceService) disconnect(c *Client) {
	s.mu.Lock()
	if c != s.owner {
		s.mu.Unlock()
		return
	}
	session := s.sessionID
	epoch := s.epoch
	s.mu.Unlock()
	if session != "" {
		s.provider.End(session)
	}
	s.end(c, epoch, session, "owner_disconnected")
}

func isAppVoiceMessage(typ string) bool {
	switch typ {
	case "app-voice-claim", "app-voice-release", "app-voice-drain-ack", "app-voice-observation", "app-voice-operation-ack":
		return true
	}
	return false
}

func (s *Server) appVoiceHTTP(w http.ResponseWriter, r *http.Request) (*appVoiceService, uint64, bool) {
	a := s.appVoice
	if a == nil || r.Header.Get("X-App-Voice-Protocol") != "1" || !s.appVoiceSameOrigin(r) {
		writeAppVoiceFailure(w, http.StatusForbidden, "voice control requires protocol 1 and same origin")
		return nil, 0, false
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 4096))
	r.Body = io.NopCloser(bytes.NewReader(body))
	var in struct {
		Protocol int    `json:"protocol_version"`
		Epoch    uint64 `json:"lease_epoch"`
	}
	_ = json.Unmarshal(body, &in)
	a.mu.Lock()
	defer a.mu.Unlock()
	if in.Protocol != 1 || in.Epoch == 0 || in.Epoch != a.epoch || strings.TrimSpace(r.Header.Get("X-App-Voice-Control")) == "" || r.Header.Get("X-App-Voice-Control") != a.control || a.owner == nil {
		writeAppVoiceFailure(w, http.StatusForbidden, "stale or non-owner app voice lease")
		return nil, 0, false
	}
	return a, in.Epoch, true
}
func (s *Server) appVoiceSameOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	parsed, err := url.Parse(origin)
	if err != nil || origin == "" || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	expected := s.publicBaseURL()
	if expected == "" {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		host, port, err := net.SplitHostPort(s.addr)
		if err != nil || host == "" || port == "" {
			return false
		}
		expected = scheme + "://" + net.JoinHostPort(host, port)
	}
	site := r.Header.Get("Sec-Fetch-Site")
	return strings.EqualFold(origin, expected) && (site == "" || site == "same-origin")
}
func (s *Server) handleAppVoiceToken(w http.ResponseWriter, r *http.Request) {
	a, epoch, ok := s.appVoiceHTTP(w, r)
	if !ok {
		return
	}
	a.mu.Lock()
	if a.sessionID != "" || a.minting || a.owner == nil {
		a.mu.Unlock()
		writeAppVoiceFailure(w, http.StatusConflict, "provider session already minted")
		return
	}
	bridge := &appVoiceBridge{service: a, owner: a.owner, epoch: epoch, generation: a.providerGeneration + 1}
	a.minting = true
	a.mu.Unlock()
	eph, err := a.provider.MintApp(r.Context(), bridge)
	if err != nil {
		a.mu.Lock()
		if a.owner == bridge.owner && a.epoch == bridge.epoch && a.minting {
			a.minting = false
		}
		a.mu.Unlock()
		writeAppVoiceFailure(w, http.StatusBadGateway, "provider mint failed")
		return
	}
	a.mu.Lock()
	if a.owner != bridge.owner || a.epoch != bridge.epoch || a.sessionID != "" || !a.minting {
		if a.owner == bridge.owner && a.epoch == bridge.epoch {
			a.minting = false
		}
		a.mu.Unlock()
		a.provider.End(eph.SessionID)
		writeAppVoiceFailure(w, http.StatusConflict, "lease changed during mint")
		return
	}
	a.sessionID = eph.SessionID
	a.providerGeneration = bridge.generation
	a.bridge = bridge
	a.minting = false
	a.mu.Unlock()
	writeAppVoiceJSON(w, http.StatusOK, map[string]any{"session_id": eph.SessionID, "expires_at": eph.ExpiresAt, "model": a.provider.Config().Model})
}
func (s *Server) handleAppVoiceSDP(w http.ResponseWriter, r *http.Request) {
	a := s.appVoice
	if a == nil || r.Header.Get("X-App-Voice-Protocol") != "1" || !s.appVoiceSameOrigin(r) {
		writeAppVoiceFailure(w, http.StatusForbidden, "same-origin app voice required")
		return
	}
	epoch, err := strconv.ParseUint(r.Header.Get("X-App-Voice-Lease-Epoch"), 10, 64)
	if err != nil {
		writeAppVoiceFailure(w, http.StatusBadRequest, "invalid lease epoch")
		return
	}
	a.mu.Lock()
	valid := a.owner != nil && a.epoch == epoch && r.Header.Get("X-App-Voice-Control") == a.control && r.Header.Get("X-App-Voice-Session") == a.sessionID
	session := a.sessionID
	a.mu.Unlock()
	if !valid {
		writeAppVoiceFailure(w, http.StatusForbidden, "stale or non-owner provider session")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, appVoiceOfferMax))
	if err != nil || len(body) == 0 {
		writeAppVoiceFailure(w, http.StatusBadRequest, "empty SDP offer")
		return
	}
	answer, _, err := a.provider.ConnectApp(r.Context(), session, string(body))
	if err != nil {
		writeAppVoiceFailure(w, http.StatusBadGateway, "provider SDP exchange failed")
		return
	}
	w.Header().Set("Content-Type", "application/sdp")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-App-Voice-Session", session)
	_, _ = io.WriteString(w, answer.SDP)
}
func (s *Server) handleAppVoiceEnd(w http.ResponseWriter, r *http.Request) {
	a, epoch, ok := s.appVoiceHTTP(w, r)
	if !ok {
		return
	}
	var in struct {
		SessionID string `json:"session_id"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in)
	a.mu.Lock()
	session := a.sessionID
	valid := in.SessionID != "" && in.SessionID == session
	a.mu.Unlock()
	if !valid {
		writeAppVoiceFailure(w, http.StatusConflict, "provider session mismatch")
		return
	}
	a.provider.End(session)
	a.end(nil, epoch, session, "explicit_end")
	writeAppVoiceJSON(w, http.StatusOK, map[string]any{"ok": true, "lease_epoch": epoch, "state": "ended"})
}
func writeAppVoiceFailure(w http.ResponseWriter, status int, detail string) {
	writeAppVoiceJSON(w, status, map[string]any{"error": detail})
}
func writeAppVoiceJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func appVoiceRandom() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func (c *Client) sendAppVoice(frame map[string]any) {
	b, err := json.Marshal(frame)
	if err == nil {
		_ = c.writeText(b)
	}
}

// transcript is intentionally refused until the owner has an exact current
// fleet entry and a daemon exposing the optional bounded reader seam.
func (s *appVoiceService) readTranscript(machine, sessionID string, n int) (string, error) {
	s.mu.Lock()
	owner := s.owner
	s.mu.Unlock()
	if owner == nil {
		return "", errors.New("owner unavailable")
	}
	host := machine
	if host == "local" {
		host = ""
	}
	for _, sess := range owner.sessionsSnapshot() {
		if sess.host.ID != host {
			continue
		}
		d := sess.daemon()
		reader, ok := d.(mcp.TranscriptReader)
		if !ok {
			return "", errors.New("daemon lacks bounded transcript reader")
		}
		rows := owner.sessionRowsForApp(host)
		for _, row := range rows {
			if row.SessionID == sessionID {
				tr, err := mcp.ReadTranscriptVia(reader, row, n)
				if err != nil {
					return "", err
				}
				tr.Path = ""
				b, _ := json.Marshal(map[string]any{"machine": machine, "session_id": sessionID, "harness": tr.Harness, "truncated": tr.Truncated, "turns": tr.Turns})
				return string(b), nil
			}
		}
		return "", errors.New("session is not in current fleet")
	}
	return "", errors.New("machine is not connected")
}
func (c *Client) sessionRowsForApp(host string) []sessiond.SessionState {
	c.mergeMu.Lock()
	defer c.mergeMu.Unlock()
	return append([]sessiond.SessionState(nil), c.ssByHost[host]...)
}

func (c *Client) appVoiceWorkspaces() []map[string]string {
	c.mergeMu.Lock()
	defer c.mergeMu.Unlock()
	out := make([]map[string]string, 0, 128)
	for _, host := range mergedHosts(c.wsByHost) {
		for _, workspace := range c.wsByHost[host] {
			if len(out) == 128 {
				return out
			}
			out = append(out, map[string]string{"workspace_id": workspace.WorkspaceID, "label": workspace.Name})
		}
	}
	return out
}
func (c *Client) appVoiceWorkspaceKnown(id string) bool {
	c.mergeMu.Lock()
	defer c.mergeMu.Unlock()
	for _, rows := range c.wsByHost {
		for _, row := range rows {
			if row.WorkspaceID == id {
				return true
			}
		}
	}
	return false
}
func (c *Client) appVoiceThreadKnown(id string, generation uint64) bool {
	c.missionControlMu.Lock()
	defer c.missionControlMu.Unlock()
	if c.missionControlSelection.threadID == id && c.missionControlSelection.generation == generation {
		return true
	}
	sub, ok := c.missionControlSubscriptions[id]
	return ok && sub.runtime != nil && sub.runtime.Thread.RuntimeGeneration == generation
}
func (c *Client) appVoiceFleet() []map[string]any {
	c.mergeMu.Lock()
	defer c.mergeMu.Unlock()
	out := make([]map[string]any, 0, 100)
	for _, host := range mergedHosts(c.ssByHost) {
		for _, row := range c.ssByHost[host] {
			if len(out) == 100 {
				return out
			}
			machine := host
			if machine == "" {
				machine = "local"
			}
			out = append(out, map[string]any{
				"machine": machine, "session_id": row.SessionID, "workspace_id": row.WorkspaceID,
				"pane_id": row.PaneID, "harness": row.Harness, "label": row.Label, "name": row.Name,
				"mode": row.Mode, "state": row.State, "doing": row.Doing, "waiting_for": row.WaitingFor,
				"done_means": row.DoneMeans, "updated_at": row.UpdatedAt,
			})
		}
	}
	return out
}
func (c *Client) rememberAppVoicePanes(workspace string, panes []sessiond.PaneInfo) {
	c.wsMu.Lock()
	defer c.wsMu.Unlock()
	known := make(map[int]bool, len(panes))
	for _, pane := range panes {
		if pane.PaneID > 0 {
			known[pane.PaneID] = true
		}
	}
	c.appVoicePanes[workspace] = known
}
func (c *Client) appVoicePaneKnown(workspace string, pane int) bool {
	c.wsMu.Lock()
	defer c.wsMu.Unlock()
	return c.appVoicePanes[workspace][pane]
}
func (c *Client) appVoiceKnownPanes() []map[string]any {
	c.wsMu.Lock()
	defer c.wsMu.Unlock()
	out := make([]map[string]any, 0, 128)
	for workspace, panes := range c.appVoicePanes {
		for pane := range panes {
			if len(out) == 128 {
				return out
			}
			out = append(out, map[string]any{"workspace_id": workspace, "pane_id": pane})
		}
	}
	return out
}
func (c *Client) appVoiceMachines() []string {
	c.sessMu.Lock()
	defer c.sessMu.Unlock()
	out := make([]string, 0, 32)
	for host := range c.sessions {
		if len(out) == 32 {
			break
		}
		if host == "" {
			out = append(out, "local")
		} else {
			out = append(out, host)
		}
	}
	return out
}

// appVoiceTurnReservation is consumed by the existing Mission Control turn
// path only. A caller cannot turn an operation frame into arbitrary HTTP work.
func (s *appVoiceService) appVoiceTurnReservation(c *Client, msg missionControlClientMessage, thread missioncontrol.Thread) error {
	if !strings.HasPrefix(msg.ClientRef, "app_voice:") {
		return nil
	}
	id := strings.TrimPrefix(msg.ClientRef, "app_voice:")
	s.mu.Lock()
	defer s.mu.Unlock()
	op := s.operations[id]
	if c != s.owner || op == nil || op.Action != "submit_thread_turn" || time.Now().After(op.Expires) {
		return errors.New("app voice work operation is missing or expired")
	}
	if op.Text != msg.Text || op.Target["thread_id"] != thread.ID || op.Target["runtime_generation"] != float64(thread.RuntimeGeneration) ||
		op.Target["draft_ref"] != msg.DraftRef || op.Target["runtime_session_id"] != thread.RuntimeSessionID ||
		op.Target["runtime_incarnation"] != thread.RuntimeIncarnation || op.Target["machine_id"] != thread.MachineID {
		return errors.New("app voice work operation target does not match the live runtime")
	}
	if op.requestID != "" && op.requestID != msg.RequestID {
		return errors.New("app voice work operation was already consumed")
	}
	op.requestID = msg.RequestID
	return nil
}
func (s *appVoiceService) recordTurnReceipt(c *Client, msg missionControlClientMessage, turnID, dispatchState string) {
	if !strings.HasPrefix(msg.ClientRef, "app_voice:") || turnID == "" || (dispatchState != "dispatched" && dispatchState != "terminal") {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	op := s.operations[strings.TrimPrefix(msg.ClientRef, "app_voice:")]
	if op == nil || c != s.owner || op.requestID != msg.RequestID || op.Target["thread_id"] != msg.ThreadID {
		return
	}
	op.turnID, op.dispatchState = turnID, dispatchState
}
