# File Explorer uploads

## Outcome

The Files applet accepts one or more ordinary desktop files by dropping them onto
its current directory list or by choosing **Upload files**. The target is exactly
the directory the applet had rendered when the operation was started. A compact,
per-file queue lives inside the applet; it offers cancel, reports calm outcomes,
and refreshes the listing only after an atomic server commit.

## Destination and host resolution

The existing Files applet is local-only: it builds roots from local fleet project
paths and explicitly excludes namespaced remote workspace IDs
(`applet-files.ts`). `GET /api/files` runs in the serve process and has no
remote transport. This feature preserves that division.

For this first write surface, the server's cleaned working directory is the
configured local Explorer root. A directory is uploadable only when its
canonical, no-symlink path is that root or a descendant. The listing may still
show other readable locations under the existing read contract, but its upload
control states plainly that the location is outside the configured Explorer
root. A remote/SSH directory is not accepted or remapped to local;
the UI is unavailable until a scoped remote writer exists.

The authenticated app shell gives each browser an HttpOnly, SameSite attachment
cookie. Its WebSocket is registered server-side under a hash of that cookie.
When it successfully lists an eligible local directory, the server creates a
short-lived directory binding owned by that live WebSocket and its current
local workspace attachment. The browser cannot read either identifier and sends
no destination identity at all on upload. A request binds its parent directory
descriptor before it receives bytes, and rechecks the binding immediately
before commit; navigation, reattachment, expiry, or socket loss causes the
temporary file to be discarded rather than written to a new directory.

## Protocol and authorization

`POST /api/files/upload` is a same-origin streaming multipart request protected
by the existing protected-route authentication plus a required exact Origin and
`Sec-Fetch-Site` check. It is intentionally not a public/general file API.
Requests need the active browser attachment and server-side directory binding,
and fail with one generic safe sentence when authentication, origin, binding,
or scope is absent. The route does not accept host addresses, workspace
identifiers, absolute paths, remote credentials, or a browser-carried host
token.

The binding is local-host-only. Remote sessiond intentionally exposes only
read-file/list-dir operations today; adding a general writer would overturn its
structural read-only boundary. Remote upload is an explicit unsupported state.

## File and path model

Each multipart part is one regular browser `File`. Names are normalized as a
single basename and reject empty, dot/reserved, absolute, separator-containing,
NUL/control-character, and oversized names. Directory, text, URL, HTML and
archive drops are rejected by the UI; server validation does not depend on MIME
or the UI. Limits are server-enforced while streaming: per file, aggregate
request, concurrent request, and wall-clock limits. Content-Length is advisory.

The destination directory is opened with no-follow semantics after its complete
path is checked below the Explorer root. The server works relative to that open
directory descriptor, refuses symlink/special-file destinations, and preserves
server-selected permissions. No browser path prefix test authorizes a write.

## Atomicity, conflicts, and cancellation

Bytes stream directly to a freshly created hidden temporary file in the opened
destination. They are never buffered as base64 or as a whole file. On a complete
stream, the server fsyncs the temp, verifies the byte count, rechecks the final
name using descriptor-relative no-follow calls, and atomically links/renames
only after a conflict decision.

The default is **never overwrite**. A pre-existing destination returns
`conflict`, naming only the browser-visible filename. The queue offers Cancel,
Keep both, or Replace; Replace requires a confirmation click. The server
rechecks immediately before commit. A conflict race returns conflict again;
there is no implicit replacement. Keep both chooses and returns a deterministic
available browser-visible name. Cancellation, request/context loss, expiry,
unmount, server shutdown, or error closes and unlinks only the server-owned
temporary file. Startup cleanup is bounded to this feature's owned temp naming
pattern and never removes a completed user file.

## UX state machine

1. **Unavailable** — upload action alone is disabled with a specific reason:
   no current listing/binding, configured-root boundary, read-only directory,
   expired binding, or unsupported host writer.
2. **Ready** — picker is available; a valid `Files` drag over the directory
   list adds a `Upload to <folder>` overlay (and local-host wording when useful).
   Dragging other controls, directories, text/URL/HTML, or archives does not
   enter this state.
3. **Queued/streaming** — each file shows its visible name, byte progress and
   Cancel. The app streams at a limited client concurrency and sends no source
   path.
4. **Conflict** — that row pauses and exposes Cancel, Keep both, and an
   explicitly-confirmed Replace. Other queued files continue independently.
5. **Completed/failed/cancelled** — a concise row outcome is shown. Only a
   confirmed completed atomic commit schedules a current-directory refresh;
   selection, focus and navigation are not reset.

