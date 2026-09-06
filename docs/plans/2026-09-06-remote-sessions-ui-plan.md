# Remote sessions — implementation plan

Wires the transport layer that landed in `5d27592` (and has had **zero importers** ever since)
to the web relay, the HTTP API, the CLI, and the browser.

Designs this implements: `docs/designs/2026-09-05-remote-sessiond-design.md` (D2, D2c, D3, D5,
D7) and `docs/designs/2026-09-05-remote-sessiond-ux-design.md` (D1–D8). Wireframes:
`docs/designs/wireframes/remote-sessiond-wireframes.html`.

## Invariants (violate one and the change is wrong)

1. **`internal/sessiond/protocol.go` is not edited.** Not one field, not one constant. Every
   host identity travels in an existing field or in a relay-level message that never reaches a
   daemon.
2. **Zero remotes ⇒ byte-identical UI.** Sidebar, Home, dock, start card must produce the same
   DOM as `main` when no host is connected. This is the top acceptance gate (§G.2 gate 1). The
   single permitted exception is the 4th Settings nav item — it is the only way to add the first
   machine, and Settings is not part of the gate.
3. **Local ids stay bare.** `w1` is `w1`. Only remote ids carry a prefix.
4. **No unit tests.** AGENTS.md bans them. Verification is `playwright-cli` against a real
   browser and a real second daemon (§G). Existing `*_test.go` that break must be *fixed*, never
   supplemented.
5. **One daemon connection per browser per host** (design D5). Never pool: PTY sizing authority
   is keyed on daemon-connection pointer identity (`pane.go:34-38`).

## Out of scope (do not build)

D4 flow control · D6 relay queue · sandbox transport · tunnels UI · narrow (<768px) breakpoint ·
tiles view · the fleet strip (ux open question 2 is unresolved; the sidebar already carries
per-host needs counts) · everything in the ux doc's YAGNI table (`:113-128`) — no status rail, no
rtt/uptime telemetry, no explanatory subtitles, no behaviour toggles, no "Add machine" chip on
Home.

---

# A. The wire contract

## A.1 Namespaced identifier format

```
<HostRef.ID> "/" <daemon-local id>          remote,  e.g.  ssh:boxb/w1
<daemon-local id>                            local,   e.g.  w1
<HostRef.ID> "/"                             host selector (create-workspace only), e.g. ssh:boxb/
```

The qualifier is **`HostRef.ID`** (`internal/transport/transport.go:37`) — never `DisplayName`.
`ssh:boxb`, `sandbox:cb997d3d-…`. Display names are mutable labels; a workspace reference that
breaks when a host is relabelled is a production-only bug.

**Canonical parse/format rules** (identical in Go and TypeScript):

| Rule | Statement |
|---|---|
| P1 | `format(host, local)` = `local` when `host == ""`, else `host + "/" + local`. |
| P2 | `split(id)` finds the **first** `/`. None ⇒ `("", id)`. Otherwise ⇒ `(id[:i], id[i+1:])`. |
| P3 | A `HostRef.ID` **must not contain `/`**. Enforced at registry admission (`RemoteRegistry.Add` rejects it). This is what makes P2 total and unambiguous. |
| P4 | Round trip: `split(format(h, l)) == (h, l)` for every `h` without `/` and every `l`. |
| P5 | `format("", l) == l` — the zero-remote guarantee, stated as an algebraic law. |
| P6 | Empty local part (`"ssh:boxb/"`) is the **host selector**. Legal *only* on `create-workspace`. Anywhere else it is a client error (`400` / `TypeError`). |

Homes:

- Go: `internal/server/hostid.go` (new) —
  `func nsID(host, local string) string`, `func splitID(id string) (host, local string)`,
  `func validHostID(id string) error`.
- TS: `web/src/lib/host-ref.ts` (new) —
  `parseHostRef(id): {host, localId}`, `formatHostRef(host, localId)`, `isRemoteId(id)`,
  `hostSelector(host)`.

## A.2 Where the rewrite happens

Two boundaries, both inside `internal/server`. Nothing else in the process ever sees a
namespaced id, and no daemon ever does.

```
browser ──(namespaced)──► Client.handleTextInput ──strip──► hostSession.conn ──► daemon
browser ◄──(namespaced)── per-session event closures ◄─stamp─ hostSession.conn ◄── daemon
```

### Inbound — `Client.handleTextInput` (`internal/server/ws.go:235-422`)

Insert one routing step **before** the existing `switch msg.Type` at `:246`:

```go
// route resolves which host this browser message is for, strips the host
// qualifier from every id it carries, and returns the session to run the
// existing switch against. browserWSID is the ORIGINAL namespaced id, kept
// because every error and every reply must echo what the browser sent.
func (c *Client) route(msg *sessiond.Message) (sess *hostSession, browserWSID string, err error)
```

Routing key, per message type:

| Type | Routing key | Inbound rewrite |
|---|---|---|
| `attach` | `msg.WorkspaceID` | `WorkspaceID` → local; sets `c.attachedHost` + `c.workspaceID` (namespaced) on success |
| `create-workspace` | `msg.WorkspaceID` as **host selector** (`"ssh:boxb/"`); absent/empty ⇒ local | clear `WorkspaceID` before forwarding |
| `rename-workspace`, `close-workspace`, `save-layout`, `close-intent` | `msg.WorkspaceID` | `WorkspaceID` → local |
| `close-confirm` | `c.closeTickets[msg.Ticket].host` | none (ticket is opaque) |
| `list-workspaces` | **fan-out, all sessions** | none |
| `preview-subscribe`, `session-state-subscribe` | **fan-out, all sessions** | none |
| `create-pane`, `close-pane`, `rename-pane`, `resize`, `pane-focus` | **currently attached session** (`c.attachedHost`) | none (pane ids stay bare — see A.3) |
| binary `FramePaneData` (`handleBinaryInput`, `:218`) | **currently attached session** | none |

`c.closeTickets` (`ws.go:41`) changes from `map[string]sessiond.CloseTarget` to
`map[string]struct{ target sessiond.CloseTarget; host string }`. The host is recorded in
`rememberCloseTicket` from the session that produced the outcome. Ticket strings are
daemon-random; a cross-host collision is theoretically possible and resolves last-writer-wins.
Accepted and documented.

### Outbound — per-session handler closures (`attachClient`, `ws.go:597-670`)

`dc.SetHandlers(...)` moves into `hostSession.installHandlers()`, where every closure captures
its own `hostID`. Two event classes:

**Fan-in** — accepted from *every* session, ids stamped:

| Event | Stamp |
|---|---|
| `workspace-list` | each `Workspaces[i].WorkspaceID` → `nsID(host, …)`; **merged** (A.4) |
| `session-state` | each `Sessions[i].WorkspaceID` → `nsID(host, …)`; **merged** (A.4) |
| `workspace-preview` | `WorkspaceID` → `nsID(host, …)` |
| `workspace-closed`, `workspace-renamed` | `WorkspaceID` → `nsID(host, …)` |

**Attached-session-only** — dropped when `hostID != c.attachedHost`:

`FramePaneData` (`OnPaneOutput`), `pane-added`, `pane-closed`, `pane-renamed`, `pane-resized`,
`layout-command`, `shell-prompt`.

> Why the drop is mandatory: a session for host A stays attached to A's workspace after the
> browser attaches to B. Its pane-data frames carry bare workspace-local pane ids that would
> collide with B's in `terminal-registry`. There is no detach in protocol v1, so the edge drops
> them. One `if` in each closure.

`pane-closed` and `pane-added` also carry `WorkspaceID`; when they *are* forwarded (attached
session) the id is stamped, so `state.ts` keeps matching against the namespaced attached id.

### Reply/error echo

