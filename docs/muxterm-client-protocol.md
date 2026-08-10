# muxterm Client Protocol (v1)

> Frozen contract. Native clients (Swift, Android) and the web client all speak
> exactly this. Field names are the Go JSON tags, byte-for-byte. Additive changes
> only; never repurpose a field or a message type.

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
| CID | `cid` | request/reply + browser-command correlation; 0 = unsolicited event |
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
| SurfaceKind | `surfaceKind` | `"terminal"` \| `"browser"`; absent = terminal |
| Placement | `placement` | tab \| split-{right,left,above,below} |
| ReferencePaneID | `referencePaneId` | split reference; 0 = active pane |
| Action | `action` | browser-command verb |
| Selector | `selector` | CSS selector (element targeting) |
| Result | `result` | raw JSON result (browser-result, eval) |
| Params | `params` | raw JSON browser-command params (§5) |
| ASCII / Text / Snapshot | `ascii` / `text` / `snapshot` | MCP results |

`WorkspaceInfo`: `{workspaceId, name?, clientRef?, paneCount}`.
`PaneInfo`: `{paneId, surfaceKind?, cols?, rows?, title?, totalSeq?, placement?, referencePaneId?}`.

## 4. Message types

**Requests (client → daemon):** create-workspace, list-workspaces,
rename-workspace, close-workspace, attach, create-pane, close-pane, resize,
rename-pane, save-layout, screen-snapshot, get-layout, create-browser-pane,
close-browser-pane.

**Replies (daemon → requester, echo cid):** workspace-created, workspace-list,
composition, pane-created, ok, screen-snapshot-result, layout-result.

**Events (daemon → subscribers, cid = 0 unless noted):** pane-added, pane-closed,
workspace-closed, workspace-renamed, pane-renamed, shell-prompt,
browser-command (carries cid), browser-result (echoes cid).

**Errors:** `error` with `code` ∈ {unknown-workspace, pane-spawn-failed,
pane-not-found}.

## 5. Browser control (client-rendered, server-drivable)

The daemon holds only a pane **handle**; the browser engine lives on the client.

- `create-browser-pane` `{type, cid, placement?, referencePaneId?}` →
  `pane-created` `{cid, paneId}` reply, plus a `pane-added`
  `{paneId, surfaceKind:"browser", title:"Browser", …}` broadcast.
- `browser-command` `{type, paneId, cid, params}` — relayed to all workspace
  subscribers. The client owning/focused on the pane executes it.
  `params` (raw JSON):
  ```json
  {
    "action": "navigate | click | scroll | evaluate | back | forward | reload",
    "selector": "css-selector",   // element targeting  (EXACTLY ONE of selector / x,y)
    "x": 0, "y": 0,               // coordinate targeting (CSS px)
    "url": "http://localhost:5173",
    "script": "return document.title",
    "timeoutMs": 30000             // evaluate timeout; default 30000, bounded
  }
  ```
  Every manipulation compiles to a native nav call or an injected-JS `evaluate`.
  An action carries EXACTLY ONE of `{selector}` or `{x,y}`.
- `browser-result` `{type, paneId, cid, result | error}` — the executing client
  returns this; the daemon broadcasts it back to workspace subscribers (echoing
  the command cid).

**Constraints:** a browser pane is drivable only while a client is attached and
focused on it (last-focus-wins authority). There is no server-side headless
fallback; a command to an unowned pane yields a typed `browser-result` error.
The `evaluate` action is bounded by `timeoutMs` (default 30 s) so an injected
script cannot hang the pane.

## 6. Binary helpers (parity with Go)

- Encode pane input: `[4-byte LE paneId][bytes]` → WebSocket binary.
- Decode pane output: first 4 bytes LE = paneId, remainder = raw VT bytes; feed
  to that pane's emulator. A payload shorter than 4 bytes is malformed.