A live region announces starts, conflicts, and terminal summaries, not every
progress increment. Picker and drag/drop use exactly this same queue.

## Supported-host matrix

| Displayed source | Read/listing | Upload |
| --- | --- | --- |
| Local directory at/below configured Explorer root | Existing local `/api/files` | Supported when writable |
| Other local readable directory | Existing local `/api/files` | Unavailable: outside configured Explorer root |
| SSH/remote directory | Not rendered by the present Files applet; sessiond has separate MCP-only read operations | **Unavailable.** The current sessiond filesystem protocol is structurally read-only and no workspace-scoped remote Explorer capability exists. This PR must not fall back to the local filesystem. |

## Remote host investigation and decision

### Existing SSH seam

SSH already supplies the right *transport shape*, but not an upload authority:

1. `internal/transport/ssh/ssh.go` starts the fixed remote command
   `muxterm sessiond-connect` through `ssh -T`; it returns stdin/stdout as a
   binary-clean `net.Conn`. The browser never receives an SSH target, key,
   tunnel, or socket address.
2. `cmd/muxterm/sessiond_connect.go` copies that stream to the remote user's
   local Unix sessiond socket. The remote-side process is the authenticated SSH
   user, so the existing local-socket peer-credential check remains valid.
3. `internal/server/remotes.go` owns one `hostSession` per browser WebSocket and
   remote `HostRef`. It reconnects independently and owns the live
   `DaemonConn`; the process-wide remote registry deliberately owns no shared
   connection.
4. `internal/server/hostid.go` namespaces browser-facing workspace ids with the
   stable `HostRef.ID`, never a display label. `HostRef.ID`,
   `DisplayName`, and transport-private `Addr` are intentionally different
   concepts (`internal/transport/transport.go`).
5. `internal/sessiond/protocol.go` can carry binary-clean framed data over this
   connection. Its only filesystem messages today are deliberately
   `read-file` and `list-dir`; `internal/sessiond/fsread.go` contains no
   mutating system call, and those read requests are not scoped to a workspace.

That last point is decisive. `read-file` / `list-dir` cannot become the
remote Explorer upload seam: their caller-provided absolute path model, their
intentional workspace independence, and their read-only implementation make
them wrong for this authority. Reusing SSH's ability to run commands, `scp`,
SFTP, a generic file API, or an arbitrary remote command would bypass exactly
the muxterm boundary that makes the existing remoting safe.

### Decision for this PR

**SSH uploads are feasible only as a separately implemented additive sessiond
capability. They are not implemented in this PR.** The local upload feature
ships unchanged and remote uploads remain unavailable.

The missing work is not merely a byte-copy method:

- The present Files applet deliberately excludes remote roots
  (`web/src/components/applets/applet-files.ts`) because `/api/files` lists the
  local serve process. There is no current remote Explorer list/navigation
  contract to bind an upload destination to.
- `DaemonConn` does not expose an upload capability or connection incarnation.
  A remote reconnect replaces its `DaemonConn`; current remote recovery is
  intentionally allowed to reattach a terminal, which is unsafe as an implicit
  continuation for a write.
- Sessiond has no workspace-owned Explorer root descriptor and no remote
  upload temp/state cleanup protocol. Adding a raw write verb to the current
  filesystem protocol would turn a structurally read-only surface into an
  arbitrary filesystem writer.

## Required SSH follow-on: Remote File Upload v1

This is the minimum design that may promote SSH from **Unavailable** to
**Supported**. It is a follow-on contract, not a claim that the messages,
remote Explorer, or transport lifecycle hooks exist in this PR.

### Authority and source model

The browser continues to upload one multipart file only to its authenticated,
same-origin local muxterm server. It never opens SSH/SFTP, reaches a remote URL,
or receives a remote credential, socket location, host address, path,
directory capability, temporary name, or upload id.

The local server owns a `remoteUploadLease` for the request. Its immutable
authoritative tuple is:

```text
browser WebSocket identity
HostRef.ID
remote HostRef source generation
remote machine identity
remote sessiond incarnation
namespaced browser workspace id + bare remote workspace id
remote Explorer directory capability + opened directory identity
server-generated upload UUID
lease expiry and byte/count/concurrency ceilings
```

`HostRef.ID` is the durable source key; `DisplayName` is presentation only and
`Addr` is interpreted only by the SSH transport. A host registry replacement
with the same label, an SSH reconnect, a changed `Addr`, or a remote daemon
restart therefore cannot inherit an existing write capability.

