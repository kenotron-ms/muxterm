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

// Allow reports whether ip is currently permitted to attempt a login (has
// not exceeded maxFailures within the trailing window).
func (r *RateLimiter) Allow(ip string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pruneLocked(ip)
	return len(r.failures[ip]) < r.maxFailures
}

// RecordFailure records a failed login attempt from ip.
func (r *RateLimiter) RecordFailure(ip string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pruneLocked(ip)
	r.failures[ip] = append(r.failures[ip], time.Now())
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
