package mcp

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
	"github.com/kenotron-ms/muxterm/internal/transport"
)

// LocalMachine is the reserved name for the daemon on this machine, and the
// value every row carries when no remote is involved.
//
// It is a real, addressable name rather than only "the absence of a machine
// argument" because a caller that has just read machine:"ssh:boxb" off a row
// needs something to write back when it means "the other one". Round-tripping
// a row's own machine field must always work.
const LocalMachine = "local"

// Timeouts. Every one of these bounds a call that crosses a machine boundary,
// because the failure this file exists to prevent is not an error -- it is a
// tool call that never returns.
const (
	// machineDialTimeout bounds establishing the byte stream to a remote
	// daemon. It is generous because an ssh dial may involve a ProxyJump, a
	// hardware key touch, or a cold TCP handshake to a sleeping host.
	machineDialTimeout = 20 * time.Second

	// machineDiscoverTimeout bounds enumerating candidate hosts. Discovery
	// reads the ssh config off local disk, so this only ever fires on a
	// pathological Include graph.
	machineDiscoverTimeout = 10 * time.Second

	// machineProbeTimeout bounds ONE reachability probe in list_machines.
	// Shorter than machineDialTimeout on purpose: list_machines answers
	// "which of these can I reach right now", and a host that needs twelve
	// seconds to answer is a host the caller should be told about rather
	// than waited on.
	machineProbeTimeout = 8 * time.Second

	// machineProbeConcurrency caps simultaneous probes so a forty-host ssh
	// config does not fork forty ssh processes at once.
	machineProbeConcurrency = 8
)

// MachineTransport is the slice of transport.Transport that internal/mcp
// needs: acquire a stream, and enumerate candidates.
//
// internal/mcp deliberately does NOT import internal/transport/ssh, for the
// same reason internal/server does not (see internal/server/remotes.go:42):
// the choice of transport belongs to the binary that assembles the process,
// not to a package that merely uses one. cmd/muxterm injects the concrete
// implementation. A nil transport is valid and makes every remote operation
// fail with one clear message instead of panicking.
type MachineTransport interface {
	// Name is the transport's stable registry key and the qualifier in
	// HostRef.ID (e.g. "ssh" for ids of the form "ssh:boxb").
	Name() string
	// Dial returns a bidirectional, binary-clean byte stream to the sessiond
	// socket on host. ctx governs establishing the connection only.
	Dial(ctx context.Context, host transport.HostRef) (net.Conn, error)
	// Discover enumerates candidate hosts. An empty slice with a nil error is
	// valid and means "nothing to report".
	Discover(ctx context.Context) ([]transport.HostRef, error)
}

// errNoTransport is returned for every remote operation when the process was
// assembled without a transport. It names the situation rather than the
// symptom, because "connect to sessiond: no such file" would send a reader
// hunting for a daemon problem that does not exist.
var errNoTransport = errors.New("this muxterm build has no remote transport wired in, so no machine other than " + LocalMachine + " can be reached")

// machines resolves machine names to hosts and holds one live daemon
// connection per machine.
//
// One connection per MACHINE, keyed on transport.HostRef.ID and never on a
// display name: an ssh alias is stable but a sandbox label is user-editable,
// and a cache keyed on a mutable label silently serves the wrong machine the
// moment someone renames one. That is the exact class of bug HostRef's ID /
// DisplayName split exists to prevent (internal/transport/transport.go:28).
type machines struct {
	tr MachineTransport

	mu    sync.Mutex
	conns map[string]*Client // key = transport.HostRef.ID

	// hosts caches the last successful discovery so that resolving a machine
	// name on every tool call does not re-read the ssh config every time.
	// Refreshed on a miss, so a host added to the config mid-session is found
	// on the first call that names it.
	hostsMu sync.Mutex
	hosts   []transport.HostRef
}

// newMachines returns a registry over tr. tr may be nil.
func newMachines(tr MachineTransport) *machines {
	return &machines{tr: tr, conns: make(map[string]*Client)}
}

// isLocal reports whether name addresses the daemon on this machine. The empty
// string is local because that is what every existing caller passes: a tool
// invoked without a machine argument must keep meaning exactly what it meant
// before this file existed.
func isLocal(name string) bool {
	n := strings.TrimSpace(name)
	return n == "" || strings.EqualFold(n, LocalMachine)
}

// resolve turns a caller-supplied machine name into a HostRef.
//
// It accepts either the durable id ("ssh:boxb") or the display name ("boxb"),
// because a human types the second and a row's machine field carries the
// first, and both must work. Whichever arrives, what comes back is the
// HostRef, and everything downstream keys on its ID.
//
// It NEVER falls back to the local machine. A name that does not resolve is an
// error naming the machine and listing what is known, because the alternative
// -- quietly acting on the local daemon when the caller asked for another one
// -- is the worst outcome this feature can produce.
func (m *machines) resolve(name string) (transport.HostRef, error) {
	name = strings.TrimSpace(name)
	if m.tr == nil {
		return transport.HostRef{}, fmt.Errorf("machine %q: %w", name, errNoTransport)
	}

	if h, ok := m.matchIn(m.cachedHosts(), name); ok {
		return h, nil
	}

	// Miss: re-read discovery once before giving up, so a host added to the
	// ssh config after this process started is still reachable.
	fresh, err := m.discover()
	if err != nil {
		return transport.HostRef{}, fmt.Errorf("machine %q: enumerating known machines failed: %w", name, err)
	}
	if h, ok := m.matchIn(fresh, name); ok {
		return h, nil
	}
	return transport.HostRef{}, unknownMachineErr(name, fresh)
}

