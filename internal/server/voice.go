package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"

	"github.com/kenotron-ms/muxterm/internal/config"
	"github.com/kenotron-ms/muxterm/internal/cos"
	"github.com/kenotron-ms/muxterm/internal/voice"
)

// The realtime voice HTTP surface.
//
//	POST /api/cos/voice/token   mint an ephemeral secret     (C2)
//	POST /api/cos/voice/sdp     exchange SDP, raise sideband  (C5)
//	POST /api/cos/voice/end     tear the session down
//	GET  /api/cos/voice/trace   what the sideband did         (evidence)
//
// All four sit behind the same auth middleware as every other owner surface.
// They are registered only when [voice] is enabled and valid; otherwise the
// paths do not exist at all, which is a better answer than a 503 for a
// capability an operator never turned on.
//
// What the browser gets and does not get:
//   - GETS the vendor's ephemeral client secret. Short-lived, scoped to one
//     realtime session, useless for anything else.
//   - NEVER GETS the Entra token or API key that minted it, and never gets to
//     name the endpoint, the model, the tool list, or the call id.
//
// The credential split is not muxterm being careful; the platform enforces
// it. An SDP exchange presented with the long-lived credential is refused
// outright: "This operation requires ephemeral tokens for authentication."

// maxOfferBytes bounds an SDP offer. Real offers are a few kilobytes.
const maxOfferBytes = 256 << 10

// voiceBridge adapts internal/cos to the narrow interface internal/voice
// needs.
//
// It resolves the supervisor LAZILY, per call, through the same relay the
// WebSocket chat uses. That is what makes "the realtime model is ears and a
// mouth" literally true: a voice turn and a typed turn are the same turn on
// the same session, queued by the same queue, with the same transcript and
// the same approvals. There is no second brain and no second session.
type voiceBridge struct {
	relay *cosRelay

	mu   sync.Mutex
	last string // most recent turn id, for a cancel with no argument
}

func (b *voiceBridge) Submit(prompt string) (voice.TurnHandle, error) {
	sup, err := b.relay.get()
	if err != nil {
		return nil, err
	}
	turn := b.relay.submit(sup, prompt, "voice")
	if turn == nil {
		return nil, errors.New("the chief of staff refused the turn")
	}
	b.mu.Lock()
	b.last = turn.ID
	b.mu.Unlock()
	return &voiceTurn{turn: turn}, nil
}

func (b *voiceBridge) Approve(requestID string, approved bool, reason string) error {
	sup := b.relay.started()
	if sup == nil {
		return errors.New("the chief of staff is not running")
	}
	return sup.Approve(requestID, approved, reason)
}

func (b *voiceBridge) Cancel(turnID string) error {
	sup := b.relay.started()
	if sup == nil {
		return errors.New("the chief of staff is not running")
	}
	if turnID == "" {
		b.mu.Lock()
		turnID = b.last
		b.mu.Unlock()
	}
	if turnID == "" {
		return errors.New("nothing is running")
	}
	return sup.Cancel(turnID)
}

// voiceTurn is one chief-of-staff turn, seen through the voice bridge.
type voiceTurn struct{ turn *cos.Turn }

func (t *voiceTurn) ID() string { return t.turn.ID }

// Wait resolves to the answer text.
//
// A cancelled ctx returns ctx.Err() and DELIBERATELY does not cancel the
// turn: the synchronous tool path abandons its wait after a few seconds, and
// killing the user's work because a voice model got bored would be the wrong
// reading of that timeout entirely. The turn runs on and its answer is
// spoken when it lands.
func (t *voiceTurn) Wait(ctx context.Context) (string, error) {
	ev, err := t.turn.Wait(ctx)
	if err != nil {
		return "", err
	}
	if ev.Ev == cos.EvError {
		msg := ev.Message
		if msg == "" {
			msg = ev.Code
		}
		return "", errors.New(msg)
	}
	if ev.Ev == cos.EvCancelled || ev.Ev == cos.EvTurnCancelled {
		return "", errors.New("cancelled")
	}
	return ev.Response, nil
}

