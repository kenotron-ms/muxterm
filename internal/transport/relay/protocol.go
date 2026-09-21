// Package relay is an experimental, single-binding HTTPS carrier for sessiond.
// It deliberately resets every connection on broker or worker restart. It does
// not provide durable terminal input replay or Azure lifecycle operations.
package relay

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	ChunkLimit   = 64 << 10
	backlogLimit = 4 << 20
	channelLimit = 256 // includes tombstones; restart the experiment when exhausted
	lease        = 30 * time.Second
)

var ErrReset = errors.New("relay connection reset; input delivery may be unknown; input was not replayed")
var errProtocol = errors.New("relay protocol rejected")

// Config files are private, role-specific, and never passed into a shell's env.
// The broker alone gets both tokens. Worker and client files get only their own.
// This first increment has one pre-authorized owner/host, not tenant auth.
type Config struct {
	URL             string `json:"url"`
	Host            string `json:"host"`
	DisplayName     string `json:"displayName,omitempty"`
	EnrollmentToken string `json:"enrollmentToken,omitempty"`
	Token           string `json:"token,omitempty"`
	ClientToken     string `json:"clientToken,omitempty"`
	WorkerToken     string `json:"workerToken,omitempty"`
}

func LoadConfig(path string) (Config, error) {
	var c Config
	f, err := os.Open(path)
	if err != nil {
		return c, errors.New("relay config unavailable")
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 {
		return c, errors.New("relay config must be a private regular file")
	}
	d := json.NewDecoder(io.LimitReader(f, 8193))
	d.DisallowUnknownFields()
	if err = d.Decode(&c); err != nil {
		return c, errors.New("invalid relay config")
	}
	if d.Decode(new(any)) != io.EOF || !strings.HasPrefix(c.Host, "sandbox:") || strings.ContainsAny(c.Host, "/ ?#") || len(c.Host) > 128 {
		return c, errors.New("invalid relay binding")
	}
	return c, nil
}
func randomID() string {
	var b [24]byte
	if _, e := rand.Read(b[:]); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b[:])
}
func validID(s string) bool { b, e := hex.DecodeString(s); return e == nil && len(b) == 24 }

type packet struct {
	Seq  uint64 `json:"seq"`
	Data []byte `json:"data"`
}
type command struct {
	ID    string  `json:"id"`
	Open  bool    `json:"open,omitempty"`
	Close bool    `json:"close,omitempty"`
	Input *packet `json:"input,omitempty"`
}
type reply struct {
	ID     string `json:"id"`
	Seq    uint64 `json:"seq"`
	Failed bool   `json:"failed,omitempty"`
}
type api struct {
	base, token, boot string
	http              *http.Client
}

func newAPI(c Config) (*api, error) {
	u, e := url.Parse(c.URL)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || len(c.Token) < 32 {
		return nil, errors.New("relay requires HTTPS origin and a scoped token")
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	tr.ResponseHeaderTimeout = 25 * time.Second
	return &api{base: strings.TrimRight(c.URL, "/"), token: c.Token, http: &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("relay redirects forbidden") }}}, nil
}
func (a *api) request(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var r io.Reader
	if body != nil {
		b, e := json.Marshal(body)
		if e != nil {
			return nil, e
		}
		r = bytes.NewReader(b)
	}
	req, e := http.NewRequestWithContext(ctx, method, a.base+path, r)
	if e != nil {
		return nil, errProtocol
	}
	req.Header.Set("Authorization", "Bearer "+a.token)
	if a.boot != "" {
		req.Header.Set("X-Worker-Boot", a.boot)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, e := a.http.Do(req)
	if e != nil {
		return nil, errors.New("relay HTTPS request interrupted")
	}
	return resp, nil
}

// post retries only the IDENTICAL operation within its existing epoch. The
// worker is the final input deduplication authority, not the HTTP response.
func (a *api) post(ctx context.Context, path string, v any, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	for {
		resp, e := a.request(ctx, "POST", path, v)
		if e == nil {
			if resp.StatusCode == 200 {
				if out != nil {
					e = json.NewDecoder(io.LimitReader(resp.Body, ChunkLimit*2)).Decode(out)
				}
				resp.Body.Close()
				return e
			}
			status := resp.StatusCode
			resp.Body.Close()
			if status < 500 {
				return ErrReset
			}
		}
		select {
		case <-ctx.Done():
			return ErrReset
		case <-time.After(100 * time.Millisecond):
		}
	}
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, ChunkLimit*2))
	d.DisallowUnknownFields()
	if d.Decode(v) != nil || d.Decode(new(any)) != io.EOF {
		http.Error(w, "invalid request", 400)
		return false
	}
	return true
}
func jsonReply(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
