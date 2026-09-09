# Terminal/Session State Model Survey

**A comparative catalog of what a robust multiplexer stores per pane/session, benchmarked against tmux, Zellij, and cmux — and where muxterm's current implementation diverges**

## Purpose and how to read this

The human has observed two concrete bugs in muxterm: **cursor appears mid-screen after reopening a pane**, and **the wrong terminal's buffer sometimes appears on the wrong pane**. A parallel session on `fix/multi-client-resize-restore` is chasing the root cause(s) of those specific bugs.

This document does not diagnose those bugs. It is a **research survey**: what does a mature multiplexer need to track, per pane/session, to survive (a) client disconnect/reconnect, (b) full daemon/app restart, and (c) multiple simultaneously-attached clients — and how does muxterm's current design compare? The goal is to hand back a concrete gap catalog that can inform, validate, or extend whatever the parallel branch is already doing, and to separately capture hardening work that is real but not urgent.

**Method.** Three external projects were studied directly from source (not from blog summaries):

| Project | What was inspected | Where | Pinned revision |
|---|---|---|---|
| **tmux** | Actual C source (`tmux/tmux`) + `tmux.1` docs, plus tmux-resurrect and tmux-continuum plugins | `/tmp/muxterm-terminal-state-survey/tmux` (+ `tmux-resurrect`, `tmux-continuum`) | tmux `31dccb6b` (master, 2026-07-30); resurrect `cff343c`; continuum `0698e8f` |
| **Zellij** | Actual Rust source (`zellij-org/zellij`) + official docs | `/tmp/muxterm-terminal-state-survey/zellij` | `0ed2edea` (2026-07-30, v0.45.0) |
| **cmux** | Confirmed public/open-source (manaflow-ai) per the human's direction. A full source-level audit matching the tmux/Zellij depth was not completed in this pass — see "cmux" column notes below; treat cmux entries as **directional, not verified**, and do not cite them as authoritative without a follow-up audit. | — | — |
| **muxterm** | This repo's own `internal/sessiond`, `internal/server`, `web/src` | this worktree | `f73fd44` |

Muxterm's own two audit reports (`/tmp/muxterm-terminal-state-survey/reports/muxterm-backend.md` and `muxterm-web.md`) are read-only source audits with file:line evidence for every claim below. The tmux and Zellij reports (`tmux.md`, `zellij.md` in the same directory) carry the same evidentiary standard, with permanent GitHub links pinned to the studied commit. This document synthesizes across all four; it does not re-derive or re-verify their findings, and it does not add new root-cause claims about the two reported bugs beyond what those audits already flagged as *plausible, not proven* contributors.

---

## Part 1: The state catalog

The catalog is organized by state domain. For each item: whether tmux/Zellij/muxterm actually track it today (cmux marked `?` where not independently verified), and a recommendation for muxterm.

Legend: **✅** = fully tracked/persisted as described · **◐** = partially tracked / present but incomplete · **❌** = not tracked · **N/A** = does not apply to that project's architecture · **?** = not verified for cmux in this pass.

### 1.1 Session/daemon identity