`sendError(cid, workspaceID, err)` (`ws.go:453`) must echo the **browser's** namespaced id, not
the stripped one — pass `browserWSID` from `route()`. When the error is a `*sessiond.DaemonError`
carrying its own `WorkspaceID` (`client.go:295`), re-stamp it: `de.WorkspaceID → nsID(host, …)`.

Replies built in `handleTextInput` that carry ids:

- `TypeComposition` (`ws.go:261-267`): `WorkspaceID: nsID(host, comp.WorkspaceID)`.
- `TypeWorkspaceCreated` (`ws.go:288-294`): `WorkspaceID: nsID(host, id)`.
- `TypeWorkspaceList` (`ws.go:276-280`, `:302`, `:311`): emitted from the merge cache (A.4), never
  from one session's reply.

## A.3 Every id-bearing protocol field, and its rule

Read off `internal/sessiond/protocol.go` (`:233-334`, `:447-478`, `:156-161`) and
`internal/sessiond/sessionstate.go:125-127`.

| Field | Type | Rewritten? | Rule |
|---|---|---|---|
| `Message.WorkspaceID` | `string` | **Yes, both directions** | Strip inbound, stamp outbound |
| `Message.PaneID` | `int` | **No** | Workspace-local; qualified by the attached session or by an accompanying `WorkspaceID` |
| `Message.ReferencePaneID` | `int` | No | Same |
| `Message.Workspaces[].WorkspaceID` | `string` | **Yes, outbound** | Stamp + merge |
| `Message.Panes[].PaneID` | `int` | No | Composition is single-session |
| `Message.Panes[].ReferencePaneID` | `int` | No | Same |
| `Message.Risks[].PaneID` | `int` | No | Close outcome is single-session |
| `Message.Sessions[].WorkspaceID` | `string` | **Yes, outbound** | Stamp + merge |
| `Message.Sessions[].PaneID` | `int` | No | Qualified by the row's `workspaceId` |
| `FramePaneData` payload `paneID` | `uint32` | **No** | Routed by attached session |

**Pane ids are never namespaced on the browser wire, and this is deliberate.** `Message.PaneID`
is an `int` and the binary frame is a 4-byte little-endian `uint32` (`protocol.go:194-208`) — a
string prefix does not fit either, and the frozen protocol forbids widening them. It is also not
needed: a browser `Client` is attached to exactly one workspace at a time (`ws.go:54-55`), so the
attached session *is* the pane-id namespace. **Do not build a proxy-id allocator for the browser
path.** There is nothing for it to disambiguate.

### The MCP case (contract only — not implemented here)

MCP is a different consumer with a different constraint and is **out of scope for this plan**.
Its contract is fixed here so a later phase does not invent a second answer:

- Agents must not parse a host out of `pane://3`, so MCP pane ids **stay integers**.
- MCP holds one long-lived connection that can be asked about a workspace it is not attached to
  (`internal/mcp/tools_layout.go:97-120` re-attaches per call), so once it can see more than one
  daemon it **must allocate local proxy pane ids** at its own edge and report the owning host as
  a **separate additive field** on `list_panes`:

  ```json
  {"pane_id": 3, "kind": "terminal", "name": "amplifier", "host": "ssh:boxb"}
  ```

  `host` is absent for local panes (mark the exception, not the norm — ux D2).
- `internal/mcp/client.go:26-32` dials `sessiond.SocketPath()` directly and has no edge today.
  Building one is design-doc rollout step 5.

## A.4 Whole-state documents must be merged at the edge

Two messages are *complete-set replacements*, and the browser replaces wholesale on arrival:

- `TypeWorkspaceList` → `state.ts:216-217` — `this._workspaces = msg.workspaces ?? []`
- `TypeSessionState` → `home-sessions.ts` `set()` — "The producer is authoritative; there is no
  merge."

With N sessions each pushing its own full set, forwarding them raw makes each host clobber the
last. The edge is the merge point:

```go
type Client struct {
    // ...
    mergeMu  sync.Mutex
    wsByHost map[string][]sessiond.WorkspaceInfo // last list per host, ids ALREADY namespaced
    ssByHost map[string][]sessiond.SessionState  // last set per host,  ids ALREADY namespaced
}

// emitWorkspaceList sends ONE workspace-list carrying the union across every
// session, in stable order: local ("") first, then hosts sorted by id. Both
// merged messages are whole-state documents, so re-emitting the union on any
// change is idempotent and a dropped frame is repaired by the next one.
func (c *Client) emitWorkspaceList(cid uint64)
func (c *Client) emitSessionState()
```

Ordering is stable so the sidebar does not reshuffle on every push.

**Retention rule (this is D8, encoded):**

- Transport drop / reconnecting ⇒ **keep** the host's cached slices and emit `host_state:
  reconnecting`. The sidebar ghosts them. Workspaces ghost, never vanish.
- Explicit disconnect or host removal ⇒ **delete** the slices and re-emit. Now they vanish,
  because the user asked for that.

`list-workspaces` from the browser fans out, refreshes every session's cache in parallel under a
5 s deadline, and emits one merged reply with the browser's `cid`. A session that fails keeps its
last-known list.

## A.5 Subscription inheritance

`c.previewWanted` / `c.sessionStateWanted` are recorded on the `Client` when the browser
subscribes. **Every session started afterwards re-asserts them on connect.** Without this, a host
connected after page load silently produces no preview tiles and no session rows. The
subscribe *reply* to the browser is driven by the local session only, so zero-remote behaviour is
unchanged; a remote daemon that rejects the subscribe is logged, not surfaced.

---

# B. `internal/server/remotes.go` (new)

## B.1 What owns what

| Thing | Scope | Lives on |
|---|---|---|
| Which hosts the user asked to reach | process | `RemoteRegistry` (on `Hub`) |
| The transport | process | `RemoteRegistry.tr` |
| A live daemon connection to a host | **per browser** | `hostSession` (on `Client`) |
| Connection state, backoff, `host_state` | **per browser** | `hostSession` |
| Last state / last error for `GET /api/remotes` | process | `RemoteRegistry` (last writer wins) |

The registry holds **no** live daemon connection. D5 forbids sharing one, so connections belong
to the browser that will use them. Per-browser state is also the honest answer for the UI: the
dropbar and the ghosting describe *this tab's* view of that host.

## B.2 Types

```go
// HostState is the relay-level connection state for one host as seen by ONE
// browser. It exists only between the local server and the browser; no daemon
// ever sees it, which is why it needs no protocol change.
type HostState string

const (
    HostConnected      HostState = "connected"
    HostReconnecting   HostState = "reconnecting"
    HostUnreachable    HostState = "unreachable"
    HostNeverConnected HostState = "never-connected"
)

// ProbeReport is the transport-neutral shape of "is muxterm usable there".
// internal/server deliberately does not import internal/transport/ssh (or
// internal/deploy): cmd/muxterm adapts the concrete transport to
// RemoteTransport below, which is what keeps the transport boundary the design
// asks for from collapsing the first time a second transport arrives.
type ProbeReport struct {
    State string // "present" | "login-shell-only" | "absent" | "unknown"
    Path  string // resolved remote path, empty when absent
    User  string // login the probe authenticated as, for the connect trace
}

// RemoteTransport is the slice of transport.Transport internal/server needs,
// plus the two operations the Remotes API exposes that transport.Transport
// expresses only as a typed error.
type RemoteTransport interface {
    Name() string
    Dial(ctx context.Context, h transport.HostRef) (net.Conn, error)
    Discover(ctx context.Context) ([]transport.HostRef, error)
    Probe(ctx context.Context, h transport.HostRef) (ProbeReport, error)
    Install(ctx context.Context, h transport.HostRef) error // "Install & connect"
}

