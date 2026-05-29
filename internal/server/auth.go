package server

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// GenerateSecret creates a random 32-byte hex-encoded secret (64 hex chars).
func GenerateSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// GenerateToken creates an HMAC-SHA256 token with an embedded Unix timestamp.
// Format: "<unix_timestamp>.<hex_hmac>"
func GenerateToken(secret string) (string, error) {
	ts := strconv.FormatInt(time.Now().Unix(), 10)

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts))
	sig := hex.EncodeToString(mac.Sum(nil))

	return ts + "." + sig, nil
}

// ValidateToken checks HMAC validity and TTL expiry.
// Returns false for malformed tokens, wrong secrets, or expired tokens.
func ValidateToken(token, secret string, ttl time.Duration) bool {
	if token == "" {
		return false
	}

	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return false
	}

	tsStr := parts[0]
	sig := parts[1]

	if sig == "" {
		return false
	}

	ts, err := strconv.ParseInt(tsStr, 10, 64)
	if err != nil {
		return false
	}

	// Check TTL expiry
	elapsed := time.Since(time.Unix(ts, 0))
	if elapsed > ttl {
		return false
	}

	// Verify HMAC
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(tsStr))
	expected := hex.EncodeToString(mac.Sum(nil))

	return hmac.Equal([]byte(sig), []byte(expected))
}

// IsLocalhost returns true if the request originates from a loopback address
// (127.0.0.1 or [::1]).
func IsLocalhost(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}

	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}

	return ip.IsLoopback()
}