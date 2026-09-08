# amplifier-sandboxes: running Amplifier sessions in hosted Azure sandboxes

Status: design. Nothing implemented, nothing provisioned.
Date: 2026-09-08. Author: design lane, branch `design/amplifier-sandboxes`.
Baseline: muxterm `origin/main` @ `50cc66f` (post #90, #92, #93). Running release v0.25.0.

## Evidence key

Every claim below carries one of three labels. They are not decoration; the
transport verdict turns on which label a claim has.

- **[VERIFIED]** — I ran the command or read the bytes myself, in this session, on this machine, on 2026-09-08.
- **[READ]** — I read it in a document or source file and cite the file and line. True as written; I did not re-execute it.
- **[INFERENCE]** — a conclusion I drew. Stated as such, with the evidence it rests on.

---

## 0. The reference repository: it exists, and it is private

**`github.com/kenotron-ms/amplifier-sandboxes` exists and is private.** [VERIFIED]

```
createdAt   2026-08-11T03:58:43Z
pushedAt    2026-08-26T23:44:17Z
isPrivate   true
description Amplifier Sandboxes: durable cloud sandboxes for Amplifier CLI
            sessions via Azure Container Apps
```

An anonymous fetch returns 404 because it is private, not because it is
missing. This is not a greenfield design. The repo is a substantial, live,
bug-fixed system — the last twenty commits are a real production trail
(tmux quoting bugs, exit-code capture, IPv4 preference for `api.anthropic.com`,
an empty `ANTHROPIC_BASE_URL` interpolating to `base_url=""`), each paired
with a commit rolling the fix onto the live default sandbox disk. [READ]

What it already built, and what it did not:

| Area | State |
|---|---|
| Substrate | `Microsoft.App/sandboxGroups@2026-02-01-preview` — ACA **Sandboxes**, explicitly not Dynamic Sessions, not ACI, not VMs (`infra/resources.bicep:86`) [READ] |
| Broker | FastAPI Container App `ca-broker-sandboxes`, hosted at `https://sandboxes.amplifier.ms`, five MCP-ish tools: submit/status/list/logs/destroy [READ] |
| Client attach | **HTTP polling of a captured tmux pane.** Its own CLI says so: "This is not a real pty — it's the broker-mediated equivalent (design §7.1 has no exec-proxy endpoint)" (`cli/src/amplifier_app_remote/cli.py:920-926`) [READ] |
| Key custody | Per-user Key Vault secret keyed on Entra `oid`, read-only tmpfs mount, never an env var; verification PASSed on leak and mount, scope-limited on suspend (`docs/evidence/2026-08-10-key-custody-verification.md`) [READ] |
| Port transport | Six documents, five branches, one campaign — **zero live evidence produced** (see §2.3) [READ] |

The single most useful thing this repo tells muxterm is a negative: **its
"attach" is not a byte stream, and it knows it.** The team already identified
the gap, opened a proof campaign to close it, and the campaign never produced
live evidence. That gap is precisely the seam muxterm needs, and §2 answers it
from a different direction than the campaign took.

### 0.1 The reference design's central difficulty — and why muxterm does not have it

`docs/designs/amplifier-sandboxes-design.md` is 275 lines, marked **DESIGN
APPROVED** as of 2026-08-10, and its §1 names the problem everything else in it
descends from [READ, `:17-25`]:

> **The central difficulty is three mismatched lifetimes** […] Work: hours to
> multiple days. Token: ~60–90 minutes. MCP connection: minutes to hours; dies
> on client sleep, network change, token expiry. […] The load-bearing
> requirement: **work must survive client disconnect, client sleep, and token
> expiry.**

Read that against muxterm and the conclusion is immediate: **muxterm already
solves this, structurally, and did before this feature was conceived.** sessiond
is a persistent daemon; panes outlive every client. The byte stream is a client
connection, not the session. So the requirement that forced the reference system
into a broker, a durable registry, an LRO poller, idempotency keys and
"transport disconnect never implies cancellation" (`2026-08-25-…-design.md:78`,
decision D-14) [READ] is satisfied here by construction, with no new machinery.

That is the strongest architectural argument in this document, and I did not
have it until I read their design. It also **reverses the burden of proof on
§6.2**: not building a broker is not muxterm being lazy, it is muxterm already
owning the durability the broker exists to provide.

The same read produced five corrections to what I had written, each marked
**[correction, from reference design]** at its point of use, and traced in
Appendix C. Two of them were outright errors on my part (§5.2, §2.4).

Two neighbours worth naming: `kenotron-ms/amplifier-remote-dtu` (private,
pushed 2026-08-26) and `kenotron-ms/agent-sandbox` (private). Not read; noted
so nobody thinks they were missed.

---

## S1. MVP — and whether this is worth building at all

### S1.1 The question that decides it

> What does a hosted Azure sandbox give a user that an ssh machine does not
> already give them today, given that machine-scoped tools shipped and work?

**Honest answer: no new muxterm capability whatsoever. Four things that are
not capabilities, and one of them is worth paying for.**

`res0` is reachable from here today, `list_machines` enumerates it,
`spawn_lane` starts sessions on it, `read_file` reads its disk. Everything
`machine:"sandbox:…"` would do, `machine:"res0"` already does. A sandbox adds
zero tools and zero verbs.

What it adds instead:

1. **Elastic capacity without owning a box.** You cannot get the eleventh
   machine out of a fleet of ten. Cold boot is documented at **< 2 s**
   ([sandboxes.azure.com/docs/sandboxes/limits](https://sandboxes.azure.com/docs/sandboxes/limits), checked 2026-09-08) [READ] — faster than provisioning anything else Azure sells.
2. **Blast-radius isolation that ssh structurally cannot give.** An ssh host is
   a real machine with the user's real keys, real `~`, real git credentials,
   real everything — `res0` included. A sandbox is a fresh container with a
   per-sandbox managed identity and a first-class **egress policy** (the API
   carries `EgressPolicy`, `EgressRule`, `EgressHostRule`, `EgressRuleAction`,
   `EgressSecretRef`) [VERIFIED — struct names present in the `aca` binary].
   ssh has no analogue. For **unattended agent lanes** — which is exactly what
   `spawn_lane` creates — this is a materially different safety story, and it
   is the one thing on this list that ssh cannot be made to do.
3. **Snapshot and commit.** `aca sandbox snapshot`, `aca sandbox commit`
   ("Save sandbox state as a reusable disk image") [VERIFIED — `aca sandbox --help`].
   Resume from snapshot documented at **< 100 ms** [READ]. No ssh analogue.
4. **Nothing to maintain.** No patching, no disk filling up, no "res0 is one
   release behind" (which it is).

### S1.2 Cost it

ACA Sandboxes have no separate meter. The pricing page states verbatim: *"Azure
Container Apps Express and Sandboxes follow the same pay-per-second pricing as
Consumption Plan."* ([azure.microsoft.com/en-us/pricing/details/container-apps/](https://azure.microsoft.com/en-us/pricing/details/container-apps/), checked 2026-09-08) [READ]

West US 2, Consumption active rates: **$0.000034 / vCPU-second**,
**$0.000004 / GiB-second** [READ, Azure Retail Prices API, checked 2026-09-08].
The SDK default sandbox is 1 vCPU / 2 GiB [READ].

```
per second   = (1 × 0.000034) + (2 × 0.000004) = 0.000042
per hour     = 0.000042 × 3600                 = $0.1512
```

**$0.1512 per sandbox-hour.** Free grant: 180,000 vCPU-s + 360,000 GiB-s per
subscription per month = exactly **50 hours/month** free at this shape [READ].

The arithmetic for a plausible pattern — the user's actual pattern is parallel
`/goal` lanes, so price ten of them:

| Pattern | Sandbox-hours | Sandbox cost | One B2s VM + 64 GB Standard SSD |
|---|---:|---:|---:|
| 1 lane, 8 h × 22 d | 176 | $26.61 (**$19.05** after grant) | $12.12 |
| **10 lanes, 8 h × 22 d** | **1,760** | **$266.11** ($258.55 after grant) | **$35.17** (all ten on one box) |
| 1 sandbox, 24×7 | 730 | $110.38 | $35.17 |

B2s at $0.0416/h, 64 GiB Standard SSD E6 at $4.80/mo [READ, retail API].

**Ten parallel lanes cost ~7.5× more as sandboxes than as ten tmux panes on one
$35 VM.** That number is the whole argument. Auto-suspend at 300 s idle [READ]
softens it — a lane that thinks for 40 minutes and idles for 20 bills less —
but it does not change the order of magnitude.

### S1.3 The verdict

**Conditionally worth building. The condition is one cheap experiment, and the
scope is one use case.**

Not worth building as a general ssh replacement. On raw throughput-per-dollar
ssh wins by 7×, and it wins today with zero new code. Anyone framing this as
"sandboxes instead of ssh" should be talked out of it.

Worth building as **the isolated-lane transport**: the place you send an
unattended agent you do not fully trust, with an egress policy, a disposable
identity, and a destroy button. That is a capability muxterm does not have and
cannot get from ssh, and §2 shows the code cost is genuinely small.

The condition: **§2.5's live probe must pass first.** If ACA Sandboxes' exec
stream cannot carry a binary-clean byte stream, this collapses to "shell out to
`aca` and poll a tmux pane" — which is what `amplifier-sandboxes` already built,
which its own CLI calls "not a real pty", and which is not worth rebuilding
inside muxterm. **Do not write transport code before the probe returns.**

### S1.4 The MVP

**The one scenario that must work end to end:**

> From this machine, `list_machines` shows a sandbox alongside `local` and
> `res0`. `spawn_lane(machine:"sandbox:…", workspace:"x", harness:"amplifier",
> prompt:"…")` starts an Amplifier session inside it. `fleet_status` reports
> that session tagged with its machine. `get_screen` shows its output. When the
> work is done, one command destroys the sandbox and the bill stops.

That is one scenario, and it is nearly all of muxterm's remote surface, because
it all rides on `Dial`.

**In the MVP:**

- `internal/transport/sandbox` implementing `transport.Transport` (§2.2).
- One sandbox group, from config. One user. West US 2.
- A `muxterm-sandbox` image with muxterm pre-installed, pinned by digest.
- `Discover` lists the group. `Provision` probes the version and refuses skew.
- Entra auth via `az account get-access-token`, following `internal/voice`.
- `muxterm sandbox create|list|destroy` CLI verbs; MCP `create_sandbox` /
  `destroy_sandbox`; every existing machine-scoped tool works unchanged.

**Deliberately excluded from the MVP — each of these is a decision, not an oversight:**

- **The broker.** muxterm talks to the ADC data plane directly, exactly as the
  ssh transport shells out to `ssh` rather than reimplementing it
  (`internal/transport/ssh/ssh.go:2-9`). Standing up a second hosted control
  plane inside muxterm is the largest available mistake here. See §6.2.
- **Multi-user, multi-tenant, RBAC.** One user, this user.
- **Cost display and budgets.** §3.4 shows runtime only, never a dollar figure.
- **Suspend/resume as a muxterm verb.** The platform auto-suspends; muxterm
  reconnects. Manual suspend is a release-2 nicety.
- **Snapshots and `commit`.** The most interesting Azure feature here, and it
  earns nothing until basic dialling works.
- **Port exposure.** The MVP uses the exec stream, not an exposed port (§2.3).
  No inbound ingress is created at all, which is also the safest posture.
- **Changing `close_workspace` / `close_pane`.** Unchanged. §5.5.
- **Changing the ssh transport.** Read as reference; not touched.

**Release 2:** an explicitly **mounted workspace volume**, so a lane's working
set survives sandbox loss and preview-to-GA recreation. **[correction, from
reference design]** I originally put snapshots here; volumes come first, because
a snapshot of a preview-era sandbox is exactly what GA may invalidate, and their
§7.6 names the mounted volume as the structural hedge for precisely that (§5.7).
Snapshot and `commit` follow once there is something durable underneath them.
**Release 3:** declarative egress policy per lane — the actual isolation
payoff, and the reason §1.1 item 2 is the one worth paying for.

---

## S2. Architecture — and the transport verdict

### S2.1 The bet, tested first

`internal/transport/transport.go:4-10` states the contract verbatim:

> muxterm needs exactly one thing from a remote: a bidirectional, binary-clean
> byte stream to a Unix socket inside the far machine. How that stream is
> obtained — an ssh subprocess, a WebSocket to an authenticated ingress, **an
> exec API** — is not muxterm's business […] sessiond.DialConn turns one into a
> working client.

And `transport.go:33-35` already writes the answer down:

> ID is the stable, transport-qualified identity of this host, e.g.
> `"ssh:boxb"` or **`"sandbox:cb997d3d-…"`**.

The interface was written with this feature in view. The bet is whether the
foresight holds.

### **VERDICT: the bet holds, with one property unproven and one that must grow.**

| Property | Fits as written? | Verdict |
|---|---|---|
| Stream acquisition | Yes, mechanism identified | **Strong evidence, not live-proven.** §2.2 |
| Peer identity | Yes, but the enum is too narrow to be honest | Declare `IdentityPeerCred`; §2.4 |
| Discovery | Yes — with one broken assumption downstream | §2.4 |
| **Provisioning** | **No.** `Provision` cannot create a host | **Must grow — additively.** §2.4 |
| Liveness | Yes, but the failure mode is new | §2.4 |

Four of five fit. The fifth does not, and the growth it needs is a *new optional
interface*, not a change to `Transport` — so ssh is untouched and nothing above
`internal/transport` learns a new concept.

### S2.2 Stream acquisition: `/exec/stream`, a WebSocket that carries stdin

This is the load-bearing finding, and I got it by reading the shipped Azure CLI
rather than by trusting any document.

`/usr/local/bin/aca` is present on this machine — `aca 1.0.0-preview.1`, a
stripped Rust ELF binary [VERIFIED]. `aca sandbox shell` is documented in its own
help as *"Open an interactive shell in a sandbox"*, taking `-c/--command` with
default `/bin/bash` [VERIFIED]. An interactive shell needs a channel that
carries stdin. Extracting the binary's string table shows exactly what that
channel is [all VERIFIED]:

| String found in `/usr/local/bin/aca` | What it establishes |
|---|---|
| `tokio-tungstenite-0.29.0`, `tungstenite-0.29.0` (many source paths) | A full WebSocket **client** is statically linked in |
| `wss://` | It dials WSS |
| `WebSocket connections require an HTTPS endpoint. Refusing to send credentials over plaintext.` | An **aca-authored** error, not a library string — aca deliberately opens an authenticated WSS connection and guards the credential |
| **`/exec/stream`** | A streaming exec endpoint, distinct from… |
| `/executeShellCommand` | …the one-shot endpoint the Python SDK wraps |
| `struct WsInMessage with 3 elements` | An aca-authored serde struct for WebSocket **input** messages |
| adjacent table run: `stdin` `resize` `width` `height` `command` `environment` `tty` | The vocabulary of a PTY-over-WebSocket protocol |
| `https://management.azuredevcompute.io` | The ADC data-plane host |
| `https://dynamicsessions.io/.default` | A token scope, alongside `https://management.azure.com/.default` |
| `Microsoft.App/sandboxGroups`, `2026-02-01-preview` | Provider and API version |
| `azure-containerapps-sandbox`, `0.1.0-beta.1` | The Rust SDK, beta |

**Conclusion: ACA Sandboxes expose a bidirectional, stdin-carrying, Entra-
authenticated WebSocket exec channel at `/exec/stream` on
`management.azuredevcompute.io`.** That is precisely the third case
`transport.go:6-7` names. [INFERENCE, from VERIFIED strings — strong: a
WebSocket library, a `wss://` scheme, an input-message struct, a `/exec/stream`
path and an interactive-shell subcommand do not co-occur by accident.]

Two consequences that shape the implementation:

**(a) `tty` is a field, so `tty:false` is requestable — and it must be.**
`internal/transport/ssh/ssh.go:119-121` records the hazard in the ssh transport:

> `-T`: never allocate a pseudo-terminal. A PTY would apply ONLCR and turn every
> 0x0A in the framed protocol into 0x0D 0x0A, silently corrupting the stream.

The identical hazard exists here and has the identical fix. `tty:false` is this
transport's `ssh -T`. Getting this wrong produces a stream that works for
twenty minutes and then desynchronises permanently.

**(b) The envelope is JSON, so the stream is framed, not raw.**
`WsInMessage` is a serde struct, and `base64` is in the string table
[VERIFIED]. So bytes are almost certainly base64 inside a JSON envelope
[INFERENCE]. `Dial` must therefore wrap-and-unwrap rather than hand the socket
straight over. That is bounded work with an exact precedent: `sshConn`
(`internal/transport/ssh/conn.go:32-46`) already adapts something that is not a
socket — a pair of subprocess pipes — into a `net.Conn`, and states its own rule:
*"Nothing here interprets the bytes."* `sandboxConn` does the same job with a
codec instead of pipes.

**What is NOT proven:** I did not open one. Opening a `/exec/stream` requires a
running sandbox, and creating one is explicitly out of scope for this round.
The exact JSON schema, the base64 details, the URL path template, the idle
timeout and the maximum stream duration are all **unknown**. §2.5 is the
experiment that closes this, and §1.3 makes it a precondition.

### S2.3 Why not the exposed port — and what the campaign actually showed

The obvious alternative is `add_port` + a WebSocket relay inside the sandbox.
Rejected for the MVP, on three findings:

1. **Sandbox ports are HTTP-only.** `SandboxPort.protocol` is
   `Literal["Http", "Http2"]`. There is no `Tcp` value and no documented raw-TCP
   sandbox ingress [READ, portal SDK reference, checked 2026-09-08]. So a port
   buys an HTTP proxy, not a socket.
2. **WebSocket support on that ingress is undocumented — a silence, not a "no".**
   Zero occurrences of "WebSocket", "Upgrade", "101" or "SSE" across the Learn
   sandbox pages, the portal ports guide, the SDK reference, or the public ARM
   spec [READ, checked 2026-09-08]. Regular ACA ingress *does* document
   WebSocket and gRPC and a 240 s request timeout
   ([learn.microsoft.com/en-us/azure/container-apps/ingress-overview](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview), updated 2026-08-31) — but that is a
   **different ingress**: sandbox ports default to `*.{region}.adcproxy.io`, and
   only migrate to `*.{region}.azurecontainerapps.io` after an irreversible
   opt-in to an Express environment [READ]. Conflating the two would be the
   easiest mistake in this document to make.
3. **The reference repo's own campaign never answered it.** Six evidence
   documents across five branches (`goal/gb-agent-sessions-g0…g0e`), and the
   final record states `live_invocation_count: 0`, `azure_external_calls: 0`,
   `endpoint_created: false`, `transport_verdict: BLOCKED`
   (`docs/evidence/2026-08-26-agent-port-transport-g0e.md:9-16,340`) [READ].
   **Zero sandboxes created, zero ports exposed, zero bytes exchanged.** Every
   named blocker was procedural — a `/tmp` symlink on macOS, a missing `ty`
   binary, a probe that omitted `--revision`, an internal budget rule, and
   finally a goal spec that asserted a commit SHA where a blob SHA was required
   [READ]. **Not one blocker demonstrates an Azure limitation.** The question is
   open, not answered.

Choosing `/exec/stream` over the port therefore also avoids creating any
inbound ingress at all — see §5.3, where that is the stronger argument.

**The reference design chose the opposite, deliberately, and it was right to.**
`docs/designs/2026-08-25-amplifier-agent-sandbox-service-design.md:51` states
[READ]:

> Official Azure Sandboxes documentation and the preview SDK support
> creation-time and runtime exposure of HTTP and HTTP/2 ports and return an
> Azure-managed HTTPS endpoint. → Broker-to-sandbox HTTP routing is a supported
> product capability **rather than an exec or file-transport workaround.**

That sentence calls the exec path a *workaround*. It is worth confronting rather
than ignoring, and the disagreement resolves cleanly: **same substrate, two
transports, because the payloads differ.** Their workload is an
OpenAI-compatible Chat Completions façade — genuinely HTTP-shaped, so HTTP
ingress is the native fit and exec would indeed be a workaround. muxterm's
payload is sessiond's binary framing, which is not HTTP-shaped at all; for a
raw byte stream the port is the workaround and the exec channel is the native
fit. Neither choice generalises to the other's problem.

Two things from that same document reinforce the choice rather than undercut it:

- Its own evidence row at `:52` concedes the port path's contracts are **"not
  yet established as durable contracts"** — long-lived SSE behaviour, buffering,
  idle and absolute timeouts, disconnect propagation, endpoint stability [READ].
  That was written 2026-08-25; the campaign that was meant to establish them
  ended BLOCKED with zero live calls the next day.
- Decision **D-05** (`:69`) is the sharpest security sentence in either repo:
  *"The sandbox port controls a full agent tool runtime and **must not become an
  alternate unauthenticated control plane.**"* It also records that
  **"Port-level Entra service authentication is not relied upon"** [READ] — the
  design does not trust the port's own auth even when using the port. muxterm
  creating no port at all is the same instinct taken one step further.

### S2.4 The remaining four properties

**Peer identity → declare `IdentityPeerCred`, and note the enum is too narrow.**
The exec'd process runs inside the sandbox as the container user and connects to
the sandbox's own local Unix socket — mechanically the same situation
`internal/transport/ssh/ssh.go:47-50` describes, so sessiond's `SO_PEERCRED`
check passes with no added handshake. Declaring `IdentityNone` would be
*inaccurate* and would imply muxterm needs a handshake that does not exist.

But `transport.go:46-59` offers only two values, and neither says *"authenticated
by an external identity provider at the ingress"* — which is where this
transport's real authorization lives. Peercred passing inside a single-user
container proves almost nothing; the Entra token at the ADC data plane proves
everything. **Recommendation (conservative): reuse `IdentityPeerCred`, and add a
doc note on `IdentityModel` recording that the enum describes what sessiond's
check sees, not where authorization comes from.** Alternative recorded and not
taken: add a third value `IdentityFederated`. Rejected for the MVP because it
changes an exported type for a distinction nothing yet consumes.

**Discovery → fits, but breaks a documented assumption downstream.**
`Discover` lists the sandboxes in the configured group and returns
`HostRef{ID: "sandbox:<uuid>", DisplayName: <label>, Addr: <group coordinates>}`.
Clean. But `internal/mcp/machines.go:36-39` says:

> machineDiscoverTimeout bounds enumerating candidate hosts. Discovery reads the
> ssh config off local disk, so this only ever fires on a pathological Include
> graph.

That stops being true. Sandbox discovery is an authenticated network round trip
that can be slow, rate-limited (data plane: 6,000 req/60 s per group [READ]) or
down. 10 s is probably still fine, but the *reason* in that comment must be
rewritten or it will mislead the next reader. Small, real, and exactly the kind
of thing this design exists to catch.

**Provisioning → the genuine misfit.**

```go
Provision(ctx context.Context, host HostRef) error   // transport.go:100
```

`Provision` takes a host that **already exists** and gets muxterm onto it. For
ssh that is right: the box is there, you install into it. A sandbox is not
there. Creating one produces a `HostRef` that did not exist when `Provision`
was called, so the signature cannot express it — there is no return value to
put the new host in. Creation also costs money and takes real time, neither of
which a bare `error` conveys.

**This is the one place the interface must grow.** The smallest growth that does
not touch ssh:

```go
// Creator is implemented by transports whose hosts must be brought into
// existence before they can be dialled. ssh does not implement it: an ssh host
// already exists. Callers type-assert.
type Creator interface {
    Create(ctx context.Context, spec CreateSpec) (HostRef, error)
    Destroy(ctx context.Context, host HostRef) error
}
```

`Transport` is unchanged, so ssh compiles untouched and every existing caller is
unaffected. Callers that want creation assert for `Creator`; callers that do not
never learn the concept exists. This mirrors how `net.Conn` implementations
optionally offer `CloseWrite` — which `sshConn` itself does
(`internal/transport/ssh/conn.go:98-100`).

With a muxterm-preinstalled image, `Provision` then reduces to what it is for
ssh: a probe. Reuse the shape wholesale — `ProbeState` /
`ProvisionError` (`internal/transport/ssh/provision.go:22-37, 61-73`) is already
a three-way typed result designed so a caller can `errors.As` instead of
matching strings. The sandbox states are `Present` / `VersionSkew` / `Absent`
(§2.7).

**Liveness → fits, but the failure mode is new and must be handled.**
A sandbox auto-suspends after `auto_suspend_seconds`, default **300** [READ],
where idle means "no ingress traffic, no code execution, no interactive shell
sessions, and no file operations" [READ]. Suspension ends the exec session:
*"The terminal session ends when you stop, suspend, or delete the sandbox.
Resuming … reopens a fresh terminal session attached to the same state."* [READ]

Whether a silent open WebSocket counts as activity is **undocumented**
[INFERENCE: it may not — the definition enumerates traffic and operations, not
open connections]. So muxterm must assume the stream can die under it while the
sandbox and its tmux state survive.

**[correction, from reference design] Redial is not a rare event — it is roughly
hourly.** I originally wrote this as an auto-suspend edge case. It is not.
Hard constraint **C4** (`docs/designs/amplifier-sandboxes-design.md:42`) [READ]:

> Entra rejects `resource=` on `refresh_token` grants → connections die at
> ~60–90 min. **Standing limitation, not fixable here.**

So the stream dies on a timer regardless of activity, suspend, or network. That
changes redial from an error path to a **normal, expected, frequent
transition** — and it must be silent, because a user watching a lane should
never see an hourly blip. Three consequences the original text missed:

1. Redial belongs on the **healthy** path in §2.7, not only on failure edges.
2. It must be **pre-emptive**: reconnect on the token's refresh margin (the
   `entraRefreshMargin` pattern already in `internal/voice/credential.go`), not
   reactively after the far end drops. Reacting means the user sees the drop.
3. The redial must be **provably lossless** before this ships, and it is the
   second thing §2.5's probe must measure — hold a stream, force a reconnect,
   confirm no pane output is lost. A transport that loses a byte an hour is
   worse than no transport, because the corruption is intermittent.

Also worth carrying: **FM7** in their failure-mode table is *"session suspended
mid-loop because native idle detection missed genuine internal activity"*
(`:85`), and their §8 accepts it with an **operational** mitigation rather than
a heartbeat — clients observing a long session poll status every 15–30 minutes,
"which resets the native idle clock as a side effect of normal monitoring"
(`:217`) [READ]. muxterm gets this for free and better: `list_machines` and
`fleet_status` are exactly such polls, and a human watching a pane generates
real traffic. Where nobody is watching, the honest statement is that a purely
internal agent loop **can** be suspended mid-work, the platform will auto-resume
it on the next touch, and tmux state survives — so the cost is latency, not
lost work. Say that in the docs rather than claiming it cannot happen.

Consequence: `internal/mcp/machines.go:88-92` caches one `*Client` per machine
keyed on `HostRef.ID`. That cache must invalidate on stream death and redial,
transparently. sessiond's framing is stateful *within* a stream but the pane
state lives in the far daemon, so a redial is cheap and lossless. Conservative
MVP choice: **redial on demand, with a bounded retry, and do not send
keepalives.** Alternative recorded and not taken: a periodic no-op to hold the
sandbox awake. Rejected because it defeats auto-suspend and therefore defeats
the only thing making sandboxes affordable (§1.2).

### S2.5 The experiment that decides this — do it before writing transport code

Thirty minutes, one disposable sandbox, one number at the end.

1. Create one sandbox in `sg-amplifier-sandboxes` (westus2), smallest tier.
2. `aca sandbox shell --id <id> -c /bin/cat --debug` and capture the transport
   log. `--debug` is documented as "verbose + transport-level details" and warns
   it may log sensitive data [VERIFIED]. That single command reveals the WSS
   URL, the handshake, the `WsInMessage` schema, and the encoding.
3. Pipe 1 MiB of `/dev/urandom` through `cat` over that channel with `tty:false`
   and diff the bytes. **Binary-clean or not — this is the whole answer.**
4. Hold the stream open, silent, for 6+ minutes past `auto_suspend_seconds=300`
   and record whether it survives.
5. **Force a reconnect mid-stream and confirm no bytes are lost.** Added after
   reading constraint C4 (§2.4): the stream dies roughly hourly no matter what,
   so lossless redial is not a nicety, it is the second load-bearing property
   after binary cleanliness.
6. **Read back the auto-delete policy after a stop/resume/stop cycle** and
   record whether the countdown re-armed. One API read; it closes an item the
   reference design has carried as unverified since 2026-08-10 (`:190,223`).
7. Destroy the sandbox, then confirm any volume it created is gone (FM9, §5.7).
   Cost of the experiment at $0.1512/h: **under $0.10.**

Pass on steps 3 and 5 → build §2.6. Fail on either → §1.3 says stop, and say so.
Steps 4, 6 and 7 inform the design but do not gate it.

### S2.6 Components and where they live

| Path | New / changed | What |
|---|---|---|
| `internal/transport/transport.go` | **changed, additive** | Add `Creator`, `CreateSpec`. Doc note on `IdentityModel`. No existing signature changes. |
| `internal/transport/sandbox/sandbox.go` | new | `Transport` + `Creator`. Mirrors `ssh/ssh.go`. |
| `internal/transport/sandbox/conn.go` | new | `sandboxConn` — WS ⇄ `net.Conn`. Mirrors `ssh/conn.go`. |
| `internal/transport/sandbox/discover.go` | new | List the group. Mirrors `ssh/discover.go`. |
| `internal/transport/sandbox/provision.go` | new | Version probe, typed `ProvisionError`. Mirrors `ssh/provision.go`. |
| `internal/transport/sandbox/adc.go` | new | ADC data-plane client: create, list, get, delete, open exec stream. |
| `internal/transport/sandbox/credential.go` | new | Entra token. **Lift the pattern from `internal/voice/credential.go`.** |
| `cmd/muxterm/remote_transport.go` | changed | Register the sandbox transport beside ssh. |
| `cmd/muxterm/cli.go` | changed | `sandbox create\|list\|destroy`. |
| `internal/mcp/run.go` | changed | Register `create_sandbox`, `destroy_sandbox`. |
| `internal/mcp/machines.go` | changed | Multi-transport resolve; fix the stale discovery comment. |
| `internal/server/remotes_api.go` | changed | A `state` field on `hostRow` for provisioning (§3.2). |
| `image/` (new dir or separate repo) | new | Dockerfile with muxterm pre-installed, pinned by digest. |
| `internal/transport/ssh/**` | **untouched** | Scope-out. Reference implementation only. |

`internal/mcp/machines.go:53-61` already anticipates more than one transport —
*"the choice of transport belongs to the binary that assembles the process"* —
so `cmd/muxterm` gains a second registration and `internal/mcp` learns nothing.

### S2.7 Lifecycle as a state machine

Do not invent a parallel state machine. The platform already has one — the
`aca` binary carries `Running`, `Stopped`, `Suspended`, `Failed` [VERIFIED],
and the portal documents `Creating`, `Resuming`, `Stopping`, `Deleting`, `Idle`
[READ]. **Map to it; add exactly one state of muxterm's own.**

```
                    create_sandbox
   (nothing) ──────────────────────────▶ REQUESTED
                                             │ ADC accepts, LRO opens
                                             ▼
                                        PROVISIONING ──────┐ create fails / quota / auth
                                             │             ▼
                            Running + version probe OK   FAILED ──▶ destroy ──▶ GONE
                                             │             ▲
                                             ▼             │ probe: version skew
                                          READY ───────────┘
                                        │      ▲
                             Dial       │      │  redial after resume
                                        ▼      │
                                        IN USE ─┘
                                    │        ▲
                    300 s idle,     │        │  any exec/ingress/file op
                    platform-driven ▼        │  (platform auto-resumes)
                                     SUSPENDED
                                        │
                             destroy_sandbox │ auto-delete policy
                                        ▼
                                       GONE
```

`PROVISIONING` is muxterm's own state and the only one it must invent, because
it is the only one the ssh transport never has (§3.2). Everything else is a
projection of the platform's status.

**Failure edges, each with a named behaviour:**

| Edge | What happens |
|---|---|
| Create rejected (quota, RBAC, region) | `REQUESTED → FAILED`. Typed error naming which. Nothing was billed. No retry — retrying a quota error just spends more. |
| Create accepted, never reaches Running | Bounded wait (60 s; cold boot is documented < 2 s, so 60 s means broken). Then `FAILED` **and destroy it** — a stuck sandbox still bills. |
| Version probe finds skew | `PROVISIONING → FAILED` with `ProvisionError{State: VersionSkew}`. **Refuse to dial.** §2.8. |
| `Dial` fails on a `READY` sandbox | Stays `READY`; the error surfaces. Three failures inside `machineDialTimeout` (20 s, `machines.go:34`) → mark unreachable, keep the sandbox, tell the user. Never auto-destroy on a dial failure. |
| Stream dies mid-session | `IN USE → SUSPENDED` (assumed). One transparent redial. Second failure surfaces. Pane state is in the far daemon and survives. |
| Sandbox destroyed out of band | `Discover` stops returning it; the cached `*Client` is invalidated; every tool naming it fails with `unknownMachineErr` (`machines.go:172-175`), which lists what *would* resolve. |
| Destroy fails | Stays `GONE` locally? **No.** Stays in its prior state, surfaces the error, and the sandbox is still billing. This is the leak case; §3.5 makes it visible. |
| Host loses network | Everything sandbox-scoped fails on timeout. `local` and any reachable ssh host keep working. |

---

## S3. UX

### S3.1 What a user does

```
$ muxterm sandbox create --label lane-auth-refactor
creating sandbox in sg-amplifier-sandboxes (westus2)…
sandbox:cb997d3d-…  ready in 3.1s  ·  1 vCPU / 2 GiB  ·  billing

$ muxterm machines
NAME                  ID                     TRANSPORT  STATE      MUXTERM
local                 local                  -          ready      0.25.0
res0                  ssh:res0               ssh        ready      0.24.0  ⚠ skew
lane-auth-refactor    sandbox:cb997d3d-…     sandbox    ready      0.25.0
```

Then nothing is new. `spawn_lane(machine:"lane-auth-refactor", …)` and every
other machine-scoped tool works exactly as it does against `res0`, because they
all ride `Dial`. **That "nothing is new" is the design succeeding.**

### S3.2 In the sidebar, beside local and ssh

The sidebar already renders machines from `hostRow`
(`internal/server/remotes_api.go:84-85`), which carries `ID` as the key and
`Name` as display-only — the split `transport.go:28-31` mandates. A sandbox is
one more row.

One thing genuinely differs: **a sandbox row has a state an ssh row never has.**
`hostRow` gains a `state` field. `local` and ssh rows report `ready` or
`unreachable`, as today. Sandbox rows can also report `provisioning`, `failed`
and `suspended`. Group them under a **Sandboxes** heading so the eye can tell
"a machine I own" from "a machine I am renting", because the second kind costs
money and the first does not.

### S3.3 Starting, not broken

ssh is binary: reachable or not. A sandbox has a legitimate not-yet state, and
if it renders as "unreachable" during it, every user's first experience is a
false failure. So:

- `provisioning` is its **own** state with its own affordance — a spinner and an
  elapsed counter, never the red that `unreachable` uses.
- Show elapsed seconds. Cold boot is documented < 2 s [READ]; at 10 s something
  is wrong and the user deserves to know that from the screen.
- At 60 s the row goes `failed` with a reason, and the sandbox is destroyed
  (§2.7). A spinner that spins forever is the worst outcome available.
- The CLI blocks with the same counter and the same 60 s bound.

### S3.4 What they see when it is costing money

**Runtime, never a dollar figure.**

```
lane-auth-refactor    sandbox:cb997d3d-…   ready · running 2h 14m
```

The reference repo reached the same conclusion from the other side: its operator
spec records *"No cost data source exists"* and specifies `estimated_cost: null`
always, with mandatory `limitations[]` strings
(`docs/plans/2026-08-11-operator-mcp-tool-namespace-spec.md:43`) [READ]. There is
no billing API behind these meters, and a rate hardcoded into a Go binary is a
number that will be wrong and will be believed. Runtime is true, is enough to
prompt the right question, and cannot rot.

Two exceptions where a rate does appear, both as text a human wrote, not a
computed total:
- `muxterm sandbox create` prints "billing" on the ready line.
- `muxterm sandbox list` footers the current rate with its source and date.

### S3.5 Teardown, and whether you can leave one running

```
$ muxterm sandbox destroy lane-auth-refactor
sandbox:cb997d3d-… has 1 live session (workspace "auth", pane 3).
destroy anyway? [y/N]
```

**Yes, you can absolutely leave one running, and that is the main hazard this
feature introduces.** ssh has no equivalent — forgetting about `res0` costs
nothing. Four mitigations, in order of how much they are worth:

1. **`auto_suspend_seconds` = 300, always set at create.** The platform's own
   idle suspend is the real protection, and it is the reason §2.4 refuses to
   send keepalives.
2. **An auto-delete policy at create time — 14 days.** `AutoDeletePolicy` is a
   first-class API object [VERIFIED — struct present in the `aca` binary].
   **[correction, from reference design]** I originally picked 7 days by
   instinct. Align to **14**, which is the reference design's confirmed decision
   (`amplifier-sandboxes-design.md:106,121,190`) [READ] — matching it costs
   nothing and diverging would mean two systems in one subscription reaping on
   different clocks. Carry their open question with it: **it is not verified
   whether the countdown re-arms on each new Stop transition or is one-shot from
   the first stop** (`:190,223`) [READ]. If it re-arms, "14 days since last
   touch" is free; if it does not, a sandbox resumed on day 13 still dies on day
   14. Add it to §2.5's probe list — it is a one-line API read, not an
   experiment.
3. **A startup reconcile, keyed on labels.** On daemon start, `Discover` the
   group. Any sandbox muxterm created and no longer tracks is reported in the
   sidebar as **orphaned** — visible, never auto-destroyed. This is deliberately
   the `sandbox_reaper` posture from the reference repo, which states of itself:
   *"There is no code path in this module to any Azure sandbox deletion API"*
   (`src/sandbox_reaper/reconcile.py:3-6`) [READ]. Report, do not reap.

   **The mechanism for "did this muxterm create it" is label selectors**, which
   the reference design already identifies as the *"clean reconciliation key
   (owner `oid`, session id, work type)"* (`amplifier-sandboxes-design.md:123`)
   [READ]. `create_sandbox` stamps `muxterm=1` and `muxterm-host=<hostname>`;
   `Discover` filters on them; §5.5's ownership rule reads them. **This is why
   muxterm needs no registry at all** — and it is worth noting that "name the
   registry and define broker crash recovery" is still an **OPEN** item in the
   reference design (`:231,271`), with its current registry an admitted
   placeholder JSONL (`src/amplifier_sandbox_client/registry.py:1-11`) [READ].
   Azure's own labels are the state store; a second one would be a second thing
   that can drift.
4. **`muxterm sandbox list` shows every sandbox in the group**, including ones
   this muxterm did not create, marked as such. You cannot forget what is on the
   screen.

---

## S4. API and CLI

### S4.1 The addressing scheme is already decided — follow it

PR #90 chose a `machine` **parameter** over namespaced identifiers, and
`internal/mcp/run.go:44-60` records all three reasons. Resolution is
`HostRef.ID` first, then `DisplayName`, ambiguity is an error not a coin flip
(`machines.go:149-170`); absent or `"local"` means this machine
(`machines.go:111-114`); and a name that does not resolve **never** falls back
to local (`machines.go:123-126`).

**Nothing here invents a second addressing scheme.** `machine:"sandbox:cb997d3d-…"`
and `machine:"lane-auth-refactor"` both resolve through the existing path with no
change to it, because `matchIn` is already transport-agnostic — it matches on ID
then DisplayName and never parses a prefix.

### S4.2 CLI

| Verb | Behaviour |
|---|---|
| `muxterm sandbox create [--label L] [--cpu N] [--memory M] [--image REF]` | Creates, waits (bounded, §3.3), prints the `HostRef.ID`. **The only command that starts a bill.** |
| `muxterm sandbox list` | Every sandbox in the group, with state and runtime, marking ones this muxterm did not create. |
| `muxterm sandbox destroy <machine>` | Resolves via the §4.1 path. Confirms if sessions are live. **The only command that stops a bill.** |
| `muxterm machines` | Unchanged surface; sandboxes appear alongside local and ssh. |
| `muxterm --remote <machine>` | Unchanged. `cmd/muxterm/cli_daemon.go:68` builds a `HostRef` with a hardcoded `"ssh:"` prefix — that is the one existing line that must learn about a second transport. |

### S4.3 MCP tools

**Two new tools. No new parameters on any existing tool.**

| Tool | `machine` param? | Notes |
|---|---|---|
| `create_sandbox` | **No — and it must not have one.** | Creation has no target machine; the sandbox *is* the result. Adding `machine` would invite `create_sandbox(machine:"res0")`, which means nothing. |
| `destroy_sandbox` | **Yes, and it is required.** | The `machine` here is the **object**, not the location. §5.5. |
| everything from #90 and #92 | unchanged | `list_machines`, `spawn_lane`, `send_input`, `get_screen`, `fleet_status`, `read_file`, `list_dir`, `lane_transcript` — all work against a sandbox with no code change, because they all ride `Dial`. |
| `close_workspace`, `close_pane` | unchanged — carry `machine` **so it can be refused** | `run.go:553-556`. §5.5. |

`create_sandbox` must be gated the way `spawn_lane` is, and for the same
recorded reason (`run.go:525-527`): *"a tool an agent does not have cannot be
misused, whereas a gate on one can be overwritten out from under you."* An
agent that can mint billable cloud resources unattended is a worse version of
the hazard `close_workspace` is already protected from. **Conservative choice:
`create_sandbox` is NOT registered for a session running inside a pane** —
reuse the existing `insidePane()` check (`run.go:557`). Alternative recorded and
not taken: an approval gate. Rejected on the codebase's own stated reasoning.

### S4.4 HTTP endpoints

`internal/server/remotes_api.go` already routes on `{id}` = a `HostRef.ID` and
notes at line 38 that *"A colon is a legal pchar in a path"* — so
`sandbox:cb997d3d-…` needs no new escaping. Existing routes work unchanged.
Two new ones:

```
POST   /api/sandboxes            create   → 202 + HostRef, state=provisioning
DELETE /api/sandboxes/{id}       destroy  → 204
```

`GET /api/remotes` gains the `state` field on each row (§3.2). Additive.

---

## S5. Security

The most important section, and the one where this feature is genuinely
different from ssh rather than merely cheaper or slower.

### S5.1 What the sandbox runs as, and what it can reach

Three identities, and conflating any two is a real vulnerability:

| Identity | Held by | Used for | MVP |
|---|---|---|---|
| **The user's Entra identity** | this machine | Authorizing create/list/destroy/exec against the ADC data plane | `az account get-access-token` |
| **The sandbox's managed identity** | the sandbox | Whatever *it* reaches — Key Vault, storage, ARM | **None. Do not assign one.** |
| **The Unix user inside** | the container | sessiond's `SO_PEERCRED` (§2.4) | container default |

**The MVP assigns the sandbox no managed identity at all.** A sandbox holding an
Azure token is a credential-exfiltration target, and the smallest secure answer
is for it to hold nothing. The reference repo's own design gives its sandboxes
a user-assigned identity `mi-amplifier-<suffix>` with **Key Vault Secrets User**
(`infra/resources.bicep:53-54,105-119`) [READ] — a sound design for what that
system does, and unnecessary for what muxterm's MVP does.

Two data points that make this concrete, both worth reading twice:

- The data-plane RBAC role is **`Container Apps SandboxGroup Data Owner`**, and
  it is genuinely separate from ARM read. I proved this by accident: `az resource
  list` showed me `sg-amplifier-resolve-aca`, and `aca sandbox list` against it
  returned **403 Forbidden** naming that exact role [VERIFIED]. **Seeing a
  sandbox group in ARM does not grant access to what is inside it.** That is a
  good property and the design should not weaken it.
- The reference repo's live sandbox image persists a fetched Anthropic key in
  **plaintext** at `~/.amplifier/keys.env` so tmux sessions inherit it, in code
  its own comment labels *"MINIMAL DEV-VALIDATION … (NOT the full keycustody
  design)"* (`image/entrypoint.sh:54-117`) [READ]. Which leads directly to:

**#92 means anything readable in that sandbox is readable from here.**
`read_file` and `list_dir` cross the machine boundary (`internal/mcp/tools_fs.go:16`),
and `internal/mcp/run.go:24-35` records that the mechanism changed —
`TypeReadFile` in the sessiond protocol made files travel. So
`read_file(machine:"sandbox:…", path:"~/.amplifier/keys.env")` returns the key.
This is **correct, intended behaviour** — it is a read-only tool doing its job —
and it means **a plaintext secret in a muxterm-reachable sandbox is a plaintext
secret on this machine.** The muxterm image must not write one. If a lane needs
an API key, it arrives as a tmpfs mount, mode 0400, never a dotfile and never an
env var — the pattern the reference repo's own verification PASSed on
(`docs/evidence/2026-08-10-key-custody-verification.md`) [READ].

### S5.2 Token lifetime

`az account get-access-token` returns a **user-delegated** token documented as
*"valid for at least 5 minutes with the maximum at 60 minutes"*
([learn.microsoft.com/en-us/cli/azure/account#az-account-get-access-token](https://learn.microsoft.com/en-us/cli/azure/account?view=azure-cli-latest#az-account-get-access-token), checked 2026-09-08) [READ]. Note *at least 5* — not
"an hour". Code that assumes 3600 s is wrong five minutes after it ships.

**MVP: `az account get-access-token`, following the precedent already in this
codebase.** `internal/voice/credential.go` already does exactly this — an
`auth_mode` that is deliberately not defaulted, `az account get-access-token
--scope`, and an `entraRefreshMargin` so a token is replaced before it expires
[VERIFIED, file read]. Lift it. Do not write a second one.

Two rules carried over from that work, both load-bearing:
- **`auth_mode` is never defaulted.** A resource with the wrong auth mode answers
  with a bare 401 naming neither credential; guessing produces an
  unhelpful error at the worst moment. The scope is likewise explicit — the
  `aca` binary carries *two* (`https://management.azure.com/.default` and
  `https://dynamicsessions.io/.default`) [VERIFIED], so guessing has a
  50% failure rate.
- **A token is never logged, never in an error string, never on disk**
  (`internal/voice/credential.go` package doc) [READ]. The MVP additionally must
  never pass `--debug` to `aca` in an automated path: its own help warns *"may
  log sensitive data. Do not share output without review"* [VERIFIED].

**The production answer is not `DefaultAzureCredential`, and this is worth
getting right because the obvious guess is wrong.** Microsoft's current guidance
is titled "Use deterministic credentials in production environments" and says:

> the specific credential in the chain that will succeed … can't be guaranteed
> ahead of time … **replace `DefaultAzureCredential` with a specific
> `TokenCredential` implementation, such as `ManagedIdentityCredential`.**

([learn.microsoft.com/en-us/dotnet/azure/sdk/authentication/best-practices](https://learn.microsoft.com/en-us/dotnet/azure/sdk/authentication/best-practices), updated 2025-09-19, checked 2026-09-08) [READ]

The failure it describes is exactly this feature's shape: someone runs `az login`
on a host, the managed identity later breaks, `DefaultAzureCredential` silently
falls through to the CLI credential, and the service runs with a *different*
principal's rights. For a thing that mints billable compute, silent principal
substitution is not an edge case.

**[correction, from reference design] A service principal is not available here,
and I was wrong to offer it.** I originally wrote "an explicit
`ManagedIdentityCredential` (or an explicit service-principal credential)". The
parenthesis is forbidden by tenant governance. Hard constraint **C2**
(`docs/designs/amplifier-sandboxes-design.md:40`) [READ]:

> **C2** | Tenant governance: **no client secrets, no client certificates.**
> Managed Identity + federated identity credential only.

The reference repo enforces this in infrastructure, not just prose — its CI/CD
uses a **federated identity credential** via GitHub OIDC precisely so no secret
or cert exists to leak (`infra/resources.bicep:254`) [READ]. The generic
"use a service principal for long-running services" advice is correct in
general and inadmissible in this tenant.

**So: MVP = `az` CLI, user-delegated, explicit scope, explicit `auth_mode`,
refreshed on a margin. Production = an explicit `ManagedIdentityCredential`,
or a federated identity credential where no managed identity exists, reused as
a singleton — never `DefaultAzureCredential`, and never a client secret or
certificate.** Microsoft's own sandbox samples use `DefaultAzureCredential()`
[READ] — sample-grade code, not guidance, and following it here would be a
mistake for the reason §5.2 already gives.

One more hard default worth adopting wholesale, because it was paid for.
Constraint **C9** (`amplifier-sandboxes-design.md:47`) [READ]:

> Any Storage account this project provisions MUST be created with shared-key
> (account-key/local) auth disabled (`allowSharedKeyAccess: false`) and accessed
> only via Entra/managed-identity auth. Learned the hard way on a prior project
> […] drew an S360 finding for exactly this. This is a hard default, not a
> per-resource toggle.

The MVP provisions no storage. The moment a workspace volume appears (§5.7),
this binds — and it is cheaper to write it down now than to draw the same
finding twice.

### S5.3 Network posture

**Inbound: nothing. This is the strongest security argument for §2.2's choice.**
Choosing `/exec/stream` over `add_port` means **no ingress is created at all** —
no `adcproxy.io` hostname, no anonymous-access flag to get wrong, no IP ACL to
misconfigure, nothing on the public internet. Ports default off: *"Ingress proxy
off by default — opt-in per sandbox and per port"* [READ]. **Keep it off.**
The connection is outbound-only, from here to `management.azuredevcompute.io`,
authenticated per-request.

If a future release does need a port, the ordering is fixed: Entra-with-email
first (`auth.entraId.emails`), IP ACL second, and `--anonymous` **never** — the
SDK logs *"Port %d exposed with anonymous access — accessible without
authentication"* at WARNING for a reason (`_operations/_port_ops.py:48`) [READ].

**Outbound: unrestricted in the MVP, and that is a stated gap.** A sandbox
reaches the internet by default, and an agent session inside it will reach at
minimum an LLM API and GitHub. `EgressPolicy` / `EgressRule` / `EgressHostRule`
exist as first-class API objects [VERIFIED — structs in the `aca` binary] and
are the correct answer, which is why they are release 3 (§1.4). Until then:
**say plainly that a sandbox has open egress, and do not claim isolation the
MVP does not deliver.** Isolation here means *blast radius*, not *network
containment*.

### S5.4 Blast radius

An unattended agent session in a sandbox can: run any command as the container
user; read and write the sandbox filesystem; reach the internet (§5.3); consume
CPU and memory up to its tier; and burn money until auto-suspend or auto-delete.

It **cannot**: reach this machine (the stream is outbound-only, and sessiond has
no network listener); reach another sandbox (each is a separate instance);
acquire an Azure token (§5.1 — no managed identity); read this machine's ssh
keys, git credentials or `~`; or exceed the group's quota of **50 concurrent
running sandboxes** [READ].

Set against `res0`, this is the actual argument for the feature. An agent on
`res0` runs as the user, in the user's home directory, with the user's ssh keys
and git credentials on disk beside it. An agent in a sandbox runs in a container
that gets destroyed. **That difference — not speed, not elasticity — is what the
7× cost premium in §1.2 buys.**

What stops it doing more: no managed identity; auto-suspend at 300 s;
auto-delete at 14 days; the platform quota; and `create_sandbox` not being
registered inside a pane (§4.3), so a lane cannot spawn more lanes.

### S5.5 The destructive boundary — resolving the tension explicitly

The C4 decision (`internal/mcp/run.go:529-556`) is that destructive reach stops
at the machine boundary. `close_workspace` and `close_pane` carry a `machine`
argument **precisely so passing one is refused rather than silently applied
here** (`run.go:553-556`). Its three reasons: (a) unnecessary, (b) unobservable
— the operator who would notice is on the other machine, (c) a known hazard was
still open.

Destroying a sandbox is destructive **and** remote. The tension is real. It
resolves like this:

> **The boundary is not "local versus remote". It is "did this muxterm bring
> this thing into existence".**

- `close_workspace` on `res0` destroys **part of** a machine muxterm did not
  create and does not own. Its lifetime belongs to somebody else. All three C4
  reasons hold.
- `destroy_sandbox` destroys **the whole of** a thing muxterm created, whose
  entire lifetime muxterm owns, and which **costs money every second it
  exists**. Reason (a) inverts completely: destruction is not unnecessary, it is
  the only way to stop a bill muxterm started. A `Create` with no `Destroy` is
  not a safety property — it is a resource leak with a credit card attached.
  Reason (b) is answered by the sandbox being a first-class row in the sidebar
  with visible state and runtime (§3.2, §3.4), which a remote pane is not.

That is why `Creator` in §2.4 pairs `Create` with `Destroy` in the *same*
interface. They are one capability. A transport that can mint billable resources
and cannot release them is worse than one that can do neither.

**Concretely, and conservatively:**

1. `close_workspace` and `close_pane` are **unchanged**. Still refused across
   any machine boundary, sandbox included. Closing a workspace inside a sandbox
   is exactly the case C4 describes: partial, unobservable, unnecessary. Destroy
   the whole sandbox or use a session inside it.
2. `destroy_sandbox` **requires** a `machine` argument and refuses `"local"` or
   absent — the mirror image of `localOnly` (`run.go:302-317`). You cannot
   destroy this machine.
3. It refuses any `machine` whose `HostRef.ID` is not `sandbox:`-prefixed, with
   a message naming the transport. **You cannot destroy `res0`**, and the refusal
   says why.
4. It confirms when sessions are live (§3.5), and reports what it destroyed.
5. **It is not registered inside a pane** (`insidePane()`), same as
   `create_sandbox` and for the same reason (§4.3). A lane can neither create
   nor destroy cloud resources.

Rejected alternative, recorded: extend C4 to permit `close_workspace` across the
boundary for sandboxes only, on the grounds that a sandbox is disposable. It
would blur the one clean rule — *destroy what you created, nothing else* — into
a per-transport exception table. The asymmetry is the point, exactly as
`run.go:547-552` argues.

### S5.6 Version skew is a security property, not just a compatibility one

`res0` runs 0.24.0 against a 0.25.0 host, and its daemon **silently drops unknown
wire requests because its dispatch switch has no default case**. A tool call
returns a result shaped like success while nothing happened.

For sandboxes this is strictly worse. An ssh host can be upgraded. A sandbox
image is **baked**, and a `commit`ted disk image or a snapshot from release 2
can be arbitrarily old — a sandbox resumed from a snapshot taken months earlier
runs whatever muxterm was current then. Silent-success against an image nobody
remembers building is a bad failure.

**Three mitigations, all cheap, all in the MVP:**

1. **Pin the image by digest, and derive the digest from the host's version.**
   `create_sandbox` refuses an image whose muxterm version is not this binary's.
2. **Probe before dialling.** `Provision` runs the *one-shot* exec
   (`/executeShellCommand`) to read `muxterm --version` **before** opening
   `/exec/stream`. On mismatch: `ProvisionError{State: VersionSkew}`, refuse to
   dial, name both versions. This reuses `ssh/provision.go`'s exact shape — a
   typed, three-way, `errors.As`-able result — and costs one HTTP request.
3. **Surface skew in the sidebar** for every machine, sandbox and ssh alike
   (`⚠ skew` in §3.1). This makes the existing `res0` defect visible too, which
   it currently is not.

Not fixing here, but noting: **the missing `default:` case in the sessiond
dispatch switch is the actual bug**, and it is a bug on both sides. A daemon
that receives a request it does not understand must say so. That is a separate
change to a file this lane does not own; it is recorded, not made.

**There is a second skew axis I originally missed: muxterm versus the preview
API.** The reference design names it **FM8** — *"Preview API changes break the
adapter or force sandbox recreation at GA"* (`amplifier-sandboxes-design.md:86`)
— accepts the risk, and names the mounted volume as *"the main structural
hedge"* (`:220`) [READ]. Its adversarial review also flags *"version skew across
three adapters sharing one library under preview API churn"* (`:236`) [READ].
muxterm would be a **fourth** adapter, and unlike the other three it is written
in Go and would not share that library. Two consequences:

- Pin the API version explicitly (`2026-02-01-preview`, the only one the
  provider offers today [VERIFIED]) and fail loudly on an unexpected one, rather
  than floating to whatever is current.
- **Do not put anything in a sandbox you would mind losing at GA.** §5.7.

### S5.7 Workspace durability and the volume leak

Two items from the reference design that the MVP must not pretend away.

**A snapshot is not the durability story; a mounted volume is.** Their §7.6 puts
the working set on an *explicitly mounted volume* (Blob for shared, Data Disk
for single-attach) *"independent of the sandbox's own root-disk snapshot"*, so
loss or recreation of a sandbox need not lose the workspace — hedging both FM3
and FM8 (`amplifier-sandboxes-design.md:183`) [READ]. My §1.4 put snapshots in
release 2 and said nothing about volumes; that ordering is wrong. **A mounted
volume should come before snapshots**, because a snapshot of a preview-era
sandbox is exactly what GA may invalidate.

**Volumes leak, and destroy must account for them.** **FM9** —*"Orphaned volumes
persist after sandbox deletion (silent cost leak)"* (`:87`) — is listed in their
adversarial review under significant concerns as having **no cleanup policy**
(`:236`) [READ]. So `destroy_sandbox` (§5.5) must either delete the volume with
the sandbox or **report by name that it did not**, and `muxterm sandbox list`
must show volumes that belong to no sandbox. A destroy that silently leaves a
billing resource behind reintroduces the exact hazard §3.5 exists to close, and
it is worse than the sandbox case because a volume is invisible in a machine
list.

---

## S6. How it fits muxterm

### S6.1 What this reuses

Almost everything. The list is the argument:

| Reused | Why it matters |
|---|---|
| `transport.Transport` (`transport.go:74-104`) | The seam. Implement it and §1.4's whole scenario works. |
| `sessiond.DialConn` | Frozen, self-describing framing that *"carries no socket assumptions"* (`transport.go:8-9`). Zero change. |
| The `machines` registry (`machines.go:80-105`) | Per-machine connections keyed on `HostRef.ID`. Its comment at :83-87 already names *"a sandbox label is user-editable"* as the reason not to key on display names. Written for this. |
| The `machine` parameter convention (`run.go:44-60`) | §4.1. No new addressing scheme. |
| `github.com/coder/websocket v1.8.14` | **Already a direct dependency** [VERIFIED, `go.mod`], and it has `func NetConn(ctx, c, msgType) net.Conn` at `netconn.go:48` [VERIFIED]. The WS→`net.Conn` adapter is largely already written and already vendored. **No new dependency for the core of this feature.** |
| `internal/voice/credential.go` | Entra auth: `auth_mode`, explicit scope, `az account get-access-token`, refresh margin. §5.2. |
| `ProbeState` / `ProvisionError` (`ssh/provision.go:22-73`) | Typed three-way provisioning result. Copy the shape. §5.6. |
| `sshConn` (`ssh/conn.go`) | How to be a `net.Conn` over something that is not a socket, including `CloseWrite` and honest `SetDeadline` failure. |
| `hostRow` / `remotes_api.go` | Sidebar rendering, ID-vs-name discipline, colon-safe routes. |
| `muxterm sessiond-connect` (`cmd/muxterm/main.go:68`) | The far-side relay. It *"refuses to spawn a daemon by design"* (`main.go:291`) — correct for a sandbox too. **Identical on both transports.** |

### S6.2 What it must not duplicate

1. **The broker.** `amplifier-sandboxes` runs a hosted FastAPI control plane at
   `sandboxes.amplifier.ms`. muxterm must not build a second one, and must not
   depend on that one. The ssh transport states the principle
   (`ssh/ssh.go:2-5`): *"It shells out rather than reimplementing the protocol,
   which is why keys, ProxyJump, bastions … all work for free."* The sandbox
   transport's equivalent is the ADC data plane and the `aca` CLI. Whatever the
   user's `az login` already does, this does.
2. **A parallel state machine.** §2.7 maps to the platform's states rather than
   inventing them.
3. **A second addressing scheme.** §4.1.
4. **A cost model.** §3.4 — runtime, not dollars.
5. **A reaper with delete authority.** §3.5 — report, do not reap. Same posture
   the reference repo's own reaper takes (`reconcile.py:3-6`) [READ].
6. **A second Entra credential implementation.** §5.2.

### S6.3 Prior art on this machine — checked, not assumed

**The Amplifier Resolve platform has already moved to ACA Sandboxes.** The
`resolve` bundle's architecture note says instances are *"Incus containers
locally with Docker … only for future remote Azure Container Instance
deployments"*. That is now out of date: there is a live
`Microsoft.App/sandboxGroups` named **`sg-amplifier-resolve-aca`** in
`rg-amplifier-resolve-aca` (westus2, provisioningState `Succeeded`) in this
subscription [VERIFIED]. I could not read inside it — `aca sandbox list` returned
**403 Forbidden**, naming the missing `Container Apps SandboxGroup Data Owner`
role [VERIFIED] — and per this round's instructions I did not touch it.

So the task's suspicion was right, but the target moved: **the intended shape is
ACA Sandboxes, not ACI.** Two consequences. First, the bundle's architecture
note should be corrected by whoever owns it. Second, and more usefully, **there
are now two independent systems in this ecosystem reaching for the same Azure
primitive** — Resolve for its workers, `amplifier-sandboxes` for Amplifier CLI
sessions — and muxterm would be the third. Before building, someone should ask
whether the sandbox *group* and the image should be shared. That is a question
for the humans, recorded here because it is cheaper to ask now than after three
teams have three images.

**The Digital Twin Universe** already does on-demand isolated environments from
declarative profiles, and it is the closest conceptual neighbour. It is
**local** — containers on this machine, no Azure dependency, no per-second
billing. The honest relationship is *complementary, not competing*: DTU answers
"run my app as if deployed" on hardware you already own; a sandbox answers "run
an agent I do not fully trust, somewhere that is not my machine". If someone
wants a *remote* DTU, `kenotron-ms/amplifier-remote-dtu` exists (private, pushed
2026-08-26) [VERIFIED, name only — not read] and should be read before anything
here is generalised in that direction.

**The bridge between them is already a hard constraint, and it should be one
here too.** Constraint **C6** (`amplifier-sandboxes-design.md:44`) [READ]:

> The sandbox unit must also run as plain Docker locally — **one container
> definition, two places it runs.**

Their rollout makes it Phase 0: *"Base image runs via plain `docker run`. […]
No Azure. A dev can submit, observe, steer, and destroy a session entirely on a
laptop using the same env contract the real broker will use"* (`:244`) [READ].

**Adopt this verbatim for the muxterm image**, for a reason specific to this
design: it makes §2.5's probe and the whole transport testable against a local
container first, with no Azure call, no billing, and no preview API. The one
piece that cannot be tested locally is the `/exec/stream` channel itself — which
is precisely why that is the *only* thing §2.5 needs a real sandbox for, and
why the probe costs under $0.10. It also means the same image DTU could run is
the image a sandbox runs, which is the honest form of "complementary".

### S6.4 The revisitable refusal, noted and not changed

`internal/mcp/run.go:24-35` already records it precisely: `lane_transcript` was
refused across machines because *"a harness transcript is a file … and this
process has no way to read a file across a machine boundary"*. #92 made files
travel (`TypeReadFile`), so **that reason has stopped being true**. The comment
draws the right distinction — *"Read crosses the boundary; destroy does not"* —
and a transcript is a read.

Reading a lane's transcript in a sandbox is exactly the case that makes this
worth revisiting: an unattended agent in a disposable container is the session
you most need to inspect from outside and can least easily attach to. **Not
changed here.** Noted as ready, with its reason already retired in the codebase's
own words.

---

## Appendix A: what I verified live, on 2026-09-08

| # | Check | Result |
|---|---|---|
| 1 | `gh repo view kenotron-ms/amplifier-sandboxes` | Exists, private, created 2026-08-11, pushed 2026-08-26 |
| 2 | `az account show` | Sub `8a673afb-d858-4a97-a490-2625396d1484` "OCTO - MADE Explorations", tenant `72f988bf-…` |
| 3 | `az resource list --resource-type Microsoft.App/sandboxGroups` | **Two** groups: `sg-amplifier-sandboxes` (rg-amplifier-sandboxes) and `sg-amplifier-resolve-aca` (rg-amplifier-resolve-aca), both westus2, both `Succeeded` |
| 4 | `az provider show -n Microsoft.App` | Registered. `sandboxGroups` apiVersions = **`2026-02-01-preview`** only. 40+ locations incl. West US 2 |
| 5 | `aca sandbox list -g rg-amplifier-sandboxes --region westus2` | **Empty.** Zero sandboxes running. **Nothing is costing money and nothing was touched.** |
| 6 | `aca sandbox list -g rg-amplifier-resolve-aca --region westus2` | **403 Forbidden**, requires `Container Apps SandboxGroup Data Owner`. Reported, not touched. |
| 7 | `aca --version` | `aca 1.0.0-preview.1`, stripped Rust ELF at `/usr/local/bin/aca` |
| 8 | `aca sandbox --help` | 20 subcommands incl. `shell`, `exec`, `port`, `egress`, `snapshot`, `commit`, `lifecycle`, `stats` |
| 9 | `aca sandbox shell --help` | "Open an interactive shell in a sandbox", `-c` default `/bin/bash` |
| 10 | `aca sandbox port add --help` | `--port`, `--anonymous`, `--email` |
| 11 | `strings /usr/local/bin/aca` | `tokio-tungstenite-0.29.0`; `wss://`; `WebSocket connections require an HTTPS endpoint…`; `struct WsInMessage with 3 elements`; `/exec/stream`; `/executeShellCommand`; `management.azuredevcompute.io`; `dynamicsessions.io/.default`; `Microsoft.App/sandboxGroups`; `2026-02-01-preview`; `azure-containerapps-sandbox 0.1.0-beta.1`; `base64`; `Running`/`Stopped`/`Suspended`/`Failed`; `EgressPolicy`/`AutoDeletePolicy`/`AutoSuspendPolicy`/`IpAccessControl` structs |
| 12 | `go.mod` | `github.com/coder/websocket v1.8.14` is a **direct** dependency; `NetConn` at `netconn.go:48` |
| 13 | `internal/voice/credential.go` | `auth_mode` entra\|api_key, `az account get-access-token --scope`, `entraRefreshMargin` — the precedent |

**Provisioned: nothing. Created: nothing. Modified: nothing. Cost incurred: $0.**
Every `az` and `aca` call above is a read.

## Appendix B: sources

Azure documentation, all checked **2026-09-08**:

- <https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-overview> — updated 2026-07-20. Sandboxes vs dynamic sessions; they are **distinct** and coexist.
- <https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-get-started> — updated 2026-08-26. **Public preview.**
- <https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview> — updated 2026-08-31. Regular ACA ingress: WebSocket, gRPC, 240 s timeout. **Not the sandbox port ingress.**
- <https://sandboxes.azure.com/docs/sandboxes/limits> — cold boot < 2 s, resume < 100 ms, suspend < 500 ms, 10 ports/sandbox, 50 concurrent running/group, 6,000 data-plane req/60 s.
- <https://sandboxes.azure.com/docs/sandboxes/sandbox/ports> — `*.{region}.adcproxy.io`; ingress off by default.
- <https://sandboxes.azure.com/docs/sandboxes/sandbox/interactive-shell> — *"The Python SDK … does not expose a PTY shell API. For an interactive shell from Python, invoke `aca sandbox shell`."*
- <https://sandboxes.azure.com/docs/sandboxes/regions> — 25 regions incl. West US 2. **`eastus` is not one of them**; `eastus2` is.
- <https://azure.microsoft.com/en-us/pricing/details/container-apps/> — *"Express and Sandboxes follow the same pay-per-second pricing as Consumption Plan."* Free grant 180,000 vCPU-s + 360,000 GiB-s + 2M requests.
- <https://learn.microsoft.com/en-us/cli/azure/account?view=azure-cli-latest#az-account-get-access-token> — token valid *"at least 5 minutes … maximum at 60 minutes"*.
- <https://learn.microsoft.com/en-us/dotnet/azure/sdk/authentication/best-practices> — updated 2025-09-19. Prefer an explicit `ManagedIdentityCredential` over `DefaultAzureCredential` in production.

Caveat carried forward: much of the sandbox detail above lives only on
`sandboxes.azure.com/docs`, which is first-party Microsoft but is product-portal
documentation for a preview feature, not archived or versioned like Learn. It
already contradicts Learn on at least one number (disk size at the XS/S/M
tiers). **For anything load-bearing, verify against the live API** — which is
what §2.5 exists to do.

---

## Appendix C: traceability — what the reference repo drove

The goal condition requires that `kenotron-ms/amplifier-sandboxes` be read
thoroughly and **drive** this design, not merely be cited by it. This appendix
exists so that claim is auditable rather than asserted. Every row is a specific
artifact in that repo, what it says, and the specific thing in this document
that exists because of it.

Clone used: `gh repo clone kenotron-ms/amplifier-sandboxes` at `/tmp/sbx-ref`,
`main` @ `888774c`, plus five fetched `goal/gb-agent-sessions-g0*` branches.

**Read in full, directly:**
`docs/designs/amplifier-sandboxes-design.md` (275 lines) ·
`docs/designs/2026-08-25-amplifier-agent-sandbox-service-design.md` (206 lines,
headings + all transport/security-relevant rows) ·
`.amplifier/goals/gb-agent-sessions-g0-port-proof.md` (117 lines) ·
`broker/vendor/azure-containerapps-sandbox/.../_operations/_port_ops.py` ·
`_model_types/_ports.py` · `_operations/_base.py` · `git log` (20 commits) ·
branch inventory · `docs/evidence/*` verdict extraction (6 files, ~89 KB).

| # | Reference artifact | What it says | What it drove here | Effect |
|---|---|---|---|---|
| 1 | design `:17-25` | Three mismatched lifetimes; work must survive disconnect, sleep, token expiry | §0.1 | **New section.** The strongest argument in this doc; reverses the burden of proof on §6.2 |
| 2 | design `:42` (C4) | Entra rejects `resource=` on refresh grants → connections die at 60–90 min, "not fixable here" | §2.4 | **Correction.** Redial reclassified from rare edge case to hourly normal path; must be pre-emptive and provably lossless |
| 3 | design `:40` (C2) | No client secrets, no client certificates — MI + federated only | §5.2 | **Correction.** Removed my service-principal recommendation as inadmissible in this tenant |
| 4 | design `:47` (C9) | Storage must set `allowSharedKeyAccess: false`; prior S360 finding | §5.2 | **New.** Adopted as a hard default ahead of any volume work |
| 5 | design `:44` (C6) + `:244` | One container definition, Docker-local and ACA; Phase 0 is a no-Azure dev loop | §6.3 | **New.** Makes the transport locally testable; narrows §2.5's Azure dependency to one channel |
| 6 | design `:87` (FM9), `:236` | Orphaned volumes persist after deletion — no cleanup policy | §5.7 | **New section.** `destroy_sandbox` must delete or name the volume |
| 7 | design `:183` (§7.6) | Volume is independent of root-disk snapshot; hedges FM3 + FM8 | §5.7, §1.4 | **Reordered.** Volumes before snapshots; my original release-2 ordering was wrong |
| 8 | design `:106,121,190,223` | Auto-delete 14 days; re-arm behaviour explicitly unverified | §3.5 | **Correction.** 7 days → 14; carried their open verification question into §2.5 |
| 9 | design `:123` | Label selectors are the clean reconciliation key | §3.5, §5.5 | **New mechanism.** Labels implement "did this muxterm create it" — and are why muxterm needs no registry |
| 10 | design `:231,271` + `registry.py:1-11` | Registry unnamed, crash recovery undefined, current one a placeholder JSONL — still OPEN | §3.5 | Justifies the no-registry choice against a known-open problem |
| 11 | design `:85` (FM7), `:215-218` | Internal-only work invisible to idle detection; mitigation is operational polling, not a heartbeat | §2.4 | **Confirmed + adopted.** Same conclusion I reached independently; took their operational mitigation and the honest "latency, not lost work" framing |
| 12 | design `:86` (FM8), `:220,236` | Preview API churn; volume is the structural hedge; skew across adapters sharing one library | §5.6 | **New.** Second skew axis (muxterm vs preview API); pin the API version |
| 13 | design `:98` (§3) | "Control plane is thin mechanism. Policy … never in the broker." | §6.2 | Converts my assertion into a citation of their own stated philosophy |
| 14 | design `:127-129` | Dynamic Sessions and Jobs evaluated and rejected with reasons | §2, substrate | Substrate question settled; not re-litigated |
| 15 | agent-service `:51` | Port routing is supported capability "rather than an exec or file-transport workaround" | §2.3 | **Confronted.** Their choice is opposite to mine; resolved as same substrate, two transports, because payloads differ |
| 16 | agent-service `:52` | Port SSE/timeout/stability behaviours "not yet established as durable contracts" | §2.3 | Independent confirmation the port path is unproven, from the design that chose it |
| 17 | agent-service `:69` (D-05) | Port "must not become an alternate unauthenticated control plane"; port-level Entra auth not relied upon | §5.3 | Sharpened the no-ingress argument; adopted their distrust one step further |
| 18 | agent-service `:78` (D-14) | Transport disconnect never implies cancellation | §2.4, §0.1 | Confirms redial-not-cancel semantics |
| 19 | `cli.py:920-926` | "This is not a real pty — broker-mediated equivalent" | §0, §2.3 | The negative that defines the gap muxterm fills |
| 20 | `evidence/…-g0e.md:9-16,340` + 5 sibling docs | Zero live calls, zero sandboxes, zero ports, verdict BLOCKED; all blockers procedural | §2.3 | Establishes the port question is **open, not answered** — the distinction the whole verdict rests on |
| 21 | `_port_ops.py:37-56` | `add_port` auth modes: anonymous / entraId+emails / IP ACL; anonymous logged at WARNING | §5.3 | Ordering for any future port work; `--anonymous` never |
| 22 | `entrypoint.sh:54-117` | Dev-validation Key Vault fetch persists key **plaintext** to `~/.amplifier/keys.env` | §5.1 | The concrete #92 exfiltration example — a real file, not a hypothetical |
| 23 | `evidence/2026-08-10-key-custody…md` | tmpfs 0400, never env var — PASS; suspend-snapshot scope-limited, standing exposure | §5.1 | The secret-handling pattern the muxterm image must follow |
| 24 | `infra/resources.bicep:53-54,105-119,254` | Sandbox MI + Key Vault Secrets User; CI/CD via GitHub OIDC federated credential | §5.1, §5.2 | Contrast for "MVP assigns no managed identity"; proof C2 is enforced in infra |
| 25 | `reconcile.py:3-6` | "No code path in this module to any Azure sandbox deletion API" | §3.5 | Report-don't-reap posture adopted wholesale |
| 26 | `operator-mcp-tool-namespace-spec.md:43` | "No cost data source exists"; `estimated_cost: null` always | §3.4 | Runtime-not-dollars decision |
| 27 | design `:7,46` (C8) | ~15 users, single-digit concurrency, elastic scale explicitly out of scope | §1.1 | Kept me from overclaiming elasticity as the payoff; isolation is the real one |
| 28 | `git log` (20 commits) | Real production bug trail: tmux quoting, exit-code capture, IPv4, empty base URL | §0 | Establishes the repo as live and bug-fixed, not aspirational — which is why its constraints bind |

**Where this design deliberately diverges, and why** — each divergence is
recorded at its point of use, not buried here:

| Divergence | Their choice | This choice | Reason |
|---|---|---|---|
| Transport | Exposed HTTP port + broker proxy | `/exec/stream` WebSocket, no ingress | Payload is a raw byte stream, not HTTP (§2.3) |
| Control plane | Hosted broker | None — direct data plane, like ssh shelling out to `ssh` | muxterm already owns durability (§0.1, §6.2) |
| State store | JSONL registry (admitted placeholder, OPEN) | Azure labels only | One less thing that can drift (§3.5) |
| Durability model | Broker + LRO + idempotency keys | sessiond daemon | Structural, not built (§0.1) |
| Sandbox identity | User-assigned MI + Key Vault access | **None** in MVP | Smallest secure answer for what muxterm does (§5.1) |

**Honest limits of this read.** I did not read: `broker/app.py`, `broker/auth.py`
or `broker/operator/*` (whether the operator namespace is live is still open);
`dcr-shim/` and `identity-binding/` beyond their purpose (DCR is not in
muxterm's path — muxterm is not an MCP client of that broker); the full text of
the six evidence documents (I extracted verdicts, blockers and live-call counts,
which is what the transport question needs); `skills/cloud-amplifier/`;
`tests/`. None of these bear on the transport verdict or the security posture.
If any conclusion here is wrong, the most likely source is the operator
namespace's true status, which affects nothing in §S1–S6.