type RemoteRegistry struct {
    mu        sync.RWMutex
    tr        RemoteTransport
    members   map[string]transport.HostRef // key = HostRef.ID; the CONNECT INTENT
    lastState map[string]HostState
    lastErr   map[string]string
    lastProbe map[string]ProbeReport
    subs      map[*Client]struct{}
}

func NewRemoteRegistry(tr RemoteTransport) *RemoteRegistry
func (r *RemoteRegistry) Hosts() []transport.HostRef              // sorted by ID
func (r *RemoteRegistry) Add(h transport.HostRef) error           // rejects an ID containing "/"
func (r *RemoteRegistry) Remove(id string) bool
func (r *RemoteRegistry) Get(id string) (transport.HostRef, bool)
func (r *RemoteRegistry) Note(id string, st HostState, errText string) // sessions report here
func (r *RemoteRegistry) Subscribe(c *Client) func()              // membership change fan-out
```

`Hub` gains `remotes *RemoteRegistry`; `server.Config` gains `Remotes RemoteTransport` (nil ⇒ the
whole feature is inert and `/api/remotes` reports empty lists — which is what a build with no
transport should do).

## B.3 `hostSession` lifecycle

```go
// hostSession is ONE browser's link to ONE host: its daemon connection, its
// state machine, and its backoff loop. Never shared between browsers (D5).
type hostSession struct {
    host    transport.HostRef
    client  *Client
    conn    DaemonConn // nil unless state == connected
    state   HostState
    attempt int
    lastErr string
    retryAt time.Time
    cancel  context.CancelFunc
}
```

State machine:

```
never-connected ──POST /connect──► dialing
dialing ──ok──► connected                      emit host_state{connected}
dialing ──err, never yet connected──► unreachable(err)   STOP. emit host_state{unreachable,error}
connected ──read loop exits──► reconnecting    emit host_state{reconnecting,attempt,retryInMs}
reconnecting ──backoff elapsed──► dialing      retries FOREVER (design "Backoff 1s → 30s, indefinitely")
unreachable ──POST /connect (Retry)──► dialing
any ──POST /disconnect / DELETE──► torn down, cache dropped, no further host_state
```

Backoff: `min(1s * 2^attempt, 30s)` plus up to 500 ms jitter — the same ladder `web/src/ws.ts:19-21`
already uses, so there is one reconnect vocabulary in the product.

`unreachable` vs `reconnecting` is the load-bearing distinction: a host that has **never** worked
stops after one failure and shows the user the raw ssh error (that is the `.r-row.err` row and the
`Retry` button). A host that **was** working retries forever, because its panes are still alive on
the far side.

On successful connect, in order:
1. `sessiond.DialConn(conn)` → `DaemonConn`; `go conn.Run()`.
2. `installHandlers(hostID)` (A.2).
3. Re-assert `c.previewWanted` / `c.sessionStateWanted` (A.5).
4. `ListWorkspaces()` → cache → `emitWorkspaceList(0)`.
5. `emitHostState(connected)`.

On `Run()` exit: mark reconnecting, emit, keep the cached slices, sleep, retry.

`Client.Remove` (`ws.go:719`) cancels every session and closes every conn.

## B.4 `DialFunc` change — exact signature and every call site

```go
// internal/server/daemon.go:45-47  (REPLACES the existing 1-line type)
//
// DialFunc creates a new daemon connection for one browser WebSocket. The zero
// HostRef means the local daemon and MUST behave exactly as it does today; any
// other value names a remote reached through a transport.
type DialFunc func(ctx context.Context, host transport.HostRef) (DaemonConn, error)
```

| # | File:line | Change |
|---|---|---|
| 1 | `internal/server/daemon.go:47` | The type itself, as above. Adds a `context` + `internal/transport` import to the package. |
| 2 | `internal/server/ws.go:483` | `dial DialFunc` field — no textual change, new type. |
| 3 | `internal/server/ws.go:552` `NewHub(dial DialFunc)` | unchanged signature, new type. |
| 4 | `internal/server/ws.go:560` `SetDialer` | unchanged signature, new type. |
| 5 | `internal/server/ws.go:568-576` `Hub.Dial()` | → `Hub.Dial(ctx context.Context, host transport.HostRef) (DaemonConn, error)`. **Production never calls this** — only `hub_dial_test.go` does. Keep it (it is the exported seam) and update the tests. |
| 6 | `internal/server/ws.go:591` `dc, err := dial()` | → `dial(c.ctx, transport.HostRef{})` — the local session. |
| 7 | `internal/server/remotes.go` (new) | `hostSession.dial` calls `dial(ctx, s.host)`. |
| 8 | `cmd/muxterm/main.go:197-201` `newSessiondDialerForSocket` | new signature; returns an error for a non-zero `host` (it is the fixed-socket test seam and has no transport). |
| 9 | `cmd/muxterm/main.go:207-222` `newSessiondDialer` | → `newSessiondDialer(tr server.RemoteTransport) server.DialFunc`; `host.ID == ""` takes today's exact path (`SocketPath` + `DefaultLogPath` + `EnsureDaemon` + `sessiond.Dial`), otherwise `tr.Dial(ctx, host)` → `sessiond.DialConn(conn)`. **`EnsureDaemon` is never run for a remote** — `sessiond-connect` deliberately refuses to spawn one (`cmd/muxterm/sessiond_connect.go:21-24`), so a mistyped host cannot silently start a daemon somewhere unexpected. |
| 10 | `cmd/muxterm/main.go:349` (runLocal) | `srv.Hub().SetDialer(newSessiondDialer(rt))` where `rt := newSSHRemoteTransport()`; also `server.Config{ …, Remotes: rt }`. |
| 11 | `cmd/muxterm/main.go:401` (runServe) | identical. |
| 12 | `internal/server/hub_dial_test.go:11,23,38` | fix the fakes to the new signature. |
| 13 | `internal/server/e2e_test.go:88` | `SetDialer(func(ctx context.Context, h transport.HostRef) (DaemonConn, error) { return sessiond.Dial(sock) })`. |

`newSSHRemoteTransport()` (new, `cmd/muxterm/remote_transport.go`) is the ~30-line adapter that
keeps `internal/server` free of `internal/transport/ssh` and `internal/deploy`:

```go
type sshRemoteTransport struct{ t *sshtransport.Transport }

