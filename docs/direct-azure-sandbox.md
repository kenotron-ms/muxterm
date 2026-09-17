# Direct Azure Sandbox v1

`muxterm sandbox` is muxterm's **owner-local**, configuration-gated lifecycle
controller for Azure Container Apps Sandbox Groups. Browser/API callers select
only a configured profile name and opaque muxterm handle; they cannot provide
Azure identity, endpoint, scope, disk, image, port, labels, signer, or
credential data.

## Sealed operator profile

The controller reads but never writes `config.toml`. `[sandbox_azure]` is
excluded from browser JSON and browser configuration updates. With no section,
the feature is explicitly `unconfigured`; configured `enabled = false` is
`disabled`; `kill_switch = true` blocks create/resume/attach while retaining
truthful status and cleanup.

```toml
[sandbox_azure]
enabled = true
kill_switch = false
store_dir = "/absolute/owner-only/path/muxterm-sandboxes"

[[sandbox_azure.profile]]
name = "nonprod-sessiond"
tenant_id = "00000000-0000-0000-0000-000000000000"
subscription_id = "00000000-0000-0000-0000-000000000000"
resource_group = "nonprod-rg"
sandbox_group = "nonprod-group"
region = "westus2"
disk_id = "/subscriptions/.../diskImages/pinned-sessiond-image"
image_digest = "registry.example/muxterm-sessiond@sha256:<64-lowercase-hex>"
release_status = "active"
protocol = 1
cpu = "1000m"
memory = "2048Mi"
auto_suspend_seconds = 300
auto_delete_seconds = 3600
controller_cidrs = ["192.0.2.0/24"]
egress_hosts = ["packages.example.com"]
```

Enabled profiles fail closed before any provider request unless they have:

- an `active` release, protocol `1`, registered private disk ID, and reviewed
  immutable OCI image digest;
- CPU/memory, disk-backed auto-suspend, and an auto-delete TTL between 300 and
  86,400 seconds;
- one to ten exact controller egress CIDRs, never IPv4 or IPv6 `/0`; and
- zero to ten exact lowercase DNS egress hostnames. Schemes, paths, ports,
  userinfo, wildcard patterns, and literal IP addresses are rejected.

The create request has a single port `8443`, default-deny IP access control,
and one configured CIDR allow rule. Its environment is exactly four
controller-derived values: protocol, lifecycle generation, profile checksum,
and an Ed25519 **public** verification key derived from the record's private signer.
Those runtime bindings, the disk/image binding, provider ID, labels, and signer
never appear in CLI, HTTP, browser, or error output.

Create also always sends `egressPolicy.defaultAction = Deny`. Each reviewed
`egress_hosts` entry becomes only a simple `{pattern, action: Allow}` host
rule—no caller-selected egress rule/body exists. An empty `egress_hosts` list
is valid and means explicit no-egress.

The direct request shape is based on the current vendored
`azure-containerapps-sandbox` source: `AsyncSandboxOperationsMixin` supports
group `PUT/GET /sandboxes` and delete; `SandboxClient` supports `POST /stop`
and `POST /resume`; `LifecyclePolicy._to_dict` supports `autoSuspendPolicy`
and `autoDeletePolicy`; and `AddPortRequest._to_dict` supports
`ports[].ipAccessControl` with `defaultAction` and rules. The vendored
`EgressPolicy._to_dict` supports `egressPolicy.defaultAction` and
`hostRules[].{pattern,action}`. This controller has no generic Azure request
or endpoint interface.

Collection observation follows the vendored `nextLink` paging shape through at
most 100 pages, including its supported bare-array response form. Each next
link must be HTTPS, have no userinfo or fragment, use the configured regional
data-plane host, exact configured Sandbox Group collection path, and one
configured API-version value; anything else is rejected without following it.

The vendored preview source establishes typed `404` as the controller's sole
absence signal. Any other Azure non-2xx response—including `409` and `412`—is
treated as an ambiguous possible lifecycle effect, never as proof of no effect.
For create, only the controller's fixed labels may then be reconciled. The
`provider-rejected` state is reserved for local typed create-spec validation
and the deterministic fake-provider failed-operation fixture.

## Lifecycle and durable state

```text
muxterm sandbox list
muxterm sandbox describe|status <handle>
muxterm sandbox create --profile nonprod-sessiond --request-id <uuid>
muxterm sandbox stop <handle> <generation> --request-id <uuid>
muxterm sandbox resume <handle> <generation> --request-id <uuid>
muxterm sandbox destroy <handle> <generation> --request-id <uuid>
muxterm sandbox reconcile <handle> <generation> --request-id <uuid>
muxterm sandbox attach <handle> <generation> --request-id <uuid>
```

Each record is private durable state: opaque handle, private provider identity,
profile checksum, generation, desired/observed state, persisted operation
history, request IDs, expected generation, and private signer. The root is
`0700`; records/locks are `0600`. Exact UUID retries replay the original
operation without advancing generation or re-calling the provider. Reuse for a
different handle, operation, profile, or expected generation is rejected.

