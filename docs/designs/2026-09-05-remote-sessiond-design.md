# Remote sessiond

## Outcome

One muxterm instance drives panes living on other machines. The sidebar shows local and
remote workspaces together, the MCP tools address remote panes by id, and `muxterm pane
send` reaches a PTY on another host. Panes keep running when the link drops, because the
daemon that owns them never left.

The premise is not "add networking to muxterm." It is that **the daemon protocol is already
transport-agnostic and nobody noticed.**

## Scope and Non-goals

In scope: making `sessiond.Dial` accept any `net.Conn`, splitting `Server.ListenAndServe`
into a listener-agnostic `Serve`, an SSH transport, edge-side workspace namespacing, and a
flow-control fix that WAN links make mandatory.

Not in scope: a network listener on sessiond, TLS, a token scheme, changes to
`protocol.go`, sessiond-to-sessiond federation, and anything at the PTY layer. PTYs do not
remote; that is what the daemon is for.

## The premise, verified before designing

Before writing any of this, the claim was tested against the running daemon on `vela0` with
**an unmodified `muxterm` binary**. A Python bridge inserted a real TCP hop into the socket
path:

```
muxterm CLI/MCP  →  unix socket (fake)  →  TCP :19999  →  unix socket (real)  →  sessiond
```

pointed at by `XDG_RUNTIME_DIR`, which is the only lever on `SocketPath()` (`spawn.go:22-36`).

```
=== THROUGH TCP HOP ===
created workspace w3 ("wan-proof")     ← control plane
created pane 1 in workspace w3         ← PTY spawn
sent 45 bytes to pane 1                ← input:  keystrokes → TCP → PTY
ken@vela0:~$ echo REMOTE_STREAM_OK-$$; uname -n
REMOTE_STREAM_OK-96234                 ← output: PTY → VTBuffer → TCP → client
vela0
```

Control plane, input, and output all worked with zero code changes. `Client` only ever
needed a `net.Conn` (`client.go:19`); the framing in `protocol.go:11-17` is self-describing
and carries no socket assumptions. **The unix socket is an implementation detail, not a
constraint.**

Two more measurements shaped the decisions below.

**Attach cost is small.** A pane with 20,000 lines of scrollback, attached as `agent` kind
(the kind that does get replay — `ClientKindCLI` skips it, `server.go:198-201`):

| direction | bytes |
|---|---|
| daemon → client | **14,760** |
| client → daemon | 179 |

**Live streaming has no flow control, and the failure is not the one expected.** With the
link throttled to 20 KB/s + 50 ms and `seq 1 400000` (~2.7 MB) blasted into the pane from
the unthrottled side:

| observation | result |
|---|---|
| bytes pushed to the slow client | **2,418,671 over 121 s** |
| subscriber disconnect (`subscriber.go:109-122`) | **did not fire** — 256 frames × 32 KiB ≈ 8 MB of headroom |
| a `get_screen` control call issued during the backlog | **never answered in 100 s** |

The 256-frame overflow disconnect was the predicted hazard. The real one is **head-of-line
blocking**: control replies queue behind bulk pane data in the same stream, so an agent goes
deaf while a noisy pane is talking. Those two numbers sitting next to each other — 15 KB to
resync, 2.4 MB of backlog nobody needed — write D4 by themselves.

## Decisions

### D1. Cut at `sessiond.Dial`, not at `DaemonConn`

Two seams exist. `server.DialFunc` / `DaemonConn` (`internal/server/daemon.go:12-47`) is an
exported 20-method interface, already faked in tests, injected via `Hub.SetDialer`
(`ws.go:560`). It is the *obvious* seam and it is the wrong one: it only remotes the web
relay, and every additive protocol message needs a new method (this already bit
`PreviewSubscribe`).

`sessiond.Dial` (`client.go:131-140`) is ten lines and is the **only** thing binding a client
to a unix socket. Cutting there remotes the web relay, the MCP server, and the CLI in one
move. Since `newSessiondDialer` (`main.go:197`) is fifteen lines that just call `Dial`,
`DaemonConn` comes along for free without being touched.

Server side, `Server.ListenAndServe` (`server.go:73-136`) mixes socket creation, chmod,
peercred, and the accept loop in one function. Split into `Serve(ln net.Listener)`.

`protocol.go` is declared FROZEN v1 (`:230-232`) and **stays untouched**. Authentication and
framing hardening go in a wrapper around the `net.Conn`, never inside the protocol.

### D2. The transport is SSH, and that is not a shortcut