func (s *sshRemoteTransport) Name() string { return s.t.Name() }
func (s *sshRemoteTransport) Dial(ctx, h) (net.Conn, error)     { return s.t.Dial(ctx, h) }
func (s *sshRemoteTransport) Discover(ctx) ([]transport.HostRef, error) { return s.t.Discover(ctx) }
func (s *sshRemoteTransport) Probe(ctx, h) (server.ProbeReport, error) {
    r, err := s.t.Probe(ctx, h)                 // internal/transport/ssh/provision.go:100
    // map ProbePresent/ProbeLoginShellOnly/ProbeAbsent → "present"/"login-shell-only"/"absent"
    // User is the part before '@' in h.Addr, or "" when the target names no user.
}
func (s *sshRemoteTransport) Install(ctx, h) error {
    d, err := deploy.New(); if err != nil { return err }
    return d.Deploy(h.Addr)                     // internal/deploy/ssh.go:45
}
```

---

# C. `/api/remotes` — full handler spec

New file `internal/server/remotes_api.go`. Registered in `server.go` beside the tunnel routes
(`:172-176`), all six behind the existing `protect()` middleware (`:125-127`):

```go
s.mux.Handle("GET /api/remotes",                    protect(http.HandlerFunc(s.handleRemotesList)))
s.mux.Handle("POST /api/remotes",                   protect(http.HandlerFunc(s.handleRemotesAdd)))
s.mux.Handle("DELETE /api/remotes/{id}",            protect(http.HandlerFunc(s.handleRemotesRemove)))
s.mux.Handle("POST /api/remotes/{id}/connect",      protect(http.HandlerFunc(s.handleRemotesConnect)))
s.mux.Handle("POST /api/remotes/{id}/disconnect",   protect(http.HandlerFunc(s.handleRemotesDisconnect)))
s.mux.Handle("POST /api/remotes/{id}/provision",    protect(http.HandlerFunc(s.handleRemotesProvision)))
```

> `{id}` is `ssh:boxb`. A colon is a legal `pchar` in a path segment and `r.PathValue("id")`
> returns it decoded. Rule P3 (no `/` in a host id) is what guarantees it stays one segment.

## C.0 Shared shapes

```jsonc
// HostRow — the single row shape used by every response array.
{
  "id":        "ssh:boxb",                       // HostRef.ID — the key for every other route
  "name":      "boxb",                           // HostRef.DisplayName — DISPLAY ONLY, never a key
  "target":    "azureuser@20.230.240.43",        // HostRef.Addr → the .r-sub line
  "transport": "ssh",                            // section heading key (ux D7)
  "managed":   true,                             // written by muxterm between its markers
  "state":     "connected",                      // connected|reconnecting|unreachable|never-connected
  "probe":     "present",                        // present|login-shell-only|absent|unknown
  "path":      "/home/azureuser/.local/bin/muxterm", // omitted when unknown/absent
  "error":     ""                                // raw transport error; omitted unless state=unreachable
}
```

```jsonc
// Every 4xx/5xx body.
{"error": "human-readable text, verbatim from internal/sshconfig or the transport"}
```

## C.1 `GET /api/remotes[?probe=1]` → 200

```jsonc
{
  "connected":  [HostRow, ...],   // registry members, state connected|reconnecting
  "discovered": [HostRow, ...],   // ssh-config hosts NOT in the registry; state never-connected
  "errors":     [HostRow, ...]    // registry members, state unreachable; "error" always populated
}
```

Sources: `sshconfig.Manager.List()` (`sshconfig.go:107`) for `managed` + `Others`;
`RemoteTransport.Discover()` (`discover.go:24`) for the candidate set; `RemoteRegistry` for
`state`/`error`/`probe`. `target` for a discovered ssh host is its `HostRef.Addr` (the alias);
for a **managed** entry it is `user@hostname` rebuilt from the `Entry` so the `.r-sub` line shows
something a human recognises.

`probe` is served **from cache only** — a bare `GET` must never block on N ssh round trips and
reports `"unknown"` for anything unprobed. `?probe=1` probes every *discovered* host
concurrently (max 8 in flight, 5 s overall deadline); anything that does not finish stays
`"unknown"`. Only the connect dialog sends `?probe=1`.

All three arrays are always present (never `null`). Zero remotes ⇒ three empty arrays.

## C.2 `POST /api/remotes` → 201

```jsonc
// request
{"name": "boxb", "target": "azureuser@10.4.2.19:2222"}   // name optional
// response
{"id": "ssh:boxb", "name": "boxb", "target": "azureuser@10.4.2.19:2222",
 "action": "created", "backup": "/home/ken/.ssh/config.muxterm.bak"}
```

- `target` parses as `[user@]host[:port]`. `host` is required.
- `name` absent ⇒ derived from the host part, then validated with `sshconfig.ValidateName`
  (`sshconfig.go:366`). Unvalidatable ⇒ **400** telling the caller to pass an explicit `name`.
- Calls `sshconfig.Manager.Add(Entry{Name, HostName, Port, User})` (`sshconfig.go:149`).
  `action` is the returned `sshconfig.Action` verbatim: `created|updated|unchanged`.
- `backup` is `Manager.BackupPath()`, omitted when empty. It is reported on the **failure** path
  too — that is when the user most needs it (`sshconfig.go:86-92`).
- Any `Add` error ⇒ **400** with the message verbatim. `sshconfig`'s errors already explain the
  hand-written-Host collision and the duplicate-marker case in full sentences; do not paraphrase
  them.
- Adding does **not** connect.

## C.3 `DELETE /api/remotes/{id}` → 200

```jsonc
{"id": "ssh:boxb", "action": "removed", "backup": "/home/ken/.ssh/config.muxterm.bak"}
```

Disconnects first (tears down every browser's session, drops merged rows), then
`sshconfig.Manager.Remove(name)` where `name = strings.TrimPrefix(id, "ssh:")`.
**404** when the id is not a muxterm-managed entry — hand-written `Host` blocks are reported by
`List` and are never removed by muxterm (`sshconfig.go:243`).

## C.4 `POST /api/remotes/{id}/connect` → 202

No request body.

```jsonc
{"id": "ssh:boxb", "state": "connecting",
 "probe": "present", "path": "/home/azureuser/.local/bin/muxterm", "user": "azureuser"}
```

The handler probes **synchronously** (one ssh round trip in the good case, 10 s deadline) so the
connect dialog can render its trace from real data, then adds the host to the registry and
notifies every attached `Client` to start a `hostSession`. It does **not** wait for the dial —
the outcome arrives on `host_state` (§D).

- `probe == "absent"` ⇒ still **202**, with `"probe":"absent"`; the session will fail and report
  `unreachable`. The UI should have offered *Install & connect* instead.
- Probe transport failure (host down, key rejected) ⇒ **502** `{"error": "<raw ssh stderr>"}`, and
  the registry records `unreachable` + that error so the settings row shows it.
- Idempotent: connecting an already-connected host is a no-op **202**.

## C.5 `POST /api/remotes/{id}/disconnect` → 200

```jsonc
{"id": "ssh:boxb", "state": "never-connected"}
```

Removes registry membership, cancels every browser's session, deletes that host's merged
workspace/session slices, re-emits the merged documents, and emits a final
`host_state{never-connected}`. The host reappears in `discovered`.

## C.6 `POST /api/remotes/{id}/provision` → 200

"Install & connect". Runs `RemoteTransport.Install` (→ `deploy.Deploy(h.Addr)`), re-probes, and on
`present`/`login-shell-only` performs C.4's connect.

```jsonc
{"id": "ssh:boxb", "probe": "present", "path": "/home/azureuser/.local/bin/muxterm", "state": "connecting"}
```

Deadline 180 s. Failure ⇒ **502** with the deploy error verbatim. `login-shell-only` is
**success**, not a warning: `Transport.Dial` goes through `bash -lc` precisely so that case works
(`internal/transport/ssh/provision.go:31-35`).

---

# D. The `host_state` relay message

**Server → browser only.** It exists solely between the local server and the browser, never on a
daemon socket, which is why it needs no `protocol.go` change. Retries travel the other way as
`POST /api/remotes/{id}/connect` — one door, already idempotent, already authenticated. There is
**no** browser→server direction.

```jsonc
{
  "type":      "host-state",
  "host":      "ssh:boxb",                 // HostRef.ID — the key everything else joins on
  "name":      "boxb",                     // display label
  "target":    "azureuser@20.230.240.43",
  "state":     "reconnecting",             // connected|reconnecting|unreachable|never-connected
  "since":     1757116800123,              // ms epoch this state began → "Disconnected 12s ago"
  "attempt":   3,                          // reconnecting only
  "retryInMs": 4000,                       // reconnecting only; ms from RECEIPT to the next dial
  "error":     "ssh: connect to host old-builder port 22: No route to host" // unreachable only
}
```

- Emitted **once per transition**, plus one frame per registry member immediately after
  `attachClient` so a fresh tab renders host groups without waiting.
- `retryInMs` is a duration, not a deadline: the browser computes
  `retryAt = Date.now() + retryInMs` on receipt and counts down on a local 1 s timer. The server
  does **not** tick a frame per second.
- **No `host_state` is ever emitted for the local daemon.** Local is unmarked (ux D2), and this is
  the mechanism behind the zero-remote gate: a user with no remotes receives zero `host-state`
  frames, so `remotesStore.any === false`, so every consumer short-circuits to today's render.
- Routed in `ws.ts` beside `WorkspacePreview`/`SessionState` (`web/src/ws.ts:582-586`).
  `state.ts:applySessiond` already has `default: return` for unknown types, so the frame is inert
  for the frozen store.

---

# E. `--remote <host>` (CLI)

## E.1 Parsing

`Config` (`cmd/muxterm/cli.go:11-38`) gains:

```go
// Remote names an ssh target to run this subcommand against instead of the
// local daemon. Empty means local. Position is GLOBAL and leading
// ("muxterm --remote boxb pane send ..."), like `git -C`, so it can never be
// confused with a subcommand's own argument -- `pane send --text "--remote x"`
// must keep working.
Remote string
```

`ParseArgs` (`cli.go:67`) peels **leading** `--remote <host>` / `--remote=<host>` tokens before
its `switch args[0]`, then dispatches on the remainder. A `--remote` given to a mode that cannot
use it (`serve`, `local`, `sessiond`, `sessiond-connect`, `deploy`, `install`, `uninstall`,
`doctor`, `mcp`, `amplifier`, `remote`, `version`) is an error:

```
--remote is only valid for the daemon subcommands: workspace, session, pane, layout, read-screen
```

Add to `printUsage` (`cli.go:41-63`), under the command list:

```
Global flags:
  --remote <host>             Run a daemon subcommand against a remote host over ssh
