package server

import (
	"errors"
	"testing"
)

func TestBroadcastChatUINavigationCountsSuccessfulWrites(t *testing.T) {
	hub := NewHub(nil)
	noBinary := func([]byte) error { return nil }
	good := newTestClient(hub, func([]byte) error { return nil }, noBinary)
	failed := newTestClient(hub, func([]byte) error { return errors.New("write failed") }, noBinary)
	disconnected := newTestClient(hub, func([]byte) error {
		t.Fatal("disconnected client's writer was called")
		return nil
	}, noBinary)
	disconnected.cancel()
	hub.clients[good] = true
	hub.clients[failed] = true
	hub.clients[disconnected] = true

	if got := hub.BroadcastChatUINavigation(chatUINavigation{Action: "chat", SessionID: "s1"}); got != 1 {
		t.Fatalf("successful browser deliveries = %d, want 1", got)
	}
}