Add `muxterm sessiond-connect`: a subcommand that pipes stdin/stdout to the local unix
socket, roughly forty lines. Locally, `ssh <host> muxterm sessiond-connect` and wrap the
pipe as a `net.Conn`.

The alternative — TCP plus mTLS — needs cert management, a new auth scheme, and a fix to the
unbounded `u32` length in `ReadFrame` (`protocol.go:218-222`) before it is safe to expose.
SSH needs none of it:

- SSH keys become the auth. `ProxyJump`, bastions, `Match` blocks, agent forwarding, and
  hardware keys all work because muxterm shells out to the system `ssh` rather than
  reimplementing it.
- Encryption and host verification are already solved and already audited.
- **`SO_PEERCRED` still passes.** The remote-side pipe runs *as the user*, connecting to a
  *local* socket. `peercred_linux.go:35` compares uids and is satisfied. The daemon-side auth
  problem does not get worked around — it disappears.

That last point is the whole argument. A TCP transport would have to replace peercred
outright (and `peercred_other.go:12` is already a no-op on non-Linux, so there is nothing to
extend). SSH means sessiond never gets a network listener at all.

Reconnect is re-exec'ing `ssh` with exponential backoff. Handshake cost (~200-350 ms) is
paid per connect, not per frame.

### D3. Namespace at the edge; the remote daemon never learns it is remote

`w1` is not globally unique — workspace ids are daemon-global monotonic
(`registry.go:59-72`) and pane ids are workspace-local (`:120-129`). Nothing in the `Message`
envelope carries an origin.

Rather than add one, the local process holds `map[alias]DaemonConn` and rewrites `w1` ⇄
`boxb/w1` on the way out and back. Zero remote-side change, zero protocol change, and the
frozen-v1 promise stays honest.

MCP keeps integer pane ids — agents should not have to parse a host out of `pane://3` — so
the edge allocates local proxy ids and reports the owning host as a separate field in
`list_panes`.

### D4. Overflow policy becomes coalesce-and-resync, and control gets its own lane

Two changes, both justified by the measurement above.

**Control frames get a separate queue** so replies never starve behind bulk pane data. This
is the actual observed failure.

**A backed-up subscriber drops its backlog and gets a fresh `Replay()`** instead of buffering
toward an 8 MB disconnect. For a VT stream the final state is the only semantically required
thing: intermediate bytes exist to *produce* the current screen, and the current screen is
already materialized in `VTBuffer`. Resync costs 15 KB against a 2.4 MB backlog — 160× less
traffic and *more* correct, because the client ends up in the right state instead of a
truthful-but-stale one.

Precedent exists: `enqueuePreview` (`subscriber.go:89-95`) already drops rather than
disconnects. This extends the droppable-frame idea from advisory frames to bulk pane data,
which is safe precisely because replay can reconstruct it.

`VTBuffer.ReplayFrom` ignores its `since` argument (`vt.go:331-336`), so there is no
delta-resume today. D4 makes that acceptable rather than urgent: 15 KB is cheap enough that
full resync is the right primitive.

### D5. One remote conn per browser client — do not pool

Per-pane sizing authority is keyed on `*conn` pointer identity (`pane.go:34-38`, claim at
`:437`, cleared at `:467`). Multiplexing N browsers through one remote connection collapses
them into a single authority holder and silently breaks the multi-client resize model
designed in `2026-07-31-multi-client-resize-focus-authority-design.md`.

Keeping connections 1:1 preserves that model for free and requires no new client identity.

### D6. Add a relay queue between the daemon read-loop and the browser

`OnPaneOutput` (`ws.go:598-609`) writes to the browser WebSocket **inline on the daemon
read-loop goroutine**, with a 5 s per-write timeout. Today a slow browser stalls that
goroutine. With a WAN hop on the other side, a stalled browser write blocks reading from the
remote daemon, which backs up the remote subscriber queue, which eventually disconnects —
a chain reaction across two independent links.

A small queue plus a writer goroutine decouples the hops. Worth doing regardless of remotes.

### D7. SSH config is the entire discovery story

Verified on `vela0`: `~/.ssh/known_hosts` is hashed (`|1|…` entries), so it **cannot** be
enumerated. `Host` blocks in `~/.ssh/config` plus `Include`d files are the only listable
source; everything else is manual entry.

This is not a limitation worth engineering around. Since the transport is the system `ssh`
binary, any alias the user has already configured works, and any host they can type works.

## Components and Boundaries

