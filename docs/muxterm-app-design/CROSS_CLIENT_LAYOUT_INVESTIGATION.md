# Cross-Client Layout Mismatch — Investigation (Task 14)

**Status:** Investigation only. No code changes made. This document confirms the
mechanism behind the native (macOS) ↔ web layout mismatch with real source
citations, and lays out candidate remediation approaches for a decision. Nothing
here is implemented.

**User report that triggered this:** *"the pane itself appears, but the position
or layout are all wrong it seems — mismatches from the native app. desktop and
web are similar — should respect that."* i.e. NOT a missing-pane bug (the pane
appears on both clients); the **arrangement/geometry** diverges.

**Repos inspected**
- `muxterm` (this repo) — Go server + web client (`web/src`)
- `muxterm-apple` (`/Users/ken/workspace/ms/muxterm-apple`) — native macOS client

---

## 0. TL;DR of the actual mechanism (confirmed)

The original working hypothesis was that **web uses the old
`LayoutBlob`/`SplitNode` schema**, so a native Bonsplit-shaped save would confuse
web. **That specific hypothesis is WRONG.** The truth found in source:

1. **The server is a pure opaque key-value store**, keyed by
   `(workspaceID, breakpoint)`. It never parses the layout. — *confirmed*
2. **The two clients use different breakpoint keys**: native attaches/reads under
   `"desktop"`; web saves/reads under `"wide"` (or `"narrow"`). Because the keys
   differ, **the two clients never read each other's persisted layout at all** —
   there is no shared layout state to be incompatible about. This is the dominant
   reason layouts don't track each other. — *confirmed*
3. **Web does NOT use `LayoutBlob`/`SplitNode`.** It persists **dockview-core's
   own `SerializedDockview` JSON** (`toJSON()`/`fromJSON()`). — *confirmed*
4. **Native currently never persists a layout at all** — there is no `save-layout`
   send anywhere in the native codebase. The native "desktop" slot is therefore
   always empty, so native always does a flat rebuild (all panes as tabs in one
   group) on attach and then applies live splits that are **purely local**, never
   persisted, never broadcast. — *confirmed*
5. The **only** live cross-client signal that affects arrangement for
   user-created panes is the `pane-added.placement` token. Native emits
   `"split-down"` for a vertical split, but web only understands `"split-below"`
   and silently falls back to `"right"` — so a native vertical split shows up on
   web as a **right** split. Divider drags and re-arrangements produce **no**
   cross-client signal whatsoever. — *confirmed (a concrete, separate bug)*

So the mismatch is the sum of (2)+(4) (no shared persistent arrangement — each
client renders its own) and (5) (the one live signal that does cross is partly
mis-mapped). Panes appear on both because `pane-added` itself is always
broadcast and honored by both clients.

---

## 1. The Go server: opaque passthrough, keyed by breakpoint

The server never interprets layout contents. It stores whatever string a client
sends, under that client's `(workspaceID, breakpoint)`, and hands it back
verbatim on attach.

- `internal/sessiond/registry.go:178-190` — `SaveLayout(wsID, breakpoint, layout)`:
  ```go
  // SaveLayout stores an opaque layout blob for (wsID, breakpoint)...
  ws.Layouts[breakpoint] = layout
  ```
  The doc comment literally says **"stores an opaque layout blob"**. No parsing,
  no validation of structure.
- `internal/sessiond/registry.go:193-201` — `Layout(wsID, breakpoint)` returns the
  stored string for that breakpoint, or `""`.
- `internal/sessiond/server.go:152-159` — composition reply sends
  `Layout: s.reg.Layout(wsID, breakpoint)`, where `breakpoint` is **whatever the
  client passed in its `attach`** (`attachConn(..., breakpoint string)`,
  `server.go:123`, `server.go:401`).
- `internal/sessiond/server.go:316-325` — `TypeSaveLayout` persists and replies
  `OK`. **It does NOT broadcast the new layout to other attached clients.** So a
  web layout save is invisible to a concurrently-attached native client until
  that client re-attaches — and even then, only if it reads the same breakpoint.
