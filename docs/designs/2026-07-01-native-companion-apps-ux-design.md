# Native Companion Apps — UX & Interaction Design (muxterm)

## Goal

Define the UX and interaction design for muxterm's native companion apps across
phone and desktop poles, with tablet interpolating between them.

## Companion Document

This document is **UX-only**. It complements the architecture design
[`docs/designs/2026-06-30-native-companion-apps-design.md`](./2026-06-30-native-companion-apps-design.md),
which owns all protocol, connectivity, SSH, and browser-drive internals. Anything
about *how* the pipe works (WebSocket contract, sessiond, embedded SSH, native
webview drive) lives there. This document defers to it and describes only *what
the user sees and does*.

Companion openable HTML wireframes live at
[`docs/designs/wireframes/native-apps-wireframes.html`](./wireframes/native-apps-wireframes.html).

## Guiding Principle

**Decrease the headache of the tool looking different from one open to the next.**
The app should feel the same every launch — same home, same groups, same
vocabulary. Consistency across launches and across platforms is a first-class
design goal, not a nicety. Where a decision trades novelty for sameness, sameness
wins.

## Scope & Fidelity

| Aspect | Decision |
|--------|----------|
| Deliverable | Written UX/interaction spec + wireframes |
| Poles designed together | **Phone** and **Desktop** |
| Interpolation | **Tablet** sits between the poles (responsive system) |
| Platforms | macOS (desktop), iOS/iPadOS, Android |

---

## Section 1 — Information Architecture & the Unified Dashboard

The spine is a **3-level hierarchy**: **Connection → Workspace → Pane.** The pole
difference is simply *how many levels are visible at once* — the hierarchy itself
never changes, which is what keeps the tool feeling identical across devices.

### The Unified Dashboard (home surface)

The home surface is a **unified dashboard** showing *every workspace across every
source*, **grouped by source** (`Local` and each remote). Same groups, same order,
every launch — this consistency is the anti-headache spine. This model **replaced**
an earlier "pick a connection, *then* see its workspaces" model, which made the
home surface change shape depending on what you last touched.

Key behaviors:

| Behavior | Rule |
|----------|------|
| Desktop cold-start | Desktop **auto-starts a local sessiond** if none is running, so the `Local` group is always populated and the app never opens cold/empty. |
| `Local` visibility | The `Local` group appears **only where a local sessiond can run** (desktop/macOS). Phone and iPad have no local sessiond, so their dashboard shows remotes only — no broken empty group. |
| Remote listing | Remotes are **always listed** (stable layout) so the dashboard shape is constant. |
| Remote connection | A remote **connects lazily** — on expand or open — **remembering its last-known workspaces** so the group isn't blank before SSH completes. This avoids SSH-ing every saved box on every launch. |

### Surface Inventory (shared across poles)

| Surface | Purpose |
|---------|---------|
| Dashboard (home) | Unified, grouped-by-source list of all workspaces. |
| Workspace view | The tiled/single-pane working canvas. |
| Workspace switcher | Move between workspaces within/across sources. |
| Pane chrome | Per-pane title/controls; browser panes add URL bar + back/forward/reload + live-port suggestions. |
| Mobile key-accessory bar | Esc / Ctrl / Tab / arrows / `\|` / `/` above the keyboard — essential for terminal use on phones. |
| Settings | Font/theme/keys mirroring `/api/config` + SSH Identities. |
| Connection status | Reconnect overlay / health indication. |

### Navigation by Pole

| Pole | Navigation model |
|------|------------------|
| **Desktop** | Persistent left sidebar (grouped Connections + Workspaces) + tiled multi-pane main area (dockview model) + menu bar. All levels visible at once. Keyboard-driven. |
| **Phone** | One pane full-screen at a time; a **pane strip** (thin rail of pane tabs/dots) to swipe/tab between panes; workspace switcher and connection list are drawers/sheets. One level at a time. |
| **Tablet** | Split view (collapsible sidebar + one or two panes) — a small desktop. The connections dashboard is the **primary** tablet surface. |

### Wireframe — Tablet Dashboard (primary surface)

