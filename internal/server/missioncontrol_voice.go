package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/voice"
)

// Mission Control text threads intentionally begin voice-disabled.  This
// surface exposes the lease/focus/capture safety negotiation needed for a
// future attachment, but never creates a provider session or accepts audio.
const missionControlVoiceOwnerCookie = "muxterm_missioncontrol_voice_owner"
const missionControlVoiceControlHeader = "X-MissionControl-Voice-Control"

type missionControlVoiceRequest struct {
	ThreadID           string `json:"thread_id"`
	RuntimeSessionID   string `json:"runtime_session_id"`
	RuntimeGeneration  uint64 `json:"runtime_generation"`
	RuntimeIncarnation string `json:"runtime_incarnation"`
	LeaseEpoch         uint64 `json:"lease_epoch"`
	FocusEpoch         uint64 `json:"focus_epoch"`
	CaptureEpoch       uint64 `json:"capture_epoch"`
	Takeover           bool   `json:"takeover"`
}

func (s *Server) registerMissionControlVoiceRoutes(protect func(http.Handler) http.Handler) {
	// registerVoiceRoutes runs during Server construction. State is owned by
	// this Server and is cleared from its shutdown path; it is never retained
	// in a process-global map keyed by dead server pointers.
	s.missionControlVoice = voice.NewLeaseManager()
	s.mux.Handle("GET /api/missioncontrol/voice/capabilities", protect(http.HandlerFunc(s.handleMissionControlVoiceCapabilities)))
	s.mux.Handle("POST /api/missioncontrol/voice/lease", protect(http.HandlerFunc(s.handleMissionControlVoiceLease)))
	s.mux.Handle("POST /api/missioncontrol/voice/heartbeat", protect(http.HandlerFunc(s.handleMissionControlVoiceHeartbeat)))
	s.mux.Handle("POST /api/missioncontrol/voice/focus", protect(http.HandlerFunc(s.handleMissionControlVoiceFocus)))
	s.mux.Handle("POST /api/missioncontrol/voice/capture", protect(http.HandlerFunc(s.handleMissionControlVoiceCapture)))
	s.mux.Handle("POST /api/missioncontrol/voice/stop", protect(http.HandlerFunc(s.handleMissionControlVoiceStop)))
}

func (s *Server) handleMissionControlVoiceCapabilities(w http.ResponseWriter, _ *http.Request) {
	if _, err := s.hub.missionControlCatalog(); err != nil {
		writeMissionControlVoiceJSON(w, http.StatusConflict, map[string]any{
			"ok": false, "surface": "Mission Control", "owner_label": "Operator/Tank",
			"capabilities": map[string]bool{
				"thread_voice_default_off": true, "lease_negotiation": false,
				"focus_fencing": false, "capture_fencing": false,
				"provider_attachment": false, "microphone_admission": false,
			},
			"code": "text_runtime_unavailable", "error": err.Error(),
		})
		return
	}
	if _, err := s.hub.missionControlRouterForText(); err != nil {
		writeMissionControlVoiceJSON(w, http.StatusConflict, map[string]any{
			"ok": false, "surface": "Mission Control", "owner_label": "Operator/Tank",
			"capabilities": map[string]bool{
				"thread_voice_default_off": true, "lease_negotiation": false,
				"focus_fencing": false, "capture_fencing": false,
				"provider_attachment": false, "microphone_admission": false,
			},
			"code": "text_runtime_unavailable", "error": err.Error(),
		})
		return
	}
	writeMissionControlVoiceJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"surface":     "Mission Control",
		"owner_label": "Operator/Tank",
		"capabilities": map[string]any{
			"thread_voice_default_off":        true,
			"voice_enabled":                   false,
			"lease_protocol_available":        true,
			"lease_negotiation":               false,
			"focus_fencing":                   true,
			"capture_fencing":                 true,
			"single_active_bridge_verified":   false,
			"explicit_takeover":               false,
			"provider_attachment":             false,
			"microphone_admission":            false,
			"spoken_prefix_audio":             false,
			"provider_input_event_mapping":    false,
			"provider_sink_stop_drain_ack":    false,
			"work_cancellation_on_audio_stop": false,
		},
		"implementation_status": map[string]string{
			"lease_protocol":               "implemented; session ownership not verified",
			"provider_attachment":          "not_implemented",
			"provider_event_mapping":       "not_implemented",
			"provider_sink_stop_drain_ack": "not_implemented",
			"spoken_prefix_audio":          "not_implemented",
		},
		"refusal": "voice admission remains disabled: this implementation has no verified thread-scoped provider attachment, event mapping, deterministic prefix acknowledgement, or old-sink stop/drain acknowledgement",
	})
}

