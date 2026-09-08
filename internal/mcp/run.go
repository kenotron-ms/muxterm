package mcp

import (
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// Refusal reasons for tools that are deliberately not machine-scoped. They are
// constants so the same words appear in the tool description and in the error,
// and so the two cannot drift apart.
const (
	// destructiveRemoteRefusal is the C4 decision, recorded where it is
	// enforced. See the comment on the close_workspace registration.
	destructiveRemoteRefusal = "close_workspace and close_pane are deliberately local-only. " +
		"Destroying panes on another machine is irreversible, invisible from here, and not needed to " +
		"enumerate or drive a remote. Close it from a session on that machine, or from the browser"
)

// lane_transcript was once refused across machines with a reason that has since
// stopped being true: "a harness transcript is a file on the machine the session
// runs on, and this process has no way to read a file across a machine
// boundary." That was a limit of the MECHANISM, not a policy, and the mechanism
// changed -- the sessiond protocol now carries read-file and list-dir (see
// internal/sessiond/protocol.go TypeReadFile), so a file on another machine is
// reachable through the same stream everything else already uses.
//
// The distinction is worth keeping in view. The other refusal above is a
// POLICY: close_workspace and close_pane stay local because destroying panes on
// a machine you cannot see is a hazard, and that reasoning is unaffected by any
// new capability. Read crosses the boundary; destroy does not.

// registerRemoteReadTools registers the machine-scoped read-only filesystem
// tools. Split out so the read-only surface is one call site rather than
// something spread through registerAllTools.
func registerRemoteReadTools(srv *Server, wrap func(func(*Client, map[string]any) (string, error)) ToolFunc) {
	registerFSTools(srv, wrap)
}

// machineArg is the schema fragment every machine-scoped tool shares.
//
// A PARAMETER, not a namespaced identifier. The alternative considered was
// encoding the machine into the ids themselves ("ssh:boxb/w1", "ssh:boxb#3"),
// and it was rejected for three reasons:
//
//  1. The daemon's ids are the REMOTE daemon's own bare ids. Namespacing would
//     mean every tool parses a prefix off, and every id that comes back out
//     has one put on, in two directions, in every tool -- a transformation
//     with no single home and therefore many places to get it wrong.
//  2. Round-tripping must hold: an id read from list_workspaces must work
//     verbatim in switch_workspace. A parameter preserves that for free; a
//     namespace only preserves it if every producer and every consumer agree
//     forever.
//  3. The project has already answered this question the same way for the CLI.
//     cmd/muxterm/cli_daemon.go:66 states it: "--remote SELECTS a daemon, it
//     does not merge two, so there is nothing here to namespace... Namespacing
//     exists only at the browser edge, because only the browser sees more than
//     one daemon at once." A tool call selects a daemon too.
//
// Absent means local, so no existing caller changes meaning.
var machineArg = map[string]any{
	"type":        "string",
	"description": "which machine to act on: omit or \"local\" for this machine, or a machine id/name from list_machines (e.g. \"ssh:boxb\" or \"boxb\"). An unknown or unreachable machine is an error -- it never silently falls back to this machine.",
}

// withMachine returns props plus the machine parameter. It takes a copy so a
// shared schema literal can never be mutated by a second registration.
func withMachine(props map[string]any) map[string]any {
	out := make(map[string]any, len(props)+1)
	for k, v := range props {
		out[k] = v
	}
	out["machine"] = machineArg
	return out
}

// registerMachineTools registers list_machines, the tool that answers "which
// machines can I reach" without anyone having to be told.
func registerMachineTools(srv *Server, m *machines) {
	srv.Register(
		"list_machines",
		"list every machine this session can address -- the local one plus every remote muxterm daemon reachable through the configured transport. Each row: machine (the durable id to pass as the machine argument of other tools), display_name, transport, addr, reachable, connected, and error when a probe failed. probe (default true) actually dials each machine to test reachability; probe:false lists candidates without spending a round trip. This is how you find machines; nobody has to tell you they exist.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"probe": map[string]any{
					"type":        "boolean",
					"description": "dial each machine to measure reachability (default true)",
				},
			},
		},
		m.listMachines,
	)
}

// lazyClient dials the sessiond daemon exactly once, on the first tool call.
// The initialize and tools/list methods must NOT trigger a dial so that MCP
// servers work without a running daemon.
type lazyClient struct {
	once sync.Once
	c    *Client
	err  error
}

