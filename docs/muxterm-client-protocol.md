# muxterm Client Protocol (v1)

> Frozen contract. Native clients (Swift, Android) and the web client all speak
> exactly this. Field names are the Go JSON tags, byte-for-byte. Additive changes
> only; never repurpose a field or a message type.

## 0. Removed in v1.1 (2026-09-03) — browser panes withdrawn

The browser-pane feature was removed from muxterm. This is a **subtractive**
change to an otherwise-frozen contract, recorded here because it breaks the
additive-only rule. Clients MUST treat the following as gone: the daemon no
longer sends them, and requests using them are not answered.

**Withdrawn `Message` fields:** `surfaceKind`, `params`, `result`, `snapshot`.
These names are **retired** — do not repurpose them for new meanings.

**Withdrawn `PaneInfo` field:** `surfaceKind` (every pane is a terminal).

**Withdrawn request types:** `create-browser-pane`, `close-browser-pane`.

**Withdrawn event types:** `browser-command`, `browser-result`.

**Withdrawn section:** the former §5 "Browser control (client-rendered,
server-drivable)"; the old §6 "Binary helpers" is now §5.

**Not withdrawn:** `action` and `selector` still exist on the wire, but their
browser-command meanings ("browser-command verb", "CSS selector") are gone. The
daemon now carries them only for non-browser purposes; a client MUST NOT treat
them as browser fields.

Everything else in this document is unchanged and still frozen.

## 1. Transport & framing

The client connects to `GET /ws` (a loopback WebSocket after any SSH forward).
Two WebSocket message kinds are used:

- **Text frames** carry one JSON `Message` envelope (§3).
- **Binary frames** carry PTY bytes: `[4-byte LITTLE-ENDIAN uint32 paneId][raw VT bytes]`.

> The daemon's internal Unix-socket framing (`[4-byte BIG-ENDIAN length][1-byte
> kind][payload]`, kinds `0x01` control / `0x02` pane-data) is an implementation
> detail of the serve↔daemon hop. Over `/ws`, control = WebSocket **text**,
> pane-data = WebSocket **binary** with the little-endian paneId prefix above.
> Encode/decode helpers mirror Go `WritePaneData` / `DecodePaneData`.

## 2. Bootstrap sequence

On connect the client observes, in order:

1. `config` — a serve-local envelope `{"type":"config","config":{…}}` (theme,
   terminal options, keybindings). Not a daemon message.
2. `workspace-list` — `{type, workspaces:[WorkspaceInfo]}`.
3. Client sends `attach` `{type:"attach", cid, workspaceId, breakpoint}`.
4. `composition` — `{type, cid, workspaceId, panes:[PaneInfo], layout}`. Sent
   FIRST, always (nil panes for an empty workspace).
5. Per-pane **replay** binary frames arrive BEFORE any live output.
6. Live output (binary frames) and events (text) follow.

### Settle barrier (required)

Each `PaneInfo.totalSeq` is the exact byte count of that pane's replay stream.
The client feeds replay bytes into a fresh emulator instance, counting bytes, and
MUST gate both user input and rendering until `receivedBytes >= totalSeq`, with a
hard 3-second timeout escape that drains partial replay so a byte-count mismatch
cannot lock the pane. On reconnect, reset only the settle state
(`ready=false`, counters=0, generation++), re-send `attach`, and drain fresh
replay into the existing scrollback (do not dispose the emulator).

## 3. The Message envelope

One struct; the `type` field discriminates. All fields `omitempty`.

| field | json | notes |
|-------|------|-------|
| Type | `type` | message type (§4) |
| CID | `cid` | request/reply correlation; 0 = unsolicited event |
| ClientRef | `clientRef` | optimistic-create correlation id |
| WorkspaceID | `workspaceId` | |
| Name | `name` | |
| PaneID | `paneId` | workspace-local |
| Cols / Rows | `cols` / `rows` | |
| Cmd | `cmd` | argv; empty = default $SHELL |
| Title | `title` | |
| Breakpoint | `breakpoint` | responsive layout key (opaque to daemon) |
| Layout | `layout` | opaque layout JSON blob (per-breakpoint) |
| Workspaces | `workspaces` | []WorkspaceInfo |
| Panes | `panes` | []PaneInfo |
| Code / Error | `code` / `error` | error envelope |
| Placement | `placement` | tab \| split-{right,left,above,below} |
| ReferencePaneID | `referencePaneId` | split reference; 0 = active pane |
| ASCII / Text | `ascii` / `text` | MCP results |

`WorkspaceInfo`: `{workspaceId, name?, clientRef?, paneCount}`.
`PaneInfo`: `{paneId, cols?, rows?, title?, totalSeq?, placement?, referencePaneId?}`.

## 4. Message types

**Requests (client → daemon):** create-workspace, list-workspaces,
rename-workspace, close-workspace, attach, create-pane, close-pane, resize,
rename-pane, save-layout, screen-snapshot, get-layout.

**Replies (daemon → requester, echo cid):** workspace-created, workspace-list,
composition, pane-created, ok, screen-snapshot-result, layout-result.

**Events (daemon → subscribers, cid = 0 unless noted):** pane-added, pane-closed,
workspace-closed, workspace-renamed, pane-renamed, shell-prompt.

**Errors:** `error` with `code` ∈ {unknown-workspace, pane-spawn-failed,
pane-not-found}.

## 5. Binary helpers (parity with Go)

- Encode pane input: `[4-byte LE paneId][bytes]` → WebSocket binary.
- Decode pane output: first 4 bytes LE = paneId, remainder = raw VT bytes; feed
  to that pane's emulator. A payload shorter than 4 bytes is malformed.
