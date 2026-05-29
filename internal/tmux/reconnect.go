package tmux

import (
	"fmt"
	"time"
)

// ReconnectConfig holds the configuration for reconnection attempts.
type ReconnectConfig struct {
	MaxRetries int
	MaxDelay   time.Duration
}

// DefaultReconnectConfig returns the default reconnection configuration.
func DefaultReconnectConfig() ReconnectConfig {
	return ReconnectConfig{
		MaxRetries: 10,
		MaxDelay:   30 * time.Second,
	}
}

// DisconnectHandler is called when the tmux control mode connection is lost.
type DisconnectHandler func(reason string)

// ReconnectHandler is called when the tmux control mode connection is restored.
type ReconnectHandler func()

// backoffDelay returns the delay for a given reconnect attempt using
// exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s.
func backoffDelay(attempt int) time.Duration {
	const maxDelay = 30 * time.Second
	delay := time.Second * (1 << uint(attempt))
	if delay > maxDelay {
		return maxDelay
	}
	return delay
}

// ControlMode manages a tmux control mode connection to a session.
type ControlMode struct {
	session string
	closeFn func()
	startFn func(session string) error
}

// NewControlMode creates a ControlMode with the given start and close functions.
func NewControlMode(startFn func(string) error, closeFn func()) *ControlMode {
	return &ControlMode{
		startFn: startFn,
		closeFn: closeFn,
	}
}

// Start initiates the control mode connection to the given session.
func (cm *ControlMode) Start(session string) error {
	cm.session = session
	if cm.startFn != nil {
		return cm.startFn(session)
	}
	return nil
}

// Close shuts down the control mode connection.
func (cm *ControlMode) Close() {
	if cm.closeFn != nil {
		cm.closeFn()
	}
}

// Reconnect attempts to re-establish the tmux control mode connection.
// It preserves the session name, closes the current connection, calls
// onDisconnect, then retries with exponential backoff up to cfg.MaxRetries.
// On success it calls onReconnect and returns nil. On exhaustion returns error.
func (cm *ControlMode) Reconnect(cfg ReconnectConfig, onDisconnect DisconnectHandler, onReconnect ReconnectHandler) error {
	session := cm.session
	cm.Close()
	if onDisconnect != nil {
		onDisconnect("connection lost")
	}
	for i := 0; i < cfg.MaxRetries; i++ {
		time.Sleep(backoffDelay(i))
		if err := cm.Start(session); err == nil {
			if onReconnect != nil {
				onReconnect()
			}
			return nil
		}
	}
	return fmt.Errorf("reconnect failed after %d attempts", cfg.MaxRetries)
}