// get returns the Client, dialing on the first call. Subsequent calls return
// the same cached result. On dial failure the error is wrapped as
// "connect to sessiond: <cause>".
//
// After a successful dial, get auto-attaches to the first available workspace
// so that pane and terminal tools work immediately without requiring an
// explicit switch_workspace call. If no workspaces exist yet (empty daemon),
// the connection remains unattached and switch_workspace must be called once
// a workspace is created.
func (lc *lazyClient) get() (*Client, error) {
	lc.once.Do(func() {
		c, err := Dial()
		if err != nil {
			lc.err = fmt.Errorf("connect to sessiond: %w", err)
			return
		}
		// Record the first workspace ID so resources/list knows which workspace
		// to attach later, via the SAME priming a remote client gets -- a local
		// client and a remote one must not arrive in different states, or a
		// tool works on one and not the other for reasons no one can see.
		//
		// The error is ignored here exactly as it was before: an empty daemon
		// is not a dial failure locally. It is NOT ignored for a remote, where
		// the same round trip is also the liveness handshake.
		_ = c.primeWorkspace(localPrimeTimeout)
		lc.c = c
	})
	return lc.c, lc.err
}

// insidePane reports whether this MCP server is running inside a muxterm pane,
// which is what makes its client a lane rather than a manager.
//
// sessiond stamps sessiond.EnvPaneID into every pane's environment (see the
// constant's doc comment for why the environment and not something cleverer),
// and a harness forwards its environment to the MCP server it starts, so the
// variable is present for a lane and absent for everything else:
//
//	lane in a pane   muxterm mcp <- amplifier/claude <- pane process   SET
//	chief of staff   muxterm mcp <- sidecar <- muxterm serve           unset
//	a shell anywhere muxterm mcp <- whatever started it                unset
//
// Deliberately a presence test, not a parse: the value is a pane id, but
// nothing here needs the id, and a malformed one still means "inside a pane".
//
// This costs no daemon connection, which matters: the whole point of the
// lazyClient above is that initialize and tools/list answer without dialing
// sessiond, and the tool list is exactly where this answer is needed.
func insidePane() bool {
	return os.Getenv(sessiond.EnvPaneID) != ""
}

// clientPool routes a tool call to the daemon it named.
//
// The local daemon keeps its own lazyClient, unchanged, because local is not a
// special case of remote: it needs no transport, no discovery and no dial
// timeout, and making it travel the remote path would put an ssh-shaped
// failure mode in front of a Unix socket that cannot have one.
type clientPool struct {
	local    *lazyClient
	machines *machines
}

// get returns the client for the machine named in args, and never anything
// else. An unresolvable or unreachable machine is an ERROR; it is never
// answered with the local client.
//
// That rule is the whole safety property of this feature. A caller who asks to
// send C-c to pane 3 on "boxb" and silently gets pane 3 on THIS machine has
// been handed a loaded gun pointed at the wrong target, and nothing downstream
// can detect it. So there is exactly one path from a machine name to a client,
// it goes through machines.resolve, and its failure mode is a message.
func (p *clientPool) get(args map[string]any) (*Client, error) {
	name, _, err := argStringOptional(args, "machine")
	if err != nil {
		return nil, err
	}
	if isLocal(name) {
		return p.local.get()
	}
	return p.machines.client(name)
}

// remoteCallTimeout is the wall-clock bound on ONE tool call that crosses a
// machine boundary, added to whatever the caller's own timeout_ms asks for.
//
// A bound is needed above sessiond's own error handling because the two are
// answers to different failures. sessiond fails every pending request when its
// read loop errors (internal/sessiond/client.go:248), which covers a
// connection that CLOSES. It does not cover one that goes quiet: a partitioned
// network, a suspended laptop, an ssh session wedged behind a stalled TCP
// window. There the socket is open, no error arrives, and the request waits
// forever. Forever is the one answer a tool must never give.
const remoteCallTimeout = 45 * time.Second

// localPrimeTimeout bounds the local client's one priming round trip. The
// local path had no bound at all, which meant a wedged local daemon hung the
// first tool call forever with no message. A generous bound is strictly better
// than none: it cannot fire in normal use and it cannot hang.
const localPrimeTimeout = 30 * time.Second

