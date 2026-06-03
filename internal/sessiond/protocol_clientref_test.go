package sessiond

import (
	"encoding/json"
	"testing"
)

// TestMessageClientRefRoundTrips verifies that ClientRef marshals under the
// locked wire tag "clientRef" and survives a marshal/unmarshal round trip.
func TestMessageClientRefRoundTrips(t *testing.T) {
	msg := &Message{Type: TypeCreateWorkspace, ClientRef: "tmp-abc123"}

	data, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	const want = `{"type":"create-workspace","clientRef":"tmp-abc123"}`
	if got := string(data); got != want {
		t.Fatalf("marshal mismatch:\n got: %s\nwant: %s", got, want)
	}

	var back Message
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.ClientRef != "tmp-abc123" {
		t.Fatalf("round-trip ClientRef = %q, want %q", back.ClientRef, "tmp-abc123")
	}
}

// TestMessageClientRefOmittedWhenEmpty verifies that an empty ClientRef is
// omitted from the wire form, keeping golden frames unchanged.
func TestMessageClientRefOmittedWhenEmpty(t *testing.T) {
	data, err := json.Marshal(&Message{Type: TypeOK})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	const want = `{"type":"ok"}`
	if got := string(data); got != want {
		t.Fatalf("marshal mismatch:\n got: %s\nwant: %s", got, want)
	}
}