| State item | tmux | Zellij | cmux | muxterm today | Recommendation |
|---|---|---|---|---|---|
| Long-lived server/daemon process distinct from clients | ✅ (`server` process) | ✅ (per-session daemon) | ? | ✅ (`sessiond`) | Keep — this is the right architecture. |
| Server/daemon incarnation ID (detectable restart) | ◐ — no explicit epoch field, but a live server never silently swaps identity; `SIGUSR1` recreates the socket **without** restarting the process, so there's nothing to distinguish | ◐ — same: no explicit epoch, but detach/reattach targets the *same* live server; a genuinely new server only appears via explicit resurrection, which the CLI already treats as a distinct code path (`ClientInfo::Resurrect`) | ? | ❌ — `NewServer` always allocates a fresh `Registry`; nothing in the protocol lets a client distinguish "same daemon, reconnect" from "new daemon, stale local state" (`internal/sessiond/server.go:26-38`) | **Gap.** tmux/Zellij don't need an epoch because their client objects are cheap and disposable — a client *always* reconnects to live server state, there is no "was this the same daemon" question to ask. muxterm's problem is structurally different: the **browser retains a stateful xterm.js object across a daemon restart**, which neither tmux nor Zellij's model has an analogue for. muxterm needs its own epoch field precisely because it kept client-side state that the other two never had to reconcile. See §2. |
| Numeric/local ID reuse after restart (session, window/workspace, pane) | ✅ ID space is server-lifetime; a fresh server naturally starts over — but tmux clients are stateless renderers, so ID reuse causes no confusion | ✅ same — `ClientId`/pane IDs are recycled aggressively, explicitly documented as "ephemeral routing key, not identity" | ? | ❌ **problematic** — `w1`, pane `1` restart at 1 on daemon restart, and unlike tmux/Zellij, muxterm's client (xterm.js instance) survives independently of the daemon and can misattribute a reused ID to old content | **Gap, direct bug-relevance.** This is the core structural difference from both reference systems: they get away with ID reuse because the client is stateless; muxterm's client is not. Either give panes/workspaces durable identity (UUID) or add an epoch so reused small IDs can't be silently accepted by a client holding stale state. |

### 1.2 Pane/PTY identity and process metadata

| State item | tmux | Zellij | cmux | muxterm today | Recommendation |
|---|---|---|---|---|---|
| Stable pane ID, unique for server lifetime | ✅ global RB-tree, `%N` | ✅ `PaneId::Terminal(u32)`, global | ? | ✅ workspace-local monotonic int | Fine within a workspace; the risk is workspace+pane composite identity not making it onto every wire frame — see §3. |
| PTY master fd / child PID | ✅ | ✅ (tracked separately: pane ID → child PID is not the same mapping) | ? | ✅ `*exec.Cmd` in daemon memory | OK |
| Initial/current cwd, argv, shell command | ✅ (queried via ps/proc as needed for display, not stored durably) | ✅ explicitly captured (`Pty` cwd cache, foreground-command detection via `sysinfo`/`tcgetpgrp`) for both live display and resurrection manifests | ? | ❌ initial cwd stored (`$HOME`), current cwd/argv **not tracked** — even though the pinned VT emulator library (`x/vt`) has OSC-7 cwd support, muxterm doesn't read it | **Gap.** Even a minimal "current cwd via OSC 7" would improve both debuggability and any future resurrect-style feature. Low urgency, but genuinely free once title/OSC handling is touched (see §1.4). |
| Exit code / runtime on natural exit | ✅ (available via hooks/format) | ✅ (`held pane` carries exit status + RunCommand for re-run) | ? | ✅ recently added — `pane-closed` now carries real exit code + runtime (commit `f73fd44`) | Good — recent work already covers this. |
| Dead-pane / exited-pane retention (for inspection) | ◐ pane object destroyed on close; only "hold on exit" panes retain a shell | ✅ "held" pane keeps exit metadata + RunCommand for re-run | ? | ❌ pane removed immediately on exit, no history/tombstone | Optional — nice-to-have, not correctness-critical. |
| Input-ownership / write authority | N/A — any attached client can type into the active pane; tmux's model doesn't need arbitration because there's one client-input at a time per window in practice, and `synchronize-panes` is opt-in | ◐ similar — no formal lease; last active client can type | ? | ❌ **no input arbitration at all** — every attached connection can write to any pane it's attached to, with no owner/focus check | **Gap, but tmux/Zellij don't solve this differently** — this is a genuine multi-client design question, not a "catch up to the reference implementations" item. See §4. |

### 1.3 Screen/grid, scrollback, cursor

This is the domain most directly implicated in the reported "cursor mid-screen" bug, so it gets the most detail.