- `internal/server/ws.go:270-271` — the browser-facing WebSocket bridge forwards
  `save-layout` to the daemon verbatim (`c.daemon.SaveLayout(...)`).

**Conclusion:** the `layout` field is a per-`(workspace,breakpoint)` opaque
string store with verbatim relay. Whatever structure lives inside it is entirely
a client-side contract, and the server enforces nothing.

---

## 2. The web client: dockview `SerializedDockview`, breakpoint `"wide"`

Web's layout blob is **dockview-core's native serialization**, not anything
muxterm-defined and not `LayoutBlob`/`SplitNode`.

- **Save** — `web/src/components/mux-dock.ts:343-352` (`_scheduleLayoutSave`):
  ```ts
  const json = JSON.stringify(this._dv.toJSON());
  this.dispatchEvent(new CustomEvent('layout-save', { detail: { layout: json }, ... }));
  ```
  `this._dv.toJSON()` returns dockview's `SerializedDockview`.
- **Restore** — `web/src/components/mux-dock.ts:809-813`:
  ```ts
  this._dv.fromJSON(JSON.parse(this.layout) as SerializedDockview);
  ```
- **Breakpoint on save** — `web/src/app.ts:1069-1074` (`_onLayoutSave`):
  ```ts
  if (currentLayoutMode() !== 'wide') return;      // narrow (phone) has no persisted layout
  this._socket?.saveLayout(ws, 'wide', e.detail.layout);
  ```
- **Breakpoint on attach** — `web/src/app.ts:983`:
  ```ts
  this._socket?.attachWithBreakpoint(e.detail.workspaceId, currentLayoutMode());
  ```
  `currentLayoutMode()` returns `'wide'` or `'narrow'` (`web/src/lib/breakpoint.ts:12-14`,
  threshold 768px). On a desktop-sized browser it is **`'wide'`**. The comment at
  `web/src/lib/breakpoint.ts:5` even states *"The single 'wide' string is also the
  server-side layout storage key."*

### Web's actual schema (dockview `SerializedDockview`)

From the installed dependency type,
`web/node_modules/dockview-core/dist/esm/dockview/dockviewComponent.d.ts:64-75`:
```ts
export interface SerializedDockview {
    grid: {
        root: SerializedGridObject<GroupPanelViewState>;   // recursive branch/leaf tree
        height: number;
        width: number;
        orientation: Orientation;
    };
    panels: Record<string, GroupviewPanelState>;
    activeGroup?: string;
    floatingGroups?: SerializedFloatingGroup[];
    popoutGroups?: SerializedPopoutGroup[];
    edgeGroups?: SerializedEdgeGroups;
}
```
The web code itself walks this shape at `web/src/components/mux-dock.ts:309-331`
(`_activePaneIdFromSavedLayout`): it reads `parsed.grid.root`, recurses on nodes
whose `type === 'leaf'` reading `data.id` / `data.activeView`, and reads a
top-level `parsed.activeGroup`. Panel IDs are the muxterm paneId stringified
(`String(pane.paneId)`, e.g. `mux-dock.ts:831-835`, `855-858`).

**Concrete shape (illustrative):**
```json
{
  "grid": {
    "root": { "type": "branch", "data": [ { "type": "leaf", "data": { "views": ["1"], "activeView": "1", "id": "g1" }, "size": 400 }, ... ], "size": 800 },
    "width": 1200, "height": 800, "orientation": "HORIZONTAL"
  },
  "panels": { "1": { "id": "1", "contentComponent": "terminal", "title": "Pane 1" }, ... },
  "activeGroup": "g1"
}
```
Key discriminators: `grid.root` with `type: "branch" | "leaf"`, `orientation:
"HORIZONTAL" | "VERTICAL"`, `panels` map keyed by pane-id string, `activeGroup`.

---

## 3. The native client: reads composition, restores via Bonsplit replay, breakpoint `"desktop"`, never saves

- **Attach breakpoint** — `Apps/macOS/main.swift:150`:
  ```swift
  let msg = SessiondMessage(type: .attach, workspaceId: workspaceId, breakpoint: "desktop")
  ```
  Native reads composition.layout under **`"desktop"`** (`main.swift:73`
  → `appState.setComposition(panes:layout:workspaceId:)`).