// callBound returns the wall-clock bound for one remote call. A caller that
// asked run_command to wait two minutes gets two minutes plus the overhead
// allowance, so this bound can never be the thing that cuts a legitimate call
// short -- it only ever catches a call that was never going to return.
func callBound(args map[string]any) time.Duration {
	d := remoteCallTimeout
	if ms, err := argInt(args, "timeout_ms"); err == nil && ms > 0 {
		d += time.Duration(ms) * time.Millisecond
	}
	return d
}

// callWithin runs fn on its own goroutine and bounds its wall-clock time,
// naming the machine in the timeout so the reader knows which far end went
// quiet. The goroutine is left running: it is blocked on a socket that will
// error out when the connection is finally reaped, and abandoning it is
// cheaper than any scheme for interrupting it.
func callWithin(machine string, bound time.Duration, fn func() (string, error)) (string, error) {
	type result struct {
		out string
		err error
	}
	done := make(chan result, 1)
	go func() {
		out, err := fn()
		done <- result{out, err}
	}()
	select {
	case r := <-done:
		return r.out, r.err
	case <-time.After(bound):
		return "", fmt.Errorf("machine %q: no reply within %s -- the machine is unreachable or has stopped responding; nothing was run on this machine instead", machine, bound)
	}
}

// NewStdioServer creates a Server wired to os.Stdin/Stdout and registers the
// MCP tools this session is entitled to: all 24 normally, and 22 inside a
// muxterm pane, where close_workspace and close_pane are withheld (see
// registerAllTools). The sessiond client is dialed lazily on the first tool
// call, so initialize and tools/list work without a running daemon.
//
// tr supplies remote machines and may be nil, which leaves every tool
// local-only and makes list_machines report just this machine. Nothing here
// dials a remote until a tool call names one.
//
// The returned closer must be called when the server exits: it closes the
// local sessiond client if one was opened, and every remote connection.
func NewStdioServer(tr MachineTransport) (*Server, func() error) {
	return NewServerWithTransport(os.Stdin, os.Stdout, tr)
}

// NewServerWithTransport is NewStdioServer with explicit IO, mirroring the
// NewServer / NewServerWithIO pair on Server itself and existing for the same
// reason: the tool surface is worth driving over something other than this
// process's real stdin and stdout.
//
// It is the whole assembled server -- same registrations, same clientPool, same
// remote wiring -- so exercising it exercises what ships, rather than a
// reimplementation of it that can drift.
func NewServerWithTransport(in io.Reader, out io.Writer, tr MachineTransport) (*Server, func() error) {
	srv := NewServerWithIO(in, out)
	pool := &clientPool{local: &lazyClient{}, machines: newMachines(tr)}
	registerWithLazy(srv, pool)
	closer := func() error {
		pool.machines.closeAll()
		if pool.local.c != nil {
			return pool.local.c.Close()
		}
		return nil
	}
	return srv, closer
}

