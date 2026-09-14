# Share-ready sandboxed workspaces — foundation record

**Status:** owner-only foundation. This document records an architectural boundary; it does **not** enable workspace sharing.

## Scope and guardrails

This track prepares muxterm so a later, separately-approved sharing design has a durable workspace identity and one authorization seam to replace. It deliberately does **not** add:

- public URLs, anonymous access, invitations, membership, users, roles, ACL editing, tenant migration, or external identity provisioning;
- cross-user workspace attachment, terminal output, screen previews, transcripts, files, task controls, sidecars, voice state, or workspace metadata exposure;
- a sandbox transport, a network listener for `sessiond`, or a relaxation of same-UID `sessiond` access;
- any UI/sidebar work. The separate UX/mock worktree owns sidebar grouping.

All present and migrated workspaces remain private to muxterm's one current local owner by default.

## What “sandboxed workspace” means today

There is no muxterm sandbox transport implementation today. In the current architecture, a sandbox is a prospective remote host/runtime that could eventually own a `sessiond` daemon and its PTYs; it is **not** an authorization principal or a shared workspace.

| Concern | Current fact | Evidence |
|---|---|---|
| Process/isolation owner | `sessiond` owns the PTY process, lifecycle, replay buffer, and workspace registry. A workspace is a daemon-local record. | `internal/sessiond/server.go:28-56`, `internal/sessiond/registry.go:9-17` |
| Current workspace ID | The daemon allocates runtime IDs such as `w1`; pane IDs are workspace-local. Neither identifies an owner and restored workspaces get fresh runtime IDs. | `internal/sessiond/registry.go:74-95`, `internal/sessiond/snapshot.go:62-66`, `internal/sessiond/snapshot.go:507-514` |
| Persistence | Session restore writes a local snapshot under the XDG data directory and relaunches panes from snapshot state. | `internal/sessiond/snapshot.go:120-161`, `internal/sessiond/snapshot.go:478-539` |
| Browser admission | Browser/session bearer authentication is an admission check. It currently does not carry a user subject into workspace authorization. | `internal/server/authmiddleware.go:79-128`, `internal/authserver/authserver.go:172-201` |
| Local authority | The Unix socket directory/socket are private, and Linux `SO_PEERCRED` admits only the daemon's UID. This is a local-OS-user boundary, not a per-workspace ACL. | `internal/sessiond/server.go:96-123`, `internal/sessiond/peercred_linux.go:13-42` |
| Remote-machine identity | `transport.HostRef.ID` is a stable transport/machine key and `DisplayName` is mutable presentation. It must not be an owner identity. | `internal/transport/transport.go:26-44` |
| Remote transport | SSH authenticates the service/OS user to the far Unix socket. It does not convey a browser-user subject or a workspace grant. | `internal/transport/ssh/ssh.go:47-171`, `cmd/muxterm/sessiond_connect.go:12-25` |
| Sandbox substrate | The existing design records that a prospective sandbox substrate currently supplies neither a bidirectional binary stream nor caller identity. | `docs/designs/2026-09-05-remote-sessiond-design.md:156-193` |

**Conclusion:** sandbox isolation limits process/runtime blast radius. It does not decide who may discover, read, control, or close a workspace. A tunnel, a remote browser connection, an SSH transport, and a read-only published artifact are all different things; none is workspace sharing.

## Chosen foundation

### Stable identities

The implementation introduces these internal-only identifiers:

- **instance owner principal ID** — cryptographically random, opaque, private state for this muxterm installation. It is neither a browser cookie/token, a browser session, a user name, OS UID, SSH login, host ID, sandbox ID, nor authentication-provider claim.
- **workspace security ID** — cryptographically random, opaque identity created for each workspace and preserved in a compatible restore snapshot. It is separate from mutable workspace names and daemon runtime `wN` IDs.
- **policy reference** — a versioned reference field with the only currently valid policy kind, `owner-only`. It is an anchor for a future explicit ACL/policy design, not an ACL, membership list, or role assignment mechanism.

The IDs remain daemon persistence data. They do not cross the frozen browser/sessiond protocol and are never rendered, logged, sent to MCP, or made part of a URL.

### Versioned metadata and migration

Workspace security metadata is nested in the daemon restore envelope, while the installation-owner record is the private XDG data file `instance-owner.json` beside existing durable muxterm state. Both are atomically written with private permissions (`0700` parent and `0600` file).