```

## E.2 Threading

All twelve socket-client dial sites already funnel through **one** function,
`dialDaemon()` (`cmd/muxterm/cli_daemon.go:22`), called from `layout_cmd.go:53`,
`pane_cmd.go:{123,226,281,330,391}`, `read_screen.go:56`, `session_cmd.go:72`,
`workspace_cmd.go:{81,136,180}`. Do **not** thread a parameter through twelve signatures for a
value that is fixed for the life of a one-shot process:

```go
// cliRemote is the --remote target for this invocation. Assigned EXACTLY ONCE
// in main(), before any subcommand runs, and never mutated afterwards; a CLI
// process handles one command against one daemon, so a parameter threaded
// through twelve call sites would carry no information this does not.
var cliRemote string

func dialDaemon() (*sessiond.Client, error) {
    if cliRemote == "" {
        // ... today's path, byte-for-byte unchanged ...
    }
    return dialRemoteDaemon(cliRemote)
}

// dialRemoteDaemon reaches the sessiond on target over ssh. It does NOT ensure
// a daemon there: sessiond-connect refuses to spawn one by design, so a
// mistyped host fails loudly instead of starting a daemon somewhere unexpected.
func dialRemoteDaemon(target string) (*sessiond.Client, error) {
    tr := sshtransport.New()
    host := transport.HostRef{ID: "ssh:" + target, DisplayName: target, Addr: target}
    ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
    defer cancel()
    conn, err := tr.Dial(ctx, host)
    if err != nil {
        return nil, fmt.Errorf("muxterm --remote %s: %w", target, err)
    }
    c := sessiond.DialConn(conn)
    go func() { _ = c.Run() }()
    return c, nil
}
```

`main()` sets `cliRemote = cfg.Remote` immediately after `ParseArgs` (`main.go:33-40`), before the
dispatch `switch`.

## E.3 The CLI never namespaces

`--remote` **selects** a daemon; it does not merge two. Every id the CLI prints and accepts is the
remote daemon's own bare id, so `muxterm --remote boxb pane send --workspace w1` consumes exactly
what `muxterm --remote boxb workspace list` printed. **Namespacing exists only at the browser
edge, because only the browser sees more than one daemon at once.** Do not add a prefix here.

`daemonNotRunningMsg` (`cli_daemon.go:16`) stays for the local path; the remote path's error text
already names the host and wraps ssh's own stderr.

---

# F. Frontend — five independently buildable units

**Unit 1 is the gate: it lands first, alone.** Units 2–5 then run in parallel with **disjoint file
ownership** — no two units edit the same file.

| Unit | Owns (exclusively) |
|---|---|
| U1 | `web/src/lib/host-ref.ts` (new), `web/src/lib/remotes-store.ts` (new), `web/src/ws.ts`, `web/src/lib/theme.ts`, the two socket-wiring hunks in `web/src/app.ts` |
| U2 | `web/src/components/mux-sidebar.ts` |
| U3 | `web/src/components/mux-connect-dialog.ts` (new), `web/src/app.ts` (overlay hunks) |
| U4 | `web/src/components/settings-surface.ts` |
| U5 | `web/src/components/mux-dock.ts`, `web/src/components/mux-start-card.ts`, `web/src/components/mux-home.ts` |

Universal rule for every unit: **a workspace id is never displayed raw.** Wherever one is shown,
render `parseHostRef(id).localId`; the host is carried by the group header or the `.badge.host`.
Known display sites: `mux-home.ts:1462`, `:1548`, `:1594`; `web/src/lib/workspace-label.ts:12-16`
(its `replace(/\D/g,'')` would otherwise digest `ssh:boxb/w1` into `1`).

Every unit ends with `cd web && npm run check:fast` at 0 errors.

---

## U1 — parse/format, `host_state` plumbing, remotes store, the token

**Files:** `web/src/lib/host-ref.ts` (new) · `web/src/lib/remotes-store.ts` (new) ·
`web/src/ws.ts` · `web/src/lib/theme.ts` · `web/src/app.ts` (socket wiring only)

**`host-ref.ts`** — mirrors A.1 exactly, rules P1–P6:

```ts
export interface HostRefParts { host: string; localId: string }
export function parseHostRef(id: string): HostRefParts;   // first '/', none ⇒ {host:'', localId:id}
export function formatHostRef(host: string, localId: string): string;
export function isRemoteId(id: string): boolean;          // parseHostRef(id).host !== ''
export function hostSelector(host: string): string;       // `${host}/` — create-workspace only
```

**`remotes-store.ts`** — same shape as `home-sessions.ts` / `preview-store.ts` (class + `subscribe`
+ module singleton), so it is never confused for the frozen `MuxStore`:

```ts
export const HOST_STATE = 'host-state' as const;   // relay-only; NOT a SessiondType

export type HostConnState = 'connected' | 'reconnecting' | 'unreachable' | 'never-connected';

export interface HostEntry {
  id: string; name: string; target: string;
  state: HostConnState; since: number;
  attempt?: number; retryAt?: number; error?: string;   // retryAt = Date.now() + retryInMs
}

class RemotesStore {
  get hosts(): readonly HostEntry[];      // stable, sorted by id
  get any(): boolean;                     // hosts.length > 0  ← THE ZERO-REMOTE GATE
  get(id: string): HostEntry | undefined;
  stateOf(workspaceId: string): HostConnState | null;  // null ⇒ local
  applyHostState(msg: Record<string, unknown>): void;
  forget(id: string): void;
  subscribe(cb: () => void): () => void;
}
export const remotesStore = new RemotesStore();
```

`remotesStore.any` is the enforcement mechanism for invariant 2: **every consumer in U2–U5 starts
with `if (!remotesStore.any) return <today's render>`**, as a single early return that can be read
and diffed at a glance.

**`ws.ts`:**
- `onHostState?: (msg: Record<string, unknown>) => void` alongside `onWorkspacePreview`
  (`ws.ts:144`) / `onSessionState` (`:157`); dispatch at `:582-586` on `raw.type === HOST_STATE`.
- `createWorkspace(name?, clientRef?, host?)` (`:318`) — when `host` is a non-empty string, set
  `msg.workspaceId = hostSelector(host)` (the A.1 P6 host selector). Absent ⇒ the message is
  byte-identical to today's.
