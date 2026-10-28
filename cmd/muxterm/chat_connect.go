package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// chat-connect is an SSH stdio bridge to this user's already running chat
// backend. It never starts, replaces, or reconfigures that backend.
func runChatConnect() error {
	base, err := sessiond.ServerURL()
	if err != nil {
		return err
	}
	token, err := sessiond.ServerToken()
	if err != nil {
		return err
	}
	target, err := url.Parse(base)
	if err != nil || target.Scheme != "http" || target.Hostname() != "localhost" {
		return fmt.Errorf("chat backend handoff must name a local HTTP server")
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = &http.Transport{Proxy: nil}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		http.Error(w, err.Error(), http.StatusBadGateway)
	}
	originalDirector := proxy.Director
	proxy.Director = func(r *http.Request) {
		originalDirector(r)
		r.Header.Del("Cookie")
		r.Header.Del("Authorization")
		r.Header.Set("X-Muxterm-Remote-Chat", "1")
		r.Header.Set("Sec-Fetch-Site", "same-origin")
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
	}
	bridge := &stdioChatConn{reader: os.Stdin, writer: os.Stdout, done: make(chan struct{})}
	listener := &singleChatListener{conn: bridge}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/sdk-") && r.URL.Path != "/api/chat-ui/navigate" {
			http.NotFound(w, r)
			return
		}
		proxy.ServeHTTP(w, r)
	})}
	err = server.Serve(listener)
	if errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}

type stdioChatConn struct {
	reader *os.File
	writer *os.File
	done   chan struct{}
	once   sync.Once
}

func (c *stdioChatConn) Read(p []byte) (int, error)  { return c.reader.Read(p) }
func (c *stdioChatConn) Write(p []byte) (int, error) { return c.writer.Write(p) }
func (c *stdioChatConn) Close() error {
	c.once.Do(func() { close(c.done); _ = c.reader.Close(); _ = c.writer.Close() })
	return nil
}
func (c *stdioChatConn) LocalAddr() net.Addr              { return chatAddr("stdio") }
func (c *stdioChatConn) RemoteAddr() net.Addr             { return chatAddr("ssh") }
func (c *stdioChatConn) SetDeadline(time.Time) error      { return nil }
func (c *stdioChatConn) SetReadDeadline(time.Time) error  { return nil }
func (c *stdioChatConn) SetWriteDeadline(time.Time) error { return nil }

type chatAddr string

func (a chatAddr) Network() string { return "stdio" }
func (a chatAddr) String() string  { return string(a) }

type singleChatListener struct {
	conn *stdioChatConn
	once sync.Once
}

func (l *singleChatListener) Accept() (net.Conn, error) {
	var conn net.Conn
	l.once.Do(func() { conn = l.conn })
	if conn != nil {
		return conn, nil
	}
	<-l.conn.done
	return nil, net.ErrClosed
}
func (l *singleChatListener) Close() error   { return l.conn.Close() }
func (l *singleChatListener) Addr() net.Addr { return chatAddr("stdio") }

var _ io.ReadWriteCloser = (*stdioChatConn)(nil)
