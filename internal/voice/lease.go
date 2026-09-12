package voice

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"sync"
	"time"
)

// Mission Control voice is deliberately separate from the legacy global
// realtime manager. A lease identifies one text-thread runtime and one
// server-issued browser bridge; it never infers either from current focus or a
// client-supplied identifier.
var (
	ErrBridgeActive                    = errors.New("voice: another Mission Control bridge holds the only active lease")
	ErrBridgeCapability                = errors.New("voice: bridge control capability is missing, unknown, or belongs to another tab")
	ErrLeaseFenced                     = errors.New("voice: lease is fenced after heartbeat loss or stop; no replacement is safe without observed sink silence")
	ErrLeaseEpoch                      = errors.New("voice: lease epoch is stale")
	ErrFocusEpoch                      = errors.New("voice: focus epoch is stale")
	ErrCaptureEpoch                    = errors.New("voice: capture epoch is stale")
	ErrCorrelation                     = errors.New("voice: thread/runtime correlation does not match the lease")
	ErrBridgeSwitchUnsupported         = errors.New("voice: switching the active bridge to another Mission Control thread requires explicit old-sink silence, which is not implemented")
	ErrTakeoverDrainUnsupported        = errors.New("voice: takeover is unavailable because the current implementation has no server-observed old sink stop/drain acknowledgement")
	ErrProviderEventMappingUnsupported = errors.New("voice: capture admission is disabled because the current implementation has no verified thread-scoped provider input item, response, and sink drain mapping")
	ErrLeaseManagerClosed              = errors.New("voice: Mission Control voice lease manager is closed")
)

// MissionControlVoiceLeaseTTL is deliberately short. A silent browser must
// lose authority rather than retain a microphone/capture lease indefinitely.
const MissionControlVoiceLeaseTTL = 45 * time.Second

// VoiceCorrelation is immutable for a lease. Every capture and focus action
// must repeat these values, so a delayed event cannot be reassigned by current
// UI focus.
type VoiceCorrelation struct {
	ThreadID           string `json:"thread_id"`
	RuntimeSessionID   string `json:"runtime_session_id"`
	RuntimeGeneration  uint64 `json:"runtime_generation"`
	RuntimeIncarnation string `json:"runtime_incarnation"`
}

// VoiceLease is the non-secret view returned to a browser.
type VoiceLease struct {
	Correlation  VoiceCorrelation `json:"correlation"`
	LeaseEpoch   uint64           `json:"lease_epoch"`
	FocusEpoch   uint64           `json:"focus_epoch"`
	CaptureEpoch uint64           `json:"capture_epoch"`
	State        string           `json:"state"`
	ExpiresAt    time.Time        `json:"expires_at"`
}

// LeaseGrant carries a new per-bridge cookie identifier and a per-tab control
// capability. Only the HTTP handler turns BridgeID into an HttpOnly cookie and
// sends ControlToken in the initial lease response; neither is serialized by
// VoiceLease or broadcast.
type LeaseGrant struct {
	Lease        VoiceLease
	BridgeID     string
	ControlToken string
	Issued       bool
}

type voiceLease struct {
	VoiceLease
	bridgeID     string
	controlToken string
}

// LeaseManager owns only safety negotiation. It intentionally holds at most
// one active-or-fenced lease for this server, matching the one-bridge
// constraint. It does not mint a provider session, accept microphone audio, or
// submit work.
type LeaseManager struct {
	mu     sync.Mutex
	ttl    time.Duration
	next   uint64
	lease  *voiceLease // active lease or fail-closed fenced tombstone
	closed bool
}

func NewLeaseManager() *LeaseManager {
	return &LeaseManager{ttl: MissionControlVoiceLeaseTTL}
}