`accepted` means the provider accepted a request—not completion. Every
accepted create/stop/resume/destroy becomes reconciliation-required; no
superseding lifecycle mutation, including destroy, is admitted until explicit
reconciliation observes the requested valid target. `reconcile` is the sole
explicit provider observation and marks an operation `succeeded` only when it
observes `Running`, `Stopped`/`Suspended`/`Idle`, or `404` after destroy.
An observation that completes while the lifecycle is still `Creating` or
`Stopping` records that **reconcile** as succeeded, but list/describe continue
to show the prior lifecycle operation as `accepted` with
`reconcile-needed`; a later reconciliation is required before any superseding
lifecycle action.
Ambiguous outcomes remain reconciliation-required or quarantined; no blind
provider retry occurs. List and describe are local durable reads: they do not
acquire a token or make cloud calls.

The store rejects symlink roots, non-private root/record/lock files, unsafe
ancestors, and cross-principal replacement detected by pre/post-open descriptor
checks. Sticky ancestors such as `/tmp` are accepted because other users cannot
replace an owner-owned child there. This portable source defense does not claim
to defend against privileged or hostile same-UID code.

## HTTP and Settings surface

```text
GET  /api/sandboxes
GET  /api/sandboxes/{handle}
GET  /api/sandboxes/presentation
POST /api/sandboxes
POST /api/sandboxes/{handle}/{attach|stop|resume|destroy|reconcile}
```

These are a distinct protected route family, not SSH remotes. The
`presentation` route is an authenticated, read-only projection built from the
already-loaded sealed configuration and the owner-local durable store. It
returns only configuration state, the fixed `unavailable` attach status, a
safe reason code/text, sorted profile names, and opaque local lifecycle
records. Rendering or reading it makes no provider, credential, reconcile, or
network call. Every mutation requires UUID `Idempotency-Key`. Create admits
only `profile`; actions admit only `generation`, plus `confirm_handle` matching
`{handle}` for destroy. Strict JSON rejects all other fields. A mutation
returns `202` only for a persisted `accepted` operation, `200` for observed
success, and a safe non-2xx record view for pending, failed, ambiguous, or
collision outcomes—an exact retry never receives `202` merely because it was
retried.

Sandbox routes do **not** accept muxterm's ordinary loopback bypass. In local
mode, a browser must obtain a normal muxterm auth-server cookie/bearer session.
A same-UID helper can instead use only the private `LocalToken` bearer. The
routes are unavailable under `--no-auth`, without changing authentication for
unrelated muxterm routes.

**Settings → Sandboxes** consumes the presentation route for the configured
state, owner-configured profile names, and local inventory. It explicitly
renders validation pending/loading, unconfigured, configured lifecycle-only,
disabled/kill-switch unavailable, and error states. A lifecycle create is
rendered and admitted only when a selected name is from the server-supplied
profile allowlist and the lifecycle collection reports safe `ready`
availability. It always says terminal/workspace connection is unavailable and
does not offer Connect, Attach, Open terminal, or Azure workspace creation. It
does not show a remote, workspace, provider identity, endpoint, label,
credential, scope, or signer. The browser keeps one generated UUID for a
retried action and asks for a local destroy confirmation before sending the
matching-handle confirmation field.
If a reconcile receives a known non-2xx HTTP response, its request UUID is
rotated so the next explicit refresh performs a new observation. A network
failure has no known response and retains its UUID for safe retry.
If Sandbox-specific authentication reports that sign-in is required, the screen
offers the normal `/auth/login?return_to=...` flow; it neither displays nor
handles any token.

## Image ingress adapter and attach blocker

`cmd/muxterm-sandbox-ingress` and `internal/sandboxingress` are the reviewed
image-side primitives built from this branch. The fixed adapter listens on
port `8443`; it accepts only cookie-free, origin-free, bearer-free WSS upgrades
at `/v1/sessiond`, requires a bounded nonce/TTL/profile-checksum/generation
Ed25519 proof, permits one stream, and proxies bounded binary frames to the
image's private sessiond Unix socket. It contains no Azure lifecycle controls.
Only after sessiond's private socket is live and the adapter has been
constructed, its enclosing runtime handler returns content-free `204 No
Content` for exact `GET /healthz` (with no query). Non-GET, query-bearing, and
other non-sessiond paths are rejected without runtime/configuration details.
If the private sessiond socket is no longer live, `/healthz` immediately returns
content-free `503`, not `204`.
This is the source-backed readiness contract for the current-branch image kit;
it is not a public session endpoint.

Before parsing its four controller-generated runtime bindings or starting
sessiond, the ingress command rejects inherited environment **names** that
could carry Azure, ARM, MSI, managed-identity, browser token, client-secret,
private-key, credential, or API-key material. This is necessary because
sessiond children inherit the process environment. The check never logs names
or values; `MUXTERM_SANDBOX_INGRESS_VERIFY_KEY` is explicitly allowed because
it is the controller-derived public verification key.

