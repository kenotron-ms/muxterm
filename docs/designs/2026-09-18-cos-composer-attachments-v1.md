# Operator composer attachments V1

## Outcome

The Mission Control composer accepts files. A person attaches a screenshot or a
text file by clicking the paperclip, dragging it onto the composer, or pasting
it from the clipboard; a strip of chips appears above the textarea; Send carries
the message and its files together. The Operator never receives the bytes. It
receives a **reference block** naming each file's media type, size and absolute
path, and reads what it needs with the file-reading tools it already has.

Off by default. `[cos.attachments] enabled = true` turns it on.

## Why a reference, not bytes

Putting file contents into the prompt is the obvious design and the wrong one.
It is unbounded (an 8 MB screenshot is not a prompt), unreviewable (the person
cannot see what the model was handed), and impossible to expire (once it is in
the transcript it is there forever). A path is a reference the Operator can
choose to follow, quote one line of, ignore, or hand to a delegated lane — and
one the server can delete on a schedule.

It also keeps the agent surface unchanged. There is no new attachment-reading
tool: `read_file` already reads a path, and the Operator bundle's charter now
says how to treat one that arrived this way (`internal/cos/sidecar/bundle/
context/cos-charter.md`).

## Ingestion

Three entry points, one path through:

| Entry | Mechanism |
|---|---|
| Paperclip | a visually-hidden `<input type="file" multiple accept=…>` |
| Drag and drop | `dragenter/over/leave/drop` on the composer box, only for drags carrying `Files` |
| Paste | `paste` on the textarea, reading `clipboardData.files` |

All three end at `cosStore.addAttachmentFiles(files)`, which is where every
policy decision and every refusal lives. A refused file becomes a **visible
failed row**, never a silent drop: a person who drags five files and gets three
chips has no way to learn which two were declined.

The `accept` list is derived on the server from the same table that validates
content, so the picker and the validator cannot drift apart.

## Storage

Private, local, and never served back.

```
$XDG_DATA_HOME/muxterm/cos-attachments/     0700
  att_<24 base64url chars>/                 0700
    <original filename>                     0400   immutable after staging
  att_<24 base64url chars>.json             0600   metadata sidecar
```

The id is 144 unguessable bits — the same width the Files upload temp name uses
— because possession of an id is what later authorizes binding it to a turn.
`validCosAttachmentID` is the only thing that turns a browser string into a path
component, and it accepts exactly the shape this server mints, so `..`, a
separator, or a symlink name never reaches `filepath.Join`.

Nothing under the root is reachable over HTTP. There is no read-back route, not
for the owner and not through `/p/` or a tunnel: a read-back route is a second
surface with its own authorization story, and V1 does not need one, because the
browser still holds the bytes it just uploaded. An image chip shows a local
object URL; a chip restored from history shows no thumbnail, which is the truth.

## Validation

Extension and content must agree. A name is a claim the uploader makes; a magic
number is evidence. Accepting either alone is how a store ends up holding
something the Operator will later read as if it were what it was called.

- Images — `png`, `jpeg`, `gif`, `webp`, each confirmed by leading bytes
  (`webp` by its RIFF tag at byte 8).
- Text — `txt/text/log/md/markdown/json/csv/yaml/yml/toml/diff/patch`,
  validated as UTF-8 **in full**, with no NUL byte.
- Archives are refused by name *and* by magic number, so a `.zip` renamed
  `.png` is caught.
- Everything else is refused.

Text carries its own 2 MiB ceiling, well under the 8 MiB file limit. That is
what makes full UTF-8 validation affordable — the file is re-read after staging
rather than carrying a partial rune across a streaming chunk boundary — and it
is also the size beyond which "the Operator will read this" stops being true.

## Authorization

Deliberately identical to the Files upload surface it sits beside:

1. the shared authentication middleware on the route;
2. `Origin` must match this server's own origin, with `Sec-Fetch-Site`
   same-origin or absent;
3. an `X-Muxterm-Cos-Attachment: 1` header no cross-origin form can set;
4. a live authenticated browser WebSocket, resolved from the HttpOnly browser
   cookie the app shell already issues.

Upload is additionally bounded: two concurrent uploads server-wide, a
two-minute per-request timeout, and a request body cap.

## Atomic submission

Text and attachments travel in **one** `cos-turn` frame. The server resolves
every id before anything is admitted, **all or nothing**, then composes a single
delivered prompt:

```
<what the person typed>

[muxterm-attachments]
- screenshot.png (image/png, 184 KB) -> /…/att_<id>/screenshot.png
[/muxterm-attachments]
```

That one string enters the existing relay as one admission, becomes one queue
entry, and reaches the sidecar as one turn op. There is no second message to
lose, reorder, or admit on its own, and no existing queue or idempotency
invariant moves: `client_ref` is still the dedupe key, the FIFO is still the
FIFO, and a reconnect retries the same frame with the same ids.