The server may create the lease only after all of these checks succeed:

1. The authenticated HTTP request maps to the exact live browser WebSocket,
   not just a shared login cookie.
2. That WebSocket is currently attached to the requested namespaced remote
   workspace; the resolved `HostRef.ID` still names the same live
   `hostSession`.
3. `hostSession` is connected and presents a fresh Remote File Upload v1
   capability reply from its current `DaemonConn`.
4. The returned machine identity and daemon incarnation equal the identity
   recorded for this source generation.
5. Remote sessiond opened the directory from the authorized workspace Explorer
   root and returned a connection-scoped directory capability. The server holds
   it; it is not encoded in a browser route, cookie, log, or response.

The server repeats the relevant tuple checks before it sends **begin**, before
it forwards each **chunk**, and before it forwards **commit** or **cancel**.
The remote sessiond repeats its own connection, workspace, capability, lease,
directory identity, sequence, expiry, and limit checks for every operation.
Either layer fences the upload if a check changes.

### Remote Explorer is a prerequisite, not a path parameter

The present remote `read-file` and `list-dir` calls intentionally accept
absolute remote paths for their MCP use case and are not attached to a
workspace. A future browser Explorer must not call them to authorize uploads.

Instead, remote sessiond needs a separate workspace-scoped Explorer capability:

```text
remote-file-explorer-open(workspace)
remote-file-explorer-enter(directory-capability, visible-child-name)
remote-file-explorer-up(directory-capability)
remote-file-explorer-list(directory-capability)
```

The opening operation has no browser-provided filesystem path. It starts from a
workspace Explorer root that sessiond itself received from a trusted workspace
creation/assignment path and holds as a no-follow directory descriptor. A
workspace without that authoritative root has no remote Files surface.

Each navigation operation accepts only one visible child basename, rejects
separators, `.` / `..`, NUL/control/reserved names, and opens the child
descriptor-relative with no symlink traversal. Sessiond stores the returned
directory capability per connection, per workspace, and per daemon
incarnation. It returns names and safe display crumbs only. The server maps
browser navigation intent to that state; it never derives a host, workspace, or
remote absolute path from a display string.

### Capability negotiation

Additive sessiond messages follow the established
`preview-subscribe`/acknowledgement pattern, but are independently versioned:

```text
remote-file-upload-capability
remote-file-upload-capability-result
```

The result must contain, at minimum:

```text
protocol_version = 1
machine_id
daemon_incarnation
max_chunk_bytes
max_file_bytes
max_aggregate_bytes
max_concurrent_uploads
```

It is a positive proof, not an optimistic assumption. A timeout, unknown
message, malformed response, lower protocol version, changed identity, absent
workspace Explorer root, or disabled remote policy yields a precise
non-disclosing availability result **before the browser reads or sends file
bytes**:

> Uploads are unavailable on this remote folder because its muxterm host does
> not support secure file upload.

The server should retain only a stable public reason category. It must not
reflect remote shell, SSH, path, socket, or host details into the Files applet.

### Wire shape and bounded streaming

The upload protocol is an additive sessiond control/data family. It must use a
new binary frame kind, for example `FrameRemoteFileUploadData`, rather than
base64 in the `Message` JSON or `FramePaneData`:

```text
remote-file-upload-begin
remote-file-upload-begin-result
FrameRemoteFileUploadData:
  16-byte server-generated upload UUID
  8-byte monotonically increasing chunk sequence
  raw chunk bytes
remote-file-upload-finish
remote-file-upload-commit
remote-file-upload-abort
remote-file-upload-result
```

`begin` carries only the server-generated upload UUID, the server-held remote
directory capability, one validated basename, the requested collision mode, and
declared bounds. It must not carry a remote path, SSH target, browser
credential, or UI host string. The remote end accepts only an attached
connection whose workspace and directory capability match exactly.

Both sides enforce the smaller of their hard limits. The server treats
`Content-Length` and browser `File.size` as advisory, meters bytes while
reading, and stops reading when a local or remote ceiling is reached. Remote
sessiond independently meters bytes, count, deadline, active uploads, frame
size, and sequence. Every frame length must be capped before allocation; the
current unbounded `ReadFrame` allocation is a prerequisite hardening item for
this new data frame.

The server streams fixed-size chunks and retains at most a bounded send window.
Remote acknowledgements/credit are required before it consumes more browser
bytes than that window permits. That provides ordering and backpressure without
buffering a file in browser, server, or JSON memory. The server and remote
sessiond calculate SHA-256 during streaming; `finish` supplies the server's
measured total and digest, and sessiond compares both against its own measured
values before it considers a file eligible for commit.