func (s *Server) handleMissionControlVoiceLease(w http.ResponseWriter, r *http.Request) {
	req, c, ok := s.missionControlVoiceRequest(w, r)
	if !ok {
		return
	}
	bridgeID, controlToken := s.missionControlVoiceCredentials(r)
	grant, err := s.missionControlVoiceManager().Claim(c, bridgeID, controlToken, req.Takeover)
	if err != nil {
		writeMissionControlVoiceLeaseError(w, err)
		return
	}
	body := map[string]any{"ok": true, "lease": grant.Lease}
	if grant.Issued {
		s.setMissionControlVoiceOwnerCookie(w, grant.BridgeID)
		// The capability is intentionally response-only: it is retained by
		// one tab and must be supplied in a header, while the browser-shared
		// HttpOnly cookie alone cannot control the lease.
		body["control_token"] = grant.ControlToken
	}
	writeMissionControlVoiceJSON(w, http.StatusCreated, body)
}

func (s *Server) handleMissionControlVoiceHeartbeat(w http.ResponseWriter, r *http.Request) {
	req, c, bridgeID, controlToken, ok := s.missionControlVoiceOwnerRequest(w, r)
	if !ok {
		return
	}
	lease, err := s.missionControlVoiceManager().Heartbeat(c, bridgeID, controlToken, req.LeaseEpoch)
	if err != nil {
		writeMissionControlVoiceLeaseError(w, err)
		return
	}
	writeMissionControlVoiceJSON(w, http.StatusOK, map[string]any{"ok": true, "lease": lease})
}

func (s *Server) handleMissionControlVoiceFocus(w http.ResponseWriter, r *http.Request) {
	req, c, bridgeID, controlToken, ok := s.missionControlVoiceOwnerRequest(w, r)
	if !ok {
		return
	}
	lease, err := s.missionControlVoiceManager().Focus(c, bridgeID, controlToken, req.LeaseEpoch, req.FocusEpoch)
	if err != nil {
		writeMissionControlVoiceLeaseError(w, err)
		return
	}
	writeMissionControlVoiceJSON(w, http.StatusOK, map[string]any{"ok": true, "lease": lease})
}

func (s *Server) handleMissionControlVoiceCapture(w http.ResponseWriter, r *http.Request) {
	req, c, bridgeID, controlToken, ok := s.missionControlVoiceOwnerRequest(w, r)
	if !ok {
		return
	}
	if err := s.missionControlVoiceManager().CaptureGate(c, bridgeID, controlToken, req.LeaseEpoch, req.FocusEpoch, req.CaptureEpoch); err != nil {
		writeMissionControlVoiceLeaseError(w, err)
		return
	}
}

func (s *Server) handleMissionControlVoiceStop(w http.ResponseWriter, r *http.Request) {
	req, c, bridgeID, controlToken, ok := s.missionControlVoiceOwnerRequest(w, r)
	if !ok {
		return
	}
	if err := s.missionControlVoiceManager().Stop(c, bridgeID, controlToken, req.LeaseEpoch); err != nil {
		writeMissionControlVoiceLeaseError(w, err)
		return
	}
	writeMissionControlVoiceJSON(w, http.StatusOK, map[string]any{
		"ok": true, "work_cancelled": false,
		"message": "Mission Control voice lease stopped; text-thread work remains running",
	})
}

func (s *Server) missionControlVoiceOwnerRequest(w http.ResponseWriter, r *http.Request) (missionControlVoiceRequest, voice.VoiceCorrelation, string, string, bool) {
	req, c, ok := s.missionControlVoiceRequest(w, r)
	if !ok {
		return missionControlVoiceRequest{}, voice.VoiceCorrelation{}, "", "", false
	}
	bridgeID, controlToken := s.missionControlVoiceCredentials(r)
	if bridgeID == "" || controlToken == "" {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "bridge_capability_required", "claim a Mission Control voice lease and retain its per-tab control_token before controlling it")
		return missionControlVoiceRequest{}, voice.VoiceCorrelation{}, "", "", false
	}
	return req, c, bridgeID, controlToken, true
}

func (s *Server) missionControlVoiceRequest(w http.ResponseWriter, r *http.Request) (missionControlVoiceRequest, voice.VoiceCorrelation, bool) {
	if !s.missionControlVoiceSameOrigin(w, r) {
		return missionControlVoiceRequest{}, voice.VoiceCorrelation{}, false
	}
	var req missionControlVoiceRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&req); err != nil {
		writeMissionControlVoiceFailure(w, http.StatusBadRequest, "bad_request", "invalid Mission Control voice request")
		return req, voice.VoiceCorrelation{}, false
	}
	c := voice.VoiceCorrelation{
		ThreadID: req.ThreadID, RuntimeSessionID: req.RuntimeSessionID,
		RuntimeGeneration: req.RuntimeGeneration, RuntimeIncarnation: req.RuntimeIncarnation,
	}
	if err := s.validateMissionControlVoiceCorrelation(c); err != nil {
		writeMissionControlVoiceFailure(w, http.StatusConflict, "stale_thread_runtime", err.Error())
		return req, voice.VoiceCorrelation{}, false
	}
	return req, c, true
}

