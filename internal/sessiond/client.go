package sessiond

import (
	"net"
	"sync"
	"sync/atomic"
)

// Client is the serve-side handle to a single sessiond Unix-socket connection.
//
// One Client wraps exactly one Unix-socket connection. The serve layer creates
// one Client per browser WebSocket. A Client is connection-scoped: after Attach,
// create-pane/resize/input target the attached workspace and carry no
// workspaceId.
type Client struct {
	conn net.Conn

	writeMu sync.Mutex // serializes frame writes onto conn

	nextCID atomic.Uint64 // monotonic correlation-id source

	pendMu sync.Mutex
	pend   map[uint64]*pending // in-flight requests keyed by CID

	hmu      sync.Mutex
	handlers Handlers // unsolicited-event handlers

	closeOnce sync.Once
}

// pending tracks a single in-flight request awaiting its reply.
type pending struct {
	ch chan *Message
}

// Handlers holds callbacks for unsolicited events (Messages with CID == 0)
// pushed by the daemon. It is guarded by Client.hmu. Fields are added by later
// tasks as event types are wired up.
type Handlers struct{}

// Dial opens a Unix-socket connection to the sessiond daemon at socketPath and
// returns a connection-scoped Client.
func Dial(socketPath string) (*Client, error) {
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		return nil, err
	}
	return &Client{
		conn: conn,
		pend: make(map[uint64]*pending),
	}, nil
}

// Close closes the underlying connection. It is idempotent: repeated calls are
// safe and only the first closes the connection.
func (c *Client) Close() error {
	var err error
	c.closeOnce.Do(func() {
		err = c.conn.Close()
	})
	return err
}
