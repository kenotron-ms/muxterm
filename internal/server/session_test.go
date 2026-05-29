package server

import (
	"encoding/json"
	"testing"
)

func TestSessionListMessage(t *testing.T) {
	// Build a SessionListMessage with 2 sessions
	msg := SessionListMessage{
		Sessions: []SessionInfo{
			{Name: "dev", Windows: 3},
			{Name: "ops", Windows: 1},
		},
	}

	// Marshal to JSON
	data, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}

	// Unmarshal back
	var got SessionListMessage
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}

	// Verify session count
	if len(got.Sessions) != 2 {
		t.Fatalf("Sessions count = %d, want 2", len(got.Sessions))
	}

	// Verify first session
	if got.Sessions[0].Name != "dev" {
		t.Errorf("Sessions[0].Name = %q, want %q", got.Sessions[0].Name, "dev")
	}
	if got.Sessions[0].Windows != 3 {
		t.Errorf("Sessions[0].Windows = %d, want 3", got.Sessions[0].Windows)
	}

	// Verify second session
	if got.Sessions[1].Name != "ops" {
		t.Errorf("Sessions[1].Name = %q, want %q", got.Sessions[1].Name, "ops")
	}
	if got.Sessions[1].Windows != 1 {
		t.Errorf("Sessions[1].Windows = %d, want 1", got.Sessions[1].Windows)
	}
}

func TestAttachSessionMessage(t *testing.T) {
	// Simulate client sending {"attach-session": "dev"}
	raw := []byte(`{"attach-session": "dev"}`)

	var msg map[string]string
	if err := json.Unmarshal(raw, &msg); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}

	name, ok := msg["attach-session"]
	if !ok {
		t.Fatal("missing 'attach-session' key")
	}
	if name != "dev" {
		t.Errorf("attach-session = %q, want %q", name, "dev")
	}
}