// registerWithLazy registers all MCP tools on srv, wrapping sessiond-backed
// handlers so the client is resolved from the call's own machine argument on
// each tool call.
func registerWithLazy(srv *Server, pool *clientPool) {
	lc := pool.local
	wrap := func(fn func(*Client, map[string]any) (string, error)) ToolFunc {
		return func(args map[string]any) (string, error) {
			c, err := pool.get(args)
			if err != nil {
				return "", err
			}
			if !c.IsRemote() {
				return fn(c, args)
			}
			return callWithin(c.Machine(), callBound(args), func() (string, error) {
				return fn(c, args)
			})
		}
	}
	// localOnly wraps a tool that CANNOT be machine-scoped, and makes that
	// refusal explicit rather than implicit.
	//
	// The subtle failure this prevents: a tool whose schema simply omits
	// "machine" does not reject a machine argument, it IGNORES one. A caller
	// that passes machine:"ssh:boxb" to such a tool gets the action performed
	// on THIS machine and a success response -- the exact silent-wrong-machine
	// outcome the whole feature is built to make impossible. So every
	// sessiond-backed tool is either machine-scoped or explicitly refuses.
	localOnly := func(reason string, fn func(*Client, map[string]any) (string, error)) ToolFunc {
		return func(args map[string]any) (string, error) {
			if name, _, err := argStringOptional(args, "machine"); err != nil {
				return "", err
			} else if !isLocal(name) {
				return "", fmt.Errorf("machine %q: refused -- %s. Nothing was done on this machine instead", name, reason)
			}
			c, err := lc.get()
			if err != nil {
				return "", err
			}
			return fn(c, args)
		}
	}

	registerAllTools(srv, wrap, localOnly)
	registerMachineTools(srv, pool.machines)
	registerRemoteReadTools(srv, wrap)
	registerTunnelTools(srv)
	registerPublishTools(srv)
	registerConfigTools(srv)

	// attachOnce guards the one-time workspace attach for resources/list.
	// Calling c.conn.Attach repeatedly replays the full retained output buffer
	// for every pane, generating spurious notifications/resources/updated events
	// on every resources/list call. We attach once and cache the pane list.
	var (
		attachOnce  sync.Once
		attachedRes []map[string]any
	)
	srv.SetResourceProvider(
		// list closure: dial lazily, attach workspace exactly once, return cached
		// pane descriptors. Subsequent resources/list calls return the same list
		// without re-attaching or replaying output buffers.
		func() []map[string]any {
			c, err := lc.get()
			if err != nil {
				return nil
			}
			attachOnce.Do(func() {
				ws := c.Workspace()
				comp, attachErr := c.conn.Attach(ws, "wide", "agent")
				if attachErr != nil {
					return
				}
				// Set the notifier AFTER Attach completes.
				// Attach replays the full scrollback for every pane; if the notifier
				// is live during replay, conn.Run tries to write MCP notifications
				// while the resources/list response is still pending — Amplifier is
				// waiting for that response and not draining the pipe, so it fills up,
				// conn.Run blocks, the sessiond socket backs up, and Attach never
				// finishes. Setting the notifier here means replay is silent; only
				// future live output fires notifications, at which point Amplifier is
				// actively reading.
				c.SetOutputNotifier(func(paneID int) {
					srv.NotifyResourceUpdated(fmt.Sprintf("pane://%d", paneID))
				})
				res := make([]map[string]any, 0, len(comp.Panes))
				for _, p := range comp.Panes {
					res = append(res, map[string]any{
						"uri":      fmt.Sprintf("pane://%d", p.PaneID),
						"name":     fmt.Sprintf("Pane %d output", p.PaneID),
						"mimeType": "text/plain",
					})
				}
				attachedRes = res
			})
			return attachedRes
		},
		// read closure: dial lazily, parse paneID from uri, return screen text.
		// Returns an error immediately on malformed URIs to avoid sending pane 0
		// to the daemon with a confusing error message.
		func(uri string) (string, error) {
			c, err := lc.get()
			if err != nil {
				return "", err
			}
			var paneID int
			if n, _ := fmt.Sscanf(uri, "pane://%d", &paneID); n != 1 {
				return "", fmt.Errorf("invalid resource URI: %q", uri)
			}
			snap, err := c.conn.ScreenSnapshot(paneID)
			if err != nil {
				return "", err
			}
			return snap.Text, nil
		},
	)
}

