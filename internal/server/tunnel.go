package server

import (
	"fmt"
	"math/rand/v2"
	"sync"
)

const tunnelIDAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
const tunnelIDLen = 5

// tunnelInfoServer is the unexported struct returned by TunnelRegistry.List.
type tunnelInfoServer struct {
	id   string
	port int
}

// TunnelRegistry tracks active tunnels by ID→port. It is safe for concurrent
// use. Tunnel IDs are 5-char random strings drawn from [a-z0-9].
type TunnelRegistry struct {
	mu      sync.RWMutex
	tunnels map[string]int
}

// NewTunnelRegistry returns an empty, ready-to-use TunnelRegistry.
func NewTunnelRegistry() *TunnelRegistry {
	return &TunnelRegistry{
		tunnels: make(map[string]int),
	}
}

// Create registers port under a freshly-generated 5-char random ID.
// It retries up to 20 times to avoid collisions. Returns (id, nil) on
// success or an error if no unique ID could be generated.
func (r *TunnelRegistry) Create(port int) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for range 20 {
		id := tunnelGenID()
		if _, exists := r.tunnels[id]; !exists {
			r.tunnels[id] = port
			return id, nil
		}
	}
	return "", fmt.Errorf("tunnel: could not generate unique ID after 20 attempts")
}

// Close removes the tunnel with the given ID. Returns false if the ID is not
// registered.
func (r *TunnelRegistry) Close(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, ok := r.tunnels[id]; !ok {
		return false
	}
	delete(r.tunnels, id)
	return true
}

// Port returns the port registered for id, and whether id exists.
func (r *TunnelRegistry) Port(id string) (int, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	port, ok := r.tunnels[id]
	return port, ok
}

// List returns all registered tunnels as a slice of unexported tunnelInfoServer
// values. Order is undefined.
func (r *TunnelRegistry) List() []tunnelInfoServer {
	r.mu.RLock()
	defer r.mu.RUnlock()

	out := make([]tunnelInfoServer, 0, len(r.tunnels))
	for id, port := range r.tunnels {
		out = append(out, tunnelInfoServer{id: id, port: port})
	}
	return out
}

// tunnelGenID builds a random 5-character string from tunnelIDAlphabet.
func tunnelGenID() string {
	b := make([]byte, tunnelIDLen)
	for i := range b {
		b[i] = tunnelIDAlphabet[rand.IntN(len(tunnelIDAlphabet))]
	}
	return string(b)
}