// matchIn finds name among hosts. Exact ID match wins over display-name match,
// so an id is never shadowed by someone else's label. An ambiguous display
// name is an error rather than a coin flip.
func (m *machines) matchIn(hosts []transport.HostRef, name string) (transport.HostRef, bool) {
	for _, h := range hosts {
		if h.ID == name {
			return h, true
		}
	}
	var hit transport.HostRef
	found := 0
	for _, h := range hosts {
		if h.DisplayName == name {
			hit = h
			found++
		}
	}
	if found == 1 {
		return hit, true
	}
	return transport.HostRef{}, false
}

// unknownMachineErr reports a name that resolved to nothing, and says what
// WOULD have resolved. A bare "unknown machine" leaves the caller with no next
// move; the list is the next move.
func unknownMachineErr(name string, hosts []transport.HostRef) error {
	if len(hosts) == 0 {
		return fmt.Errorf("unknown machine %q: no remote machines are configured (nothing in ~/.ssh/config to reach); use list_machines to check", name)
	}
	ids := make([]string, 0, len(hosts))
	for _, h := range hosts {
		ids = append(ids, h.ID)
	}
	sort.Strings(ids)
	return fmt.Errorf("unknown machine %q: known machines are %s, %s; use list_machines to check reachability",
		name, LocalMachine, strings.Join(ids, ", "))
}

// discover enumerates candidates and refreshes the cache.
func (m *machines) discover() ([]transport.HostRef, error) {
	if m.tr == nil {
		return nil, errNoTransport
	}
	ctx, cancel := context.WithTimeout(context.Background(), machineDiscoverTimeout)
	defer cancel()
	hosts, err := m.tr.Discover(ctx)
	if err != nil {
		return nil, err
	}
	m.hostsMu.Lock()
	m.hosts = hosts
	m.hostsMu.Unlock()
	return hosts, nil
}

// cachedHosts returns the last discovery result without re-reading anything.
func (m *machines) cachedHosts() []transport.HostRef {
	m.hostsMu.Lock()
	defer m.hostsMu.Unlock()
	return m.hosts
}

// client returns the live connection to the named machine, dialing on first
// use and reusing it afterwards.
//
// A cached connection whose read loop has died is EVICTED and this call fails
// naming the machine; the next call re-dials. Failing the in-flight call
// rather than transparently redialing is deliberate: a caller who just sent
// input to a pane on a host that dropped needs to know the send may not have
// landed, and a silent reconnect would tell them the opposite.
func (m *machines) client(name string) (*Client, error) {
	host, err := m.resolve(name)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	c := m.conns[host.ID]
	if c != nil && c.Dead() {
		delete(m.conns, host.ID)
		m.mu.Unlock()
		_ = c.Close()
		return nil, fmt.Errorf("machine %q: connection dropped (%v); retry to reconnect", host.ID, c.DeadErr())
	}
	if c != nil {
		m.mu.Unlock()
		return c, nil
	}
	m.mu.Unlock()

	dialed, err := m.dial(host)
	if err != nil {
		return nil, err
	}

	// Re-check under the lock: two concurrent tool calls naming the same
	// cold machine both dial, and exactly one connection may be kept.
	m.mu.Lock()
	if existing := m.conns[host.ID]; existing != nil && !existing.Dead() {
		m.mu.Unlock()
		_ = dialed.Close()
		return existing, nil
	}
	m.conns[host.ID] = dialed
	m.mu.Unlock()
	return dialed, nil
}

// dial acquires a stream to host and turns it into a working client.
//
// This is the whole of what "reach a remote" means, and it is short because
// internal/transport already absorbed the hard part: sessiond's framing is
// self-describing and carries no socket assumptions, so any binary-clean
// bidirectional stream is enough (internal/sessiond/client.go:138).
func (m *machines) dial(host transport.HostRef) (*Client, error) {
	if m.tr == nil {
		return nil, fmt.Errorf("machine %q: %w", host.ID, errNoTransport)
	}
	ctx, cancel := context.WithTimeout(context.Background(), machineDialTimeout)
	defer cancel()

	conn, err := m.tr.Dial(ctx, host)
	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("machine %q: unreachable, timed out after %s connecting to %s: %w",
				host.ID, machineDialTimeout, host.Addr, err)
		}
		return nil, fmt.Errorf("machine %q: unreachable (%s): %w", host.ID, host.Addr, err)
	}

	c := newClient(sessiond.DialConn(conn), host.ID)

	// One bounded round trip, which both proves the far daemon is really
	// answering and records a workspace so pane tools work immediately --
	// the same priming the local client gets. See primeWorkspace.
	if err := c.primeWorkspace(machineDialTimeout); err != nil {
		_ = c.Close()
		return nil, fmt.Errorf("machine %q: reached %s but its muxterm daemon did not answer: %w", host.ID, host.Addr, err)
	}
	if err := c.attachRemote(machineDialTimeout); err != nil {
		_ = c.Close()
		return nil, fmt.Errorf("machine %q: attaching to a workspace on %s: %w", host.ID, host.Addr, err)
	}
	return c, nil
}

