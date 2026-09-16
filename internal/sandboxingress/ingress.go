// Package sandboxingress implements the fixed port-8443 runtime adapter for a
// muxterm sessiond image. It owns no Azure lifecycle capability: a validated
// runtime environment supplies only profile checksum, generation, and a public
// Ed25519 verification key.
package sandboxingress

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/kenotron-ms/muxterm/internal/sandboxazure"
)

const (
	PathSessiond        = "/v1/sessiond"
	PathHealthz         = "/healthz"
	SessiondSubprotocol = "muxterm-sessiond-v1"
	maxFrameBytes       = 64 << 10
	handshakeTTL        = 10 * time.Second
	frameTimeout        = 30 * time.Second
	unixDialTimeout     = 3 * time.Second
)

var (
	ErrHandshake = errors.New("sandbox ingress: handshake rejected")
	ErrProtocol  = errors.New("sandbox ingress: protocol rejected")
)

// Config is injected only by the sealed image runtime environment. No HTTP
// request data or browser value can alter it.
type Config struct {
	Protocol        int
	ProfileChecksum string
	Generation      uint64
	VerifyKey       ed25519.PublicKey
	UnixSocket      string
}

func (c Config) Validate() error {
	if c.Protocol != sandboxazure.RuntimeProtocol || c.Generation == 0 ||
		len(c.VerifyKey) != ed25519.PublicKeySize || strings.TrimSpace(c.UnixSocket) == "" {
		return ErrProtocol
	}
	checksum, err := hex.DecodeString(c.ProfileChecksum)
	if err != nil || len(checksum) != sha256.Size {
		return ErrProtocol
	}
	return nil
}

// Server admits one proof-bound WSS stream at a time and passes only bounded
// binary frames to the already-private same-UID sessiond socket.
type Server struct {
	cfg    Config
	active atomic.Bool
	stats  stats
}

type stats struct{ accepted, rejected, dials atomic.Uint64 }
type Stats struct{ AcceptedConnections, RejectedProofs, UnixDials uint64 }

func New(cfg Config) (*Server, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &Server{cfg: cfg}, nil
}
func (s *Server) Stats() Stats {
	return Stats{s.stats.accepted.Load(), s.stats.rejected.Load(), s.stats.dials.Load()}
}

// ServeHTTP accepts only a cookie-free, bearer-free, origin-free upgrade at the
// one fixed adapter path. Authentication is application proof, not public URL
// bearer material.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || r.URL.Path != PathSessiond ||
		r.URL.RawQuery != "" ||
		r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("Origin") != "" {
		http.Error(w, "sandbox ingress unavailable", http.StatusForbidden)
		return
	}
	if !s.active.CompareAndSwap(false, true) {
		http.Error(w, "sandbox ingress unavailable", http.StatusTooManyRequests)
		return
	}
	defer s.active.Store(false)
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled, Subprotocols: []string{SessiondSubprotocol}})
	if err != nil {
		return
	}
	defer ws.Close(websocket.StatusNormalClosure, "closed") //nolint:errcheck
	if ws.Subprotocol() != SessiondSubprotocol {
		_ = ws.Close(websocket.StatusPolicyViolation, "protocol rejected")
		return
	}
	ws.SetReadLimit(maxFrameBytes)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	if err := s.authenticate(ctx, ws); err != nil {
		s.stats.rejected.Add(1)
		_ = ws.Close(websocket.StatusPolicyViolation, "authentication failed")
		return
	}
	unixConn, err := (&net.Dialer{Timeout: unixDialTimeout}).DialContext(ctx, "unix", s.cfg.UnixSocket)
	if err != nil {
		_ = ws.Close(websocket.StatusTryAgainLater, "sessiond unavailable")
		return
	}
	defer unixConn.Close() //nolint:errcheck
	s.stats.accepted.Add(1)
	s.stats.dials.Add(1)
	errCh := make(chan error, 2)
	go func() { errCh <- copyWebSocketToUnix(ctx, ws, unixConn) }()
	go func() { errCh <- copyUnixToWebSocket(ctx, unixConn, ws) }()
	<-errCh
}

