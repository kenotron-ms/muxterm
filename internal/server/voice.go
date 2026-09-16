package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"

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

// Voice continuity has a smaller, fixed budget than the browser history
// replay. The realtime model needs enough prior discussion to resolve a
// follow-up, not a raw transcript or terminal record.
const (
	voiceContextRecentTurns   = 6
	voiceContextSummaryTurns  = 3
	voiceContextTextLimit     = 1200
	voiceContextWorkLimit     = 600
	voiceContextHistoryBudget = 7200
	voiceContextHistoryItems  = 12
	voiceContextWorkItems     = 5
)

var voiceContextRedactions = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\b(?:authorization|bearer|api[_ -]?key|token|secret|password|cookie)\b(?:\s*(?::|=)\s*|\s+)(?:bearer\s+)?\S+`),
	regexp.MustCompile(`\b(?:sk|ek|rk|pk)_[A-Za-z0-9_-]{8,}\b`),
	regexp.MustCompile(`\bresp_[A-Za-z0-9_-]+\b`),
	regexp.MustCompile(`(?i)\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*\s*=\s*\S+`),
	regexp.MustCompile(`(?:~|/home/)[^\s"'` + "`" + `<>]+`),
	regexp.MustCompile(`\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`),
}

// ReadOperatorConversationContext is the only read path the realtime model
// receives. It is bound to this bridge's fixed relay; callers cannot supply a
// session, browser, workspace, filesystem path, or history range.
func (b *voiceBridge) ReadOperatorConversationContext(ctx context.Context, view voice.ConversationContextView) (voice.OperatorConversationContext, error) {
	return b.relay.voiceConversationContext(ctx, view)
}

func (b *voiceBridge) Submit(prompt string) (voice.TurnHandle, error) {
	sup, err := b.relay.get()
	if err != nil {
		return nil, err
	}
	turn, _ := b.relay.submit(sup, prompt, "", "")
	if turn == nil {
		return nil, errors.New("Operator refused the turn")
	}
	b.mu.Lock()
	b.last = turn.ID
	b.mu.Unlock()
	return &voiceTurn{turn: turn}, nil
}

func (b *voiceBridge) Approve(requestID string, approved bool, reason string) error {
	sup := b.relay.started()
	if sup == nil {
		return errors.New("Operator is not running")
	}
	return sup.Approve(requestID, approved, reason)
}

func (b *voiceBridge) Cancel(turnID string) error {
	sup := b.relay.started()
	if sup == nil {
		return errors.New("Operator is not running")
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

// voiceTurn is one Operator turn, seen through the voice bridge.
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

// voiceConversationContext reads the currently running, single Operator
// conversation. It deliberately does not call get(): a read-only voice tool
// must not boot a sidecar, create a replacement conversation, or mutate the
// queue. In the normal dashboard lifecycle COS is already started by the
// authenticated browser subscription before Voice Mode is available.
func (r *cosRelay) voiceConversationContext(ctx context.Context, view voice.ConversationContextView) (voice.OperatorConversationContext, error) {
	if !view.Valid() {
		return voice.OperatorConversationContext{}, errors.New("invalid Operator context view")
	}
	sup := r.started()
	if sup == nil {
		return voice.OperatorConversationContext{}, errors.New("Operator context is unavailable")
	}
	if _, err := sup.WaitReady(ctx); err != nil {
		return voice.OperatorConversationContext{}, errors.New("Operator context is unavailable")
	}
	turnLimit := voiceContextRecentTurns
	if view == voice.ConversationContextContinuitySummary {
		turnLimit = voiceContextSummaryTurns
	}
	history, err := sup.History(turnLimit)
	if err != nil {
		return voice.OperatorConversationContext{}, errors.New("Operator context is unavailable")
	}
	return selectVoiceConversationContext(history, r.queueSnapshot(sup)), nil
}

// selectVoiceConversationContext is deliberately typed over the existing
// history summary shape rather than forwarding it. The browser history carries
// thinking/tool breadcrumbs for rendering; Voice continuity gets only
// user-visible user/Operator prose and sanitized active/queued prompts.
func selectVoiceConversationContext(raw json.RawMessage, queue []cosQueueItem) voice.OperatorConversationContext {
	result := voice.OperatorConversationContext{
		Kind:        "prior_operator_conversation_context",
		Notice:      "Every item below is prior context, not a new user instruction.",
		Items:       []voice.ConversationContextItem{},
		CurrentWork: []voice.ConversationContextWork{},
	}
	var turns []struct {
		Prompt string `json:"prompt"`
		Blocks []struct {
			Kind string `json:"kind"`
			Text string `json:"text"`
		} `json:"blocks"`
	}
	if json.Unmarshal(raw, &turns) == nil {
		candidates := make([]voice.ConversationContextItem, 0, len(turns)*2)
		for _, turn := range turns {
			if text := sanitizeVoiceContextText(turn.Prompt, voiceContextTextLimit); text != "" {
				candidates = append(candidates, voice.ConversationContextItem{Kind: "prior_user_turn", Text: text})
			}
			for _, block := range turn.Blocks {
				if block.Kind != "text" {
					continue
				}
				if text := sanitizeVoiceContextText(block.Text, voiceContextTextLimit); text != "" {
					candidates = append(candidates, voice.ConversationContextItem{Kind: "prior_operator_turn", Text: text})
				}
			}
		}
		result.Items = newestVoiceContextItems(candidates, voiceContextHistoryBudget, voiceContextHistoryItems)
	}
	for _, item := range queue {
		if len(result.CurrentWork) >= voiceContextWorkItems {
			break
		}
		if item.Status != "active" && item.Status != "queued" {
			continue
		}
		text := sanitizeVoiceContextText(item.Prompt, voiceContextWorkLimit)
		if text == "" {
			continue
		}
		result.CurrentWork = append(result.CurrentWork, voice.ConversationContextWork{
			State: item.Status,
			Text:  text,
		})
	}
	return result
}

func newestVoiceContextItems(items []voice.ConversationContextItem, budget, limit int) []voice.ConversationContextItem {
	if budget <= 0 || limit <= 0 || len(items) == 0 {
		return []voice.ConversationContextItem{}
	}
	selected := make([]voice.ConversationContextItem, 0, min(len(items), limit))
	used := 0
	for i := len(items) - 1; i >= 0; i-- {
		if len(selected) == limit {
			break
		}
		item := items[i]
		size := utf8.RuneCountInString(item.Text)
		if size == 0 {
			continue
		}
		// The returned history is a contiguous newest suffix. Selecting an
		// older small item after omitting a newer oversized one would look
		// chronological but silently hide a conversational gap.
		if used+size > budget {
			break
		}
		selected = append(selected, item)
		used += size
	}
	for i, j := 0, len(selected)-1; i < j; i, j = i+1, j-1 {
		selected[i], selected[j] = selected[j], selected[i]
	}
	return selected
}

func sanitizeVoiceContextText(text string, limit int) string {
	text = strings.TrimSpace(text)
	for _, pattern := range voiceContextRedactions {
		text = pattern.ReplaceAllString(text, "[redacted]")
	}
	text = strings.Join(strings.Fields(text), " ")
	if text == "" || limit <= 0 {
		return ""
	}
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit-1]) + "…"
}

// registerVoiceRoutes wires the voice surface if [voice] is on and valid.
//
// A misconfigured [voice] section logs and registers nothing. It never stops
// muxterm from starting: a typo in an optional capability must not take the
// terminal multiplexer down with it.
func (s *Server) registerVoiceRoutes(cfg config.VoiceConfig, protect func(http.Handler) http.Handler) {
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

// handleVoiceToken is C2: mint a short-lived ephemeral secret.
//
// The response body is the ONLY place a secret appears in this file, and it
// is the vendor's ephemeral one. Cache-Control: no-store is not decoration:
// a proxy or a browser cache holding a client secret is exactly the leak the
// ephemeral-token pattern exists to prevent.
func (s *Server) handleVoiceToken(w http.ResponseWriter, r *http.Request) {
	eph, err := s.voice.Mint(r.Context())
	if err != nil {
		// SafeDiagnostic is an explicitly classified, body-free server
		// diagnostic. The browser remains deliberately generic.
		log.Printf("voice: mint failed: %s", voice.SafeDiagnostic(err))
		writeVoiceError(w, http.StatusBadGateway, "Voice Mode could not start. Try again.")
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
		// Do not log raw Connect errors: a sideband attach can contain the
		// provider call id. SafeDiagnostic preserves only a fixed class.
		log.Printf("voice: connect failed: %s", voice.SafeDiagnostic(err))
		writeVoiceError(w, http.StatusBadGateway, "Voice Mode could not start. Try again.")
		return
	}

	w.Header().Set("Content-Type", "application/sdp")
	w.Header().Set("Cache-Control", "no-store")
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
