// internal/ai/client.go
package ai

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// ErrDisabled is returned when no Anthropic API key resolves, meaning AI
// capabilities are inert: no client is constructed and no network traffic
// occurs.
var ErrDisabled = errors.New("ai: disabled (no API key configured)")

// PingModel is the model used for the low-cost connectivity check in Ping.
const PingModel = anthropic.ModelClaudeHaiku4_5

// PingTimeout bounds how long a single Ping call may take.
const PingTimeout = 15 * time.Second

// PingResult is the outcome of a successful Ping.
type PingResult struct {
	OK bool `json:"ok"`
}

// ProviderError wraps an Anthropic API rejection with only the fields safe
// to surface: HTTP status, request ID, and a redacted message. It never
// carries the raw request/response.
type ProviderError struct {
	StatusCode int
	RequestID  string
	Message    string
}

func (e *ProviderError) Error() string {
	return fmt.Sprintf("ai: provider error (status %d, request %q): %s", e.StatusCode, e.RequestID, e.Message)
}

// Client returns a cached Anthropic SDK client for the currently resolved
// key, constructing one only when the key has changed since the last call.
// When no key resolves, it returns ErrDisabled before constructing anything
// or touching the network.
func (m *Manager) Client() (*anthropic.Client, error) {
	key, _ := m.resolve()
	if key == "" {
		return nil, ErrDisabled
	}

	m.mu.RLock()
	if m.cached != nil && m.cachedKey == key {
		c := m.cached
		m.mu.RUnlock()
		return c, nil
	}
	m.mu.RUnlock()

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cached != nil && m.cachedKey == key {
		return m.cached, nil
	}
	c := anthropic.NewClient(option.WithAPIKey(key))
	m.cached, m.cachedKey = &c, key
	return &c, nil
}

// Ping issues a minimal, low-cost request to Anthropic to verify the
// configured key is accepted. It returns ErrDisabled unchanged when AI is
// not enabled. On a provider rejection it returns a *ProviderError whose
// Message has been passed through m.redact, so the key never appears in
// the returned error.
func (m *Manager) Ping(ctx context.Context) (PingResult, error) {
	client, err := m.Client()
	if err != nil {
		return PingResult{}, err
	}

	ctx, cancel := context.WithTimeout(ctx, PingTimeout)
	defer cancel()

	_, err = client.Messages.New(ctx, anthropic.MessageNewParams{
		Model:     PingModel,
		MaxTokens: 1,
		Messages: []anthropic.MessageParam{
			anthropic.NewUserMessage(anthropic.NewTextBlock("ping")),
		},
	})
	if err != nil {
		var apiErr *anthropic.Error
		if errors.As(err, &apiErr) {
			return PingResult{}, &ProviderError{
				StatusCode: apiErr.StatusCode,
				RequestID:  apiErr.RequestID,
				Message:    m.redact(apiErr.Error()),
			}
		}
		return PingResult{}, errors.New(m.redact(err.Error()))
	}
	return PingResult{OK: true}, nil
}