// RuntimeHandler is the image's entire public HTTP surface. It is constructed
// only after the entrypoint has started sessiond, confirmed its private socket,
// and constructed the ingress adapter. Health is therefore never affirmative
// before the binary stream's local prerequisite is ready.
//
// GET /healthz returns an intentionally content-free 204 only while ready
// reports the private sessiond socket live. Query-bearing,
// non-GET, and all other non-sessiond paths are rejected without reflecting
// runtime configuration. The sessiond adapter continues to own its strict WSS
// request checks.
func RuntimeHandler(adapter http.Handler, ready func() bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == PathHealthz && r.Method == http.MethodGet && r.URL.RawQuery == "":
			w.Header().Set("Cache-Control", "no-store")
			if ready == nil || !ready() {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		case r.URL.Path == PathSessiond:
			adapter.ServeHTTP(w, r)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
}

func (s *Server) authenticate(ctx context.Context, ws *websocket.Conn) error {
	challenge, err := newChallenge(s.cfg)
	if err != nil {
		return err
	}
	deadline, cancel := context.WithTimeout(ctx, handshakeTTL)
	defer cancel()
	if err := ws.Write(deadline, websocket.MessageBinary, challenge.encode()); err != nil {
		return ErrHandshake
	}
	kind, data, err := ws.Read(deadline)
	if err != nil || kind != websocket.MessageBinary {
		return ErrHandshake
	}
	proof, err := decodeProof(data)
	if err != nil || proof.Generation != challenge.Generation || proof.ExpiresUnix != challenge.ExpiresUnix ||
		time.Now().Unix() > challenge.ExpiresUnix || !ed25519.Verify(s.cfg.VerifyKey, challenge.signingPayload(), proof.Signature[:]) {
		return ErrHandshake
	}
	return nil
}

func copyWebSocketToUnix(ctx context.Context, ws *websocket.Conn, conn net.Conn) error {
	for {
		kind, data, err := ws.Read(ctx)
		if err != nil {
			return err
		}
		if kind != websocket.MessageBinary || len(data) > maxFrameBytes {
			return ErrProtocol
		}
		if err := conn.SetWriteDeadline(time.Now().Add(frameTimeout)); err != nil {
			return err
		}
		if err := writeFull(conn, data); err != nil {
			return err
		}
	}
}
func copyUnixToWebSocket(ctx context.Context, conn net.Conn, ws *websocket.Conn) error {
	buf := make([]byte, maxFrameBytes)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			writeCtx, cancel := context.WithTimeout(ctx, frameTimeout)
			writeErr := ws.Write(writeCtx, websocket.MessageBinary, buf[:n])
			cancel()
			if writeErr != nil {
				return writeErr
			}
		}
		if err != nil {
			return err
		}
	}
}
func writeFull(w io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := w.Write(data)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}

type challenge struct {
	Protocol    byte
	Generation  uint64
	ExpiresUnix int64
	ProfileHash [sha256.Size]byte
	Nonce       [32]byte
}
type proof struct {
	Generation  uint64
	ExpiresUnix int64
	Signature   [ed25519.SignatureSize]byte
}

func newChallenge(cfg Config) (challenge, error) {
	var c challenge
	checksum, err := hex.DecodeString(cfg.ProfileChecksum)
	if err != nil || len(checksum) != sha256.Size {
		return c, ErrProtocol
	}
	if _, err := rand.Read(c.Nonce[:]); err != nil {
		return c, err
	}
	c.Protocol, c.Generation, c.ExpiresUnix = byte(cfg.Protocol), cfg.Generation, time.Now().Add(handshakeTTL).Unix()
	copy(c.ProfileHash[:], checksum)
	return c, nil
}
func (c challenge) encode() []byte {
	data := make([]byte, 85)
	copy(data[:4], "MXSC")
	data[4] = c.Protocol
	binary.BigEndian.PutUint64(data[5:13], c.Generation)
	binary.BigEndian.PutUint64(data[13:21], uint64(c.ExpiresUnix))
	copy(data[21:53], c.ProfileHash[:])
	copy(data[53:], c.Nonce[:])
	return data
}
func (c challenge) signingPayload() []byte {
	return append([]byte("muxterm-sandbox-ingress-proof-v1\x00"), c.encode()...)
}
func decodeProof(data []byte) (proof, error) {
	var p proof
	if len(data) != 84 || string(data[:4]) != "MXSP" {
		return p, ErrProtocol
	}
	p.Generation = binary.BigEndian.Uint64(data[4:12])
	p.ExpiresUnix = int64(binary.BigEndian.Uint64(data[12:20]))
	copy(p.Signature[:], data[20:])
	return p, nil
}

// NewProofForFixture makes the closed proof wire representation available to
// the deterministic offline verifier without exposing any server secret.
func NewProofForFixture(challengeBytes []byte, signer ed25519.PrivateKey) ([]byte, error) {
	if len(challengeBytes) != 85 || string(challengeBytes[:4]) != "MXSC" || len(signer) != ed25519.PrivateKeySize {
		return nil, ErrProtocol
	}
	generation, expiry := binary.BigEndian.Uint64(challengeBytes[5:13]), binary.BigEndian.Uint64(challengeBytes[13:21])
	payload := append([]byte("muxterm-sandbox-ingress-proof-v1\x00"), challengeBytes...)
	sig := ed25519.Sign(signer, payload)
	data := make([]byte, 84)
	copy(data[:4], "MXSP")
	binary.BigEndian.PutUint64(data[4:12], generation)
	binary.BigEndian.PutUint64(data[12:20], expiry)
	copy(data[20:], sig)
	return data, nil
}

// ParseRuntimeConfig validates the non-secret environment contract used by the
// fixed image entrypoint. It is deliberately separate from Azure configuration.
func ParseRuntimeConfig(protocol, checksum, generation, publicKey, socket string) (Config, error) {
	g, err := strconv.ParseUint(generation, 10, 64)
	if err != nil {
		return Config{}, ErrProtocol
	}
	key, err := base64.RawStdEncoding.DecodeString(publicKey)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return Config{}, ErrProtocol
	}
	cfg := Config{Protocol: sandboxazure.RuntimeProtocol, ProfileChecksum: checksum, Generation: g, VerifyKey: ed25519.PublicKey(key), UnixSocket: socket}
	if protocol != "1" || cfg.Validate() != nil {
		return Config{}, ErrProtocol
	}
	return cfg, nil
}

var _ http.Handler = (*Server)(nil)