- **Read-only-on-drop guard** in `sendPaneInput` (`:193`): drop the frame when the attached
  workspace's host is not `connected`. Behaviour, not copy (ux D8): input during a drop is
  discarded, never queued — replaying keystrokes into a shell that has moved on is how you
  `rm -rf` the wrong thing. This lives here because it is the single choke point all three input
  paths (`app.ts:952`, `:1220`, `:1599`) already pass through.

**`theme.ts`:** one line, immediately after the `--chrome-driver-accent` line (`:346`):

```ts
root.style.setProperty('--remote', 'var(--chrome-driver-accent)');
```

Written as an alias rather than a literal so it follows the palette (light/dark) for free. Custom
properties inherit into shadow roots, so no component needs its own copy. **This is the entire
palette addition.**

**`app.ts`:** two lines beside the other socket callbacks —
`this._socket.onHostState = (m) => remotesStore.applyHostState(m);` — and pass
`e.detail?.host` through the existing `workspace-create` handler into `createWorkspace`.

**Acceptance:** with a remote connected, `remotesStore.hosts` shows one entry that flips
`connected → reconnecting → connected` across an ssh kill; with no remote,
`remotesStore.any === false` and no `host-state` frame ever arrives (check the WS frame log).

---

## U2 — sidebar host groups

**File:** `web/src/components/mux-sidebar.ts` (only)

Rewrites `_renderWorkspaces()` (`:1307-1333`). `_computeCards()` is unchanged except that card ids
are now possibly namespaced; group with `parseHostRef(card.id).host`.

**Zero-remote early return — first statement in `_renderWorkspaces()`:**

```ts
if (!remotesStore.any) {
  // today's exact render: cards.map(...) + the single bottom .new-ws-btn
}
```

Group order: local (`''`) first, then `remotesStore.hosts` order (sorted by id).

DOM per group, classes taken verbatim from the wireframe (`:239-262`, `:434-484`):

```html
<div class="hostgroup">
  <div class="hg-head [collapsed]">            <!-- click toggles -->
    <span class="hg-chev">▾</span>             <!-- rotate -90deg when .collapsed -->
    <span class="hg-dot ok|warn|off"></span>   <!-- connected|reconnecting|never-connected -->
    <span class="hg-name [remote]">boxb</span> <!-- .remote ⇒ tinted with --remote -->
    <span class="hg-needs">✷ 2</span>          <!-- OR --> <span class="hg-meta">reconnecting</span>
  </div>
  <div class="hg-body [hidden] [stale]">
    <div class="stale-banner"><span class="spin">⟳</span><span>Disconnected 12s ago</span>
      <button class="retry-btn">retry</button></div>   <!-- .stale only -->
    …ws-card…
    <button class="new-ws-btn remote">+ New workspace</button>
  </div>
</div>
…
<button class="new-ws-btn">+ New workspace</button>      <!-- bottom = LOCAL -->
<button class="new-ws-btn remote">+ Connect machine</button>
```

Rules:
- **Class reconciliation:** the wireframe calls the dashed button `.new-btn`; the shipped
  component calls it `.new-ws-btn` (`:1329`). **Keep `.new-ws-btn`** and add only the wireframe's
  `remote` modifier (`.new-ws-btn.remote { color: var(--remote) }`, hover border `--remote`).
  Do not rename an existing class.
- **`.hg-needs` only while collapsed** (ux D6): `.hg-head:not(.collapsed) .hg-needs {display:none}`.
  Expanded, the `.ws-needs` pills on the cards already say it.
- `.hg-meta` (`reconnecting`) replaces `.hg-needs` while the host is reconnecting.
- **Remotes collapsed by default**, local expanded. `@state() private _collapsed = new Set<string>()`
  seeded with each remote host id the first time it is seen. No localStorage (YAGNI).
- `.hg-body.stale` when the group's host is not `connected`: cards go `opacity:.5`, dashed
  amber border, canvas `saturate(0) opacity(.45)`. Workspaces **ghost, never vanish** (ux D8) —
  which works precisely because the Go edge retains the cached rows while reconnecting (A.4).
- The `.stale-banner` age is `Date.now() - host.since`; `retry-btn` →
  `POST /api/remotes/{id}/connect`.
- Per-group `+ New workspace` dispatches the existing `workspace-create` event with
  `detail: { host }`. **There is no machine picker** (Decision 3) — the group *is* the choice. The
  bottom button dispatches with no `detail`, meaning local, exactly as today.
- `+ Connect machine` dispatches a new `connect-machine` event (handled by U3).
- Remote cards get the `remote` class (`.ws-card.remote` → `--remote` active border, purple dot,
  purple `.ws-chip .x`).

**Acceptance:** (a) zero remotes — `shadowRoot.querySelectorAll('.hostgroup').length === 0` and the
rendered HTML matches `main`; (b) one connected remote — two `.hg-head`, the remote one carries
`.hg-name.remote` and starts `.collapsed`, clicking toggles `.hg-body.hidden`, the `.hg-needs` pill
appears only while collapsed; (c) the remote group's `+ New workspace` creates a workspace whose id
starts `ssh:<host>/`.

---

## U3 — `mux-connect-dialog.ts` (new component)

**Files:** `web/src/components/mux-connect-dialog.ts` (new) · `web/src/app.ts` (overlay hunks)

`app.ts`: widen `_overlayPanel` (`:626`) to `'settings' | 'shortcuts' | 'about' | 'connect'`, mount
the dialog in the existing `.overlay-backdrop` block (`:1510-1523`), and open it on the
`connect-machine` event from U2.

Markup and classes verbatim from the wireframe (`:333-357`, `:709-746`):

```html
<div class="dialog cdialog">
  <div class="d-header"><h2>Connect machine</h2><button class="close-btn">×</button></div>
  <div class="cd-body">
    <div class="cand [sel]">                       <!-- one per discovered host -->
      <span class="cand-radio"></span>
      <div class="cand-main">
        <div class="cand-name">gpu-01</div>
        <div class="cand-sub">ken@10.4.2.19</div>
      </div>
      <span class="cand-tag">not installed</span>  <!-- probe === "absent" ONLY -->
    </div>
    <div class="divider"></div>
    <input class="ai-input" placeholder="user@host">   <!-- ALWAYS present -->
    <div class="probe">…exactly three lines…</div>
  </div>
  <div class="cd-foot">
    <button class="b-cancel">Cancel</button>
    <button class="b-confirm">Connect</button>
  </div>
</div>
```

- Candidates come from `GET /api/remotes?probe=1` → the `discovered` array. `.cand-name` is
  `name`, `.cand-sub` is `target`.
- `.cand-tag` "not installed" **only** for `probe === "absent"`. `login-shell-only` gets **no**
  tag: `Dial` goes through `bash -lc` precisely so that case works
  (`internal/transport/ssh/provision.go:31-35`). Tagging it would be a warning about a
  non-problem.