- **No save path** — grep across the entire native source (`Apps/`, `Sources/`)
  for any construction/send of a `save-layout` message returns **zero call
  sites**; only the enum case exists
  (`Sources/MuxtermKit/Protocol/SessiondType.swift:33`). The
  `PersistedTreeNode` `encode(to:)` implementation exists
  (`Apps/macOS/BonsplitTreeCodec.swift:74-85`) but **is never invoked** to
  persist. Native therefore **never writes** the `"desktop"` slot → it is always
  empty → native always takes the flat-rebuild branch on attach
  (`Apps/macOS/WorkspaceViewController.swift:188-196`).
- **Restore path (dead in practice today, since nothing is ever saved)** —
  `Apps/macOS/WorkspaceViewController.swift:184-196` gates restore on
  `BonsplitTreeCodec.isBonsplitShaped(data)`; if not Bonsplit-shaped it discards
  and flat-rebuilds. `BonsplitTreeCodec.isBonsplitShaped`
  (`Apps/macOS/BonsplitTreeCodec.swift:106-136`) explicitly rejects anything that
  isn't its own `{"type":"pane"|"split", ...}` tree — and a dockview
  `SerializedDockview` (top-level `grid`/`panels`/`activeGroup`, no top-level
  `type`) fails `isTreeNodeShaped` immediately (`obj["type"] as? String` is nil).

### Native's two schemas

- **Old (pre-Bonsplit) `LayoutBlob`/`SplitNode`** —
  `Sources/MuxtermKit/Model/LayoutBlob.swift`:
  ```
  LayoutBlob { breakpoint: String, splits: [SplitNode] }
  SplitNode = leaf(paneId:) | hsplit(left,right,ratio) | vsplit(top,bottom,ratio)
  ```
  Wire: top-level `{"breakpoint","splits"}`; leaves `{"type":"leaf","paneId":N}`.
- **Current Bonsplit-era `PersistedTreeNode`** —
  `Apps/macOS/BonsplitTreeCodec.swift:18-88`:
  ```json
  { "type": "pane",  "pane":  { "paneId": 1 } }
  { "type": "split", "split": { "orientation": "horizontal"|"vertical",
                                "dividerPosition": 0.5, "first": <node>, "second": <node> } }
  ```
  Note: this is muxterm's own schema, deliberately **not** Bonsplit's internal
  `ExternalTreeNode` (per `Apps/macOS/BONSPLIT_API_NOTES.md §1/§6` — Bonsplit has
  **no restore/load API**; restoration is done by replaying `createTab` /
  `splitPane` / `setDividerPosition(fromExternal:)`).

### Schema comparison

| | Top-level keys | Split node discriminator | Divider/ratio field | Pane id location |
|---|---|---|---|---|
| **web (dockview `SerializedDockview`)** | `grid`, `panels`, `activeGroup` | `grid.root` nodes: `type: "branch"/"leaf"` | branch `size` (px) + `orientation` | `panels` map key + leaf `data.views[]` |
| **native old `LayoutBlob`** | `breakpoint`, `splits` | `type: "leaf"/"hsplit"/"vsplit"` | `ratio` (0..1) | leaf `paneId` |
| **native current `PersistedTreeNode`** | `type` (`pane`/`split`) | `type: "pane"/"split"` | `dividerPosition` (0..1) | `pane.paneId` |

All three are mutually incompatible in top-level shape and discriminators. Each
side's parser rejects the others (web `fromJSON` throws → caught at
`mux-dock.ts:841-849` → clean rebuild; native `isBonsplitShaped` → false →
flat rebuild).

---

## 4. Live cross-client signal: `pane-added.placement` (and the `split-down` bug)

The persisted layout blob is not the only thing affecting arrangement. When a
pane is created, the server broadcasts `pane-added` carrying a `placement` token,
and this is honored live by both clients. This is why **panes appear** on both.

- Server broadcasts `pane-added` with `Placement` verbatim —
  `internal/sessiond/server.go:442-448`; field defined
  `internal/sessiond/protocol.go:172` and `:234` with the documented set
  `tab|split-right|split-left|split-above|split-below`.
