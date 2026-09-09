package voice

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"sync"
	"time"

	"github.com/kenotron-ms/muxterm/internal/config"
)

// Manager owns the realtime capability for one muxterm process.
//
// ONE live session at a time, deliberately. A second concurrent voice
// session would be a second mouth on one chief of staff, which already
// serializes turns -- so the two would interleave answers into each other's
// conversations. Opening a new session closes the previous one.
type Manager struct {
	client *Client
	bridge Bridge

	mu       sync.Mutex
	handles  map[string]*handle
	live     *handle
	onEnded  func(sessionID, reason string)
	traces   []Trace
	tracesMu sync.Mutex
}

// handle is one browser's voice session, from mint to teardown.
type handle struct {
	id        string
	secret    string
	expiresAt int64
	minted    time.Time
	sideband  *Sideband
}

// mintTTL bounds how long an unused minted secret is kept. A browser that
// mints and never connects should not leave a usable secret in memory.
const mintTTL = 10 * time.Minute

// maxTraces bounds the in-memory trace ring. Traces exist for the automated
// end-to-end harness; they are not a log and are not durable.
const maxTraces = 500

// NewManager builds a Manager. cfg must have passed Validate. keyPath is the
// owner-only file a settings-saved API key lives in (voice.DefaultKeyPath()).
func NewManager(cfg config.VoiceConfig, bridge Bridge, keyPath string) (*Manager, error) {
	if !cfg.Enabled {
		return nil, errors.New("voice: disabled")
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	cred, err := NewCredential(cfg, keyPath)
	if err != nil {
		return nil, err
	}
	return &Manager{
		client:  NewClient(cfg, cred),
		bridge:  bridge,
		handles: map[string]*handle{},
	}, nil
}

// Config returns the resolved voice config.
func (m *Manager) Config() config.VoiceConfig { return m.client.Config() }

// Mint creates a realtime session and returns its ephemeral secret plus a
// muxterm-side session id.
//
// The session id is what the browser presents on the SDP exchange. The
// secret is returned because it is the vendor's client credential and the
// browser is entitled to it -- it is short-lived, scoped to one session, and
// carries no authority over anything but that session. The credential that
// minted it never leaves this process.
func (m *Manager) Mint(ctx context.Context) (Ephemeral, error) {
	eph, err := m.client.MintEphemeral(ctx)
	if err != nil {
		return Ephemeral{}, err
	}
	id, err := newID()
	if err != nil {
		return Ephemeral{}, err
	}

	m.mu.Lock()
	m.sweepLocked()
	m.handles[id] = &handle{id: id, secret: eph.Value, expiresAt: eph.ExpiresAt, minted: time.Now()}
	m.mu.Unlock()

	eph.SessionID = id
	return eph, nil
}

// Connect completes the WebRTC handshake for a minted session and brings the
// tool sideband up.
//
// sessionID names a secret THIS process minted. The browser never supplies a
// call id or an endpoint: the call id is read from the vendor's own Location
// header on the exchange muxterm performed, because the sideband keyed to it
// executes shell tools.
func (m *Manager) Connect(ctx context.Context, sessionID, offerSDP string) (Answer, error) {
	m.mu.Lock()
	m.sweepLocked()
	h, ok := m.handles[sessionID]
	m.mu.Unlock()
	if !ok {
		return Answer{}, errors.New("voice: unknown or expired voice session; mint a new one")
	}

	answer, err := m.client.ExchangeSDP(ctx, h.secret, offerSDP)
	if err != nil {
		return Answer{}, err
	}

	// The teardown callback closes over THIS session's id, so a spoken
	// exit lands on the same Manager.End the browser's POST reaches
	// instead of inventing a second way to tear a session down.
	sb, err := Dial(ctx, m.client, answer.CallID, h.secret, m.bridge, m.record,
		func(reason string) { m.endWithReason(sessionID, reason) })
	if err != nil {
		// Audio would still work, but a chief of staff that cannot act
		// is not the feature. Fail the connection rather than hand back
		// a session that can only chat.
		return Answer{}, err
	}

	m.mu.Lock()
	prev := m.live
	h.sideband = sb
	m.live = h
	m.mu.Unlock()

	if prev != nil && prev != h && prev.sideband != nil {
		prev.sideband.Close()
	}
	return answer, nil
}

// SetOnEnded installs the hook called after a session is torn down.
//
// It exists so the browser can be TOLD. A session the model hangs up ends
// server-side, but the microphone light, the peer connection and the idle
// state all live in the page -- and a browser still showing a live session
// that is gone is the same lie as a session that would not end. The hook
// carries no credential and no transcript: a session id and a reason.
func (m *Manager) SetOnEnded(fn func(sessionID, reason string)) {
	m.mu.Lock()
	m.onEnded = fn
	m.mu.Unlock()
}

// End tears down a session. Idempotent, and safe for a session id that was
// minted but never connected.
func (m *Manager) End(sessionID string) {
	m.endWithReason(sessionID, "ended by the browser")
}

// endWithReason is the ONE teardown. Every way a voice session can end --
// the browser's POST, the model's spoken exit -- arrives here.
func (m *Manager) endWithReason(sessionID, reason string) {
	m.mu.Lock()
	h := m.handles[sessionID]
	delete(m.handles, sessionID)
	if h != nil && m.live == h {
		m.live = nil
	}
	onEnded := m.onEnded
	m.mu.Unlock()

	if h == nil {
		// Already gone. Nothing ended, so nothing is announced: a
		// browser that tears down on the hook and then posts /end for
		// the same id must not be told again.
		return
	}
	if h.sideband != nil {
		h.sideband.Close()
	}
	if onEnded != nil {
		onEnded(sessionID, reason)
	}
}

// Close tears down everything. Called when the server shuts down.
func (m *Manager) Close() {
	m.mu.Lock()
	hs := make([]*handle, 0, len(m.handles))
	for _, h := range m.handles {
		hs = append(hs, h)
	}
	m.handles = map[string]*handle{}
	m.live = nil
	m.mu.Unlock()
	for _, h := range hs {
		if h.sideband != nil {
			h.sideband.Close()
		}
	}
}

// Live returns the connected sideband, or nil.
func (m *Manager) Live() *Sideband {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.live == nil {
		return nil
	}
	return m.live.sideband
}

// sweepLocked drops minted-but-unconnected handles that have gone stale.
func (m *Manager) sweepLocked() {
	for id, h := range m.handles {
		if h.sideband == nil && time.Since(h.minted) > mintTTL {
			delete(m.handles, id)
		}
	}
}

func (m *Manager) record(t Trace) {
	m.tracesMu.Lock()
	defer m.tracesMu.Unlock()
	m.traces = append(m.traces, t)
	if len(m.traces) > maxTraces {
		m.traces = m.traces[len(m.traces)-maxTraces:]
	}
}

// Traces returns a copy of the trace ring. Coarse by construction: event
// kinds and tool names only, never arguments, results, or credentials.
func (m *Manager) Traces() []Trace {
	m.tracesMu.Lock()
	defer m.tracesMu.Unlock()
	out := make([]Trace, len(m.traces))
	copy(out, m.traces)
	return out
}

func newID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", errors.New("voice: could not generate a session id")
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
