package main

import (
	"fmt"
	"io"
	"net"
	"os"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// runSessiondConnect pipes this process's stdin/stdout to the local sessiond
// Unix socket, making a plain byte stream (an ssh subprocess's pipes, a
// sandbox bridge, anything) a usable path to the daemon's frozen protocol.
//
// It is a plumbing primitive and deliberately knows nothing about what carried
// its stdio. It is also deliberately BINARY-CLEAN: raw io.Copy in both
// directions, no line buffering and no text processing, because the frozen
// protocol is length-prefixed binary framing and a single mangled byte
// desynchronizes the stream permanently.
//
// It never spawns a daemon. EnsureDaemon is a policy decision for the caller
// that owns the session; a missing socket here is an error to report, not a
// condition to fix, so a mistyped host can never silently start a daemon
// somewhere unexpected.
func runSessiondConnect() error {
	sock, err := sessiond.SocketPath()
	if err != nil {
		return fmt.Errorf("resolve sessiond socket path: %w", err)
	}
	if _, statErr := os.Stat(sock); statErr != nil {
		return fmt.Errorf("muxterm daemon not running: no socket at %s", sock)
	}
	conn, err := net.Dial("unix", sock)
	if err != nil {
		return fmt.Errorf("muxterm daemon not reachable: dialing %s: %w", sock, err)
	}
	defer conn.Close() //nolint:errcheck

	// Upstream (stdin -> daemon) runs on its own goroutine so neither
	// direction can stall the other: the daemon pushes unsolicited events
	// with no request to pair them to, so both directions are live at once.
	go func() {
		_, _ = io.Copy(conn, os.Stdin)
		// Stdin is done, so half-close: the daemon must see a real EOF on its
		// read side to know no more requests are coming, while the reply
		// direction stays open long enough to deliver what it still owes us.
		// A full Close here would truncate those replies.
		if cw, ok := conn.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		} else {
			_ = conn.Close()
		}
	}()

	// Downstream (daemon -> stdout) is the direction worth waiting on: it ends
	// when the daemon closes the connection, which is the real end of the
	// session. A clean EOF here is success. The upstream goroutine may still be
	// parked reading stdin; process exit collects it.
	if _, err := io.Copy(os.Stdout, conn); err != nil {
		return fmt.Errorf("sessiond connection: %w", err)
	}
	return nil
}