- Web maps the token to a dockview direction —
  `web/src/components/mux-dock.ts:138-145`:
  ```ts
  case 'split-left':  return 'left';
  case 'split-above': return 'above';
  case 'split-below': return 'below';
  default:            return 'right'; // split-right or unknown
  ```
- **Native emits `"split-down"` for a vertical split** —
  `Apps/macOS/WorkspaceViewController.swift:433-434`:
  ```swift
  let placement = orientation == .horizontal ? "split-right" : "split-down"
  ```

`"split-down"` is **not** in web's recognized set (`split-below` is), and the
server does not normalize it (`server.go:448` passes it through). So a **native
vertical split → web renders it as a right split** (falls through to `default`).
Native horizontal split (`"split-right"`) does map correctly to web `right`.

Additionally: `TypeSaveLayout` is **not broadcast** (`server.go:316-325`), and
there is no live "divider moved / re-arranged" message — so any divider drag or
tab-reorder in one client produces **no** signal to the other. Only pane
creation/close cross live.

---

## 5. Precise statement of the failure mode (confirmed, not hypothesized)

The mismatch the user sees is the composition of these confirmed facts:

1. **No shared persisted arrangement.** Native persists under `"desktop"` (and in
   fact never persists at all today); web persists under `"wide"`. Different map
   keys in `ws.Layouts` ⇒ neither client ever reads the other's blob. Each client
   renders arrangement from its **own** local state. *(Dominant cause.)*
2. **Even if the keys were unified, the blobs are mutually unreadable** — dockview
   `SerializedDockview` vs. native `PersistedTreeNode` — and each client's loader
   defensively discards a foreign blob and rebuilds flat. So key-unification alone
   would not fix it.
3. **Native never writes a layout**, so the native side of any shared store would
   be empty regardless.
4. **The one live signal that does cross (`pane-added.placement`) is partly
   mis-mapped**: native's vertical split token `"split-down"` is unknown to web and
   degrades to a right split.
5. Panes themselves always appear on both because `pane-added`/composition pane
   lists are broadcast and honored independent of any layout blob.

This **denies** the original hypothesis's specifics (web is not on the old
`LayoutBlob` schema; the problem is not "native Bonsplit blob poisons web's
`LayoutBlob` parser") but **confirms its spirit** (schemas are incompatible and
there is no shared interpretation) — while adding two mechanisms the hypothesis
missed: the **breakpoint-key divergence** (the real reason nothing is shared) and
**native never persisting** + the **`split-down`/`split-below` token bug**.

---

## 6. Candidate approaches to reconcile native/web layout (NOT yet chosen)

These are options for a decision — none are implemented. Each is a real option
grounded in the code above.

### Option A — Unify on ONE shared, client-neutral layout schema + one breakpoint key
Define a single muxterm-owned layout schema (a simple recursive
pane/split tree with `orientation` + ratio, essentially `PersistedTreeNode`
generalized), have **both** clients translate to/from it on save/load, and agree
on **one** breakpoint key for "desktop-class" widths (e.g. both use `"wide"`).
Native would translate Bonsplit's `treeSnapshot()` → shared schema on save and
replay shared schema → `createTab`/`splitPane`/`setDividerPosition` on load
(machinery already exists at `WorkspaceViewController.swift:213-269`). Web would
translate dockview `toJSON()` ↔ shared schema.
*Tradeoff:* This is the only option that makes desktop/web layouts genuinely
track each other, which is what the user asked for. But it is the most work and
the riskiest: it needs two lossy bidirectional translators (dockview's grid uses
pixel `size`; native/shared use fractional ratios; group-of-tabs vs. single-pane
leaves must be represented in the shared schema), plus a live-sync story (today
`save-layout` isn't broadcast, so cross-client updates would still only apply on
re-attach unless the server also broadcasts saves — a `server.go:316-325`
change). Highest fidelity, highest cost.

