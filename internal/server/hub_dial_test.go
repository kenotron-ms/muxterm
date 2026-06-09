package server

import (
	"errors"
	"testing"
)

// TestHubDial_NoDialer verifies that Dial returns an error when no dialer is configured.
func TestHubDial_NoDialer(t *testing.T) {
	h := NewHub(nil)
	_, err := h.Dial()
	if err == nil {
		t.Fatal("expected error when no dialer configured, got nil")
	}
}

// TestHubDial_WithDialer verifies that Dial invokes the configured DialFunc and returns a connection.
func TestHubDial_WithDialer(t *testing.T) {
	fake := &fakeDaemonConn{}
	h := NewHub(func() (DaemonConn, error) {
		return fake, nil
	})
	conn, err := h.Dial()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if conn != fake {
		t.Fatal("expected the fake DaemonConn to be returned")
	}
}

// TestHubDial_DialError verifies that Dial propagates dialer errors.
func TestHubDial_DialError(t *testing.T) {
	dialErr := errors.New("dial failed")
	h := NewHub(func() (DaemonConn, error) {
		return nil, dialErr
	})
	_, err := h.Dial()
	if !errors.Is(err, dialErr) {
		t.Fatalf("expected %v, got %v", dialErr, err)
	}
}