// closeAll tears down every remote connection. Called when the MCP server exits.
func (m *machines) closeAll() {
	m.mu.Lock()
	conns := make([]*Client, 0, len(m.conns))
	for id, c := range m.conns {
		conns = append(conns, c)
		delete(m.conns, id)
	}
	m.mu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
}

// machineRow is one line of the list_machines answer.
type machineRow struct {
	ID          string `json:"machine"`
	DisplayName string `json:"display_name"`
	Transport   string `json:"transport"`
	Addr        string `json:"addr,omitempty"`
	Reachable   bool   `json:"reachable"`
	Error       string `json:"error,omitempty"`
	Connected   bool   `json:"connected"`
}

// list enumerates every machine this process can address, local first.
//
// probe decides whether reachability is measured or merely reported from what
// is already known. Measuring costs one ssh round trip per host, which is why
// it is a parameter and not a constant.
//
// This is the answer to "which machines can I reach", obtained WITHOUT being
// told: the candidate set comes from internal/transport's own Discover, which
// for ssh reads ~/.ssh/config -- the same on-disk source the browser's
// /api/remotes listing is built from (internal/server/remotes_api.go:238).
// Nothing here invents a second connection mechanism or a second registry.
func (m *machines) list(probe bool) ([]machineRow, error) {
	rows := []machineRow{m.localRow()}

	if m.tr == nil {
		return rows, nil
	}
	hosts, err := m.discover()
	if err != nil {
		return nil, fmt.Errorf("enumerating machines: %w", err)
	}

	remote := make([]machineRow, len(hosts))
	for i, h := range hosts {
		remote[i] = machineRow{
			ID:          h.ID,
			DisplayName: h.DisplayName,
			Transport:   m.tr.Name(),
			Addr:        h.Addr,
		}
	}

	// A machine this process is already talking to is reachable by
	// observation; no probe can be more authoritative than a live connection.
	m.mu.Lock()
	for i := range remote {
		if c := m.conns[remote[i].ID]; c != nil && !c.Dead() {
			remote[i].Connected = true
			remote[i].Reachable = true
		}
	}
	m.mu.Unlock()

	if probe {
		m.probeAll(hosts, remote)
	}

	sort.Slice(remote, func(i, j int) bool { return remote[i].ID < remote[j].ID })
	return append(rows, remote...), nil
}

// localRow describes this machine. Reachability is the existence of the
// sessiond socket, which is the same test dialDaemon makes before dialing.
func (m *machines) localRow() machineRow {
	row := machineRow{
		ID:          LocalMachine,
		DisplayName: LocalMachine,
		Transport:   LocalMachine,
		Connected:   true,
	}
	sock, err := sessiond.SocketPath()
	if err != nil {
		row.Error = err.Error()
		return row
	}
	if _, statErr := os.Stat(sock); statErr != nil {
		row.Error = "no sessiond daemon running on this machine"
		return row
	}
	row.Reachable = true
	return row
}

// probeAll fills in Reachable/Error for every row not already known live.
// Probes run concurrently but capped, and each is independently bounded, so
// one black-holed host cannot stall the answer for the rest.
func (m *machines) probeAll(hosts []transport.HostRef, rows []machineRow) {
	sem := make(chan struct{}, machineProbeConcurrency)
	var wg sync.WaitGroup
	for i := range hosts {
		if rows[i].Connected {
			continue
		}
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			ctx, cancel := context.WithTimeout(context.Background(), machineProbeTimeout)
			defer cancel()
			conn, err := m.tr.Dial(ctx, hosts[i])
			if err != nil {
				rows[i].Error = err.Error()
				return
			}
			c := newClient(sessiond.DialConn(conn), hosts[i].ID)
			if err := c.primeWorkspace(machineProbeTimeout); err != nil {
				rows[i].Error = err.Error()
				_ = c.Close()
				return
			}
			_ = c.Close()
			rows[i].Reachable = true
		}(i)
	}
	wg.Wait()
}

// listMachines is the MCP tool handler for list_machines.
func (m *machines) listMachines(args map[string]any) (string, error) {
	probe := true
	if v, present, err := argBool(args, "probe"); err != nil {
		return "", err
	} else if present {
		probe = v
	}
	rows, err := m.list(probe)
	if err != nil {
		return "", err
	}
	return jsonText(map[string]any{"machines": rows, "probed": probe}), nil
}