| Input state | Owner-only behavior | Snapshot write behavior |
|---|---|---|
| No snapshot / first start | Mint private installation owner and fresh workspace metadata. | Normal snapshots are safe. |
| Legacy v0/v1 snapshot with all security metadata omitted | Restore exactly as before, lazily mint owner-only metadata in memory, and persist it in a v2 snapshot on a later normal write. | Safe after successful migration. |
| Valid current v2 snapshot | Require every workspace to carry valid canonical `owner-only` metadata bound to the same installation owner and retain security workspace IDs despite fresh `wN` runtime IDs. | Safe. |
| Mixed/missing v2 security metadata | Fail closed; never reinterpret a v2 snapshot as legacy. | Suppressed. |
| Missing/corrupt/future snapshot | Preserve the source snapshot; follow the existing blank-safe start behavior. | Suppressed so a failed parse cannot overwrite recovery evidence. |
| Invalid/current metadata or owner mismatch | Fail closed for that snapshot; never infer an owner from name, `wN`, pane ID, contents, host label, or browser state. | Suppressed. |
| Older binary later rewrites an envelope | A newer binary treats the missing fields as a legacy migration and creates new security IDs rather than guessing continuity. | No authorization state can be transferred by guesswork. |

This is intentionally a conservative compatibility story. The present owner remains able to use legacy workspaces, while a future grant cannot survive an ambiguous/rollback path.

### Central authorization seam

The shared package supplies a single owner-only evaluator. It receives an internal principal plus a typed resource/action, and returns only allow/deny. The present evaluator permits only the exact instance owner. It has no collaborator condition and no configuration switch that can make a foreign principal succeed. Browser-facing resource decisions carry only the trusted internal runtime workspace ID plus the `HostRef.ID` routing scope; neither is a principal or the private workspace security ID. The owner-only evaluator uses that scope only as a lookup handle. A future per-workspace evaluator requires a trusted daemon-side resolver from `(host, runtime workspace ID)` to the private security ID before it can enforce workspace-specific policy.

The server receives a server-created admission from the authenticated/local-owner boundary and applies the evaluator before a protected handler or WebSocket can touch daemon data. Legacy server construction with no authorization fields receives an in-memory owner-only default for compatibility; once any owner/authorizer/principal/admission field is supplied, all of owner, authorizer, matching owner principal, and valid matching admission are required, otherwise protected paths fail closed. Cookie/bearer admissions retain only a private renewal closure that rechecks the existing token manager, so expiry or revocation ends the WebSocket before any subsequent control or egress. Direct loopback browser requests require the same existing browser login: a loopback IP does not prove the current OS user. The browser password is verified by the existing login backend for this instance's current OS account, while the workspace owner principal remains opaque and separate from that account name. `--no-auth` remains the explicit insecure development/test escape and the same-UID local helper token remains a separate local administration channel. A synthetic non-owner, stale, or absent admission exists only as an injected development/integration subject; no request header, browser UI, query parameter, external token, or provider can manufacture it in normal operation.

Required egress coverage is explicit:

| Boundary | Decision before state/data/control |
|---|---|
| Browser WebSocket setup | Before daemon dial or initial workspace enumeration. |
| Workspace reads and controls | Before list/create/attach/rename/layout/pane create-input-resize-focus-close and close confirmation. |
| Terminal data | Before composition/replay/live pane bytes are emitted; attached-pane bytes and events capture a host/workspace/attachment epoch before sequencing, then recheck it under the sequencing lock before authorization and egress. |
| Full-fleet pushes | Before cache/update/emit of workspace list, preview, and session-state documents. |
| Host/file/detail surfaces | Treated as machine/instance authority, never implicitly granted by a future workspace read permission. |
| MCP | Current stdio/same-UID MCP stays owner-only; it cannot impersonate a future collaborator. |
| CoS/voice | Currently instance-global and owner-only. Future workspace sharing cannot implicitly expose sidecar transcript, approvals, voice handles, or voice broadcasts. |
| Raw `sessiond` / remote transport | Same-UID local admission remains owner-only. A remote byte stream is not a browser principal. |

## Threat model and present treatment