// registerAllTools registers the 16 sessiond-backed MCP tools on srv using
// wrap to convert func(*Client, map[string]any)(string,error) handlers into
// ToolFuncs. Tools are registered in the canonical order:
//
//	Terminal:   run_command, send_input, get_screen
//	Workspace:  list_workspaces, create_workspace, switch_workspace, close_workspace*
//	Layout:     create_pane, rename_pane, close_pane*, list_panes, get_layout
//	Delegation: spawn_lane
//	Fleet:      fleet_status, lane_transcript, session_send
//
// * Withheld when insidePane() reports this server is running in a muxterm
// pane, leaving 14 here. Read the comment at each of the two
// registrations before changing that.
//
// The 3 tunnel tools (list_tunnels, create_tunnel, close_tunnel) and the 3
// publishing tools (publish_file, list_publications, revoke_publication) are
// registered separately, via registerTunnelTools and registerPublishTools,
// because they go through the HTTP REST API of the serve layer rather than the
// sessiond daemon -- and so must keep working when no daemon is running.
func registerAllTools(
	srv *Server,
	wrap func(func(*Client, map[string]any) (string, error)) ToolFunc,
	localOnly func(string, func(*Client, map[string]any) (string, error)) ToolFunc,
) {
	// --- Terminal tools ---

	srv.Register(
		"run_command",
		"run command and wait for completion via OSC 133, returns output+exit code; for long-running use send_input",
		map[string]any{
			"type": "object",
			"properties": withMachine(map[string]any{
				"pane_id":    map[string]any{"type": "integer"},
				"command":    map[string]any{"type": "string"},
				"timeout_ms": map[string]any{"type": "integer"},
			}),
			"required": []string{"pane_id", "command"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newTerminalTools(c).runCommand(args)
		}),
	)

	srv.Register(
		"send_input",
		"send input without waiting, for interactive programs/control sequences; text (optional) is always sent as literal bytes, unchanged, safe for any payload including strings that happen to match a key name; keys (optional) is an array of key names (Enter, Tab, Escape, Backspace, Up, Down, Left, Right, C-c, C-d, C-z) each translated to its byte sequence, e.g. keys: [\"Enter\"] to press Enter; if both are given, text is sent first, then keys, e.g. text: \"ls -la\", keys: [\"Enter\"]; at least one of text/keys is required",
		map[string]any{
			"type": "object",
			"properties": withMachine(map[string]any{
				"pane_id": map[string]any{"type": "integer"},
				"text":    map[string]any{"type": "string"},
				"keys":    map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
			}),
			"required": []string{"pane_id"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newTerminalTools(c).sendInput(args)
		}),
	)

	srv.Register(
		"get_screen",
		"current screen state as plain text + cursor",
		map[string]any{
			"type": "object",
			"properties": withMachine(map[string]any{
				"pane_id": map[string]any{"type": "integer"},
			}),
			"required": []string{"pane_id"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newTerminalTools(c).getScreen(args)
		}),
	)

	// --- Workspace tools ---

	srv.Register(
		"list_workspaces",
		"list all workspaces with id/name/pane count/active flag; each row carries the machine it belongs to",
		map[string]any{
			"type":       "object",
			"properties": withMachine(map[string]any{}),
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newWorkspaceTools(c).listWorkspaces(args)
		}),
	)

	srv.Register(
		"create_workspace",
		"create new empty workspace by name, return id",
		map[string]any{
			"type": "object",
			"properties": withMachine(map[string]any{
				"name": map[string]any{"type": "string"},
			}),
			"required": []string{"name"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newWorkspaceTools(c).createWorkspace(args)
		}),
	)

	srv.Register(
		"switch_workspace",
		"switch MCP session to a different workspace \u2014 detach current, attach given id; subsequent terminal/layout tools target new workspace",
		map[string]any{
			"type": "object",
			"properties": withMachine(map[string]any{
				"workspace_id": map[string]any{"type": "string"},
			}),
			"required": []string{"workspace_id"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newWorkspaceTools(c).switchWorkspace(args)
		}),
	)

	// WITHHELD INSIDE A PANE. A session running in a pane is a lane, and a
	// lane closing a workspace is the failure this guard exists to prevent:
	// asked to "tear down what you started", a lane reads its own workspace as
	// something it started and closes it as a final act, taking its verdict,
	// its PR number and its report with it. There is no legitimate call in the
	// other direction either -- a lane has no business closing anybody else's
	// workspace. So the tool is simply not there.
	//
	// Not an approval gate, for the reason already stated at spawn_lane below:
	// a tool an agent does not have cannot be misused, whereas a gate on one
	// can be overwritten out from under you.
	//
	// SECOND, INDEPENDENT LIMIT -- THE DESTRUCTIVE-ACTION BOUNDARY (C4).
	// Even where close_workspace IS offered, it is local-only: it refuses a
	// remote machine argument rather than acting on one. The reasoning, and
	// the alternative that was rejected:
	//
	//   Chosen: destructive reach stops at the machine boundary. Enumerating
	//   and driving a remote is fully supported; destroying things on one is
	//   not. Three reasons compound. (a) It is unnecessary: nothing in "the
	//   chief of staff can see and use another machine's sessions" requires
	//   destroying a workspace there. (b) It is unobservable: the operator
	//   watching a remote pane vanish is on the OTHER machine, so the usual
	//   corrective feedback loop is absent. (c) The known hazard is still
	//   open: agent lanes were recently found closing workspaces they should
	//   not have, and the fix is still in flight on
	//   fix/lanes-cannot-close-workspaces. Widening a hazard across machines
	//   before its fix has landed is the wrong order.
	//
	//   Rejected: a machine parameter here too, symmetrical with every other
	//   tool. Symmetry is a real cost -- one tool behaving unlike its
	//   neighbours is a thing to remember -- and it was still not worth it,
	//   because the asymmetry is exactly the point. The refusal is explicit
	//   and names itself (see localOnly), so a caller learns the rule from
	//   the error rather than from a surprise.
	//
	// This is a deliberate decision, not an accident of which tools happened
	// to get a machine parameter: both closers carry the machine argument in
	// their schema PRECISELY so that passing one is refused instead of
	// silently ignored and applied here.
	if !insidePane() {
		srv.Register(
			"close_workspace",
			"close workspace by id on THIS machine, terminating all panes, cannot be undone. Deliberately not machine-scoped: a remote machine argument is refused, never silently applied here.",
			map[string]any{
				"type": "object",
				"properties": withMachine(map[string]any{
					"workspace_id": map[string]any{"type": "string"},
				}),
				"required": []string{"workspace_id"},
			},
			localOnly(destructiveRemoteRefusal, func(c *Client, args map[string]any) (string, error) {
				return newWorkspaceTools(c).closeWorkspace(args)
			}),
		)
	}

	// --- Layout tools ---

	srv.Register(
		"create_pane",
		"create new terminal pane, placement tab|split-right|split-left|split-above|split-below advisory \u2014 split executed by the web UI",
		map[string]any{
			"type": "object",
			"properties": withMachine(map[string]any{
				"kind": map[string]any{
					"type": "string",
					"enum": []string{"terminal"},
				},
				"placement": map[string]any{
					"type": "string",
					"enum": []string{"tab", "split-right", "split-left", "split-above", "split-below"},
				},
				"reference_pane": map[string]any{"type": "integer"},
			}),
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newLayoutTools(c).createPane(args)
		}),
	)

	srv.Register(
		"rename_pane",
		"rename pane by id, sets display label",
		map[string]any{
			"type": "object",
			"properties": withMachine(map[string]any{
				"pane_id": map[string]any{"type": "integer"},
				"name":    map[string]any{"type": "string"},
			}),
			"required": []string{"pane_id", "name"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newLayoutTools(c).renamePane(args)
		}),
	)

	// WITHHELD INSIDE A PANE, for the same reason as close_workspace above and
	// with one addition: a lane's own pane IS the lane, so close_pane on it is
	// suicide with the report still unwritten, and close_pane on a sibling
	// kills somebody else's work with no way to say sorry.
	if !insidePane() {
		srv.Register(
			"close_pane",
			"close pane by id on THIS machine, terminating its process. Deliberately not machine-scoped: a remote machine argument is refused, never silently applied here.",
			map[string]any{
				"type": "object",
				"properties": withMachine(map[string]any{
					"pane_id": map[string]any{"type": "integer"},
				}),
				"required": []string{"pane_id"},
			},
			localOnly(destructiveRemoteRefusal, func(c *Client, args map[string]any) (string, error) {
				return newLayoutTools(c).closePane(args)
			}),
		)
	}

	srv.Register(
		"list_panes",
		"list all panes in the current or specified workspace with pane_id, kind, and name; each row carries the machine it belongs to",
		map[string]any{
			"type": "object",
			"properties": withMachine(map[string]any{
				"workspace": map[string]any{"type": "string"},
			}),
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newLayoutTools(c).listPanes(args)
		}),
	)

	srv.Register(
		"get_layout",
		"get ASCII layout diagram of the current workspace; empty string when no layout saved",
		map[string]any{
			"type": "object",
			"properties": withMachine(map[string]any{
				"workspace": map[string]any{"type": "string"},
			}),
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newLayoutTools(c).getLayout(args)
		}),
	)

	// --- Delegation tools ---
	//
	// spawn_lane is intentionally CREATE-ONLY, and there is deliberately no
	// destroy_lane beside it. An agent that delegates must be able to open new
	// work and must never be able to destroy existing work; closure stays with
	// the human (docs/designs/2026-09-06-cos-delegation-model.md section 2).
	// close_pane and close_workspace above are now withheld from any server
	// running inside a pane, which is every lane this tool starts. The
	// principle is unchanged and merely enforced one layer lower: a tool an
	// agent does not have cannot be misused, whereas an approval gate on one
	// can be overwritten out from under you. What changed is WHERE the surface
	// is chosen -- an agent's bundle cannot decide this, because muxterm does
	// not write the bundle a lane runs; the server does.
	//
	// SETTLED: the chief-of-staff bundle takes the muxterm tool set WHOLE
	// (mcp_muxterm_*), so the CoS CAN close a pane or a workspace. That is
	// deliberate, not an oversight. Managing muxterm is what a chief of staff
	// for muxterm is for; a CoS that opens workspaces and can never tidy them
	// leaves an accumulating mess. What it may not do is a LANE's work --
	// hence no bash, no file writes, no delegate. Section 2 of the delegation
	// model carries the full table and the reasoning.
	//
	// The CoS keeps both tools under the rule above BECAUSE OF WHERE IT RUNS:
	// it is a sidecar of `muxterm serve`, not a pane process, so insidePane()
	// is false for it. That is a real coupling, not a coincidence -- move the
	// sidecar into a pane and it silently loses the two tools. If that day
	// comes, give it an explicit exemption rather than weakening the rule.
	//
	// The broadcast above is still the thing to respect: closure is gated by
	// ASKING (the approval card) and by the charter rule that the CoS never
	// closes a workspace it did not create -- not by the tool's absence.
	srv.Register(
		"spawn_lane",
		"delegate work: launch a coding-agent session (amplifier|claude) in a pane of the named workspace, creating that workspace if it does not exist; prompt is the session's opening turn; goal (amplifier only) instead launches a /goal loop with that stop condition, and prompt is ignored; returns workspace_id, pane_id, harness, workspace_created",
		map[string]any{
			"type": "object",
			"properties": withMachine(map[string]any{
				// The bounds are in the schema as well as enforced in
				// tools_lane.go, so a caller is told the rule before it breaks
				// it rather than only afterwards.
				"workspace": map[string]any{
					"type":        "string",
					"maxLength":   maxWorkspaceNameBytes,
					"description": "workspace name: one line of plain text, no control characters",
				},
				"harness": map[string]any{
					"type": "string",
					"enum": []string{"amplifier", "claude"},
				},
				"prompt": map[string]any{
					"type":        "string",
					"description": "the lane's opening turn, as work to do. It must not begin with '/': the harness would read that as a slash command. Use goal to start a /goal loop",
				},
				"goal": map[string]any{
					"type": "string",
					"description": "stop condition for a /goal loop (amplifier only; prompt is then ignored). " +
						"The lane loops headlessly until the condition is met, and when the loop ends " +
						"the pane does NOT close: it resumes that same session interactively, holding " +
						"the whole run's context, so a lane that got most of the way there can be " +
						"finished by typing at it. Until a human types, the row reads mode=autonomous " +
						"with the verdict in state and the condition in done_means",
				},
				"placement": map[string]any{
					"type": "string",
					"enum": []string{"tab", "split-right", "split-left", "split-above", "split-below"},
				},
			}),
			"required": []string{"workspace", "harness", "prompt"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newLaneTools(c).spawnLane(args)
		}),
	)

	// --- Fleet tools ---
	//
	// These three read (and, for session_send, write to) the daemon's
	// session-state feed -- the same structured rows the browser's home view
	// renders. They exist because the alternative is scraping terminal screens
	// to answer a question that is already answered structurally one layer
	// away, and because two of the fields they carry (done_means, knows) are
	// DECLARED by each session and appear on no screen at any cost.
	//
	// Alone among the sessiond-backed tools they are NOT scoped to the
	// attached workspace: the daemon fans session state out across every
	// workspace to every opted-in connection. See the header comment in
	// fleet.go.

	srv.Register(
		"fleet_status",
		"what every agent session on ONE machine is doing, across ALL workspaces -- not just the attached one. "+
			"Defaults to this machine; pass machine to report a connected remote instead. Every row carries a machine field. "+
			"Returns full declared rows: session_id, pane_id, workspace_id, harness, project, name, label, mode "+
			"(interactive|autonomous), state (working|blocked|done|failed|stopped), waiting_for, doing, done_means "+
			"(an autonomous lane's own stop condition; empty for interactive ones), knows (files the session has read), "+
			"pr, updated_at. done_means and knows are declared by the session and appear on no terminal screen, "+
			"so this is the only way to see them. Optional state filters by exact lifecycle state; optional workspace "+
			"filters by workspace NAME (an unknown name is an error, never a new workspace). An empty sessions list "+
			"means no agent sessions are running, which is a normal answer",
		map[string]any{
			"type": "object",
			"properties": withMachine(map[string]any{
				"state": map[string]any{
					"type": "string",
					"enum": fleetStates,
				},
				"workspace": map[string]any{
					"type":        "string",
					"description": "workspace NAME (not id); must already exist",
				},
			}),
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newFleetTools(c).fleetStatus(args)
		}),
	)

	srv.Register(
		"lane_transcript",
		"read the last few turns a session actually exchanged, from its harness's own on-disk transcript "+
			"(amplifier and claude). Harness and project directory come from the fleet snapshot, so only a session "+
			"listed by fleet_status can be read. THIS IS A TAIL, NOT THE CONVERSATION: only the end of the file is "+
			"read (a bounded window, at most 4 MB, however large the file), each turn's text is clipped to 400 "+
			"characters, and last_n is capped at 100 (default 10). truncated=true in the result means earlier turns "+
			"exist and were not read. Defaults to this machine; pass machine to read the transcript of a session on "+
			"a connected remote, which is read from THAT machine's disk through its own daemon -- never answered "+
			"with this machine's files. The result carries the machine it came from",
		map[string]any{
			"type": "object",
			"properties": withMachine(map[string]any{
				"session_id": map[string]any{
					"type":        "string",
					"description": "a session_id from fleet_status",
				},
				"last_n": map[string]any{
					"type":        "integer",
					"description": "turns to return, newest last (default 10, max 100)",
				},
			}),
			"required": []string{"session_id"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newFleetTools(c).laneTranscript(args)
		}),
	)

	srv.Register(
		"session_send",
		"type text into a known session's pane, addressed by session_id -- to unblock one waiting at a prompt, "+
			"or to steer one that has drifted. submit (default true) appends Enter. Switches the MCP session to that "+
			"session's workspace if needed, which discards this connection's buffered pane output, so drain anything "+
			"you care about first. REFUSES any session_id not in the current fleet_status snapshot: this addresses "+
			"known sessions only and can never target an arbitrary pane id. Returns pane_id, workspace_id",
		map[string]any{
			"type": "object",
			"properties": withMachine(map[string]any{
				"session_id": map[string]any{
					"type":        "string",
					"description": "a session_id from fleet_status",
				},
				"text": map[string]any{"type": "string"},
				"submit": map[string]any{
					"type":        "boolean",
					"description": "append Enter after the text (default true)",
				},
			}),
			"required": []string{"session_id", "text"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newFleetTools(c).sessionSend(args)
		}),
	)
}