| State item | tmux | Zellij | cmux | muxterm today | Recommendation |
|---|---|---|---|---|---|
| Server/daemon-owned canonical grid (cells + styling) | ✅ `grid`/`screen`, retained for server lifetime | ✅ `Grid` (server-owned), retained for daemon lifetime | ? | ✅ `x/vt` emulator's active screen | OK — the ownership model itself is right. |
| Scrollback depth | ✅ configurable (`history-limit`), collected in batches | ✅ 10,000 lines default | ? | ✅ 2,000 lines fixed (server) — vs. client default 10,000 (browser xterm.js) | **Note the asymmetry**: muxterm's server retains *less* history than its own client default. A reload can't recover what the live tab had. Either raise server-side scrollback or make the mismatch an explicit, understood tradeoff — not an accident. |
| Current cursor position | ✅ (`screen.cx/cy`) | ✅ (`Cursor{x,y,...}`) | ? | ✅ tracked in emulator, ✅ emitted on replay (absolute CUP) | Position itself survives reconnect — see below for why it can still *look* wrong. |
| **Saved cursor** (DECSC/`ESC 7`, `CSI s`) | ✅ explicit `input_ctx.old_cx/old_cy` slot, separate from grid | ✅ explicit `Cursor` clone on `ESC 7`/`CSI s` | ? | ❌ **not tracked at all by muxterm's replay path** — the pinned `x/vt` library *has* a saved-cursor field internally, but `serializeGrid` never reads or emits it | **Gap, direct bug-relevance.** If an app saved its cursor before disconnect (common in full-screen TUIs, e.g. `less`, `vim` on some code paths) and the connection drops mid-sequence, reattach has no way to represent "there is a pending saved-cursor slot" — that state is silently dropped, not merely deferred. |
| **Alternate-screen saved cursor** (mode 1049's cursor+rendition save) | ✅ explicit `screen.saved_cx/saved_cy/saved_cell`, separate from DECSC slot — tmux tracks **two distinct** saved-cursor mechanisms | ✅ folded into `AlternateScreenState` (cursor moved wholesale into the saved struct) | ? | ❌ same gap as above | Same as above. |
| **Inactive screen while the other is active** (main screen content while alt is active, or vice versa) | ✅ both retained; `saved_grid` explicitly holds the *other* screen's visible rows while alt is active | ✅ Zellij explicitly swaps `lines_above`/viewport/cursor/sixel into `AlternateScreenState` and back | ? | ❌ **the most concrete, evidence-backed gap in this whole survey**: production replay serializes *only the currently active screen*. If alt is active, the inactive main screen is never emitted (§4.4 of the muxterm-backend audit); if main is active, replay never forces `?1049l`, so a client stuck in alt mode from before disconnect can end up receiving main-screen content into an alt-mode client buffer | **Gap, direct bug-relevance — this is the single most concrete, source-confirmed candidate for "wrong buffer on wrong pane" and "cursor mid-screen".** Neither tmux nor Zellij drop the inactive screen on reattach; both retain both screens (or an explicit saved-screen struct) precisely because dropping the "other" screen breaks reattach fidelity. muxterm's `serializeGrid` should restore both, or at minimum force an explicit `?1049l`/`?1049h` reset consistent with the emulator's actual active-screen state before applying any snapshot. |
| **Modes** (origin, autowrap, insert, application cursor/keypad, mouse tracking variants, bracketed paste, focus events, synchronized output) | ✅ full bitset (`screen.mode`), all restored on reattach because reattach never leaves the server | ✅ same — explicit mode fields in `Grid`, all restored because the daemon never restarted | ? | ❌ **the pinned `x/vt` emulator tracks all of this internally, but `serializeGrid` emits none of it** — replay is cells + optional `?1049h` + final CUP only | **Gap, direct bug-relevance.** A client that reconnects after the app enabled bracketed paste, application cursor keys, or mouse tracking gets none of that state back, yet the live emulator (and the still-running app) believes those modes are active. This produces exactly the class of "things look subtly wrong after reopening" symptom reported. |
| Scroll margins / regions | ✅ retained (server lifetime) | ✅ retained | ? | ❌ not emitted by replay | Same category as modes above — bundle into the same fix. |
| Tab stops | ✅ | ✅ (reset on resize, but otherwise retained) | ? | ❌ not emitted by replay | Low practical impact alone; bundle with the mode-restoration fix rather than fixing in isolation. |
| Current pen/rendition (SGR) for *future* writes (as opposed to already-styled cells) | ✅ (part of `input_ctx`) | ✅ (`Cursor.pending styles`) | ? | ❌ not restored explicitly — only already-rendered cell styling survives, not the "next write" pen | Bundle with modes. |
| Title / OSC 0-2 | ✅ | ✅ (title + title-stack, `CSI 22/23 t`) | ? | ❌ **OSC title is parsed by the pinned emulator but the code comment explicitly defers wiring it to `Pane.Title`** — this is a known, self-documented gap, not a surprise finding | Cheap fix — the parser already extracts this; only the plumbing to `Pane.Title` is missing. |
| Palette / color overrides, cursor color | ✅ | ✅ (OSC 4/10/11/104/110/111; explicit no-ops for 12/112) | ? | ❌ not tracked/restored | Low priority — cosmetic in the reconnect case. |
| Hyperlinks (OSC 8) | ✅ retained in cell attributes | ✅ `LinkHandler`, tab-shared | ? | Not evaluated at this depth (emulator likely supports parsing; not surfaced/restored by muxterm's replay) | Low priority for the reported bugs; worth a follow-up if hyperlink-heavy workflows matter. |
| Images (sixel/Kitty graphics) | ✅ sixel; discarded on resize | ◐ sixel yes, Kitty/iTerm2 image protocols confirmed **absent** in Zellij's own source | ? | Not evaluated | Out of scope for this bug class. |
| Partial/incomplete escape sequence at the exact moment of snapshot | ✅ — parser context (`input_ctx`) is never torn down mid-stream because the server never stops | ✅ — same reasoning | ? | ❌ **structural risk**: because the snapshot boundary and buffer-write/broadcast are two separate operations (see §1.5), a snapshot taken between two PTY fragments can miss a pending escape prefix, then deliver the completion bytes as ordinary live data to a fresh client buffer that never saw the prefix | **Gap, direct bug-relevance.** Neither tmux nor Zellij has an analogous risk because they never "snapshot and switch renderer" — the renderer *is* the same emulator throughout. muxterm's replace-vs-append ambiguity (see §3) is the root structural cause here, not a VT-parser detail. |

### 1.4 Wire/protocol identity (routing correctness)

| State item | tmux | Zellij | cmux | muxterm today | Recommendation |
|---|---|---|---|---|---|
| Every output/input frame is unambiguously scoped to (session, window, pane) | ✅ — but trivially, because tmux has **no wire protocol in this sense**: client and server are in one process tree, screen writes go straight to the attached tty via direct function calls filtered by `session_has`/`aggressive-resize`, not a routable frame format | ✅ same reasoning — Zellij's IPC does tag terminal-ID on every `PtyBytes`/write instruction, and `Screen`→`Tab` resolution walks a real object graph per message, not an implicit "current attachment" | ? | ❌ **binary data frames carry only a workspace-local `paneId`; workspace identity is implicit in which daemon connection carried the frame, not present in the frame itself** (`internal/sessiond/protocol.go:107-125`) | **Gap, direct bug-relevance — likely the single most important structural fix for "wrong buffer on wrong pane".** Even Zellij, which *does* have a real multi-hop routing problem (not just one process tree like tmux), tags every PTY-bytes message with an explicit terminal ID that identity resolution walks explicitly rather than trusting ambient per-connection state. muxterm should add `{workspaceId, paneId}` — ideally plus a daemon-epoch/attach-generation — to every frame, control event, and internal callback closure, not just to the composite in-memory map key. |
| Attach/snapshot generation token (to reject stale frames after re-attach or reconnect) | N/A — no analogous risk; there is no separate "replay vs. live" phase to desynchronize | N/A — same; Zellij's reconnection model doesn't replay a serialized snapshot into a live object, it just resumes rendering from the still-live `Grid` | ? | ❌ **not tracked at all** — `TotalSeq` is a byte count, not a generation/sequence ID; there is no way to prove a frame belongs to a specific attach | **Gap, direct bug-relevance.** This is the item most specific to muxterm's own architecture: because muxterm (unlike tmux/Zellij) does a discrete "replay snapshot, then live-subscribe" handoff rather than continuous rendering against one persistent emulator, it needs an explicit boundary marker that tmux and Zellij simply don't need. Recommend a monotonic `attachGeneration`/`snapshotSeq` on composition + every subsequent frame, with stale-generation frames dropped. |
| Control events (pane-added/closed/renamed, workspace-list) ordered relative to composition | N/A (no such split exists) | N/A (no such split exists) | ? | ◐ **binary output frames are protected by an `attachSeq` lock; control events are not** — a control event immediately after composition can race the request/reply and reach the client with stale workspace context | **Gap.** Extend the existing (working) `attachSeq` mechanism to cover control-event delivery, not just binary pane-output frames. |

### 1.5 Snapshot/replay semantics (the replace-vs-append question)

This deserves its own section because it's the one area where muxterm's design choice is *qualitatively different* from both reference implementations, not just less complete.

tmux and Zellij never actually need a "replay" concept for ordinary reconnect: the server-owned grid **is** the terminal, and a newly attached client is simply told to redraw from that live object. There is no serialization step, no separate replay format, and therefore no possibility of the replay being incomplete relative to the live state — they are the same object.

muxterm's architecture is different by design: the browser keeps its **own** client-side terminal object (xterm.js) alive independently of the daemon, across tab switches and transient disconnects, for good reasons (local scrollback, selection, cheap redraw). This means muxterm has invented a problem tmux/Zellij don't have: **reconciling two independently-alive terminal objects (server VT emulator + client xterm.js) at reconnect time.** That reconciliation is exactly where the audits found the sharpest gaps:

- Replay is generated as a **full snapshot** (cells + limited state), but the existing client xterm.js object is only bookkeeping-reset (`resetForReattach`), never actually cleared or replaced. A full snapshot applied on top of a dirty, retained buffer is neither "replace" nor "append" — it's an unintentional hybrid that can duplicate scrollback and leave stale mode/screen state underneath fresh content.
- The snapshot boundary and the live-broadcast boundary are two separately-locked operations (`Pane.buf.Write` then, later, `broadcastPaneData` under a different lock acquisition) — a chunk can be captured in the replay **and** re-delivered live, applying cursor-relative bytes twice.

**Recommendation:** Pick one semantic, explicitly, and make it structurally true rather than approximately true:
- **Option A (replace):** Treat every full replay as authoritative replacement state. Either construct a fresh xterm.js `Terminal` and swap it in after replay completes, or perform a real, verified full reset (clear both buffers, reset modes) before writing the snapshot.
- **Option B (true delta):** Implement real incremental replay with absolute sequence numbers, so a client with existing state only receives what it's missing. This is the harder option but is the only one compatible with preserving local client scroll/selection across reconnect.

Either option requires making snapshot-generation and live-subscription-start a single atomic transaction (fixing the double-delivery gap above), not two independently-locked steps.

---

## Part 2: Multi-client size negotiation

This is the area with the most surprising external finding: **the "tmux classic rule" as usually described is not tmux's current default.**

| Aspect | tmux | Zellij | cmux | muxterm today |
|---|---|---|---|---|
| Documented/folklore default | "smallest attached client" | N/A (Zellij is younger, no folklore baggage) | ? | N/A |
| **Actual current default** | `window-size latest` (changed from `smallest` in a 2019 commit) — the most-recently-active client's size wins, not the smallest | Cross-axis **minimum** of clients currently viewing the tab (independently per axis: min-width and min-height need not come from the same client) | ? | **Last-writer-wins** — whichever client's resize message arrives last mutates the shared PTY, with no policy at all |
| Which clients "count" | Configurable nuance: without `aggressive-resize`, a client counts if its *session merely contains* the window (even if not the current window there); with it, only clients where the window is the session's *current* window count | Only clients whose `active_tab_ids` currently point at that tab | ? | Every client currently attached to the workspace, unconditionally |
| Explicit "manual" / fixed-size option | ✅ `window-size manual` + `resize-window` | ◐ no direct equivalent found; tab size is always derived from attached-client minimum | ? | ❌ |
| Zoom/fullscreen size handling | ✅ zoom is window-global; saves/restores the pre-zoom layout explicitly, and un-zooms/re-zooms transparently if the outer window resizes while zoomed | ✅ zoom is a single `Option<PaneId>` shared across all clients viewing the tab; entering it affects every client | ? | ❌ not implemented (configured action is a no-op) |
| Policy broadcast to other clients when size changes | ✅ implicit — because sizing is computed centrally and pushed via redraw, not client-initiated | ✅ same — `recompute_tab_size` is server-driven, clients don't fight over it | ? | ❌ **no resize broadcast at all** — other attached clients are never told the PTY grid changed size |
| Resize applied as one atomic transition (stored size + kernel PTY + parser/grid all updated together) | ✅ (`window_pane_resize` sequencing is deliberate, with a repaint safeguard against no-op resize cycles) | ✅ (`recompute_tab_size` → layout → PTY resize is one server-driven pipeline) | ? | ❌ **`Pane.Resize` releases its lock before calling `pty.Setsize`/`VTBuffer.Resize`** — concurrent client resizes can interleave and leave stored dimensions, kernel PTY size, and the VT emulator's own grid at three different values |

**Bottom line for muxterm:** both mature reference systems put size-negotiation authority in the **server**, using an explicit, documented policy, and neither one lets an individual attached client simply overwrite the shared PTY size unilaterally. muxterm currently has neither a policy nor a broadcast — this is a straightforward, well-precedented gap to close, and the tmux `latest`-vs-`smallest`-vs-`aggressive-resize` design space gives muxterm several off-the-shelf policy options rather than needing to invent one from scratch.

---

## Part 3: What survives what (the durability matrix)

| Event | tmux | Zellij | muxterm today |
|---|---|---|---|
| Client detach + reattach | Full fidelity — same server objects, same grid/cursor/modes/history, no serialization involved | Full fidelity — same reasoning; integration test explicitly asserts split + text survive detach/attach | **Partial** — daemon objects do survive HTTP-server ("serve") restart, but the *client-visible* fidelity gap comes from the replay/replace ambiguity in §1.5, not from the daemon losing state |
| HTTP/serve-process restart (muxterm) / n/a for tmux/Zellij (no separate "web tier") | N/A | N/A | ✅ **survives**, provided `sessiond` stays reachable — this is a genuine, real strength of muxterm's two-process design and is worth stating plainly, not just cataloging gaps |
| Daemon/server full restart | ❌ **by design** — no built-in checkpoint; explicitly documented as configuration-only re-read | ❌ **by design** — same; resurrection is an explicit, separate, lower-fidelity path (§Part 4) | ❌ — and **muxterm's own `README.md` currently overstates this** (claims reboot survival that the implementation does not provide); this is a documentation-accuracy problem to fix regardless of any code change |
| OS reboot | ❌ (tmux alone has nothing) | ❌ (Zellij alone has nothing) | ❌ (same — PTYs/processes are OS-level and cannot survive without external checkpointing) |
| Multiple simultaneously attached clients, consistent view | ✅ (server-computed size + one canonical grid, viewport-cropped per client) | ✅ (same model) | ❌ **not consistent today** — see Part 2; different clients can render the same pane at different grids with no reconciliation |

---

## Part 4: What "restart survival" tools in the wild actually capture

The human specifically asked to treat tmux-resurrect/tmux-continuum's capture list as a community-vetted "everything a session needs to survive a full restart" checklist. The finding here is important and somewhat surprising: **it is not that list.** It is deliberately narrower, and the narrowness is instructive.

**What tmux-resurrect actually persists (main save file):** session/window/pane names and indices, active/zoomed markers, the *unzoomed* layout string, pane working directory, pane title, and a best-effort reconstructed command line for the pane's foreground process (via `ps` parent/child inspection). Grouped-session relationships get special handling; ordinary cross-session window links do not (no general `link-window` reconstruction).

**What it explicitly does NOT persist**, even though a "checklist" reading might assume it does: process memory/state (impossible — it's not a checkpoint tool), the terminal grid/cells, cursor or saved-cursor position, alternate-screen/main-screen pairing, scroll region, tab stops, terminal modes, current rendition/parser state, copy-mode state, palette, hyperlink table, or images. Optional pane-content capture (`capture-pane -epJ`) is explicitly **visual text replay via `cat`**, re-parsed by a brand-new shell/PTY — not a grid import. The tool's own restore-script comment claims to restore "exact cursor positions," but in context that refers to *which pane is selected*, not the VT cursor; this is a known internal documentation/comment mismatch worth noting so it isn't miscited elsewhere.

**Zellij's built-in resurrection (its equivalent idea, on by default)** follows the identical shape: it persists topology (tabs/panes/geometry/names), detected cwd/command (offered as "press Enter to run" rather than auto-executed, to avoid re-running possibly-destructive commands), and *optionally* an ANSI-text viewport/scrollback replay explicitly described in Zellij's own code as text replay through a **brand-new parser**, not state deserialization. It does not persist grid cells, cursor, saved cursor, modes, or the main/alternate pair.

**The actual lesson for muxterm:** the community consensus captured by these tools is not "here is the complete VT state to serialize." It's the opposite: **mature tooling treats full VT-state serialization as out of scope entirely**, and instead persists *topology + a best-effort process re-launch + optional lossy text replay*. This has a direct, calming implication for muxterm's own README overclaim (§Part 3) — the fix there is to **narrow the promise to match what's actually deliverable**, not to build a from-scratch VT checkpoint format that no mature reference project has built either. Where muxterm genuinely differs from both references — and where the gap catalog above is real and actionable — is in the **detach/reattach case** (client stays live, daemon stays live), not the full-restart case. Full-restart-with-fidelity is a research problem industry-wide; live-reattach-with-fidelity is a solved problem that muxterm's own architecture accidentally reintroduces (§1.5) because it keeps a second, independent client-side terminal object that tmux/Zellij's designs never had to reconcile.

---

## Part 5: cmux

Per direction, cmux (manaflow-ai) was confirmed to be genuinely public/open source, but a source-level audit at the same depth as the tmux/Zellij reports was not completed in this research pass. No cmux-specific claims are made in the tables above beyond "not verified" (`?`). If cmux's terminal-state model is wanted as a fourth reference point with the same evidentiary bar (pinned commit, file:line citations), that should be a follow-up research task, not an extension of this document from memory or inference.

---

## Recommendations

### Must-fix — directly plausible contributors to the reported bugs, evidence-backed

These are drawn from the muxterm-backend/muxterm-web audits' own "plausible contributors" sections, cross-checked against how tmux/Zellij avoid the equivalent failure mode. None of these are root-cause claims — they are prioritized because they are structurally real gaps (confirmed against code) *and* they sit directly in the causal path the bug reports describe. The parallel `fix/multi-client-resize-restore` branch may already be addressing some of these; treat this as a checklist to cross-reference, not a new work order.

1. **Restore both screens, not just the active one, on reattach** (§1.3). Replay currently emits only the active screen; the inactive main/alternate screen is silently dropped. This is the single most concrete match to "wrong buffer on wrong pane" found in this survey.
2. **Make attach a single atomic snapshot+subscribe transaction** (§1.3, §1.5). Buffer-write and broadcast are two separately-locked steps today; a chunk can be captured in a snapshot and re-delivered live, double-applying cursor-relative bytes. Both tmux and Zellij avoid this entirely by never separating "snapshot" from "live" in the first place.
3. **Decide replace-vs-append for client-side replay and enforce it structurally** (§1.5). Today's `resetForReattach` clears bookkeeping but not the actual xterm.js buffer/modes, so a full snapshot lands on top of stale local state.
4. **Restore/replay modes, saved cursor, and margins on reattach — not just cells and cursor position** (§1.3). The pinned VT library already tracks all of this; only the replay serialization is incomplete.
5. **Tag every wire frame and control event with explicit `{workspaceId, paneId}` identity (and an attach-generation token), not just an implicit connection-scoped pane ID** (§1.4). This is the routing-correctness fix most directly analogous to how Zellij's real multi-hop IPC avoids ambient-state bugs that tmux's single-process model never had to solve in the first place.
6. **Give the daemon an incarnation/epoch identifier** and refuse to let a client that survived a daemon restart silently reuse small numeric IDs as if they still referred to the same object (§1.1). This is the one item where muxterm's architecture (client state outliving the daemon) creates a problem neither tmux nor Zellij has an analogue for — it needs its own solution, not a borrowed one.

### Should-fix — real hardening, not urgent, not directly implicated in the reported bugs

7. **Define and broadcast an explicit multi-client resize policy** (Part 2) — pick a tmux-style option (`smallest`/`latest`/`manual`-equivalent), serialize resize as one atomic transaction (stored size + PTY + emulator grid together), and broadcast the authoritative size to all attached clients instead of last-writer-wins with no notification.
8. **Serialize pane lifecycle transitions** (create/close/workspace-teardown) so registry insertion, process start, and broadcast happen as one ordered transaction rather than independently-ordered steps that can race.
9. **Make daemon startup exclusive** (PID/lock file or equivalent) so two concurrent "ensure daemon" calls can't orphan a live daemon by unlinking its socket.
10. **Wire the already-parsed OSC 0/2 title through to `Pane.Title`** — the parser already extracts it; only the plumbing is missing.
11. **Correct the README's reboot-survival claim** to state the actual guarantee (survives HTTP-server restart while the same `sessiond` stays reachable; does not survive daemon restart or OS reboot) — in line with how both tmux and Zellij scope their own restart-survival promises narrowly and explicitly rather than overclaiming.
12. **Reconcile server-side scrollback depth (2,000 lines) with the client's own default (10,000 lines)** — either raise the server-side limit or treat the mismatch as a documented, intentional tradeoff rather than an unexamined asymmetry.

### Explicitly out of scope / not recommended

- **Full VT-state checkpoint/serialization to survive an OS reboot or daemon crash.** Part 4's finding is that no mature reference project (tmux+resurrect, Zellij) attempts this either — they persist topology plus best-effort process re-launch, and treat exact grid/cursor/mode restoration after a full restart as unsolved. Building this for muxterm would be novel, unproven-elsewhere engineering, not catching up to an established bar. If ever pursued, treat it as new R&D with its own design doc, not a hardening task.
- **Full input-ownership/write-arbitration model** (§1.2) — neither tmux nor Zellij solves this any better than muxterm currently does (both allow any attached client/session-with-focus to type); this is a genuine open product question, not a gap relative to prior art.

---

## Evidence trail

Full per-project audits with file:line citations and (for tmux/Zellij) permanent commit-pinned GitHub links are preserved at:

- `/tmp/muxterm-terminal-state-survey/reports/tmux.md`
- `/tmp/muxterm-terminal-state-survey/reports/zellij.md`
- `/tmp/muxterm-terminal-state-survey/reports/muxterm-backend.md`
- `/tmp/muxterm-terminal-state-survey/reports/muxterm-web.md`

These are scratch-directory outputs (not committed) and should be treated as the primary source material behind every claim in this document. If deeper verification of any specific line item is needed, start there before re-deriving from scratch.
