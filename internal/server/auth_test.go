package server

import (
	"net/http"
	"testing"
)

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
