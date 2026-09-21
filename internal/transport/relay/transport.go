package relay

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/kenotron-ms/muxterm/internal/transport"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Transport addresses one manually authorized binding, without provisioning.
type Transport struct {
	cfg Config
	a   *api
}

func New(c Config) (*Transport, error) {
	a, e := newAPI(c)
	if e != nil {
		return nil, e
	}
	return &Transport{c, a}, nil
}
func (t *Transport) Name() string                      { return "sandbox" }
func (t *Transport) Identity() transport.IdentityModel { return transport.IdentityNone }
func (t *Transport) Provision(context.Context, transport.HostRef) error {
	return errors.New("relay has no provisioning capability")
}
func (t *Transport) Discover(ctx context.Context) ([]transport.HostRef, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	resp, e := t.a.request(ctx, "GET", "/discover", nil)
	if e != nil {
		return nil, e
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, errors.New("relay worker unavailable")
	}
	var v struct {
		Host string `json:"host"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 1024)).Decode(&v) != nil || v.Host != t.cfg.Host {
		return nil, errProtocol
	}
	name := t.cfg.DisplayName
	if name == "" {
		name = "Sandbox"
	}
	return []transport.HostRef{{ID: v.Host, DisplayName: name}}, nil
}
func (t *Transport) Dial(ctx context.Context, h transport.HostRef) (net.Conn, error) {
	if h.ID != t.cfg.Host {
		return nil, errors.New("unknown relay machine")
	}
	id := randomID()
	if e := t.a.post(ctx, "/open", map[string]string{"id": id, "host": h.ID}, nil); e != nil {
		return nil, e
	}
	life, cancel := context.WithCancel(context.Background())
	client, pump := net.Pipe()
	c := &relayConn{Conn: client, cancel: cancel, a: t.a, id: id, pump: pump}
	go func() {
		defer c.Close()
		var seq uint64
		buf := make([]byte, ChunkLimit)
		for {
			n, e := pump.Read(buf)
			if n > 0 {
				seq++
				if t.a.post(life, "/channels/"+id+"/input", packet{seq, buf[:n]}, nil) != nil {
					return
				}
			}
			if e != nil {
				return
			}
		}
	}()
	go func() { defer c.Close(); _ = t.receive(life, id, pump) }()
	return c, nil
}

type relayConn struct {
	net.Conn
	cancel context.CancelFunc
	a      *api
	id     string
	pump   net.Conn
	once   sync.Once
}

func (c *relayConn) Read(p []byte) (int, error) {
	n, e := c.Conn.Read(p)
	if e != nil {
		return n, ErrReset
	}
	return n, e
}

// A transport acceptance is not a shell execution acknowledgement. On any
// failure the caller must inspect the remote state, never retry raw input.
func (c *relayConn) Write(p []byte) (int, error) {
	n, e := c.Conn.Write(p)
	if e != nil {
		return n, ErrReset
	}
	return n, nil
}

func (c *relayConn) Close() error {
	c.once.Do(func() {
		c.cancel()
		_ = c.Conn.Close()
		_ = c.pump.Close()
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_ = c.a.post(ctx, "/channels/"+c.id+"/close", struct{}{}, nil)
		}()
	})
	return nil
}
func (t *Transport) receive(ctx context.Context, id string, w io.Writer) error {
	var after uint64
	guard := frameGuard{w: w}
	lastSeen := time.Now()
	for {
		if time.Since(lastSeen) > lease {
			return ErrReset
		}
		requestCtx, requestCancel := context.WithTimeout(ctx, 25*time.Second)
		resp, e := t.a.request(requestCtx, "GET", "/channels/"+id+"/events?after="+strconv.FormatUint(after, 10), nil)
		if e == nil {
			if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
				resp.Body.Close()
				requestCancel()
				return ErrReset
			}
			scanner := bufio.NewScanner(resp.Body)
			scanner.Buffer(make([]byte, 4096), ChunkLimit*2)
			var eventID string
			var data []byte
			for scanner.Scan() {
				lastSeen = time.Now()
				line := scanner.Text()
				switch {
				case strings.HasPrefix(line, ":"):
					continue
				case strings.HasPrefix(line, "id: "):
					eventID = strings.TrimPrefix(line, "id: ")
				case strings.HasPrefix(line, "data: "):
					if data != nil {
						resp.Body.Close()
						requestCancel()
						return errProtocol
					}
					data = []byte(strings.TrimPrefix(line, "data: "))
				case line == "":
					if data == nil {
						continue
					}
					var p packet
					if json.Unmarshal(data, &p) != nil || eventID != strconv.FormatUint(p.Seq, 10) || p.Seq != after+1 || len(p.Data) == 0 || len(p.Data) > ChunkLimit {
						resp.Body.Close()
						requestCancel()
						return errProtocol
					}
					if conn, ok := w.(net.Conn); ok {
						_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
					}
					if guard.write(p.Data) != nil {
						resp.Body.Close()
						requestCancel()
						return ErrReset
					}
					after = p.Seq
					data = nil
					eventID = ""
					if t.a.post(ctx, "/channels/"+id+"/ack", map[string]uint64{"seq": after}, nil) != nil {
						resp.Body.Close()
						requestCancel()
						return ErrReset
					}
				default:
					resp.Body.Close()
					requestCancel()
					return errProtocol
				}
			}
			resp.Body.Close()
			requestCancel()
		}
		requestCancel()
		select {
		case <-ctx.Done():
			return ErrReset
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// Validate lengths before sessiond.ReadFrame can allocate from an untrusted
// peer. Chunk limits alone cannot protect a length-prefixed protocol.
const FrameLimit = 8 << 20

type frameGuard struct {
	w         io.Writer
	header    []byte
	remaining uint32
}

func (g *frameGuard) write(p []byte) error {
	for len(p) > 0 {
		if g.remaining == 0 {
			n := min(4-len(g.header), len(p))
			g.header = append(g.header, p[:n]...)
			p = p[n:]
			if len(g.header) < 4 {
				continue
			}
			total := binary.BigEndian.Uint32(g.header)
			if total < 1 || total > FrameLimit {
				return fmt.Errorf("relay sessiond frame exceeds bound")
			}
			if _, e := g.w.Write(g.header); e != nil {
				return e
			}
			g.header = nil
			g.remaining = total
		}
		n := min(int(g.remaining), len(p))
		if n > 0 {
			if _, e := g.w.Write(p[:n]); e != nil {
				return e
			}
			p = p[n:]
			g.remaining -= uint32(n)
		}
	}
	return nil
}
