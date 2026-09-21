package relay

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type channel struct {
	id                     string
	ready, closed, retired bool
	pending                *packet
	inputSeq               uint64
	inputHash              [32]byte
	outputSeq, outputAck   uint64
	outputHash             [32]byte
	output                 []packet
	outputBytes            int
	touched                time.Time
}

// Broker is a bounded reference single-owner relay. Its state is intentionally
// volatile. Losing it terminates epochs instead of reconstructing shell input.
type Broker struct {
	mu       sync.Mutex
	cfg      Config
	boot     string
	beat     time.Time
	channels map[string]*channel
	changed  chan struct{}
}

func NewBroker(c Config) (*Broker, error) {
	if len(c.ClientToken) < 32 || len(c.WorkerToken) < 32 || c.ClientToken == c.WorkerToken {
		return nil, fmt.Errorf("distinct scoped broker tokens required")
	}
	return &Broker{cfg: c, channels: make(map[string]*channel), changed: make(chan struct{})}, nil
}
func (b *Broker) notify() { close(b.changed); b.changed = make(chan struct{}) }
func (b *Broker) expire() {
	now := time.Now()
	for _, c := range b.channels {
		if !c.closed && (now.Sub(b.beat) > lease || now.Sub(c.touched) > lease) {
			c.closed = true
			c.pending = nil
			c.output = nil
			c.outputBytes = 0
			b.notify()
		}
	}
}
func (b *Broker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(20 * time.Second))
	role := "client"
	want := b.cfg.ClientToken
	if strings.HasPrefix(r.URL.Path, "/worker/") {
		role = "worker"
		want = b.cfg.WorkerToken
	}
	if r.Header.Get("Origin") != "" || r.Header.Get("Cookie") != "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+want)) != 1 {
		http.Error(w, "unauthorized", 401)
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.expire()
	if role == "worker" {
		if r.URL.Path == "/worker/register" && r.Method == "POST" {
			var v struct {
				Boot string `json:"boot"`
			}
			if !decode(w, r, &v) {
				return
			}
			if !validID(v.Boot) {
				http.Error(w, "invalid boot", 400)
				return
			}
			// A register is never retried automatically: an ambiguous result requires
			// a new process incarnation. No old process may reclaim a replaced boot.
			for _, c := range b.channels {
				c.closed = true
				c.pending = nil
				c.output = nil
				c.outputBytes = 0
			}
			b.boot = v.Boot
			b.beat = time.Now()
			b.notify()
			jsonReply(w, map[string]string{"boot": b.boot})
			return
		}
		if b.boot == "" || r.Header.Get("X-Worker-Boot") != b.boot {
			http.Error(w, "worker fenced", 410)
			return
		}
		b.beat = time.Now()
		switch {
		case r.URL.Path == "/worker/poll" && r.Method == "GET":
			b.poll(w, r)
		case r.URL.Path == "/worker/reply" && r.Method == "POST":
			var v reply
			if !decode(w, r, &v) {
				return
			}
			c := b.channels[v.ID]
			if c == nil {
				http.Error(w, "closed", 410)
				return
			}
			if c.closed {
				c.retired = true
				jsonReply(w, struct{}{})
				return
			}
			if v.Failed {
				c.closed = true
				c.pending = nil
				c.output = nil
				c.outputBytes = 0
			} else if v.Seq == 0 {
				c.ready = true
			} else if c.pending != nil && c.pending.Seq == v.Seq {
				c.inputSeq = v.Seq
				c.inputHash = sha256.Sum256(c.pending.Data)
				c.pending = nil
			} else if v.Seq != c.inputSeq {
				http.Error(w, "sequence", 409)
				return
			}
			b.notify()
			jsonReply(w, struct{}{})
		case strings.HasPrefix(r.URL.Path, "/worker/output/") && r.Method == "POST":
			c := b.channels[strings.TrimPrefix(r.URL.Path, "/worker/output/")]
			if c == nil || c.closed {
				http.Error(w, "closed", 410)
				return
			}
			var p packet
			if !decode(w, r, &p) {
				return
			}
			h := sha256.Sum256(p.Data)
			if len(p.Data) == 0 || len(p.Data) > ChunkLimit || p.Seq == 0 {
				http.Error(w, "packet", 400)
				return
			}
			if p.Seq == c.outputSeq && h == c.outputHash {
				jsonReply(w, struct{}{})
				return
			}
			if p.Seq != c.outputSeq+1 || c.outputBytes+len(p.Data) > backlogLimit {
				c.closed = true
				c.pending = nil
				c.output = nil
				c.outputBytes = 0
				b.notify()
				http.Error(w, "reset", 410)
				return
			}
			c.output = append(c.output, p)
			c.outputBytes += len(p.Data)
			c.outputSeq = p.Seq
			c.outputHash = h
			b.notify()
			jsonReply(w, struct{}{})
		default:
			http.NotFound(w, r)
		}
		return
	}
	if r.URL.Path == "/discover" && r.Method == "GET" {
		if b.boot == "" || time.Since(b.beat) > lease {
			http.Error(w, "worker unavailable", 503)
			return
		}
		jsonReply(w, map[string]string{"host": b.cfg.Host})
		return
	}
	if r.URL.Path == "/open" && r.Method == "POST" {
		var v struct {
			ID   string `json:"id"`
			Host string `json:"host"`
		}
		if !decode(w, r, &v) {
			return
		}
		if v.Host != b.cfg.Host || !validID(v.ID) {
			http.Error(w, "binding", 403)
			return
		}
		if b.boot == "" || time.Since(b.beat) > lease {
			http.Error(w, "worker unavailable", 503)
			return
		}
		c := b.channels[v.ID]
		if c == nil {
			active := 0
			for _, v := range b.channels {
				if !v.closed {
					active++
				}
			}
			if len(b.channels) >= channelLimit || active >= 16 {
				http.Error(w, "capacity", 429)
				return
			}
			c = &channel{id: v.ID, touched: time.Now()}
			b.channels[v.ID] = c
			b.notify()
		}
		b.wait(w, r, c, func() bool { return c.ready })
		return
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) != 3 || parts[0] != "channels" {
		http.NotFound(w, r)
		return
	}
	c := b.channels[parts[1]]
	if c == nil || c.closed {
		http.Error(w, "connection fenced", 410)
		return
	}
	c.touched = time.Now()
	switch {
	case parts[2] == "input" && r.Method == "POST":
		var p packet
		if !decode(w, r, &p) {
			return
		}
		if !c.ready || p.Seq == 0 || len(p.Data) == 0 || len(p.Data) > ChunkLimit {
			http.Error(w, "packet", 400)
			return
		}
		h := sha256.Sum256(p.Data)
		if p.Seq == c.inputSeq && h == c.inputHash {
			jsonReply(w, struct{}{})
			return
		}
		if p.Seq != c.inputSeq+1 || (c.pending != nil && (c.pending.Seq != p.Seq || !bytes.Equal(c.pending.Data, p.Data))) {
			http.Error(w, "sequence conflict", 409)
			return
		}
		if c.pending == nil {
			c.pending = &p
			b.notify()
		}
		b.wait(w, r, c, func() bool { return c.inputSeq == p.Seq })
	case parts[2] == "events" && r.Method == "GET":
		b.events(w, r, c)
	case parts[2] == "ack" && r.Method == "POST":
		var v struct {
			Seq uint64 `json:"seq"`
		}
		if !decode(w, r, &v) {
			return
		}
		if v.Seq > c.outputSeq {
			http.Error(w, "cursor", 409)
			return
		}
		if v.Seq > c.outputAck {
			c.outputAck = v.Seq
			for len(c.output) > 0 && c.output[0].Seq <= v.Seq {
				c.outputBytes -= len(c.output[0].Data)
				c.output[0] = packet{}
				c.output = c.output[1:]
			}
		}
		jsonReply(w, struct{}{})
	case parts[2] == "close" && r.Method == "POST":
		c.closed = true
		c.pending = nil
		c.output = nil
		c.outputBytes = 0
		b.notify()
		jsonReply(w, struct{}{})
	default:
		http.NotFound(w, r)
	}
}