// registerTunnelTools registers the 3 tunnel MCP tools directly on srv,
// without going through the lazyClient. Tunnel tools communicate with the
// serve-layer HTTP REST API (not the sessiond daemon), so they must not
// require sessiond to be running.
func registerTunnelTools(srv *Server) {
	tt := newTunnelTools()

	srv.Register(
		"list_tunnels",
		"list all active tunnels with id and port",
		map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
		func(args map[string]any) (string, error) {
			return tt.listTunnels(args)
		},
	)

	srv.Register(
		"create_tunnel",
		"create a new port-forward tunnel for the given local port (1-65535); returns id, port, and url. "+
			"url is absolute only when muxterm is configured with a public origin; otherwise it is the "+
			"relative path /t/{id}/, which the caller resolves against whatever origin it reached muxterm on. "+
			"The tunnel is auth-protected: it is reachable by this already-authenticated user, not shareable as an anonymous link",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"port": map[string]any{"type": "integer"},
			},
			"required": []string{"port"},
		},
		func(args map[string]any) (string, error) {
			return tt.createTunnel(args)
		},
	)

	srv.Register(
		"close_tunnel",
		"close tunnel by id, removing the port-forward",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tunnel_id": map[string]any{"type": "string"},
			},
			"required": []string{"tunnel_id"},
		},
		func(args map[string]any) (string, error) {
			return tt.closeTunnel(args)
		},
	)
}
