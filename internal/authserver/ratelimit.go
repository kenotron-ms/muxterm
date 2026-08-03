package authserver

import (
	"sync"
	"time"
)

// RateLimiter enforces a hard cap on failed login attempts per source IP:
// at most maxFailures within the trailing window. This is a hard
// requirement per the design doc's Error Handling section — PAM now gates
// a real OS password, so failed remote attempts must be throttled. State
// is in-memory only; a server restart clears all lockout history (an
// accepted Phase 1 limitation for a single-account personal tool, not a
// silent gap).
type RateLimiter struct {
	mu          sync.Mutex
	maxFailures int
	window      time.Duration
	failures    map[string][]time.Time
}

// NewRateLimiter returns a limiter allowing at most maxFailures failed
// attempts per source IP within window. The design doc's example figure is
// 5 attempts / 15 minutes.
func NewRateLimiter(maxFailures int, window time.Duration) *RateLimiter {
	return &RateLimiter{
		maxFailures: maxFailures,
		window:      window,
		failures:    make(map[string][]time.Time),
	}
}

// Reserve atomically checks whether ip has capacity within the trailing
// window and, if so, immediately records a provisional failure entry
// (reserving a slot) before returning true. This closes the gap between
// checking capacity and recording a failure that existed with a separate
// Allow()+RecordFailure() pair: without atomicity, concurrent callers
// could all observe capacity before any of them recorded a failure,
// letting more than maxFailures concurrent authentication attempts reach
// a slow backend (e.g. real PAM) before the limiter actually engaged.
//
// Callers MUST treat a true return as "the attempt is both permitted AND
// already recorded as a failure." If the attempt turns out to succeed,
// call RecordSuccess(ip) to clear the reservation (and any prior
// failures) for that ip. If it fails, the reservation already IS the
// recorded failure — do not call anything else; there is no separate
// RecordFailure anymore.
func (r *RateLimiter) Reserve(ip string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pruneLocked(ip)
	if len(r.failures[ip]) >= r.maxFailures {
		return false
	}
	r.failures[ip] = append(r.failures[ip], time.Now())
	return true
}

// RecordSuccess clears ip's failure history on a successful login.
func (r *RateLimiter) RecordSuccess(ip string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.failures, ip)
}

// pruneLocked drops failures older than window. Caller MUST hold r.mu.
func (r *RateLimiter) pruneLocked(ip string) {
	cutoff := time.Now().Add(-r.window)
	kept := r.failures[ip][:0]
	for _, t := range r.failures[ip] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) == 0 {
		delete(r.failures, ip)
	} else {
		r.failures[ip] = kept
	}
}