| Threat | Foundation response | Deferred proof before any sharing release |
|---|---|---|
| Cross-user discovery/data leak | Owner-only authorization gates the WebSocket before workspace enumeration and data emission; full-set events are egress-gated. | Per-workspace filtering at every producer/relay. |
| Browser/MCP confused deputy | Browser subject is server-created; stdio MCP remains local-owner only and cannot assert a browser subject. | Credential audience/resource binding and a separate network-MCP design. |
| Workspace-ID guessing | The owner-only perimeter receives the requested runtime `wN` and host scope only as an internal routing handle; it never treats either as an owner/principal or exposes private metadata. Denials do not distinguish existence. | A trusted daemon-side runtime-to-security-ID resolver, then constant response/error policy and abuse-rate controls. |
| Stale grants/revocation | There are no grants to become stale. Metadata carries no membership. | Explicit approval, expiry/lease, revocation propagation, audit decision model, and reconnect behavior. |
| Forgotten browser connections | Browser/session authentication remains admission-only; authorization is reapplied before sensitive output/control egress. | Server-side session lifecycle and prompt invalidation on revocation. |
| Remote host impersonation | Host ID is routing context only; it never establishes user ownership. | Authenticated encrypted transport, peer/issuer trust, host-key/certificate validation, and cross-server trust rules. |
| PTY input, resize, focus, or close escalation | Owner-only action gate precedes each control path. Existing activity-aware close safety remains intact. | Capability-separated roles and confirmation/revocation re-checks on close tickets. |
| Terminal replay, preview, session-state, transcript exposure | Owner-only egress gate is required before bytes/document emission. | Subscriber filtering/redaction semantics and no fanout of unauthorized metadata. |
| File/PR/sidecar/voice escalation | Classified as machine/instance authority, not as workspace read access. | Separate per-resource policy and explicit consent boundary. |
| Sandboxing mistaken for authorization | Documented and structurally avoided: sandbox/transport identity cannot satisfy a principal check. | Sandbox bridge handshake, subject proof, listener policy, liveness/reconnect and ingress validation. |

No new user-data audit store is created. Future access decisions must be auditable, but audit retention, data minimization, viewer access, and correlation identifiers remain product/security decisions rather than silently manufactured storage.

## Future role and capability vocabulary (documentation only)

If sharing is approved, the minimum capability model must separate at least:

- **owner** — policy, sharing, lifecycle, and revocation authority;
- **viewer** — explicit, read-only workspace metadata/output where individually approved;
- **operator** — an independently granted input/control capability; never implied by viewing;
- **manager** — an independently granted workspace/pane lifecycle capability; never implied by operator;
- **instance administrator** — host, transport, configuration, tunnel, update, files, PR integration, CoS, and voice authority, all separate from workspace roles.

Terminal input executes in the workspace's OS/security context. Resize and focus influence a live TTY. Close terminates work. File access, transcript access, task approval, sidecar control, voice control, remote provisioning, tunneling, updates, and `gh` access can have broader machine consequences. None can be a default consequence of future workspace visibility.

## Perimeter requirements before enabling sharing

A sharing release must prove, not assume:

1. a stable authenticated application principal source and subject lifecycle;
2. per-request/session subject separation and no reliance on client-supplied IDs;
3. authenticated, encrypted transport plus explicit host/issuer trust across servers;
4. resource-scoped capability checks before every read/control/data egress, including event fanout;
5. explicit owner approval, expiration/lease semantics, immediate revocation checks, and reconnection handling;
6. no information leak on absent/foreign/stale identity, guessed workspace ID, or revoked access;
7. a separate-origin or equivalent browser perimeter for tunneled/untrusted content before it can coexist with less-trusted authenticated users;
8. testing with only fresh dev-local/DTU state and synthetic principals, never a real user's browser, workspace, transcript, configuration, or second session.

## Deliberately deferred

- actual team membership, identity-provider integration, tenant model, user names, role policy, invitations, ACL storage/editing, audit retention, and revocation implementation;
- sandbox provisioning/discovery/ingress and a sandbox-side bridge;
- remote cross-server authorization and subject forwarding;
- filtered collaborative fleet, preview, transcript, file, PR, CoS, or voice behavior;
- all sharing UI, including sidebar grouping.

The following decision gate is therefore mandatory before real sharing: **Which system issues and verifies application principals, how does a remote/sandbox listener prove and receive them, and which servers trust which issuers under what lease/revocation model?**
