package relay

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync"
	"time"
)

type workerChannel struct {
	socket net.Conn
	last   uint64
	hash   [32]byte
	dead   bool
}

// RunWorker only connects outward. Each invocation registers a fresh boot and
// never restores input or sockets. Duplicate open cannot resurrect a channel.
func RunWorker(ctx context.Context, c Config, socket string) error {
	if c.EnrollmentToken != "" {
		c.Token = c.EnrollmentToken
	}
	a, err := newAPI(c)
	if err != nil {
		return err
	}
	if c.EnrollmentToken != "" {
		enrollCtx, done := context.WithTimeout(ctx, 10*time.Second)
		resp, e := a.request(enrollCtx, "POST", "/worker/enroll", map[string]string{"token": c.EnrollmentToken})
		if e != nil {
			done()
			return ErrReset
		}
		var credential struct {
			Token string `json:"token"`
		}
		e = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&credential)
		resp.Body.Close()
		done()
		if resp.StatusCode != 200 || e != nil || len(credential.Token) < 32 {
			return ErrReset
		}
		a.token = credential.Token
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	boot := randomID()
	regctx, regcancel := context.WithTimeout(ctx, 10*time.Second)
	resp, err := a.request(regctx, "POST", "/worker/register", map[string]string{"boot": boot})
	if err != nil {
		regcancel()
		return ErrReset
	}
	resp.Body.Close()
	regcancel()
	if resp.StatusCode != 200 {
		return ErrReset
	}
	a.boot = boot
	channels := map[string]*workerChannel{}
	var mu sync.Mutex
	defer func() {
		mu.Lock()
		defer mu.Unlock()
		for _, ch := range channels {
			_ = ch.socket.Close()
		}
	}()
	fail := func(id string, ch *workerChannel) {
		mu.Lock()
		ch.dead = true
		_ = ch.socket.Close()
		mu.Unlock()
		_ = a.post(ctx, "/worker/reply", reply{ID: id, Failed: true}, nil)
	}
	for {
		pollctx, pollcancel := context.WithTimeout(ctx, 20*time.Second)
		resp, err = a.request(pollctx, "GET", "/worker/poll", nil)
		if err != nil {
			pollcancel()
			return ErrReset
		}
		if resp.StatusCode != 200 {
			resp.Body.Close()
			pollcancel()
			return ErrReset
		}
		var commands []command
		err = json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&commands)
		resp.Body.Close()
		pollcancel()
		if err != nil || len(commands) > channelLimit {
			return errProtocol
		}
		for _, cmd := range commands {
			if !validID(cmd.ID) {
				return errProtocol
			}
			mu.Lock()
			ch := channels[cmd.ID]
			mu.Unlock()
			if cmd.Close {
				if ch != nil {
					mu.Lock()
					ch.dead = true
					_ = ch.socket.Close()
					mu.Unlock()
				}
				if a.post(ctx, "/worker/reply", reply{ID: cmd.ID, Failed: true}, nil) != nil {
					return ErrReset
				}
				continue
			}
			if cmd.Open {
				if ch == nil {
					if len(channels) >= channelLimit {
						return errProtocol
					}
					conn, e := net.DialTimeout("unix", socket, 3*time.Second)
					if e != nil {
						return errors.New("worker private sessiond unavailable")
					}
					ch = &workerChannel{socket: conn}
					mu.Lock()
					channels[cmd.ID] = ch
					mu.Unlock()
					go func(id string, ch *workerChannel) {
						var seq uint64
						buf := make([]byte, ChunkLimit)
						for {
							n, e := ch.socket.Read(buf)
							if n > 0 {
								seq++
								if a.post(ctx, "/worker/output/"+id, packet{seq, buf[:n]}, nil) != nil {
									fail(id, ch)
									return
								}
							}
							if e != nil {
								fail(id, ch)
								return
							}
						}
					}(cmd.ID, ch)
				}
				mu.Lock()
				dead := ch.dead
				mu.Unlock()
				if a.post(ctx, "/worker/reply", reply{ID: cmd.ID, Failed: dead}, nil) != nil {
					return ErrReset
				}
				continue
			}
			// Single writer: sequence/content check, Unix write, then cursor commit.
			mu.Lock()
			p := cmd.Input
			if ch == nil || ch.dead {
				mu.Unlock()
				if a.post(ctx, "/worker/reply", reply{ID: cmd.ID, Failed: true}, nil) != nil {
					return ErrReset
				}
				continue
			}
			if p == nil || p.Seq == 0 || len(p.Data) == 0 || len(p.Data) > ChunkLimit {
				mu.Unlock()
				return errProtocol
			}
			h := sha256.Sum256(p.Data)
			if p.Seq == ch.last && h == ch.hash {
				mu.Unlock()
				if a.post(ctx, "/worker/reply", reply{ID: cmd.ID, Seq: p.Seq}, nil) != nil {
					return ErrReset
				}
				continue
			}
			if p.Seq != ch.last+1 {
				mu.Unlock()
				fail(cmd.ID, ch)
				continue
			}
			_ = ch.socket.SetWriteDeadline(time.Now().Add(5 * time.Second))
			n, e := ch.socket.Write(p.Data)
			if e != nil || n != len(p.Data) {
				mu.Unlock()
				fail(cmd.ID, ch)
				continue
			}
			ch.last = p.Seq
			ch.hash = h
			mu.Unlock()
			// A crash here fences this boot on restart. It cannot replay this batch
			// into a new Unix socket. A lost HTTP response only retries this ACK.
			if a.post(ctx, "/worker/reply", reply{ID: cmd.ID, Seq: p.Seq}, nil) != nil {
				return ErrReset
			}
		}
	}
}