```
┌───────────────────────────────────────────────────────────┐
│  muxterm                                     ⚙︎    + Add   │
├───────────────────────────────────────────────────────────┤
│  ▾ ● Local (this device)                    3 workspaces   │
│    ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐        │
│    │ api  2▩ │ │ web  3▩ │ │scratch1▩│ │  + new  │        │
│    └─────────┘ └─────────┘ └─────────┘ └─────────┘        │
│  ▾ ● home dev box       user@dev.tail…      2 workspaces   │
│    ┌─────────┐ ┌─────────┐ ┌─────────┐                     │
│    │trainer4▩│ │infra 1▩ │ │  + new  │                     │
│    └─────────┘ └─────────┘ └─────────┘                     │
│  ▸ ○ vps          ubuntu@203.0.113.7      tap to connect   │
└───────────────────────────────────────────────────────────┘
```

### Wireframe — Desktop (sidebar + tiled panes)

```
┌────────────────────┬──────────────────────────────────────┐
│ ⌂ Dashboard        │  Local · api                         │
│ ▾ ● Local          │  ┌────────────┬───────────────────┐  │
│    api        2▩   │  │ zsh        │ vite :5173   (⊟)  │  │
│    web        3▩   │  │            │                   │  │
│    scratch    1▩   │  └────────────┴───────────────────┘  │
│ ▾ ● home dev box   │                                      │
│    trainer    4▩   │                                      │
│    infra      1▩   │                                      │
│ ▸ ○ vps    connect │                                      │
│ ⚙ Settings   + Add │                                      │
└────────────────────┴──────────────────────────────────────┘
```

### Wireframe — Phone Home

```
┌─────────────────────────────┐
│  muxterm            ⚙︎   +  │
│ ● home dev box              │
│   trainer        4 panes  › │
│   infra          1 pane   › │
│ ○ vps          tap to connect›│
└─────────────────────────────┘
```

---

## Section 2 — The Workspace View (the heart)

The workspace view is where work happens. Its shape scales with the pole while the
verbs stay identical.

### By Pole

| Pole | Workspace behavior |
|------|--------------------|
| **Desktop** | Tiled multi-pane canvas (dockview model). Focused pane has a subtle highlight border; each pane has a slim title bar (name, close, `⤢` maximize). Browser panes get an extra chrome row. Drag pane edge to resize; drag pane to re-split. Keyboard: `⌘1..9` jump panes, `⌘T` new terminal, `⌘\` split. |
| **Phone** | One pane fills the screen; a **pane strip** (dots/tabs) at top or bottom; tap or swipe left/right to move between panes; a focused terminal raises the **key-accessory bar**; a browser pane shows a compact URL bar + back/forward, page scrolls/pinches natively. |
| **Tablet** | Two panes side-by-side max + collapsible sidebar — a scaled-down desktop. |

### Shared Interaction Rules

| Rule | Definition |
|------|------------|
| **Focus = authority** | The focused pane receives keystrokes (terminal) or browser-drive authority (browser). Phone: the *visible* pane is focused. Desktop: the *last-clicked* pane is focused. |
| **Same creation verb everywhere** | Pane creation is one verb everywhere (`create-pane` / `create-browser-pane`); only *placement* differs — split on desktop, append-to-strip on phone. |
| **Per-pole layout persistence** | Layout uses the per-client `layout` blob keyed by `breakpoint`, so phone and desktop layouts for the same workspace are remembered **separately**. |

---

## Section 3 — Connection & Onboarding Flow (the genuinely new native surface)

This surface never existed in the web app (the host served it). It is where
first-run impressions are made, so it prioritizes transparency over cleverness.

- **First launch →** empty Connections/dashboard with one primary action:
  **"Add Connection."** No account, no signup.
- **Add Connection sheet:**
  - **Name**
  - **Target:** `Local` | `Remote`
  - **Remote →** `user@host` (+ optional port)
  - **Identity:** use the **system SSH agent / `~/.ssh`** by default (desktop) OR
    **import/generate a key** (mobile, which has no `~/.ssh`); surface the public
    key to copy into the box's `authorized_keys`.
- **Connect → a transparent progress trail.** Silence is the enemy — SSH +
  forwarding has several failure points, so each step is shown:
  `Reaching host… → SSH auth… → Forwarding control port… → Attaching… → ✓`.
  Each step can fail with a **typed, actionable** message — e.g.
  "key rejected (tried `id_ed25519`)", or "can't reach `host` — is it on your
  tailnet?" with a **reachability hint card** linking to Tailscale/VPN guidance
  (muxterm *guides*, it doesn't own NAT traversal).
- **Reconnect** reuses the same trail as a slim overlay; the workspace stays
  visible underneath, dimmed.
- **Mobile nuance:** SSH key management gets a dedicated **Settings → Identities**
  screen (generate, name, export public key, delete).
- **Local target** collapses the flow to one step: `Connecting… → ✓`.

### Wireframes — Connection Flow (phone add-sheet, success trail, failure state)

```
┌─────────────────────────────┐        ┌─────────────────────────────┐
│ ✕   Add Connection     Save │        │        Connecting…          │
│ NAME                        │        │  ✓ Reaching dev.box         │
│ [ home dev box            ] │        │  ✓ SSH auth (id_ed25519)    │
│ TARGET   [ Local ][▣Remote] │        │  ✓ Forwarding control port  │
│ HOST                        │        │  ◐ Attaching…               │
│ [ user@dev.box       :22  ] │        │  ·  Live                    │
│ IDENTITY                    │        └─────────────────────────────┘
│  ◉ Use key: id_ed25519   ▾  │
│  ○ Generate new key         │        ┌─────────────────────────────┐
│  ⧉ Copy public key          │        │        Can't connect        │
└─────────────────────────────┘        │  ✓ Reaching dev.box         │
                                       │  ✗ SSH auth: key rejected   │
                                       │     (tried id_ed25519)      │
                                       │  [⧉ Copy public key]        │
                                       │  [⚙ Choose another key]     │
                                       └─────────────────────────────┘