// wait unlocks while parked. HTTP retries never create a second worker write.
func (b *Broker) wait(w http.ResponseWriter, r *http.Request, c *channel, done func() bool) {
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	for !done() && !c.closed {
		wake := b.changed
		b.mu.Unlock()
		select {
		case <-r.Context().Done():
			b.mu.Lock()
			return
		case <-deadline.C:
			b.mu.Lock()
			http.Error(w, "pending", 503)
			return
		case <-wake:
			b.mu.Lock()
		}
	}
	if c.closed {
		http.Error(w, "connection fenced", 410)
		return
	}
	jsonReply(w, struct{}{})
}
func (b *Broker) poll(w http.ResponseWriter, r *http.Request) {
	boot := b.boot
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	for {
		if b.boot != boot {
			http.Error(w, "worker fenced", 410)
			return
		}
		cmds := []command{}
		for id, c := range b.channels {
			if c.closed {
				if !c.retired {
					cmds = append(cmds, command{ID: id, Close: true})
				}
				continue
			}
			if !c.ready {
				cmds = append(cmds, command{ID: id, Open: true})
			} else if c.pending != nil {
				cmds = append(cmds, command{ID: id, Input: c.pending})
			}
		}
		if len(cmds) > 0 {
			jsonReply(w, cmds)
			return
		}
		wake := b.changed
		b.mu.Unlock()
		select {
		case <-r.Context().Done():
			b.mu.Lock()
			return
		case <-deadline.C:
			b.mu.Lock()
			jsonReply(w, cmds)
			return
		case <-wake:
			b.mu.Lock()
		}
	}
}
func (b *Broker) events(w http.ResponseWriter, r *http.Request, c *channel) {
	after, e := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
	if e != nil || after < c.outputAck || after > c.outputSeq {
		http.Error(w, "cursor expired", 410)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	rc := http.NewResponseController(w)
	for {
		if c.closed {
			return
		}
		c.touched = time.Now()
		b.expire()
		if c.closed {
			return
		}
		var p *packet
		for _, v := range c.output {
			if v.Seq > after {
				x := v
				p = &x
				break
			}
		}
		wake := b.changed
		b.mu.Unlock()
		_ = rc.SetWriteDeadline(time.Now().Add(10 * time.Second))
		var err error
		if p != nil {
			data, _ := json.Marshal(p)
			_, err = fmt.Fprintf(w, "id: %d\ndata: %s\n\n", p.Seq, data)
			after = p.Seq
		} else {
			_, err = fmt.Fprint(w, ": heartbeat\n\n")
		}
		if err == nil {
			err = rc.Flush()
		}
		b.mu.Lock()
		if err != nil {
			return
		}
		if p != nil {
			continue
		}
		b.mu.Unlock()
		select {
		case <-r.Context().Done():
			b.mu.Lock()
			return
		case <-time.After(10 * time.Second):
		case <-wake:
		}
		b.mu.Lock()
	}
}

// RunSweeper bounds idle channels even if nobody makes another request.
func (b *Broker) RunSweeper(ctx context.Context) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			b.mu.Lock()
			b.expire()
			b.mu.Unlock()
		}
	}
}