### Remote filesystem integrity and collision parity

At `begin`, remote sessiond creates a fresh hidden, `O_EXCL|O_NOFOLLOW` temp
file in the authorized destination filesystem using a server-generated upload
UUID-derived name. The temp uses controlled mode/ownership; browser-provided
permissions and MIME types are ignored. Sessiond holds an opened descriptor for
the authorized directory and uses descriptor-relative operations throughout.

At every terminal operation it:

- reopens/revalidates the directory underneath the workspace root by descriptor
  identity, refusing parent traversal and symlink replacement;
- rejects special files, symlink final names, non-regular targets, and unsafe
  hard-link situations;
- fsyncs the temporary file, verifies size/digest, and fsyncs the directory;
- creates a new final name through no-clobber link/rename semantics, never
  string-prefix containment or an overwrite-capable rename;
- removes only the owned temporary name after its atomically confirmed result.

The user-visible collision contract matches local uploads:

| Choice | Remote behavior |
| --- | --- |
| Cancel | Abort and unlink only this upload's owned temp. |
| Keep both | Sessiond chooses the next deterministic visible available name atomically and returns that visible name. |
| Replace | The applet requires a separate confirmation. Sessiond accepts a server-held, connection/workspace/directory/name/target-identity-bound conflict record, rechecks that identity at commit, then uses an exchange/no-follow primitive. A changed/raced target is restored and returned as a fresh conflict; it is never silently replaced. |

Conflict records and replace confirmation evidence remain server/remote state,
not browser tokens. As with the local implementation, a chosen resolution may
restart the streaming attempt rather than preserve a hidden pending temp; this
keeps the browser UI keyed on the visible filename and makes disconnect cleanup
simple. No local destination ever stages remote-file bytes.

### Failure, loss, and cleanup semantics

Remote upload v1 is deliberately **not resumable**. A remote `hostSession`
generation changes on SSH drop, reconnect, explicit disconnect, host removal or
replacement, browser WebSocket loss, local server restart, workspace detach or
closure, remote sessiond restart, identity mismatch, or directory-capability
expiry. The local server then stops forwarding input, sends best-effort abort
only to the original live connection, and reports:

> Upload stopped before the file was saved. Refresh the remote folder and try
> again.

It never replays chunks, finishes, commits, or retargets an upload after a new
connection appears. Sessiond's per-connection cleanup aborts active uploads and
unlinks only temps whose UUID it owns. Its bounded startup sweeper considers
only the private upload-temp naming pattern, verifies regular no-follow files
inside a configured workspace Explorer root, has an age/count bound, and never
removes a visible completed file.

Exactly-once resume is a future, separate protocol: it would require durable
remote upload state, a server-held resume ledger, a stable machine identity,
the same daemon incarnation, explicit acknowledged chunk offsets/digest, and a
new accept/reject handshake. A reconnect alone is not that proof.

### Required implementation seam

The follow-on should add a narrowly typed `RemoteFileUploadClient` capability
beside—not by widening indiscriminately—the current `DaemonConn` relationship.
`hostSession` must expose a generation/identity snapshot that changes before a
reconnect can be used. The Files server route selects the exact live
`hostSession` from the authenticated browser's attachment and calls the typed
remote capability; it must not call `transport.Transport.Dial` itself, create a
second pooled remote connection, or learn `HostRef.Addr`.

The SSH transport remains unchanged apart from carrying the additive sessiond
frames over the existing `sessiond-connect` pipe. That preserves OpenSSH's
known-host, ProxyJump, agent, and key behavior and keeps remote command
execution fixed to the already-audited sessiond bridge.

### Remote Files UX contract

This PR keeps the current local-only Files applet unchanged. When a
workspace-scoped remote Files surface is added, its upload control has four
source-aware states:

| State | User-visible behavior |
| --- | --- |
| No remote Explorer capability / old version | Picker alone is disabled with the precise secure-upload-unavailable reason. A drag over the file-list surface is ignored; it must not appear as a target or start reading files. |
| Capability present but source not writable or attachment/lease invalid | Picker alone is disabled with a plain reason such as read-only folder, remote disconnected, or refresh needed. Browsing remains available where its own read contract allows it. |
| Ready | Picker works. A valid file drag over only the remote directory-list surface shows `Upload to <visible folder> on <host display name>` before any browser bytes are read. It must never display the transport address. |
| Uploading, conflict, terminal | The same compact, accessible per-file queue and conflict choices as local apply. A source fence changes the row to `Upload stopped before the file was saved. Refresh the remote folder and try again.`; it must not silently retry against a new host or directory. |

