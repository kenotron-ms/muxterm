package sessiond

import (
	"net"
	"path/filepath"
	"testing"
	"time"
)

// fakeDaemon is an in-process Unix-socket server used to test the serve-side
// Client in isolation. It accepts exactly one connection and hands it to a
// per-test handler. The listener is closed and the socket file removed on
// cleanup.
type fakeDaemon struct {
	sockPath string
}

// newFakeDaemon starts a fake daemon that accepts exactly one connection and
// passes the accepted net.Conn to handler in a goroutine.
func newFakeDaemon(t *testing.T, handler func(conn net.Conn)) *fakeDaemon {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "fake.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	t.Cleanup(func() {
		_ = ln.Close()
	})
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		handler(conn)
	}()
	return &fakeDaemon{sockPath: sock}
}

func TestDialConnects(t *testing.T) {
	fd := newFakeDaemon(t, func(conn net.Conn) {
		time.Sleep(200 * time.Millisecond)
		_ = conn.Close()
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()
	if c == nil {
		t.Fatal("Dial returned nil *Client")
	}
}