### Option B — Keep schemas separate, but guarantee structural (not pixel-exact) parity via a normalized "layout intent" broadcast
Leave each client persisting its own native format for its own breakpoint, but
add a small, normalized, client-neutral "arrangement intent" message (pane tree +
orientations + ratios, no pixels) that the server **broadcasts** on any layout
change (divider drag, split, reorder), which each client applies best-effort to
its own engine. Also fix the `split-down`→`split-below` token
(`WorkspaceViewController.swift:433`) as part of this.
*Tradeoff:* Achieves "desktop and web are similar" (same tree structure and
proportions) without forcing byte-identical persistence, and gives true live sync
(the thing Option A only gets by also changing broadcast behavior). Ratios
translate cleanly; the ambiguity is mapping dockview "tab groups" onto native
"panes with tabs" and vice-versa. Medium cost, medium fidelity, and it degrades
gracefully (a client that can't represent something falls back locally). Probably
the best balance if live parity is the real goal.

### Option C — Minimal correctness fix only: accept that geometry differs, but make the shared signals correct and preserve pane VISIBILITY/placement
Don't try to unify persisted layouts at all. Just (1) fix the
`split-down`→`split-below` token mismatch so the one live split signal maps
correctly, and (2) optionally unify the breakpoint key so at least the *same*
client family shares consistently. Explicitly accept that native (Bonsplit tiling)
and web (dockview docking) will show visually different — but structurally
sensible — arrangements, since their layout engines are fundamentally different
paradigms (tiling splitter vs. docking tab-manager).
*Tradeoff:* Cheapest and lowest-risk; fixes the one clearly-wrong behavior (native
vertical split showing as right-split on web) immediately. But it does **not**
satisfy the user's stated desire that "desktop and web are similar" for
arbitrary arrangements — it only removes the most jarring discrepancy. Good as a
fast first step or if full parity is judged not worth the translator complexity.

---

## 7. Evidence index (file:line)

- `internal/sessiond/registry.go:178-190` — opaque `SaveLayout` (verbatim store)
- `internal/sessiond/registry.go:193-201` — `Layout` read-back
- `internal/sessiond/server.go:123,152-159,401` — composition sends layout for the attached breakpoint
- `internal/sessiond/server.go:316-325` — save-layout persists but does NOT broadcast
- `internal/sessiond/server.go:442-448` — `pane-added` broadcast carries `Placement` verbatim
- `internal/sessiond/protocol.go:172,234` — placement token set `tab|split-right|split-left|split-above|split-below`
- `internal/server/ws.go:270-271` — web WS bridge forwards save-layout verbatim
- `web/src/components/mux-dock.ts:343-352` — save = `JSON.stringify(this._dv.toJSON())`
- `web/src/components/mux-dock.ts:809-849` — restore via `fromJSON`, catch → clean rebuild
- `web/src/components/mux-dock.ts:138-145` — placement→direction map (`default: 'right'`)
- `web/src/components/mux-dock.ts:309-331` — walks dockview `grid.root`/`activeGroup`
- `web/src/app.ts:983` — attach breakpoint = `currentLayoutMode()`
- `web/src/app.ts:1069-1074` — save under breakpoint `'wide'`
- `web/src/lib/breakpoint.ts:5,12-14` — `'wide'`/`'narrow'`, 768px threshold
- `web/node_modules/dockview-core/.../dockviewComponent.d.ts:64-75` — `SerializedDockview`
- `Apps/macOS/main.swift:73,150` — reads composition.layout; attaches breakpoint `"desktop"`
- `Apps/macOS/WorkspaceViewController.swift:184-196` — restore-gate → flat rebuild fallback
- `Apps/macOS/WorkspaceViewController.swift:213-269` — Bonsplit replay restore machinery
- `Apps/macOS/WorkspaceViewController.swift:385,433-434` — create-pane placement (`"split-down"` for vertical)
- `Apps/macOS/BonsplitTreeCodec.swift:18-136` — `PersistedTreeNode` schema + `isBonsplitShaped` rejection of foreign blobs
- `Sources/MuxtermKit/Model/LayoutBlob.swift` — old `LayoutBlob`/`SplitNode` schema
- `Apps/macOS/BONSPLIT_API_NOTES.md §1/§6` — Bonsplit has no restore API; replay-based restoration
- Native `save-layout` senders: **none found** (grep of `Apps/`, `Sources/`) — native never persists a layout today