- The manual `user@host` input is **always present**, not a fallback (design D7: "manual entry must
  always remain available"). Submitting it does `POST /api/remotes {target}` then
  `POST /api/remotes/{id}/connect`.
- Confirm → `POST /api/remotes/{id}/connect`, then the dialog stays open rendering **exactly three
  probe trace lines**, in this order and no more:

  1. `✓ reachable as azureuser` — from the connect response's `user`; `✗` + the raw error on 502.
  2. `✓ muxterm at /home/azureuser/.local/bin/muxterm` — from `path`; `✗ muxterm not installed`
     when `probe === "absent"`, in which case the confirm button becomes **Install & connect**
     (`POST …/provision`).
  3. `▸ attaching…` → on the first `host-state{connected}` for that host, becomes
     `✓ attached · 2 workspaces, 5 panes` (counts from the merged workspace list, filtered to that
     host).

  `.probe .ok` = `--mux-ok`, `.probe .run` = `--mux-ansi-6`.

  > The wireframe's line 2 reads `✓ muxterm 0.9.2`. **Nothing on the wire reports the remote
  > version** — `ProbeResult` carries a path, not a version — so the line reports the path, which
  > is real. Do not invent a version string; that is exactly the "invisible successes" trap the
  > ux doc's YAGNI pass already threw out.

- On `host-state{connected}` the dialog closes; on `unreachable` it replaces line 3 with the raw
  error and keeps the dialog open with a **Retry** confirm button.

**Acceptance:** `+ Connect machine` opens the dialog with one `.cand` per `~/.ssh/config` host; a
host without muxterm shows `not installed`; connecting a good host renders exactly three `.probe`
lines and then closes, and the host group appears in the sidebar.

---

## U4 — Settings › Remotes pane

**File:** `web/src/components/settings-surface.ts` (only)

Three edits:
1. `:608` — `@state() private _section: 'appearance' | 'notifications' | 'ai' | 'remotes' = 'appearance';`
2. `:1088-1101` — a 4th `<button class="sidebar-item …">Remotes</button>` after AI.
3. The content ternary (`:1103-1108`) — `_renderRemotes()`.

`_renderRemotes()` renders from `GET /api/remotes` (refetched on open, on every `host-state`, and
after every mutation), with these classes from the wireframe (`:494-522`, `:634-700`):

```
.section-title  ("Connected")
  .r-row.connected  > .r-dot.ok   .r-main(.r-name,.r-sub)  .r-btn.danger "Disconnect"
  .r-row.degraded   > .r-dot.warn .r-main(...) .r-state "reconnecting" .r-btn "Retry"
.section-title.section-gap  ("From ~/.ssh/config")
  .r-row            > .r-dot.off  .r-main(...) .r-btn.pri "Connect"
  .r-row            > .r-dot.off  .r-main(...) .r-btn "Install & connect"      ← probe "absent"
  .r-row.err        > .r-dot.err  .r-main(.r-name, .r-sub.err = RAW ssh error) .r-btn "Retry"
.divider
.section-title  ("Add a host")
  input.ai-input placeholder="user@host"
```

Rules:
- Section 1 = the `connected` array. Section 2 = `[...discovered, ...errors]`, sorted by `name` —
  the wireframe shows the error row sitting among the ssh-config rows because that is where the
  host lives.
- Section 2's heading is derived from the row's `transport` field via a label map
  (`{ssh: 'From ~/.ssh/config'}`), one section per transport (ux D7). Today that is one section;
  a second transport adds one without a code change. **This is the only part of the UI that knows
  transports exist.**
- Button per state: connected → `Disconnect` (`DELETE`-free: `POST …/disconnect`);
  reconnecting → `.r-state` + `Retry`; discovered with probe `present|login-shell-only|unknown` →
  `Connect` (`.r-btn.pri`); probe `absent` → `Install & connect` (`POST …/provision`);
  unreachable → `Retry`.
- `.r-sub.err` carries the **raw** transport error string from `HostRow.error`, unedited. `ssh:
  connect to host old-builder port 22: No route to host` is more useful than anything we could
  write about it.
- `Add a host`: Enter → `POST /api/remotes {target}`, then refetch. A 400 renders the returned
  `error` text inline under the input (sshconfig's messages are full sentences written for a
  human).
- Managed rows (`managed: true`) additionally offer a small `Remove` (`.r-btn.danger`) →
  `DELETE /api/remotes/{id}`. Unmanaged (hand-written) rows never do.
- **Zero-remote note:** the Remotes nav item is always present. It is the only way to add the
  first machine, and Settings is explicitly outside the byte-identical gate (invariant 2).

**Acceptance:** the Remotes pane lists every `~/.ssh/config` host; Connect moves a row from section
2 to section 1 with a green dot; killing the link flips it to `.r-row.degraded` with `reconnecting`;
a host with no route renders `.r-row.err` carrying ssh's own message.

---

## U5 — connection-state visuals

**Files:** `web/src/components/mux-dock.ts` · `web/src/components/mux-start-card.ts` ·
`web/src/components/mux-home.ts`

All three start with `if (!remotesStore.any) return <today's render>`.

**`mux-dock.ts`**
- `_paintTab` (`:451-468`): when the attached workspace is remote, prepend
  `<span class="hostpin">boxb</span>` before the title (host name from `remotesStore`, never the
  raw `ssh:` id). While that host is reconnecting the pin becomes `.hostpin.warn` with a `⟳ `
  prefix and `--mux-warn` colours (the wireframe uses an inline style at `:800`; make it a class).
  Tab styling: `.dv-tab.active.remote { border-top-color: var(--remote) }`.
- **dropbar**: a `<div class="dropbar">` between the tab strip and the dock body, present **only**
  while the attached host is not connected (ux D8: the rail appears *only* on drop):
  `<b>⟳ reconnecting</b> · 4s` + `.retry-btn`. The countdown is `Math.max(0, retryAt - Date.now())`
  on a local 1 s interval; `retry-btn` → `POST /api/remotes/{id}/connect`.
- The terminal body is dimmed (`opacity:.45; filter:saturate(.3)`) while dropped. **Input blocking
  is U1's guard in `sendPaneInput`, not a `readonly` attribute here** — the behaviour must hold
  even if a surface forgets the class.

**`mux-start-card.ts`** — the fleet-wide split (ux D5):
- New property: `@property({attribute:false}) split: { name: string; count: number | null }[] = []`.
- Renders `.split` > `.splitrow` > `.nm` + `<b>`; a `null` count renders `.splitrow.unknown` with
  `?`. Empty `split` renders nothing at all, so zero remotes is byte-identical.
- **`?`, never `0`, for a host that is not connected. Zero is a claim you cannot make about a host
  you cannot see** — this is the one extra line of UI the ux doc calls load-bearing.
- `count` stays `needsInputCount()` over the union, so it does not under-report the moment a
  machine connects. The caller (sidebar `render()`, `mux-sidebar.ts:1441-1447`) computes `split`
  from `needsInputByWorkspace()` keyed by `parseHostRef(wsId).host` — a one-expression prop, so it
  does not create a second owner of `mux-sidebar.ts`.

**`mux-home.ts`** — machine is a **property, not a group** (ux D1). Home keeps its
`Needs input / Running / Completed` grouping untouched.
- `.badge.host` on any card/row whose `s.workspaceId` is remote, text = host display name;
  `.badge.host.down` (dashed, amber) when that host is not connected. Sits beside the existing
  `.badge.autonomous` / `.badge.pr` in `.item-head`.
- `.rowc.stale` (dashed, `opacity:.65`) for rows from a non-connected host.
- Meta lines at `:1462`, `:1548`, `:1594` render `parseHostRef(s.workspaceId).localId` — otherwise
  they read `ssh:boxb/w1 · p3`.
- **No fleet strip.** ux open question 2 is unresolved and the sidebar already carries per-host
  needs counts.

**Acceptance:** with a remote attached, its tabs show a `.hostpin`; killing the link makes the
dropbar appear and count down, typing into the pane produces nothing on reattach, the start card
shows `?` for that host, and its Home rows go `.rowc.stale` with a dashed `.badge.host.down`.

---

# G. Acceptance

Per AGENTS.md: **no unit tests.** Both paths below are run by hand (or by an agent's tool calls)
against a real daemon. Fresh workspace and fresh daemon per run — fixture rot rules apply doubly
with two daemons in play.

## G.1 CLI path (`--remote`)

The fixture must be a **genuinely separate daemon**, or the test proves nothing.

> **Trap:** plain `ssh localhost muxterm sessiond-connect` reaches the *same* daemon (same
> `XDG_RUNTIME_DIR`), so both ends hand out identical ids and every namespacing bug is invisible.
> Either use a real second host / DTU container, or use the shim below.

Shim fallback (one file on the "remote" side):

```bash
# ~/bin/muxterm-remote-shim  — a SECOND daemon on the same box
#!/usr/bin/env bash
export XDG_RUNTIME_DIR="$HOME/.muxterm-remote-rt"; mkdir -p "$XDG_RUNTIME_DIR"
exec muxterm sessiond-connect
```

with `sshtransport.Transport{RemoteBinary: "$HOME/bin/muxterm-remote-shim"}` (the transport emits
`'<path>' sessiond-connect`; the shim ignores its argument).

```bash
make build
ssh <host> true                                     # key auth works, no prompt (BatchMode=yes)

./bin/muxterm --remote <host> workspace list         # the REMOTE daemon's workspaces, bare ids
./bin/muxterm --remote <host> workspace create acc-remote
./bin/muxterm --remote <host> pane create --workspace <wsid>
./bin/muxterm --remote <host> pane send --pane <n> --text 'uname -n' --keys Enter
./bin/muxterm --remote <host> read-screen <n>        # ← must print the REMOTE hostname
./bin/muxterm workspace list                         # local list UNCHANGED, remote ws absent
```

Pass conditions: the remote hostname appears in `read-screen`; ids are **bare** (no `ssh:` prefix)
everywhere in CLI output; the local list is untouched; `muxterm --remote nosuchhost workspace list`
fails immediately with ssh's own message and no hang (BatchMode) and never starts a daemon.

## G.2 Browser path (playwright-cli)

```bash
make build && ./bin/muxterm &
playwright-cli open http://localhost:8311
```

**Gate 1 — zero remotes is byte-identical (this gate blocks the merge).**
Before any host is connected, capture and diff against `main`:

```js
// playwright-cli evaluate
[...document.querySelector('mux-app').shadowRoot.querySelectorAll('mux-sidebar')]
  .map(s => s.shadowRoot.innerHTML).join('\n')
```

Must be identical to the same capture on `main`. Also assert: `.hostgroup` count `0`, `.hostpin`
count `0`, `.dropbar` count `0`, `.badge.host` count `0`, `.split` count `0`, and **zero
`host-state` frames** on the WebSocket.

**Gate 2 — connect.** Settings › Remotes (or `+ Connect machine`) → connect the fixture host. The
host group appears with a green `.hg-dot.ok`, collapsed; expanding shows its workspace cards;
preview tiles stream for both hosts simultaneously; the local group is unchanged.

**Gate 3 — remote workspace lifecycle.** The remote group's `+ New workspace` creates a workspace
whose id starts `ssh:<host>/`; attaching opens panes; typing reaches the remote PTY; `uname -n` in
that pane prints the remote hostname; the tab shows a `.hostpin`.

**Gate 4 — collapse/expand (ux D6).** `.hg-needs` shows only while collapsed.

**Gate 5 — drop.** Kill the ssh process (`pkill -f 'ssh .* sessiond-connect'`). Within ~1 s:
`.hg-dot.warn` + `.hg-meta` "reconnecting"; `.hg-body.stale` ghosts the cards **without removing
them**; `.stale-banner` counts up; the dropbar appears and counts **down**; typing into the remote
pane is discarded; the start card shows `?` for that host (not `0`); Home rows go `.rowc.stale`.
The **local** group and its panes are entirely unaffected — that is the two-failure-domains test.

**Gate 6 — reattach.** Let the backoff reconnect (or hit retry). Cards un-ghost, the dropbar
disappears, the pane redraws clean with no garbage, and input works again.

**Gate 7 — unreachable.** Connect a host with no route. Settings shows `.r-row.err` with ssh's raw
error and a Retry button; the sidebar shows no group for it (never-connected hosts live in
settings, ux failure table); no infinite retry loop is started.

**Gate 8 — disconnect.** Disconnect from settings: the host group and its rows disappear (this is
the one case where workspaces *do* vanish, because the user asked), the host returns to
`From ~/.ssh/config`, and the UI returns to the Gate 1 capture.

---

# Build order and parallelization

```
┌──────────────────────────── SEQUENTIAL SPINE ────────────────────────────┐
 S1  hostid.go + remotes.go + DialFunc change + all 13 call sites (§A,§B)
     ⇢ gate: `go build ./...` clean, existing server tests fixed, zero-remote
       browser session still identical (Gate 1 with the old frontend)
 S2  /api/remotes handlers (§C)   +   host_state emission (§D)
     ⇢ gate: all six routes answer with curl; host_state observable in the
       browser's WS frame log
└──────────────────────────────────────────────────────────────────────────┘
              │                                       │
              ▼                                       ▼
        U1  (frontend gate)                     E  --remote CLI  ── fully
        host-ref + remotes-store                   independent of S2 and of
        + ws.ts + theme token                      every frontend unit; can
        ⇢ gate: remotesStore reflects              start as soon as S1 lands
          host_state, `any === false` at zero      ⇢ gate: §G.1
              │
   ┌──────────┼──────────┬──────────┐
   ▼          ▼          ▼          ▼
  U2         U3         U4         U5          ← four agents, in parallel,
 sidebar   connect    settings   state           disjoint file ownership
 groups    dialog     remotes    visuals
```

- **S1 → S2 → U1 is the only hard chain.** Everything after U1 fans out.
- **E (`--remote` CLI) is a genuine second lane**: it depends only on S1's `DialFunc` change (and
  barely even that — it touches `cmd/muxterm` only). Start it in parallel with S2.
- U2/U3/U4/U5 own disjoint files; the only shared file is `app.ts`, whose socket-wiring hunk
  belongs to U1 (already merged) and whose overlay hunk belongs to U3.
- Merge order among U2–U5 is free. Each must independently re-verify **Gate 1** before merging —
  the zero-remote guarantee is the one thing four parallel agents can each break alone.

## Files created

```
internal/server/hostid.go              A.1 — nsID / splitID / validHostID
internal/server/remotes.go             B   — RemoteRegistry, hostSession, HostState, RemoteTransport
internal/server/remotes_api.go         C   — the six handlers
cmd/muxterm/remote_transport.go        B.4 — sshRemoteTransport adapter (ssh + deploy live here)
web/src/lib/host-ref.ts                F/U1
web/src/lib/remotes-store.ts           F/U1
web/src/components/mux-connect-dialog.ts F/U3
```

## Files modified

```
internal/server/daemon.go       :45-47   DialFunc signature
internal/server/ws.go           :41 :54 :218 :235-422 :479-486 :568-576 :581-702 :719-729
internal/server/server.go       :30-61 :157-176   Config.Remotes + six routes
cmd/muxterm/cli.go              :11-38 :41-63 :67  Config.Remote + leading-flag peel + usage
cmd/muxterm/cli_daemon.go       :22      cliRemote + dialRemoteDaemon
cmd/muxterm/main.go             :33-40 :192-222 :337-349 :389-401
internal/server/hub_dial_test.go, internal/server/e2e_test.go   fixed to the new signature
web/src/ws.ts                   :144-157 :193 :318 :582-586
web/src/lib/theme.ts            :346     one line
web/src/lib/workspace-label.ts  :12-16   localId before the digit strip
web/src/app.ts                  :626 :1510-1523 + socket callbacks
web/src/components/{mux-sidebar,mux-dock,mux-start-card,mux-home,settings-surface}.ts
```

## Files deliberately untouched

`internal/sessiond/protocol.go` · `internal/sessiond/client.go` · `internal/transport/**` ·
`internal/sshconfig/**` · `internal/deploy/**` · `internal/mcp/**`.

The transport package needs no change to be used — which was the point of the design, and is the
one claim this plan actually tests.