Text, URL, HTML, directory, and archive drops never activate the remote target.
Dragging over controls, the sidebar, a terminal, or outside the Files surface
continues to use ordinary browser behavior. The availability check is a
server-side answer for the active source; the UI does not infer support from a
host label or cached prior connection.

### Follow-on verification contract

No remote writer is implemented or claimed by this PR, so it does not add a
mocked remote-upload test. Before enabling SSH, a follow-on must demonstrate
the real protocol with a fresh isolated local SSH fixture: an ephemeral SSH
server, a separate remote sessiond, a fixture-only remote Explorer root, and a
separate local destination sentinel. It must prove actual file hashes appear
only in the remote authorized directory and never in the local sentinel.

Required evidence, all through a real browser → local muxterm server → SSH
`sessiond-connect` → remote sessiond path:

| Scenario | Required proof |
| --- | --- |
| Single/multiple files and picker/drop | Overlay identifies the selected remote source; ordered bounded upload completes and remote hashes/listing match. |
| Queue/backpressure/cancel | Progress reflects real relay flow; cancellation leaves no visible completion or owned temp on either side. |
| SSH loss, sessiond restart, browser reload, remote host replacement | No replay, automatic commit, or cross-incarnation destination; all owned temps are cleaned or safely swept. |
| Foreign/unauthorized host or workspace | Begin/chunk/finish/commit/cancel all fail without host, path, existence, target, or SSH disclosure. |
| Unsafe names and objects | Traversal, separators, controls, archive/directory attempts, symlink parent/final target, FIFO/socket/device, limits, and slow send fail without escape or leak. |
| Collision/race | Cancel, remote-selected Keep both, confirmed Replace, and commit-time target races never silently overwrite. |
| Local regression | Local upload still writes only local root; existing viewer/publication safety retains download-only HTML/SVG behavior. |

The sandbox gate has a different evidence rule: a clearly labeled **synthetic
protocol fixture** may prove only disabled/unsupported UI and host/expiry
fencing. It cannot establish Azure or sandbox upload support. A later real
sandbox acceptance run must verify the independently delivered bridge/runtime
against the same byte-placement and lifecycle cases before the sandbox matrix
row changes.


## Verification

| Check | Result |
| --- | --- |
| `go build ./...` and `go vet ./...` | Passed in the isolated dev worktree |
| `cd web && npm run check:fast && npm run build` | Passed; existing non-fatal lint and bundle-size warnings remain |
| `node web/e2e/files-upload.mjs --base http://127.0.0.1:8313 --cdp http://127.0.0.1:9335` | Passed 15/15: desktop drop overlay, multi-file byte hashes/list refresh, picker, Android-class portrait/landscape control geometry, cancellation, reload cleanup, conflict choices, invalid drops/archive rejection, and outside-root symlink refusal |
| Auth/origin unbound HTTP probes | Cross-origin and same-origin-but-unbound POSTs both returned safe `403` failures without paths |
| Existing Files publish regression script | 5/7 assertions held; its two public-link assertions are blocked in dev because the inherited public origin points at the production hostname, not the isolated dev server. The upload change does not modify viewer or publication code. |
| SSH/sessiond source trace | Completed against `transport/ssh`, `sessiond-connect`, `hostSession`, `HostRef`, the additive protocol precedent, and the structural read-only filesystem implementation. It establishes a safe future relay seam but also establishes that no upload capability exists today. |
| Isolated SSH fixture | **Not run and not claimed.** No remote Explorer or Remote File Upload v1 implementation exists in this PR, so a mocked transfer would not prove remote support. The required real-fixture acceptance matrix is specified above. |
| Sandbox synthetic fixture | **Not run and not claimed.** The present Files applet does not surface sandbox folders and no sandbox bridge/protocol exists. The required synthetic disabled/fencing fixture and later real bridge acceptance gate are specified above. |

## Out of scope

Recursive directory upload, archive expansion, file preview changes, terminal
panes, preview canvas behavior, Mission Control/Operator/voice, workspace
sidebar, sandbox lifecycle or Azure work, sharing/ACL redesign, and a remote
writer **implementation** are out of scope. The Remote File Upload v1 section
is a follow-on contract only. Existing viewer and publication classification
continue to treat uploaded HTML and SVG as downloads, never executable content
inside the authenticated viewer.
