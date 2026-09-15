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
root. A remote/SSH or sandbox directory is not accepted or remapped to local;
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
structural read-only boundary. Sandboxes have no verified binary-safe,
long-lived sessiond path. Both are explicit unsupported states, not fallback
paths.

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
| SSH/remote directory | Not rendered by the present Files applet | Unavailable: sessiond filesystem protocol is read-only; no scoped remote writer |
| Sandbox directory | No verified Files transport | Unavailable: no verified sandbox sessiond transport |

## Verification

| Check | Result |
| --- | --- |
| `go build ./...` and `go vet ./...` | Passed in the isolated dev worktree |
| `cd web && npm run check:fast && npm run build` | Passed; existing non-fatal lint and bundle-size warnings remain |
| `node web/e2e/files-upload.mjs --base http://127.0.0.1:8313 --cdp http://127.0.0.1:9335` | Passed 15/15: desktop drop overlay, multi-file byte hashes/list refresh, picker, Android-class portrait/landscape control geometry, cancellation, reload cleanup, conflict choices, invalid drops/archive rejection, and outside-root symlink refusal |
| Auth/origin unbound HTTP probes | Cross-origin and same-origin-but-unbound POSTs both returned safe `403` failures without paths |
| Existing Files publish regression script | 5/7 assertions held; its two public-link assertions are blocked in dev because the inherited public origin points at the production hostname, not the isolated dev server. The upload change does not modify viewer or publication code. |
| Remote/sandbox fixture | Not run: no verified safe remote writer exists. The Files surface remains local-only and reports the exact unavailable reason instead of falling back to local storage. |

## Out of scope

Recursive directory upload, archive expansion, file preview changes, terminal
panes, preview canvas behavior, Mission Control/Operator/voice, workspace
sidebar, sandbox lifecycle or Azure work, sharing/ACL redesign, and a remote
writer protocol are out of scope. Existing viewer and publication classification
continue to treat uploaded HTML and SVG as downloads, never executable content
inside the authenticated viewer.