A message whose attachments cannot all be honored is refused whole, with one
clear error and the draft kept. A turn that silently arrived with three of its
four screenshots is worse than one that was refused, because the person has no
way to see which one the Operator never got.

An attachment is a message on its own: a send with files and no text is
accepted, because paste-a-screenshot-and-press-send is the commonest real use.

## Queue, history, and the parser

The reference block is a wire contract shared by `internal/server/
cos_attachments.go` and `web/src/lib/cos-attachments.ts`. The server writes it;
every browser path parses it back out — the admission receipt, the queue
projection, `turn_submitted`, `turn_start`, the decorated dispatch error, and a
history replay of a conversation written weeks ago. One serialization, one
parser, so a reloaded tab shows exactly what the Operator received: the person's
words in the bubble, their files as chips beneath.

The parser is strict and trailing-only — the block must end the prompt, both
sentinels must stand alone on their own lines, and every line between them must
parse — because a half-recognized block rendered as chips would be a worse lie
than showing the raw line.

**The block has exactly one author.** The browser hides it from the bubble and
the charter presents it to the Operator as the server speaking, so a person who
types a sentinel line themselves would otherwise be able to forge an attachment
the server never staged, pointing anywhere on disk, *and* hide that they had.
The server therefore indents any line of user text that is exactly a sentinel,
always, whether or not the message carries attachments. An indent rather than a
refusal or a deletion: the parser needs an exact match, and the line still reads
as what the person wrote.

For the same reason a filename may not contain U+2028, U+2029 or U+0085. They
survive the shared filename validator (they are not control characters) and
JavaScript's `.` does not match them, so one of them in a name makes a genuine
block fail to parse — and a real attachment then renders as a raw protocol
block, absolute server path and all, in the middle of the conversation.

## Expiry

| State | Life |
|---|---|
| staged (uploaded, never sent) | 1 hour |
| bound (sent with a turn) | `retention_hours`, default 168 (7 days) |

Retention starts **before** the turn is queued, never after. Binding afterwards
leaves a window in which a queued turn names a path whose staged hour can expire
under it; binding first can at worst extend the life of an attachment whose turn
was never admitted, which costs one file and no correctness.

Removing a chip deletes the file immediately rather than waiting out the staged
hour — someone who attaches the wrong screenshot and takes it back has every
right to expect it gone. That discard refuses to touch an attachment already
bound to a turn, because history points at it.

A sweep runs at startup and every 15 minutes, reading the directory in batches,
and also clears temp files from interrupted uploads.

**Staging is capped at 24 records.** `max_files` bounds one *message*, not the
store, so without a second bound an authenticated page could stage forever and
fill the disk long before the staged hour expired. Sent attachments are
deliberately not counted against the cap: a week of ordinary use must not lock
the composer.

**Known limit — a turn queued longer than its retention loses its attachment.**
Retention is measured from admission, not from dispatch, and the FIFO has no
age bound. With the shipped 7-day retention this needs a week-long queue, which
is not a real state; with `retention_hours = 1` it is reachable. A lease
renewed at dispatch would close it and is not in V1.

## Delegated lanes

A lane runs as the same user on the same machine, so an attachment path resolves
there exactly as it does in the Operator session. The charter therefore tells
the Operator to put the **path** in a lane's prompt and let the lane open the
file itself — pasting a file's bytes into a `spawn_lane` prompt is how a prompt
becomes unreadable and a large file becomes a failure. No code change was needed
for this; the property falls out of private-but-user-readable storage, and the
charter is where it is made explicit.

## Configuration

```toml
[cos.attachments]
enabled         = false   # off by default; this is an operator decision
max_files       = 4       # per message
max_file_bytes  = 8388608 # 8 MiB
retention_hours = 168     # 7 days
```

Out-of-range values are a startup error, not a silent clamp: a clamped limit
reads as accepted and behaves as something else.

`MUXTERM_COS_ATTACHMENTS=1|0` overrides `enabled` for one process. It exists
because `make dev-local` isolates `XDG_RUNTIME_DIR` and `XDG_DATA_HOME` but
deliberately does **not** isolate `XDG_CONFIG_HOME`: verifying this feature must
never require editing the real `~/.config/muxterm/config.toml` the production
server reads. Same family as `MUXTERM_COS_SESSION_ID`.

## Deliberately not in V1

- No read-back route for attachment bytes, and no public publishing.
- No remote/SSH or URL sourcing — the store is local, like the Files
  writer it sits beside.
- No OCR or captioning. The Operator has no vision tool; it says so and hands
  the path to a lane that does.
- No arbitrary binary or archive ingestion.
- No attachment lease renewal for a turn sitting in the queue (above).
- No per-turn structured attachment metadata on the queue or history frames.
  The block-parsing path already covers all three replays with one contract;
  adding a second, structured channel would mean two sources of truth about the
  same message.
