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
	s.meetingCalls.mu.Lock()
	defer s.meetingCalls.mu.Unlock()
	if old := s.meetingCalls.byMeeting[meetingID]; old != nil {
		delete(s.meetingCalls.byToken, old.Token)
	}
	delete(s.meetingCalls.byMeeting, meetingID)
	if r.Method == http.MethodDelete {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	call := &meetingCall{ChatID: chatID, MeetingID: meetingID, Token: randomMeetingSecret(), Expires: time.Now().Add(time.Hour), HostLastSeen: time.Now()}
	s.meetingCalls.byMeeting[meetingID] = call
	s.meetingCalls.byToken[call.Token] = call
	writeJSON(w, http.StatusOK, map[string]any{"token": call.Token, "inviteUrl": inviteOrigin + "/guest/" + call.Token, "expiresAt": call.Expires.UTC().Format(time.RFC3339), "iceServers": meetingICEServers()})
}

func (s *Server) callByToken(w http.ResponseWriter, token string) *meetingCall {
	if len(token) != 32 {
		http.Error(w, "Invite unavailable", 404)
		return nil
	}
	s.meetingCalls.mu.Lock()
	call := s.meetingCalls.byToken[token]
	if call == nil || (time.Now().After(call.Expires) && !call.GuestJoined) {
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
	defer s.meetingCalls.mu.Unlock()
	if s.meetingCalls.byToken[call.Token] != call || (time.Now().After(call.Expires) && (!call.GuestJoined || r.Header.Get("X-Muxterm-Guest-Lease") != call.GuestLease)) {
		http.Error(w, "Invite expired or revoked", 404)
		return
	}
	provided := r.Header.Get("X-Muxterm-Guest-Lease")
	if call.GuestJoined && (provided == "" || provided != call.GuestLease) {
		http.Error(w, "This invite already has a guest", 409)
		return
	}
	if !call.GuestJoined {
		call.GuestJoined = true
		call.GuestLease = randomMeetingSecret()
		meetingLock := s.pageDocumentLock("meeting-" + call.ChatID)
		meetingLock.Lock()
		if meeting, err := readMeeting(call.ChatID, call.MeetingID); err == nil {
			meeting.Participants = []string{"You", "Guest"}
			_ = saveMeeting(meeting)
		}
		meetingLock.Unlock()
	}
	call.NextSeq++
	call.Signals = append(call.Signals, meetingSignal{Seq: call.NextSeq, From: "guest", Type: "joined"})
	call.GuestLastSeen = time.Now()
	meeting, _ := readMeeting(call.ChatID, call.MeetingID)
	writeJSON(w, http.StatusOK, map[string]any{"meetingId": call.MeetingID, "title": meeting.Title, "lease": call.GuestLease, "iceServers": meetingICEServers(), "expiresAt": call.Expires.UTC().Format(time.RFC3339)})
}

func (s *Server) handleMeetingHostSignals(w http.ResponseWriter, r *http.Request) {
	chatID, meetingID, ok := s.meetingLocation(w, r)
	if !ok {
		return
	}
	s.meetingCalls.mu.Lock()
	defer s.meetingCalls.mu.Unlock()
	call := s.meetingCalls.byMeeting[meetingID]
	if call == nil || call.ChatID != chatID || (time.Now().After(call.Expires) && !call.GuestJoined) {
		http.Error(w, "Call invite unavailable", 404)
		return
	}
	s.serveMeetingSignalsLocked(w, r, call, "host")
}

func (s *Server) handleMeetingGuestSignals(w http.ResponseWriter, r *http.Request) {
	s.meetingCalls.mu.Lock()
	defer s.meetingCalls.mu.Unlock()
	call := s.meetingCalls.byToken[r.PathValue("token")]
	if call == nil || (time.Now().After(call.Expires) && !call.GuestJoined) {
		http.Error(w, "Invite expired or revoked", 404)
		return
	}
	if !call.GuestJoined || r.Header.Get("X-Muxterm-Guest-Lease") != call.GuestLease {
		http.Error(w, "Join the meeting first", 403)
		return
	}
	s.serveMeetingSignalsLocked(w, r, call, "guest")
}

func (s *Server) serveMeetingSignalsLocked(w http.ResponseWriter, r *http.Request, call *meetingCall, role string) {
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
		writeJSON(w, http.StatusOK, map[string]any{"signals": out, "cursor": call.NextSeq, "peerConnected": !peerSeen.IsZero() && now.Sub(peerSeen) < 10*time.Second, "guestJoined": call.GuestJoined})
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 32<<10))
	if err != nil {
		http.Error(w, "Signal too large", 413)
		return
	}
	var input struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(data, &input) != nil || !validMeetingSignal(input.Type) || len(input.Payload) > 30<<10 {
		http.Error(w, "Invalid signal", 400)
		return
	}
	if len(input.Payload) > 0 && !json.Valid(input.Payload) {
		http.Error(w, "Invalid payload", 400)
		return
	}
	call.NextSeq++
	call.Signals = append(call.Signals, meetingSignal{Seq: call.NextSeq, From: role, Type: input.Type, Payload: input.Payload})
	if len(call.Signals) > 256 {
		call.Signals = call.Signals[len(call.Signals)-256:]
	}
	writeJSON(w, http.StatusOK, map[string]any{"cursor": call.NextSeq})
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