Controller attach remains explicitly unsupported. The source proves the sealed
image/runtime proof protocol can build from current muxterm source, but does
not establish Azure's external inbound WSS port behavior or the provider's
actual registered-disk-to-image-digest association. Those are the narrow
external prerequisites for live deployment and for enabling controller attach;
until then no API or UI claims connection success.

## Delivery status

The current source delivers sealed lifecycle and image-side safeguards; it does not deliver a live provider attachment, image deployment, lifecycle/cleanup proof, or user access. All evidence here is source and offline verification only.

| Delivery item | Status | Source-addressable record |
| --- | --- | --- |
| Source baseline | Delivered | `internal/sandboxazure`, `internal/server/sandboxes_api.go`, and `internal/config/config.go` provide configuration-gated profiles, protected routes, durable idempotency, reconciliation, and generation fences. |
| Authenticated attach | Residual | `sandboxazure.Controller.Attach` applies pre-dial state fences, then returns `sandboxazure.ErrAttachUnsupported`. |
| Image/provider readiness | Residual | `cmd/muxterm-sandbox-ingress` and `internal/sandboxingress` provide an image-side bounded challenge/proof binary bridge, not provider deployment or image provenance. |
| Live proof/lifecycle cleanup | Residual | Source/offline verification is not live provider lifecycle, attachment, or cleanup evidence. |
| Conditional access | Residual | This source performs no Azure RBAC assignments and must not use a direct-provider role as an attach substitute. |
| Settings/sidebar read-only inventory presentation | Delivered | `internal/server/sandboxes_api.go:handleSandboxPresentation` and `sandboxazure.PresentationReader` provide authenticated, read-only configuration/profile/inventory data; `web/src/components/settings-surface.ts` and `web/src/components/mux-sidebar.ts` expose only safe local presentation and keep terminal/workspace connection unavailable. This is not a configured deployment or normal workspace/remote deliverable. |
| Settings configured deployment selection/validation/persistence | Residual | `sandboxazure.Profile` in `internal/sandboxazure/config.go` has no non-secret broker/deployment reference field, and the source has no server-side validation/persistence API for such a reference; `internal/sandboxazure/provider.go:Provider` offers lifecycle CRUD only. Safe behavior is to expose only server-allowlisted profile names and read-only records, with no settings writes or endpoint discovery. The next action is a reviewed server-side deployment-reference and validation contract that can be projected and persisted owner-only without browser credentials or endpoints. |
| Normal Azure workspace/sidebar | Residual | `internal/sandboxazure/controller.go:Controller.Attach` returns `sandboxazure.ErrAttachUnsupported`, while `internal/sandboxazure/provider.go:Provider` has no verified sessiond stream contract. Until verified sandbox identity and sessiond transport exist, the safe behavior is the separate Azure inventory group only: no remote registry, workspace creation, or socket path. |
| Checks/docs | Offline only | `go run ./cmd/sandbox-verify` verifies the source contract offline; it is not live provider evidence. |

The delivered inventory does not establish verified sandbox identity,
sessiond readiness, reconnect semantics, or RBAC authorization. The Settings
and sidebar surfaces are therefore truthful local presentation only; they make
no provider calls on render/read and never reconstitute a remote or workspace
from a lifecycle record.

Current safeguards keep profiles configuration-gated and sandbox routes within the existing protected-route model. Browser callers cannot supply provider credentials; implementation must not manufacture a generic proxy, tunnel, or REST read/input loop as a sessiond attach. The fixed ingress adapter is only an image-side source primitive with bounded challenge/proof and binary bridging.

The residual blocker is a requirement missing from this source: a versioned, supported provider or broker contract must be supplied and reviewed for authenticated binary sessiond transport bound to owner, session, handle, generation, profile, and endpoint, with short-lived single-use proofs, replay fencing, and lifecycle/reconnect semantics. Documented immutable image-digest-to-registered-disk provenance is also required.

Next, obtain that approved contract and provenance, or an explicit high-impact owner decision to deploy a broker-owned WSS attachment service with server-side authorization and provider-held authority. The latter is not authorized by this source-only status. Then perform the separately approved single-sandbox live proof and cleanup before any user role assignment.

## Operations bounds

Each serialized controller/provider attempt has a hard **30-second** context
deadline; the direct HTTP client has the same 30-second request bound. The
store lock is the single-machine concurrency boundary: one lifecycle transition
or reconciliation runs at a time for all records. Provider quota/capacity
responses are bounded, redacted failures; they never synthesize success and
require operator reconciliation before retrying a mutation. Audit-safe logs and
external views use opaque handles and state only, never provider IDs, endpoints,
runtime values, labels, signers, or credentials.

Created provider labels are fixed controller audit bindings
(`muxterm.handle`, `muxterm.request-id`, and the reviewed image digest) rather
than caller data. The hard auto-delete TTL is a cost bound, not automatic local
cleanup: muxterm does not claim unattended cleanup after it is offline. The
owner must reconcile accepted or ambiguous records and use destroy for safe
cleanup. The kill switch prevents new create/resume/attach while retaining
truthful local status and destroy of already reconciled owned resources.
