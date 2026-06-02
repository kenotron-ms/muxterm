package server

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestGenerateSecret(t *testing.T) {
	s1, err := GenerateSecret()
	if err != nil {
		t.Fatalf("GenerateSecret: %v", err)
	}
	if len(s1) != 64 {
		t.Errorf("secret length = %d, want 64 hex chars", len(s1))
	}

	s2, err := GenerateSecret()
	if err != nil {
		t.Fatalf("GenerateSecret: %v", err)
	}
	if s1 == s2 {
		t.Error("two secrets should not be identical")
	}
}

func TestGenerateAndValidateToken(t *testing.T) {
	secret, err := GenerateSecret()
	if err != nil {
		t.Fatalf("GenerateSecret: %v", err)
	}

	token, err := GenerateToken(secret)
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}

	// Token should have the format <unix_timestamp>.<hex_hmac>
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		t.Fatalf("token format invalid: %q", token)
	}

	// Should be valid with a reasonable TTL
	if !ValidateToken(token, secret, 30*time.Second) {
		t.Error("token should be valid with 30s TTL")
	}
}

func TestValidateToken_WrongSecret(t *testing.T) {
	secret1, _ := GenerateSecret()
	secret2, _ := GenerateSecret()

	token, err := GenerateToken(secret1)
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}

	if ValidateToken(token, secret2, 30*time.Second) {
		t.Error("token should be rejected with wrong secret")
	}
}

func TestValidateToken_Expired(t *testing.T) {
	secret, _ := GenerateSecret()

	token, err := GenerateToken(secret)
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}

	// TTL of 0 means immediately expired
	if ValidateToken(token, secret, 0) {
		t.Error("token should be expired with TTL=0")
	}
}

func TestValidateToken_Malformed(t *testing.T) {
	secret, _ := GenerateSecret()

	cases := []struct {
		name  string
		token string
	}{
		{"empty", ""},
		{"no period", "notokenperiod"},
		{"short", "123.ab"},
		{"missing sig", "12345."},
		{"non-numeric timestamp", "abc.deadbeef"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if ValidateToken(tc.token, secret, 30*time.Second) {
				t.Errorf("malformed token %q should be rejected", tc.token)
			}
		})
	}
}

func TestIsLocalhost(t *testing.T) {
	cases := []struct {
		name       string
		remoteAddr string
		want       bool
	}{
		{"ipv4 loopback", "127.0.0.1:12345", true},
		{"ipv6 loopback", "[::1]:12345", true},
		{"private ipv4 192", "192.168.1.1:12345", false},
		{"private ipv4 10", "10.0.0.1:12345", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := &http.Request{RemoteAddr: tc.remoteAddr}
			got := IsLocalhost(r)
			if got != tc.want {
				t.Errorf("IsLocalhost(%q) = %v, want %v", tc.remoteAddr, got, tc.want)
			}
		})
	}
}