func (s *Server) validateMissionControlVoiceCorrelation(c voice.VoiceCorrelation) error {
	if !validMissionControlRequestID(c.ThreadID) || !validMissionControlRequestID(c.RuntimeSessionID) ||
		c.RuntimeGeneration == 0 || !validMissionControlRequestID(c.RuntimeIncarnation) {
		return errors.New("thread_id, runtime_session_id, runtime_generation, and runtime_incarnation are required")
	}
	catalog, err := s.hub.missionControlCatalog()
	if err != nil {
		return err
	}
	thread, _, found, err := catalog.Thread(c.ThreadID)
	if err != nil || !found {
		return errors.New("Mission Control thread is unknown")
	}
	if thread.Lifecycle != "active" || thread.RuntimeSessionID != c.RuntimeSessionID ||
		thread.RuntimeGeneration != c.RuntimeGeneration || thread.RuntimeIncarnation != c.RuntimeIncarnation {
		return errors.New("Mission Control thread runtime is stale")
	}
	router, err := s.hub.missionControlRouterForText()
	if err != nil {
		return errors.New("Mission Control text runtime is not live")
	}
	runtime := router.Runtime(c.ThreadID)
	if runtime == nil || runtime.Thread.ID != c.ThreadID ||
		runtime.Thread.RuntimeSessionID != c.RuntimeSessionID ||
		runtime.Thread.RuntimeGeneration != c.RuntimeGeneration ||
		runtime.Thread.RuntimeIncarnation != c.RuntimeIncarnation {
		return errors.New("Mission Control text runtime is not live")
	}
	return nil
}

func (s *Server) missionControlVoiceCredentials(r *http.Request) (string, string) {
	bridgeID := ""
	if cookie, err := r.Cookie(missionControlVoiceOwnerCookie); err == nil {
		bridgeID = cookie.Value
	}
	return bridgeID, strings.TrimSpace(r.Header.Get(missionControlVoiceControlHeader))
}

func (s *Server) setMissionControlVoiceOwnerCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name: missionControlVoiceOwnerCookie, Value: token, Path: "/api/missioncontrol/voice",
		HttpOnly: true, Secure: s.secureCookies(), SameSite: http.SameSiteStrictMode,
		MaxAge: int(voice.MissionControlVoiceLeaseTTL.Seconds()),
	})
}

func (s *Server) missionControlVoiceManager() *voice.LeaseManager {
	return s.missionControlVoice
}

// missionControlVoiceSameOrigin is stricter than the general protected-route
// wrapper because these routes mint a per-tab control capability. Browser POSTs
// must carry the configured public origin when proxied, or the direct request
// origin otherwise. A custom header capability then supplies the CSRF second
// factor: a cross-origin page cannot read the initial response or set the
// non-simple header without an allowed CORS preflight (none is provided).
func (s *Server) missionControlVoiceSameOrigin(w http.ResponseWriter, r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		writeMissionControlVoiceFailure(w, http.StatusForbidden, "origin_required", "Mission Control voice control requests require an exact same-origin Origin header")
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil ||
		parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		writeMissionControlVoiceFailure(w, http.StatusForbidden, "origin_invalid", "Mission Control voice control origin is invalid")
		return false
	}
	expected := s.publicBaseURL()
	if expected == "" {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		expected = scheme + "://" + r.Host
	}
	if !strings.EqualFold(origin, expected) {
		writeMissionControlVoiceFailure(w, http.StatusForbidden, "origin_mismatch", "Mission Control voice control origin does not match this server")
		return false
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
		writeMissionControlVoiceFailure(w, http.StatusForbidden, "cross_site_request", "Mission Control voice control requires a same-origin browser request")
		return false
	}
	return true
}

func writeMissionControlVoiceLeaseError(w http.ResponseWriter, err error) {
	code := "lease_refused"
	switch {
	case errors.Is(err, voice.ErrBridgeActive):
		code = "bridge_active"
	case errors.Is(err, voice.ErrBridgeCapability):
		code = "bridge_capability_invalid"
	case errors.Is(err, voice.ErrLeaseFenced):
		code = "lease_fenced"
	case errors.Is(err, voice.ErrLeaseEpoch):
		code = "stale_lease_epoch"
	case errors.Is(err, voice.ErrFocusEpoch):
		code = "stale_focus_epoch"
	case errors.Is(err, voice.ErrCaptureEpoch):
		code = "stale_capture_epoch"
	case errors.Is(err, voice.ErrCorrelation):
		code = "stale_correlation"
	case errors.Is(err, voice.ErrBridgeSwitchUnsupported):
		code = "bridge_switch_unsupported"
	case errors.Is(err, voice.ErrTakeoverDrainUnsupported):
		code = "provider_sink_drain_ack_unsupported"
	case errors.Is(err, voice.ErrProviderEventMappingUnsupported):
		code = "provider_event_mapping_unsupported"
	case errors.Is(err, voice.ErrLeaseManagerClosed):
		code = "lease_manager_closed"
	}
	writeMissionControlVoiceFailure(w, http.StatusConflict, code, err.Error())
}

func writeMissionControlVoiceFailure(w http.ResponseWriter, status int, code, detail string) {
	writeMissionControlVoiceJSON(w, status, map[string]any{"ok": false, "code": code, "error": detail})
}

func writeMissionControlVoiceJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