// registerVoiceRoutes wires the voice surface if [voice] is on and valid.
//
// A misconfigured [voice] section logs and registers nothing. It never stops
// muxterm from starting: a typo in an optional capability must not take the
// terminal multiplexer down with it.
func (s *Server) registerVoiceRoutes(cfg config.VoiceConfig, protect func(http.Handler) http.Handler) {
	if s.hub.missionControlTextEnabled() {
		// Text-preview is deliberately voice-off. Register explicit refusals
		// rather than constructing a manager: this prevents token minting or
		// provider connection before any voice bridge can exist.
		refuse := protect(http.HandlerFunc(s.handleThreadedTextVoiceRefusal))
		s.mux.Handle("POST /api/cos/voice/token", refuse)
		s.mux.Handle("POST /api/cos/voice/sdp", refuse)
		s.mux.Handle("POST /api/cos/voice/end", refuse)
		s.mux.Handle("GET /api/cos/voice/trace", refuse)
		return
	}
	if !cfg.Enabled {
		return
	}
	if err := cfg.Validate(); err != nil {
		log.Printf("voice: realtime voice is enabled but not usable, so it is switched off: %v", err)
		return
	}
	mgr, err := voice.NewManager(cfg, &voiceBridge{relay: s.hub.cos}, voice.DefaultKeyPath())
	if err != nil {
		log.Printf("voice: realtime voice could not start, so it is switched off: %v", err)
		return
	}
	s.voice = mgr
	// The browser's half of a spoken exit: when the model hangs up, the
	// page has to hear about it or it keeps a microphone open on a session
	// that is gone. Uses the WebSocket every browser already holds rather
	// than a second channel.
	mgr.SetOnEnded(func(sessionID, reason string) {
		s.hub.BroadcastVoiceEnded(sessionID, reason)
	})

	s.mux.Handle("POST /api/cos/voice/token", protect(http.HandlerFunc(s.handleVoiceToken)))
	s.mux.Handle("POST /api/cos/voice/sdp", protect(http.HandlerFunc(s.handleVoiceSDP)))
	s.mux.Handle("POST /api/cos/voice/end", protect(http.HandlerFunc(s.handleVoiceEnd)))
	s.mux.Handle("GET /api/cos/voice/trace", protect(http.HandlerFunc(s.handleVoiceTrace)))
	log.Printf("voice: realtime voice enabled (model %s, auth_mode %s)", cfg.Model, cfg.AuthMode)
}

func (s *Server) handleThreadedTextVoiceRefusal(w http.ResponseWriter, _ *http.Request) {
	writeVoiceError(w, http.StatusConflict, "voice is unavailable while Mission Control text preview is enabled")
}

// handleVoiceToken is C2: mint a short-lived ephemeral secret.
//
// The response body is the ONLY place a secret appears in this file, and it
// is the vendor's ephemeral one. Cache-Control: no-store is not decoration:
// a proxy or a browser cache holding a client secret is exactly the leak the
// ephemeral-token pattern exists to prevent.
func (s *Server) handleVoiceToken(w http.ResponseWriter, r *http.Request) {
	eph, err := s.voice.Mint(r.Context())
	if err != nil {
		// err is built by internal/voice, which never puts a credential
		// in an error string.
		log.Printf("voice: mint failed: %v", err)
		writeVoiceError(w, http.StatusBadGateway, err.Error())
		return
	}
	cfg := s.voice.Config()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"session_id": eph.SessionID,
		"value":      eph.Value,
		"expires_at": eph.ExpiresAt,
		"model":      cfg.Model,
		// Named so the browser can show what it is talking to. NOT a
		// credential, and NOT something the browser may change.
		"auth_mode": cfg.AuthMode,
	})
}

// handleVoiceSDP exchanges the browser's offer and raises the sideband.
//
// Takes the offer as a raw application/sdp body and the muxterm session id
// as a header, so there is no JSON escaping of a multi-kilobyte SDP blob in
// either direction.
func (s *Server) handleVoiceSDP(w http.ResponseWriter, r *http.Request) {
	sessionID := strings.TrimSpace(r.Header.Get("X-Voice-Session"))
	if sessionID == "" {
		writeVoiceError(w, http.StatusBadRequest, "missing X-Voice-Session header")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxOfferBytes))
	if err != nil || len(body) == 0 {
		writeVoiceError(w, http.StatusBadRequest, "empty SDP offer")
		return
	}

	answer, err := s.voice.Connect(r.Context(), sessionID, string(body))
	if err != nil {
		log.Printf("voice: connect failed: %v", err)
		writeVoiceError(w, http.StatusBadGateway, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/sdp")
	w.Header().Set("Cache-Control", "no-store")
	// The call id is reported for observability. The browser cannot USE
	// it: nothing accepts a call id from a client.
	w.Header().Set("X-Call-Id", answer.CallID)
	_, _ = io.WriteString(w, answer.SDP)
}

func (s *Server) handleVoiceEnd(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SessionID string `json:"session_id"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&req)
	s.voice.End(req.SessionID)
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"ok":true}`)
}

// handleVoiceTrace reports what the sideband has done: event kinds, tool
// names, timestamps. It exists so an automated end-to-end run can prove a
// tool actually executed server-side rather than infer it from what the
// model said. It carries no arguments, no results, and no credentials.
func (s *Server) handleVoiceTrace(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{"traces": s.voice.Traces()})
}

func writeVoiceError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": msg})
}
