package server

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type meetingSignal struct {
	Seq     int64           `json:"seq"`
	From    string          `json:"from"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type meetingCall struct {
	ChatID, MeetingID, Token, GuestLease string
	Expires                              time.Time
	GuestJoined                          bool
	GuestLastSeen, HostLastSeen          time.Time
	Signals                              []meetingSignal
	NextSeq                              int64
}

type meetingCallRegistry struct {
	mu        sync.Mutex
	byMeeting map[string]*meetingCall
	byToken   map[string]*meetingCall
}

func newMeetingCallRegistry() *meetingCallRegistry {
	return &meetingCallRegistry{byMeeting: map[string]*meetingCall{}, byToken: map[string]*meetingCall{}}
}

func (r *meetingCallRegistry) revoke(meetingID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if call := r.byMeeting[meetingID]; call != nil {
		delete(r.byToken, call.Token)
		delete(r.byMeeting, meetingID)
	}
}

func (r *meetingCallRegistry) sweep() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, call := range r.byMeeting {
		if time.Now().After(call.Expires) {
			delete(r.byToken, call.Token)
			delete(r.byMeeting, id)
		}
	}
}

func randomMeetingSecret() string {
	var bytes [24]byte
	_, _ = rand.Read(bytes[:])
	return base64.RawURLEncoding.EncodeToString(bytes[:])
}

func meetingICEServers() []map[string]any {
	// Operators provide their own STUN/TURN credentials. Empty is deliberate:
	// host candidates can work on a LAN without contacting any outside service.
	raw := os.Getenv("MUXTERM_MEETING_ICE_SERVERS")
	if raw == "" {
		return []map[string]any{}
	}
	var servers []map[string]any
	if json.Unmarshal([]byte(raw), &servers) != nil {
		return []map[string]any{}
	}
	valid := make([]map[string]any, 0, len(servers))
	for _, server := range servers {
		urls, ok := server["urls"]
		if !ok {
			continue
		}
		allowed := func(value string) bool {
			return strings.HasPrefix(value, "stun:") || strings.HasPrefix(value, "turn:") || strings.HasPrefix(value, "turns:")
		}
		switch value := urls.(type) {
		case string:
			if allowed(value) {
				valid = append(valid, server)
			}
		case []any:
			good := len(value) > 0
			for _, item := range value {
				url, ok := item.(string)
				if !ok || !allowed(url) {
					good = false
					break
				}
			}
			if good {
				valid = append(valid, server)
			}
		}
	}
	return valid
}

// A guest invite needs a stable HTTPS origin supplied by the operator. The
// request Host header is not authority for a link that will leave this machine.
func (s *Server) meetingInviteOrigin() (string, string) {
	if s.noAuth || os.Getenv("MUXTERM_DEV_INSTANCE") == "1" {
		return "", "Guest calls require an authenticated, publicly hosted Muxterm server. This development instance cannot create guest invites."
	}
	if !s.behindReverseProxy {
		return "", "Host Muxterm at a public HTTPS address, then set [server] behind_reverse_proxy = true and public_origin before inviting a guest."
	}
	origin := s.publicBaseURL()
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" {
		return "", "Set [server] public_origin to the public HTTPS address guests can open."
	}
	host := strings.ToLower(u.Hostname())
	ip := net.ParseIP(host)
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") ||
		(ip != nil && (!ip.IsGlobalUnicast() || ip.IsPrivate())) {
		return "", "Set [server] public_origin to a public HTTPS address guests can open, not a local address."
	}
	return origin, ""
}

func (s *Server) handleMeetingCallReadiness(w http.ResponseWriter, _ *http.Request) {
	origin, reason := s.meetingInviteOrigin()
	writeJSON(w, http.StatusOK, map[string]any{
		"available": origin != "", "reason": reason, "inviteOrigin": origin,
	})
}

func (s *Server) handleMeetingInvite(w http.ResponseWriter, r *http.Request) {
	inviteOrigin := ""
	if r.Method == http.MethodPost {
		var reason string
		inviteOrigin, reason = s.meetingInviteOrigin()
		if reason != "" {
			http.Error(w, reason, http.StatusConflict)
			return
		}
	}
	chatID, meetingID, ok := s.meetingLocation(w, r)
	if !ok {
		return
	}
	meeting, err := readMeeting(chatID, meetingID)
	if errors.Is(err, os.ErrNotExist) {
		http.Error(w, "Meeting not found", 404)
		return
	}
	if err != nil || meeting.Kind != "call" {
		http.Error(w, "Not a call meeting", 400)
		return
	}
	if r.Method == http.MethodPost && meeting.EndedAt != "" {
		http.Error(w, "Call already ended", http.StatusConflict)
		return
	}
	s.meetingCalls.mu.Lock()
	if old := s.meetingCalls.byMeeting[meetingID]; old != nil {
		delete(s.meetingCalls.byToken, old.Token)
	}
	delete(s.meetingCalls.byMeeting, meetingID)
	if r.Method == http.MethodDelete {
		s.meetingCalls.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
		return
	}
	call := &meetingCall{ChatID: chatID, MeetingID: meetingID, Token: randomMeetingSecret(), Expires: time.Now().Add(time.Hour), HostLastSeen: time.Now()}
	s.meetingCalls.byMeeting[meetingID] = call
	s.meetingCalls.byToken[call.Token] = call
	s.meetingCalls.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"token": call.Token, "inviteUrl": inviteOrigin + "/guest/" + call.Token, "expiresAt": call.Expires.UTC().Format(time.RFC3339), "iceServers": meetingICEServers()})
}

func (s *Server) callByToken(w http.ResponseWriter, token string) *meetingCall {
	if len(token) != 32 {
		http.Error(w, "Invite unavailable", 404)
		return nil
	}
	s.meetingCalls.mu.Lock()
	call := s.meetingCalls.byToken[token]
	if call == nil || time.Now().After(call.Expires) {
		call = nil
	}
	s.meetingCalls.mu.Unlock()
	if call == nil {
		http.Error(w, "Invite expired or revoked", 404)
	}
	return call
}

func (s *Server) handleMeetingGuestJoin(w http.ResponseWriter, r *http.Request) {
	call := s.callByToken(w, r.PathValue("token"))
	if call == nil {
		return
	}
	s.meetingCalls.mu.Lock()
	if s.meetingCalls.byToken[call.Token] != call || time.Now().After(call.Expires) {
		s.meetingCalls.mu.Unlock()
		http.Error(w, "Invite expired or revoked", 404)
		return
	}
	provided := r.Header.Get("X-Muxterm-Guest-Lease")
	if call.GuestJoined && (provided == "" || provided != call.GuestLease) {
		s.meetingCalls.mu.Unlock()
		http.Error(w, "This invite already has a guest", 409)
		return
	}
	joinedNow := !call.GuestJoined
	if !call.GuestJoined {
		call.GuestJoined = true
		call.GuestLease = randomMeetingSecret()
	}
	call.NextSeq++
	call.Signals = append(call.Signals, meetingSignal{Seq: call.NextSeq, From: "guest", Type: "joined"})
	call.GuestLastSeen = time.Now()
	lease, expires := call.GuestLease, call.Expires
	chatID, meetingID := call.ChatID, call.MeetingID
	s.meetingCalls.mu.Unlock()
	meetingLock := s.pageDocumentLock("meeting-" + chatID)
	meetingLock.Lock()
	meeting, err := readMeeting(chatID, meetingID)
	if err == nil && joinedNow {
		meeting.Participants = []string{"You", "Guest"}
		err = saveMeeting(meeting)
	}
	meetingLock.Unlock()
	if err != nil {
		s.meetingCalls.revoke(meetingID)
		http.Error(w, "Meeting unavailable", 404)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"meetingId": meetingID, "title": meeting.Title, "lease": lease, "iceServers": meetingICEServers(), "expiresAt": expires.UTC().Format(time.RFC3339)})
}

func (s *Server) handleMeetingHostSignals(w http.ResponseWriter, r *http.Request) {
	chatID, meetingID, ok := s.meetingLocation(w, r)
	if !ok {
		return
	}
	input, status, message := readMeetingSignal(w, r)
	if status != 0 {
		http.Error(w, message, status)
		return
	}
	s.meetingCalls.mu.Lock()
	call := s.meetingCalls.byMeeting[meetingID]
	if call == nil || call.ChatID != chatID || time.Now().After(call.Expires) {
		s.meetingCalls.mu.Unlock()
		http.Error(w, "Call invite unavailable", 404)
		return
	}
	output := serveMeetingSignalsLocked(r, call, "host", input)
	s.meetingCalls.mu.Unlock()
	writeJSON(w, http.StatusOK, output)
}

func (s *Server) handleMeetingGuestSignals(w http.ResponseWriter, r *http.Request) {
	input, status, message := readMeetingSignal(w, r)
	if status != 0 {
		http.Error(w, message, status)
		return
	}
	s.meetingCalls.mu.Lock()
	call := s.meetingCalls.byToken[r.PathValue("token")]
	if call == nil || time.Now().After(call.Expires) {
		s.meetingCalls.mu.Unlock()
		http.Error(w, "Invite expired or revoked", 404)
		return
	}
	if !call.GuestJoined || r.Header.Get("X-Muxterm-Guest-Lease") != call.GuestLease {
		s.meetingCalls.mu.Unlock()
		http.Error(w, "Join the meeting first", 403)
		return
	}
	if r.Method == http.MethodPost && (input.Type == "recording" || input.Type == "end") {
		s.meetingCalls.mu.Unlock()
		http.Error(w, "Guest cannot change host recording or end the call", 403)
		return
	}
	output := serveMeetingSignalsLocked(r, call, "guest", input)
	s.meetingCalls.mu.Unlock()
	writeJSON(w, http.StatusOK, output)
}

type meetingSignalInput struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

func readMeetingSignal(w http.ResponseWriter, r *http.Request) (meetingSignalInput, int, string) {
	if r.Method == http.MethodGet {
		return meetingSignalInput{}, 0, ""
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(15 * time.Second))
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 32<<10))
	if err != nil {
		return meetingSignalInput{}, 413, "Signal too large"
	}
	var input meetingSignalInput
	if json.Unmarshal(data, &input) != nil || !validMeetingSignal(input.Type) || len(input.Payload) > 30<<10 || (len(input.Payload) > 0 && !json.Valid(input.Payload)) {
		return meetingSignalInput{}, 400, "Invalid signal"
	}
	return input, 0, ""
}

func serveMeetingSignalsLocked(r *http.Request, call *meetingCall, role string, input meetingSignalInput) map[string]any {
	now := time.Now()
	if role == "host" {
		call.HostLastSeen = now
	} else {
		call.GuestLastSeen = now
	}
	if r.Method == http.MethodGet {
		since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
		out := make([]meetingSignal, 0, 16)
		for _, event := range call.Signals {
			if event.Seq > since && event.From != role {
				out = append(out, event)
			}
		}
		peerSeen := call.GuestLastSeen
		if role == "guest" {
			peerSeen = call.HostLastSeen
		}
		dropped := len(call.Signals) > 0 && call.Signals[0].Seq > 1 && since < call.Signals[0].Seq-1
		return map[string]any{"signals": out, "cursor": call.NextSeq, "signalsDropped": dropped, "peerConnected": !peerSeen.IsZero() && now.Sub(peerSeen) < 10*time.Second, "guestJoined": call.GuestJoined}
	}
	call.NextSeq++
	call.Signals = append(call.Signals, meetingSignal{Seq: call.NextSeq, From: role, Type: input.Type, Payload: input.Payload})
	if len(call.Signals) > 256 {
		call.Signals = call.Signals[len(call.Signals)-256:]
	}
	return map[string]any{"cursor": call.NextSeq}
}

func validMeetingSignal(kind string) bool {
	switch kind {
	case "offer", "answer", "ice", "share", "recording", "leave", "end":
		return true
	}
	return false
}

func (s *Server) handleMeetingGuestPage(w http.ResponseWriter, r *http.Request) {
	call := s.callByToken(w, r.PathValue("token"))
	if call == nil {
		return
	}
	meeting, err := readMeeting(call.ChatID, call.MeetingID)
	if err != nil {
		http.Error(w, "Meeting unavailable", 404)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:")
	_, _ = io.WriteString(w, strings.ReplaceAll(meetingGuestHTML, "{{TITLE}}", html.EscapeString(meeting.Title)))
}
