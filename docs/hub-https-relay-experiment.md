# HTTPS sandbox relay: first integration increment

Implemented experiment, not Azure attachment or a production broker release.
Normal `muxterm` startup, SSH support, configuration, and PR #150's unsupported
Azure attach remain unchanged. Build and run the separate
`cmd/muxterm-relay-experiment` executable only in an isolated container.

The adaptation design was saved to
`/home/ken/artifacts/hub-sse-sandbox-adaptation.md` before implementation.
Its source is [sadlilas/hub-teamwork PR #279](https://github.com/sadlilas/hub-teamwork/pull/279),
`docs/optional-sandbox-sessions.md` at
`81c477a6472b85a601e7b64ba9402b1406976319`.
`kenotron-ms/hub-teamwork` also exists, but its inspected main
`55872e85a469a1ac585e6ca7c39aed334c03c93f` lacks that document. The inspected
sadlilas main is `6946a534c59f48afba45ca3ecd83299b3d118e47`: its gateway is
identical to the kenotron-ms snapshot, while app code and docs differ.
The Hub proposal is not an already deployed relay implementation.

## What works in this increment

A reference broker authenticates two separate preconfigured capabilities for
one sandbox binding. The worker initiates HTTPS long-polls and output POSTs.
The local transport initiates input POSTs and output SSE GETs. Neither side
requires an inbound Internet listener. There is no WebSocket upgrade on the
sandbox or broker path and no dependence on Azure WSS ingress working.

```
browser -- existing WebSocket --> muxterm experiment serve
                                   | POST input / GET SSE output
                                   v
                              HTTPS broker
                                   ^
                                   | worker POST output / GET commands
                          outbound worker
                                   | one private Unix socket per connection
                                sessiond --> PTYs
```

`relay.Transport` provides the existing binary `net.Conn` contract.
`sessiond.DialConn`, `server.hostSession`, host-qualified workspaces, per-tab
attach/replay and the browser terminal are reused. The `mcp` mode injects the
same transport into the existing machine tool registry, including
`list_machines`, `read_file` and `list_dir`. Files are read by the remote daemon;
there is no new file proxy. The experiment exposes local plus one relay host;
composing SSH and relay discovery in normal muxterm is deferred.

## Input safety contract

Each process start gets a random 192-bit worker boot ID. Each client Dial gets
a random 192-bit connection ID. A connection owns exactly one Unix socket.
Worker registration fences all previous connections. Broker restart loses all
connections and requires a fresh worker registration. No pending input is
restored from disk, and no old connection is reopened on another socket.

For each connection, one serialized client writer numbers byte batches from 1.
Batches contain up to 64 KiB decoded bytes, encoded as base64 by Go's JSON
encoder. Broker input handling permits only the next sequence or an identical
retry. It compares SHA-256 content for acknowledged retries and exact bytes
for the pending batch. Gaps, conflicting repeats and closed connections are
rejected. Only one batch per connection is pending at a time.

**The worker also deduplicates, independently of broker deduplication.** Its
single command loop checks sequence and content before writing. Exactly the
next sequence is written once to that connection's Unix socket, with a
five-second deadline. Only a complete write advances the cursor. Repeating the
last sequence with identical content sends the same acknowledgement without
writing again. A conflict, partial write or write failure fences the channel.
Duplicate open commands never recreate a closed socket.

Worker acknowledgement means bytes reached the Unix stream, not that a shell
command completed. There is an unavoidable crash window between Unix write
and worker acknowledgement. If the worker crashes there, restarting it creates
a new boot and fences all old IDs. The client receives a reset; the original
input is **not** retried into a fresh connection. Users must inspect remote
state to determine whether a command ran. This is ordered, deduplicated
same-connection delivery with explicit uncertainty on crash, **not exactly-once
shell execution across crashes**.

The `net.Conn` has socket-like buffered acceptance: a successful Write does
not prove shell execution or receipt of a worker acknowledgement. Failure
returns `ErrReset`, explicitly naming uncertain input delivery. Existing MCP
connection eviction fails the in-flight call rather than replaying it; the
browser host session reconnects and reattaches to the surviving PTY. No new
browser acknowledgement or uncertainty indicator is implemented in this slice.

## Output, bounds and failure behavior

The worker uploads sequential output batches. The broker deduplicates them,
retains them until client consumption acknowledgements, and emits SSE IDs.
The Go reader reconnects with its last consumed sequence in `?after=`. It
preserves partial frame state and never passes replayed bytes twice to the
same reader. No SSE cursor is reused for a new daemon connection.

Output retention is bounded to 4 MiB per connection. There are at most 16 live
connections and 256 connection records including tombstones per broker run.
The worker retains at most 256 socket/cursor records. A 30-second lease bounds
idle connections and absent workers; a sweeper enforces it without requiring
another HTTP request. SSE heartbeats occur at ten-second intervals and GETs
rotate within 25 seconds. HTTP POST retries are bounded to 20 seconds.
Oversized output backlog closes only that subscriber. The shell/sessiond
process is not killed. The existing daemon also bounds its subscriber queue.

The local transport checks the sessiond frame length **before exposing its
header to sessiond.ReadFrame**, which otherwise allocates from the peer's
announced length. The experiment permits at most 8 MiB per frame and does not
buffer a complete frame. Chunk bounds alone would not prevent a hostile
length prefix from causing a large allocation.

State is intentionally in memory. Broker or worker restart resets epochs;
there is no claim of durable, multi-replica replay. The worker exits on a
failed control poll/ack, closing its sockets; restarting it is a supervisor
operation. Same-epoch SSE and POST interruptions can recover, while uncertain
endpoint state causes a reset and normal daemon attach/screen replay.

## Authentication and execution boundary

The role-specific config file must be a private regular file (no group/other
permission bits). Client and worker capabilities are distinct, at least 32
characters, and never appear in URLs, command arguments, browser state or logs.
The broker is configured with both; each endpoint gets only its own.
Authentication checks precede route handling. Wrong role, wrong host binding,
expired connection ID, cookies and browser Origin headers are rejected.
HTTPS certificate/hostname validation is enabled; redirects and ambient HTTP
proxies are disabled. No Azure/user/cloud administrative token enters the
sandbox. A compromised worker can disrupt its one binding, but cannot request
local-machine daemon operations through this protocol.

This static single-owner capability setup is intentionally not production
identity. There is no Entra issuance, credential expiry/renewal, resource
attestation or automatic enrollment. The broker sees terminal/file bytes.
Do not use real credentials or sensitive work in this experiment.

The executable refuses to run outside a container and requires `--experimental`.
Its browser server binds an explicit loopback IP and runs without login **only
inside that disposable container**. It does not load production configuration,
spawn a daemon automatically, or write the MCP handoff file. Every daemon
socket is explicit. The optional plaintext broker listener must be loopback
behind a TLS proxy; alternatively provide both `--cert` and `--key`.

## Running and verification

Build from a source worktree without replacing installed binaries:

```
cd web
npm ci
npm run build
npm run check:fast
cd ..
go build -o /tmp/relay-experiment ./cmd/muxterm-relay-experiment
go build -o /tmp/relay-sessiond ./cmd/muxterm
go vet ./...
```

Use a dedicated DTU, not a host scratch server. The verification fixture uses:

- `/opt/relay/bin/relay` and `/opt/relay/bin/muxterm`: transferred built binaries.
- nginx TLS on 443 to loopback broker 18080, buffering disabled for SSE.
- Trusted test certificate with SANs `127.0.0.1` and `10.222.0.1`.
- Network namespace `relay-worker`, address `10.222.0.2`, with no default route;
  only outbound TCP443 to peer `10.222.0.1` is allowed. Unsolicited inbound and
  IPv6 traffic are blocked; established replies and loopback are permitted.
- A private mount namespace for the remote sessiond's `/tmp`, so a marker can
  exist remotely and be absent from the local daemon's filesystem.
- Chromium and Playwright CLI for the real browser at DTU `127.0.0.1:8313`.

The executable modes are `broker`, `worker`, `serve`, and `mcp`, selected by
`--mode`, with `--config <private-json-path>`. Worker and serve also require
`--socket <absolute-private-socket>`; serve requires `--addr 127.0.0.1:8313`.
Config schema:

```
broker: {"host":"sandbox:fixture","clientToken":"<random-client-capability>","workerToken":"<different-random-worker-capability>"}
client: {"host":"sandbox:fixture","url":"https://127.0.0.1","token":"<client-capability>"}
worker: {"host":"sandbox:fixture","url":"https://10.222.0.1","token":"<worker-capability>"}
```

`tools/https-relay/start-fixture.py` creates fresh private configs and starts
only DTU-owned processes. It refuses fixture reuse and records exact PIDs for
cleanup. `mcp-smoke.py` drives real MCP, creates a real shell, and verifies
remote marker/file/directory/screen behavior, including local absence.
Browser verification uses the repository's real-user scenario, adjusted for
the current sidebar, against the DTU URL. These are integration runs, not unit
tests or fake sessiond responses.

After browser verification, put `fault-proxy.py` on loopback18081 and change
**only the DTU nginx upstream** from18080 to18081, then reload that DTU nginx.
Run `fault-verify.py`. It forces worker command redelivery, loss of the client
input response after acknowledgement, SSE disconnect, and a worker crash after
Unix write but before broker acknowledgement. Actual shell files must contain
one side effect, not two. It also checks auth, out-of-order rejection, closed
IDs and broker restart fencing. The proxy's fault-control endpoint exists only
in this test helper, never in the broker. It does not log payloads or tokens.

Destroy the exact DTU created for the run. Never discover and stop processes
by name on the host. No verification here provisions or bills Azure.

## Not covered

Production broker integration, Azure egress behavior, Entra authorization,
image/disk provenance, automated registration, sandbox CRUD/attach UI, suspend
and resume, cleanup while the local owner is offline, durable/replayed input
across a crash, multi-replica operation, end-to-end encryption, remote preview
ports, and SSH+relay aggregation in normal muxterm are outside this increment.
A successful isolated run is not evidence that Azure or the deployed owned
broker is configured for this transport.


## Recorded verification (2026-09-20)

On an isolated DTU with real TLS, the restricted network namespace and private
remote `/tmp` described above:

- MCP machine discovery and real shell/file/directory/screen operations passed;
  the remote marker was absent through the local daemon.
- Real Chromium keyboard input, refresh/replay, split persistence, resize and a
  second browser attachment passed.
- Worker command redelivery and loss of a successful client input response each
  produced one shell side effect. Cutting SSE recovered the existing connection.
- Killing the worker after Unix write but before broker ACK, then restarting it,
  produced no repeated shell side effect. Broker restart fenced old channel IDs.
- Invalid/cross-role credentials, wrong binding, out-of-order input and input on
  closed connections were rejected.
- `go build ./...`, `go vet ./...`, frontend build and `npm run check:fast` passed
  (zero errors; existing frontend warnings).

The full historical browser scenario is not all green: deleting the selected
pane then refreshing leaves a stale active pane ID. The same failure reproduced
on a fresh local workspace without the relay. Historical tab width/dock-bar
expectations also differ from the current UI. These are recorded limitations,
not fixes claimed by this transport increment. Attention checks used the current
store API and do not establish terminal BEL transport. Azure and regional
latency/load behavior were not tested.