```

---

## Section 4 — Browser Pane UX

The browser pane is the centerpiece of the re-architecture. It renders natively on
the client but can be driven from the server (per the architecture doc).

- **Chrome:** a compact top bar — `‹ ›` back/forward, `⟳` reload, a URL field, and
  a **⚡ port chip** that drops down live listening ports (from muxterm's port
  tracking) as one-tap targets. Below it, the live webview.
- **Live-port suggestions** are the anti-friction move — you rarely type a URL; you
  pick `:5173` from what's actually running.
- **New wrinkle — "agent is driving."** Because an MCP agent can drive the *same*
  live browser the human sees (see architecture doc, Section 4), the pane shows a
  visible **authority state** so control never feels haunted:
  - A slim banner/glow: **`◉ agent driving`** when an MCP command stream is active;
    **`● you`** when the human holds focus.
  - **Last-focus-wins:** tapping the page takes control back (flips to `● you`);
    the agent's next command flips it to `◉ agent`.
- **Consistency tie-in:** the URL chip, port dropdown, and authority banner look
  identical across poles — only density changes.

### Wireframes — Browser Pane (desktop, phone)

```
┌───────────────────────────────────────────┐   ┌─────────────────────────────┐
│ ‹ ›  ⟳  localhost:5173/app      ⚡:5173 ▾ │   │ ‹ ›  ⟳  localhost:5173  ⚡▾ │
│ ◉ agent driving              ⧉ open in tab │   │ ● you                       │
├───────────────────────────────────────────┤   ├─────────────────────────────┤
│            [ live web page ]              │   │      [ live web page ]      │
└───────────────────────────────────────────┘   └─────────────────────────────┘
```

---

## Section 5 — Settings & Mobile Key Bar

- **Settings:** font / theme / palette (mirrors `/api/config`), plus **SSH
  Identities** (generate / name / export-public-key / delete) — especially
  important on mobile, which has no shell to manage keys from.
- **Mobile key-accessory bar:** a persistent above-keyboard strip providing **Esc**,
  **Ctrl** (sticky modifier), **Tab**, **arrow keys**, and common symbols
  (`|` `/` `~` `-` etc.), because phone keyboards lack them. This is essential for
  real terminal use on a phone.

---

## Open Questions

- Whether to **auto-connect remotes on launch** vs. **connect-on-expand** (current
  design: connect-on-expand, remember last-known workspaces).
- The exact **pane-strip affordance on phone** (dots vs. tabs vs. edge-swipe) — to
  validate in hi-fi.
- **Tablet split behavior:** fixed two-pane max vs. adaptive — revisit at hi-fi.
- Whether the **"agent driving" state needs finer granularity** (which agent / what
  it's doing).