// Claim establishes the only bridge lease. A first claim ignores every
// caller-supplied bridge value and issues fresh random credentials. Reclaims
// require both the server-issued HttpOnly bridge cookie identifier and the
// per-tab control capability; a tab sharing only browser cookies cannot
// control, renew, or recover the bridge.
//
// A stop, expiry, or attempted hand-off leaves a fenced tombstone. Since this
// increment has no provider sink-silence acknowledgement, that tombstone is
// never removed automatically and all takeover claims fail closed.
func (m *LeaseManager) Claim(c VoiceCorrelation, bridgeID, controlToken string, takeover bool) (LeaseGrant, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return LeaseGrant{}, ErrLeaseManagerClosed
	}
	if m.lease == nil {
		issuedBridgeID, err := newSecret()
		if err != nil {
			return LeaseGrant{}, err
		}
		issuedControlToken, err := newSecret()
		if err != nil {
			return LeaseGrant{}, err
		}
		m.next++
		m.lease = &voiceLease{
			VoiceLease: VoiceLease{
				Correlation: c, LeaseEpoch: m.next, State: "active",
				ExpiresAt: time.Now().Add(m.ttl).UTC(),
			},
			bridgeID: issuedBridgeID, controlToken: issuedControlToken,
		}
		return LeaseGrant{
			Lease: m.lease.VoiceLease, BridgeID: issuedBridgeID,
			ControlToken: issuedControlToken, Issued: true,
		}, nil
	}

	m.expireLocked()
	if m.lease.State != "active" {
		if takeover {
			return LeaseGrant{}, ErrTakeoverDrainUnsupported
		}
		return LeaseGrant{}, ErrLeaseFenced
	}
	if m.lease.bridgeID == bridgeID && m.lease.controlToken == controlToken {
		if m.lease.Correlation != c {
			return LeaseGrant{}, ErrBridgeSwitchUnsupported
		}
		m.lease.ExpiresAt = time.Now().Add(m.ttl).UTC()
		return LeaseGrant{Lease: m.lease.VoiceLease}, nil
	}
	return LeaseGrant{}, ErrBridgeActive
}

func (m *LeaseManager) Heartbeat(c VoiceCorrelation, bridgeID, controlToken string, leaseEpoch uint64) (VoiceLease, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	lease, err := m.authorizeLocked(c, bridgeID, controlToken, leaseEpoch)
	if err != nil {
		return VoiceLease{}, err
	}
	lease.ExpiresAt = time.Now().Add(m.ttl).UTC()
	return lease.VoiceLease, nil
}

// Focus advances a fencing epoch; the current focused surface must present the
// prior epoch. It has no relationship to browser-global focus.
func (m *LeaseManager) Focus(c VoiceCorrelation, bridgeID, controlToken string, leaseEpoch, expectedFocusEpoch uint64) (VoiceLease, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	lease, err := m.authorizeLocked(c, bridgeID, controlToken, leaseEpoch)
	if err != nil {
		return VoiceLease{}, err
	}
	if lease.FocusEpoch != expectedFocusEpoch {
		return VoiceLease{}, ErrFocusEpoch
	}
	lease.FocusEpoch++
	return lease.VoiceLease, nil
}

// CaptureGate proves that a capture is still scoped to the owning bridge,
// lease, and focus epoch. It never increments capture or admits input because
// the current implementation lacks verified provider-originated event mapping.
func (m *LeaseManager) CaptureGate(c VoiceCorrelation, bridgeID, controlToken string, leaseEpoch, focusEpoch, expectedCaptureEpoch uint64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	lease, err := m.authorizeLocked(c, bridgeID, controlToken, leaseEpoch)
	if err != nil {
		return err
	}
	if lease.FocusEpoch != focusEpoch {
		return ErrFocusEpoch
	}
	if lease.CaptureEpoch != expectedCaptureEpoch {
		return ErrCaptureEpoch
	}
	return ErrProviderEventMappingUnsupported
}

// Stop fences the only lease but never cancels text-thread work. Keeping the
// tombstone is intentional: without a server-observed sink-silence signal,
// deleting it would turn a local stop into an unsafe immediate takeover.
func (m *LeaseManager) Stop(c VoiceCorrelation, bridgeID, controlToken string, leaseEpoch uint64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	lease, err := m.authorizeLocked(c, bridgeID, controlToken, leaseEpoch)
	if err != nil {
		return err
	}
	lease.State = "fenced"
	return nil
}

// Close drops the one bounded lease record when the owning Server exits.
func (m *LeaseManager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lease = nil
	m.closed = true
}

func (m *LeaseManager) authorizeLocked(c VoiceCorrelation, bridgeID, controlToken string, leaseEpoch uint64) (*voiceLease, error) {
	if m.closed {
		return nil, ErrLeaseManagerClosed
	}
	if m.lease == nil {
		return nil, ErrLeaseFenced
	}
	m.expireLocked()
	if m.lease.State != "active" {
		return nil, ErrLeaseFenced
	}
	if m.lease.bridgeID != bridgeID || m.lease.controlToken != controlToken {
		return nil, ErrBridgeCapability
	}
	if m.lease.Correlation != c {
		return nil, ErrCorrelation
	}
	if m.lease.LeaseEpoch != leaseEpoch {
		return nil, ErrLeaseEpoch
	}
	return m.lease, nil
}

func (m *LeaseManager) expireLocked() {
	if m.lease != nil && m.lease.State == "active" && !time.Now().Before(m.lease.ExpiresAt) {
		m.lease.State = "fenced"
	}
}

func newSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", errors.New("voice: could not generate a bridge credential")
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
