// internal/ai/capability.go
package ai

import (
	"errors"
	"log"
	"os"
	"strings"
	"sync"

	"github.com/anthropics/anthropic-sdk-go"
)

type Source string

const (
	SourceSettings Source = "settings"
	SourceEnv      Source = "env"
	SourceNone     Source = "none"
)

const EnvKeyVar = "ANTHROPIC_API_KEY"
const MinKeyLen = 16

var ErrInvalidKey = errors.New("ai: invalid api key")

// Status is muxterm's own AI capability flag.
//
// It carries no fragment of the key -- not a mask, not a length, not the last
// four characters. "Is a key set, and where did it come from" is the entire
// truth this type tells, because a hint is still a disclosure and a GET route
// that returns one cannot be called write-only.
type Status struct {
	Enabled bool   `json:"enabled"`
	Source  Source `json:"source"`
}

// Manager is the ONE credential store in this binary.
//
// It backs three things that used to be, or could easily have become,
// separate: muxterm's own Anthropic-powered features, the /api/credentials
// onboarding surface, and the environment injected into a lane at spawn. A
// second store beside it is how one of them quietly stops being the one that
// matters, so there is not one.
type Manager struct {
	stores map[Provider]*keyStore

	mu        sync.RWMutex
	cached    *anthropic.Client
	cachedKey string

	// verdicts remembers the outcome of the last live check per provider, so
	// a status read costs nothing and a check is an explicit act. Empty until
	// something checks; "not checked yet" is a state the UI shows honestly
	// rather than dressing up as either health or failure.
	vmu      sync.RWMutex
	verdicts map[Provider]Verdict
}

// NewManager returns a Manager whose Anthropic key lives at anthropicKeyPath
// (the --ai-key-path flag's value, defaulting to DefaultKeyPath) and whose
// other providers live beside it in ConfigDir.
func NewManager(anthropicKeyPath string) *Manager {
	stores := map[Provider]*keyStore{}
	for _, p := range Providers {
		path := KeyPath(p)
		if p == ProviderAnthropic && anthropicKeyPath != "" {
			path = anthropicKeyPath
		}
		stores[p] = newKeyStore(path)
	}
	return &Manager{stores: stores, verdicts: map[Provider]Verdict{}}
}

// storePath reports where p's key is kept, for display in the UI. A path is
// not a secret; the file it names is.
func (m *Manager) storePath(p Provider) string {
	if s, ok := m.stores[p]; ok {
		return s.path
	}
	return KeyPath(p)
}

// stored returns the key muxterm itself holds for p, or "" when it holds
// none. A read error is logged (path only) and reported as absent.
// StoredKey returns the credential muxterm itself holds for p, or "".
//
// Exported for ONE caller: the explicit "also write this into amplifier's
// keys.env" action, which propagates what muxterm stored and nothing else. It
// is deliberately not a general accessor -- no HTTP route returns what it
// returns, and none may.
func (m *Manager) StoredKey(p Provider) string { return m.stored(p) }

func (m *Manager) stored(p Provider) string {
	s, ok := m.stores[p]
	if !ok {
		return ""
	}
	key, err := s.Load()
	if err != nil {
		log.Printf("ai: %v", err)
		return ""
	}
	return key
}

func (m *Manager) resolve() (string, Source) {
	if key := m.stored(ProviderAnthropic); key != "" {
		return key, SourceSettings
	}
	if envKey := strings.TrimSpace(os.Getenv(EnvKeyVar)); envKey != "" {
		return envKey, SourceEnv
	}
	return "", SourceNone
}

func (m *Manager) Status() Status {
	key, src := m.resolve()
	if key == "" {
		return Status{Enabled: false, Source: SourceNone}
	}
	return Status{Enabled: true, Source: src}
}

func (m *Manager) IsAIEnabled() bool { return m.Status().Enabled }

func (m *Manager) SaveKey(key string) (Status, error) {
	if err := m.SaveProviderKey(ProviderAnthropic, key); err != nil {
		return Status{}, err
	}
	return m.Status(), nil
}

func (m *Manager) ClearKey() (Status, error) {
	if err := m.ClearProviderKey(ProviderAnthropic); err != nil {
		return Status{}, err
	}
	return m.Status(), nil
}

// SaveProviderKey stores key for p with owner-only permissions.
//
// It does not verify -- verification is the caller's decision, because the
// two callers want different things: the onboarding route refuses to write a
// credential the vendor actively rejected, while the older /api/ai/key route
// keeps its long-standing store-then-test behaviour.
func (m *Manager) SaveProviderKey(p Provider, key string) error {
	s, ok := m.stores[p]
	if !ok {
		return ErrInvalidKey
	}
	key = strings.TrimSpace(key)
	if len(key) < MinKeyLen {
		return ErrInvalidKey
	}
	if err := s.Save(key); err != nil {
		return err
	}
	m.invalidate()
	m.forgetVerdict(p)
	return nil
}

// ClearProviderKey removes muxterm's stored key for p. Idempotent.
//
// Clearing does not make the machine unconfigured: an environment variable or
// an entry in amplifier's own keys.env may still be there, and Report will
// say so rather than claiming the credential is gone.
func (m *Manager) ClearProviderKey(p Provider) error {
	s, ok := m.stores[p]
	if !ok {
		return ErrInvalidKey
	}
	if err := s.Clear(); err != nil {
		return err
	}
	m.invalidate()
	m.forgetVerdict(p)
	return nil
}

func (m *Manager) invalidate() {
	m.mu.Lock()
	m.cached, m.cachedKey = nil, ""
	m.mu.Unlock()
}

func (m *Manager) redact(s string) string {
	out := s
	for _, p := range Providers {
		if key := m.stored(p); key != "" {
			out = strings.ReplaceAll(out, key, "[REDACTED]")
		}
	}
	if key, _ := m.resolve(); key != "" {
		out = strings.ReplaceAll(out, key, "[REDACTED]")
	}
	return out
}