| Component | Change |
|---|---|
| `internal/sessiond/client.go` | `DialConn(net.Conn)` alongside `Dial(path)` |
| `internal/sessiond/server.go` | `Serve(ln net.Listener)` extracted from `ListenAndServe` |
| `internal/sessiond/subscriber.go` | control lane; coalesce-and-resync overflow (D4) |
| `internal/sessiond/transport_ssh.go` | **new** — `ssh` subprocess as a `net.Conn` |
| `cmd/muxterm/sessiond_connect.go` | **new** — `muxterm sessiond-connect`, ~40 lines |
| `internal/server/remotes.go` | **new** — `map[alias]DaemonConn`, id rewriting (D3) |
| `internal/server/ws.go` | relay queue (D6) |
| `internal/mcp/` | host field on `list_panes`; edge-allocated pane ids |
| `internal/sshconfig/` | **new** — parse `Host` blocks, follow `Include` |
| `protocol.go` | **none** |

## Failure Handling

- **Link drops.** Panes keep running; sessiond owns the PTYs. Workspaces ghost rather than
  vanish. Backoff 1s → 30s, indefinitely.
- **Input during a drop is discarded, not queued.** Replaying keystrokes into a shell that
  has moved on is how you `rm -rf` the wrong thing. The pane goes read-only instead.
- **Remote binary missing.** Detected during the connect probe; offer `muxterm deploy <host>`
  (`internal/deploy/ssh.go`), which already exists.
- **Version skew.** Feature detection stays the existing pattern — send an additive message,
  wait 2 s for a reply (`client.go:43-51`).

## Known filesystem coupling

The daemon assumes it shares a filesystem with its producers. A remote client silently
breaks these, and none are fixed by this design:

- The session-state spool is a local directory (`sessionstore.go:40-84`) written by
  `muxterm session report` and the `hooks-muxterm-session` Amplifier module. Remote sessions
  report into the **remote** spool — correct, but the local Home view only sees them via the
  relay.
- `server.url` hardcodes `localhost` (`spawn.go:233`), so MCP `create_tunnel` opens a tunnel
  on the **local** server even for a remote pane's port. Tunnels should follow the pane's
  daemon; deferred.
- `Pane` restores `cwd` from local paths (`pane.go:161-167`).
- The restore snapshot is a local file (`snapshot.go`).

## Verification

Per AGENTS.md, no unit tests. Verification is a real browser against a real remote daemon.

1. Reproduce the TCP-hop harness above and confirm the walking skeleton over real `ssh`.
2. `playwright-cli` against a two-host setup: remote workspaces appear, keystrokes reach the
   remote PTY, output streams back.
3. Kill the link mid-session; confirm panes survive, cards ghost, reattach replays clean.
4. Re-run the 20 KB/s + 2.7 MB burst; confirm a control call is answered while the backlog
   drains (this is the D4 acceptance test, and it fails today).
5. Fresh workspace and fresh daemon per run — fixture rot rules from AGENTS.md apply doubly
   with two daemons in play.

## Rollout

1. `Serve(net.Listener)` + `DialConn(net.Conn)` — pure refactor, no behavior change.
2. `muxterm sessiond-connect` + SSH transport + `--remote <host>`, single-host, CLI only.
3. Edge namespacing (D3) and the web relay.
4. D4 and D6 — the flow-control work. **Ship before promoting remotes past experimental.**
5. MCP host-aware pane ids.
6. UI, per `2026-09-05-remote-sessiond-ux-design.md`.

## Assumptions and Risks

- **Assumes the same muxterm version both ends.** Protocol v1 is frozen, but nothing
  negotiates today.
- **`ReadFrame` trusts an unbounded `u32`** (`protocol.go:218-222`). Behind SSH the peer is
  authenticated before any frame is read, but the cap is one line and should be added anyway.
- **Latency is not hidden.** Echo is a round trip. At 34 ms this is unnoticeable; at 200 ms
  it will be felt, and no amount of buffering fixes it — only local echo would, which is a
  different and much larger design.
- **Two failure domains, one UI.** The hardest ongoing cost is not the transport; it is that
  every state in the interface now has an "or the host is gone" variant.

## Shared Seams

- `2026-07-31-multi-client-resize-focus-authority-design.md` — D5 exists to preserve it.
- `2026-06-30-native-companion-apps-design.md` — takes the *other* branch: SSH-forward the
  HTTP port so the client is always loopback. That gives remote **access**; this gives remote
  **control**, because `web/src/ws.ts:570` derives the WebSocket URL from `location.host`
  and so a browser tab can only ever address one instance.
- `2026-06-12-sidebar-and-tunnels-design.md` — the sidebar's second section that never
  shipped. `.tab-content` is still named for it.
- `docs/muxterm-client-protocol.md` — the settle barrier and `TotalSeq` contract that D4's
  resync must keep honest.
