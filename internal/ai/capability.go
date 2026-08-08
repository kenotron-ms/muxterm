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

type Status struct {
	Enabled bool   `json:"enabled"`
	Source  Source `json:"source"`
	KeyHint string `json:"keyHint"`
}

type Manager struct {
	store *keyStore

	mu        sync.RWMutex
	cached    *anthropic.Client
	cachedKey string
}

func NewManager(path string) *Manager {
	return &Manager{store: newKeyStore(path)}
}

func (m *Manager) resolve() (string, Source) {
	key, err := m.store.Load()
	if err != nil {
		log.Printf("ai: %v", err)
	} else if key != "" {
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
		return Status{Enabled: false, Source: SourceNone, KeyHint: ""}
	}
	return Status{Enabled: true, Source: src, KeyHint: keyHint(key)}
}

func (m *Manager) IsAIEnabled() bool { return m.Status().Enabled }

func (m *Manager) SaveKey(key string) (Status, error) {
	key = strings.TrimSpace(key)
	if len(key) < MinKeyLen {
		return Status{}, ErrInvalidKey
	}
	if err := m.store.Save(key); err != nil {
		return Status{}, err
	}
	m.invalidate()
	return m.Status(), nil
}

func (m *Manager) ClearKey() (Status, error) {
	if err := m.store.Clear(); err != nil {
		return Status{}, err
	}
	m.invalidate()
	return m.Status(), nil
}

func (m *Manager) invalidate() {
	m.mu.Lock()
	m.cached, m.cachedKey = nil, ""
	m.mu.Unlock()
}

func (m *Manager) redact(s string) string {
	key, _ := m.resolve()
	if key == "" {
		return s
	}
	return strings.ReplaceAll(s, key, "[REDACTED]")
}

func keyHint(key string) string {
	if len(key) < 8 {
		return ""
	}
	return "…" + key[len(key)-4:]
}
