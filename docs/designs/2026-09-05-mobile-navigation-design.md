# Mobile Navigation and Home

**Status:** Design, pre-implementation. Mockups first.
**Worktree:** `muxterm-mobile-nav` / branch `feat/mobile-nav-and-home`

---

## Outcome

On a phone, muxterm gets a navigation model instead of a dropdown: a **hamburger
drawer** that is the real sidebar — preview cards and all — a **bottom sheet** for
panes, and a **home** surface that survives being 360px wide. Every list the user
picks from renders in the bottom half of the screen, where the thumb is.

The measure of success is a phone-only one: a person holding the device in one
hand can reach home, switch workspaces, switch panes, and start a session,
without a keyboard chord and without missing a tap.

---

## The finding that reframes this

**Today, on a phone, you cannot reach home at all.**

Home is reachable from exactly two places:

| Entry point | `file:line` | Available on a phone? |
|---|---|---|
| Start card in the sidebar → `home-show` | `mux-sidebar.ts:1361` | No — `<mux-sidebar>` renders only when `isWide` (`app.ts:1010`) |
| `installHomeToggle(config.keys.toggleHome)` chord | `app.ts:1661` | No — a phone has no chord |

The narrow-mode title bar has no home affordance of any kind. So the "mobile
friendly view of the home experience" is not a polish task on an existing screen.
It is a screen that has no door.

That is the strongest argument for the drawer: the sidebar is the best surface in
the app, and the breakpoint currently deletes it.

---

## Current state (verified against live source)

### The picker you want to ditch is already dead

`web/src/components/workspace-picker.ts` (316 lines) is **registered but rendered
nowhere**. `app.ts:30` imports it for side effects; `app.ts:1190` holds a
placeholder comment where it used to be. Only its `workspaceLabel()` helper
survives, imported by `mux-sidebar.ts:4` and `mux-pane-picker.ts:4`.

It is also the only component in the codebase with hardcoded hex colours
(`#1e1e2e`, `#45475a`, `#cdd6f4` …) — it never joined the theme system. Its rows
are `padding: 6px 8px` on 14px text ≈ 28px tall; its icon buttons ≈ 22px. Its one
touch concession (`workspace-picker.ts:137`) makes buttons *visible* on coarse
pointers, not *bigger*.

**So "ditch the workspace picker" means: delete the file, and take the workspace
section out of the thing that actually shipped in its place.**

### What actually ships on a phone

`<mux-pane-picker>` (`mux-pane-picker.ts`), a dropdown inside the narrow title
bar. It exists because `mux-dock.ts:723` hides the entire dockview tab strip below
768px — with no tabs, something has to name the current pane.

```
┌──────────────────────────────────────────┐
│ ● muxterm   project › ●build ▾   🎤 + ⋯  │  44px
├──────────────────────────────────────────┤
│                                          │
│              terminal                    │  no tab strip
│                                          │
└──────────────────────────────────────────┘
```

Tapping the breadcrumb drops a panel with **two flat sections in one list**:
`Workspaces` (all of them) then `Panes` (current workspace only). It is
`position: absolute; top: calc(100% + 4px); right: 0` with **no `max-height` and
no scroll container** — five workspaces and six panes runs off the bottom of the
screen with no way to reach the end.

Rows are a correct 44px. The problem is not the target size. The problem is that
one flat unscrollable list is doing two different jobs, anchored at the top of the
screen, which is the part of a phone a thumb cannot reach.

### The responsive system, in full

There is one breakpoint and eleven media queries. That is the entire system.

```ts
// breakpoint.ts:10
export const WIDE_MIN_WIDTH = 768;
```

Consumed by two runtime files (`app.ts:49`, `workspace-controller.ts:15`). It
drives a single hard component swap: **wide → `<mux-sidebar>`; narrow →
`<mux-title-bar>`**. Seven of the eleven media queries are `(pointer: coarse)`
bumps to 44px. One `matchMedia()` call exists and it detects PWA standalone mode,
not layout.

`'wide'` / `'narrow'` are also **wire values** — the daemon persists layout per
breakpoint (`ws.ts:217`). Adding a third breakpoint has a protocol cost. This
design does not add one.

### Home is already most of the way there

| | |
|---|---|
| ✅ | `.tiles` is `repeat(auto-fill, 218px)` — reflows 4 → 1 column, no overflow at 320px |
| ✅ | `.home` is `max-width: 928px; margin-inline: auto` — shrinks cleanly |
| ✅ | `--t-input: 16px` on the composer textarea — deliberately at iOS Safari's focus-zoom threshold |
| ✅ | `@media (pointer: coarse)` → `.btn`, `.wsel`, `.seg button` ≥ 44px; `.send` 44×44 |
| ✅ | `@media (max-width: 560px)` → hides the "Shift+Enter" hint, because a phone has no Shift+Enter |
| ⚠️ | `.crow` (composer footer) is `display: flex` with **no wrap** — two 44px selects + a 44px send button on a 320px screen |
| ⚠️ | `.rowc` grid `var(--s-6) 1fr auto`; the `auto` column is `nowrap`, so a long workspace id squeezes the title |
| ❌ | Sticky composer vs. the on-screen keyboard is unhandled |
| ❌ | A single 218px tile in a 360px viewport wastes 40% of the width |
| ❌ | `viewport-fit=cover` is set in `index.html` and `env(safe-area-inset-*)` appears **nowhere** |

So: home needs a handful of fixes, not a rewrite. The navigation needs a model.

---

## Chosen design: three surfaces

```
   NAV BAR (top, 44px + safe area)          persistent chrome
        │
        ├── ☰  ──────────────►  WORKSPACE DRAWER   (left, full height)
        │                       the real sidebar, with previews
        │
        ├── breadcrumb ──────►  PANE SHEET         (bottom sheet)
        │                       panes of the current workspace only
        │
        └── ⋯  ──────────────►  LAUNCHER MENU      (bottom sheet)
```

One rule sets the geometry: **the bar is at the top, and everything it opens
renders at the bottom.** The top of a phone is where you look; the bottom is
where you can reach. Splitting those two jobs is the whole trick.

### The nav bar

```
┌──────────────────────────────────────────┐
│  ☰³    project › ●build ▾      🎤   ⋯    │   44px
└──────────────────────────────────────────┘
   │        │                    │     │
   │        │                    │     └── launcher (settings, about, reconnect)
   │        │                    └──────── mic (unchanged)
   │        └───────────────────────────── pane sheet
   └────────────────────────────────────── workspace drawer + needs-input badge
```

The `+` new-pane button leaves the bar. It becomes the **first, pinned** row of
the pane sheet, where it is next to the panes it is about to join. That buys back
the width the breadcrumb needs, and it is a better home for the action: "show me
the panes" and "make another one" are the same errand.

### Surface 1 — the workspace drawer

```
┌────────────────────────────┬───────────┐
│  ✻ 3   Needs input         │           │
│        2 workspaces        │  terminal │
├────────────────────────────┤  (dimmed, │
│  WORKSPACES                │   still   │
│                            │   live)   │
│  ┌──────────────────────┐  │           │
│  │ ● project      3 panes│ │           │
│  │ ┌──────────────────┐ │  │           │
│  │ │ ▓▓▒░ live canvas │ │  │           │
│  │ │ ░▒▓ preview      │ │  │           │
│  │ └──────────────────┘ │  │           │
│  └──────────────────────┘  │           │
│                            │           │
│  ┌──────────────────────┐  │           │
│  │   notes       1 pane  │ │           │
│  │ ┌──────────────────┐ │  │           │
│  │ │ ░░▒ dimmed       │ │  │           │
│  │ └──────────────────┘ │  │           │
│  └──────────────────────┘  │           │
│                            │           │
├────────────────────────────┤           │
│  +  New workspace          │           │
└────────────────────────────┴───────────┘
   86vw, max 360px
```

**The drawer is `<mux-sidebar>`.** Not a new component, not a mobile port — the
same element, in a different container. `app.ts` stops gating it on `isWide` and
instead chooses its *presentation*: a Split.js column when wide, a popover drawer
when narrow.

That is what "lean into the sidebar" cashes out to. Every property that makes the
sidebar good on desktop is already width-reactive and arrives on the phone for
free:

- `_measureCardWidth` (`mux-sidebar.ts:891`) sizes previews in **columns**, not
  scale — a 340px drawer card renders *more terminal*, not bigger pixels, clamped
  by `PREVIEW_MIN_COLS 24` / `PREVIEW_MAX_COLS 80`.
- The live/pushed asymmetry is already the visual hierarchy: the attached
  workspace paints live and vivid at 6 Hz; the others are
  `saturate(0.25) opacity(0.55)` server tiles (`mux-sidebar.ts:497`).
- The 6 Hz tick is already gated on `document.visibilityState`
  (`preview-store.ts:245`). **It must also gate on drawer-open** — see D6.
- `<mux-start-card>` is already the home affordance, already carries the
  needs-input count, and already has a designed zero state
  (`mux-start-card.ts:68`).

**Home button:** the Start card, pinned at the top of the drawer, full width. It
is the same control that means "home" on desktop. Nothing new to learn, nothing
new to build.

### Surface 2 — the pane sheet

```
              ┌──────────────────────────┐
              │        terminal          │
              │        (dimmed)          │
              │                          │
              ├──────────────────────────┤
              │           ▁▁▁            │  grab handle   ┐
              │   PANES · project        │  heading       │ pinned
              │   +  New pane            │  56px          ┘
              │ ═════════════════════════│  scroll edge
              │   ✓  ● build       ✕     │  56px          ┐
              │   ─────────────────────  │                │
              │      server        ✕     │  56px          │ scrolls
              │   ─────────────────────  │                │
              │      logs          ✕     │  56px          │
              │   ─────────────────────  │                │
              │      test-watch    ✕     │  56px          ┘
              │                          │  ← safe-area inset
              └──────────────────────────┘
```

Panes of the **current workspace only**. Workspaces moved to the drawer. This is
the split that makes both surfaces legible.

Rows are 56px, not 44px — 44 is the floor for a target you aim at, and this is a
list you scan and stab at while walking. The close `✕` keeps its own 44×44 hit
box inside the 56px row, with a gap from the row's own tap area so a thumb aiming
at "switch to logs" does not kill it.

**`+ New pane` is the first row, and it is pinned outside the scroller.** As a
last row it would be the one control in the sheet whose position depends on how
many panes exist and where the list happens to be scrolled — at six panes on a
short phone it is below the fold entirely. Pinned at the top it is always in the
same place, which is what makes it a muscle-memory target. The cost is honest:
the top of a bottom sheet is the farthest part of it from a thumb. At
`max-height: 60dvh` that top edge still sits around 40% down the screen, which is
a far shorter reach than the title-bar `+` it replaces.

A heavier divider separates the pinned rows from the scroller, so the scroll
boundary reads without motion.

Bounded height: `max-height: 60dvh` with the list scrolling inside. Today's
dropdown has none, which is the bug that hides the last pane.

### Surface 3 — launcher menu

Same bottom-sheet chrome as the pane sheet, `popover="auto"`. Currently
`launcher-menu.ts` buttons are `padding: 6px 10px` ≈ 26px — below the touch floor
*in the mobile title bar*. In a sheet they become 56px rows and the problem
disappears.

---

## Decisions

### D1. Native platform primitives, not hand-built overlays

Both the drawer and the sheet use the **Popover API** (`popover="auto"` +
`popovertarget`). Baseline in every browser muxterm supports.

What that buys, for free, that the codebase currently hand-rolls:

| Behaviour | Popover gives it | What we'd otherwise write |
|---|---|---|
| Top layer | yes | more entries in the z-index ladder |
| Light dismiss (tap outside) | yes | document click listener + hit testing |
| Escape to close | yes | keydown handler that must not fight xterm.js |
| Focus management | yes | manual focus trap |
| One-at-a-time | yes | close-the-other-one bookkeeping |

The z-index point is not academic. `app.ts` already runs a ladder — `1000`
connecting overlay, `1500` title-bar menu anchor, `2000` pane picker, `2500` close
alerts, `3000` dialogs — and `<mux-home>` is an `inset: 0` overlay inside
`.main-pane`. Adding two more custom overlays means picking two more numbers.
Top-layer means picking none.

### D2. Where "native menu element" ends, and why

You asked about native menu sheets. Worth being precise about the ceiling,
because it decides which surface gets which treatment.

A `<select>` is the only element that opens the **real OS sheet** — the iOS wheel,
the Android Material dialog. It is genuinely excellent: correct by construction,
zero CSS, familiar, accessible, and it never has a touch-target bug. But its
options are *strings*. No bell dot, no `✕`, no live preview canvas, no pane-count
chip.

So:

| Surface | Element | Why |
|---|---|---|
| Composer harness picker | `<select>` | one-of-N string. **Already is one** (`.wsel`, `mux-home.ts:1479`) |
| Composer workspace target | `<select>` | same |
| Pane sheet | `popover` sheet | rows need `✕` and a bell dot |
| Workspace drawer | `popover` drawer | cards need a live canvas |
| Launcher menu | `popover` sheet | rows need icons |

The mockup ships **both variants of the pane picker** — the popover sheet and a
real `<select>` — so the difference can be felt on the actual device rather than
argued about. If the `<select>` wins on feel, the cost is losing per-row close,
and the fallback is close-from-the-dock. That is a decision worth making with a
thumb, not a spec.

`<dialog>` was considered for the sheet and rejected: `showModal()` puts it in the
top layer too, but it is *modal* — it inerts the page. The drawer wants the
terminal behind it visibly alive (that is the point of the previews), and a modal
backdrop fights the "peek and dismiss" gesture. `popover="auto"` is non-modal and
light-dismissable, which is exactly the semantic.

### D3. Delete `workspace-picker.ts`

It is dead, it is off-theme, and its rows are half a touch target tall. Move
`workspaceLabel()` to `web/src/lib/workspace-label.ts` — its two real consumers
(`mux-sidebar`, `mux-pane-picker`) already import only that. Drop the import at
`app.ts:30` and the placeholder comment at `app.ts:1190`.

### D4. The hamburger carries the needs-input badge

On desktop the Start card's count is always visible in the sidebar. Behind a
closed drawer it is not. So the count comes out to the bar:

```
 ☰³        3 sessions need input, drawer closed
 ☰         all clear
```

Reusing `NEEDS_GLYPH = '✻'` and the Start card's own zero-state rule
(`mux-start-card.ts:68`): at zero the badge is not a grey zero, it is absent.

This is the one piece of genuinely new visual design in the nav. Everything else
is a relocation.

### D5. No edge-swipe to open the drawer

Tempting, and wrong here, for three reasons that all land on the same 20px:

1. `terminal-registry.ts:650-680` hand-rolls `touchstart`/`touchmove` scrolling
   because xterm.js v6 regressed native touch-scroll. An edge gesture would have
   to negotiate with that.
2. iOS Safari owns the left edge for back-navigation.
3. A terminal is a horizontally scrollable surface. A left-edge drag is
   ambiguous with "scroll this wide output".

The hamburger is a 44×44 target in the corner. Swipe-**to-close** on the open
drawer is safe (the drawer owns its own surface) and is in scope.

### D6. Previews pause when the drawer is closed

`preview-store.ts:245` already gates the 6 Hz live tick on
`document.visibilityState`. A closed drawer is the same condition — the canvases
are not on screen — but the tab is visible, so the existing gate does not fire.

Without this, a phone repaints a canvas six times a second that nobody is looking
at, on a battery. Gate on `visibilityState === 'visible' && (isWide ||
drawerOpen)`. The pushed server tiles are unaffected; they are already
event-driven.

### D7. The tile grid is width-driven: 1 column on a portrait phone, up to 5 wide

Today the grid is `repeat(auto-fill, 218px)` (`mux-home.ts:753`) against a fixed
`TILE_COLS = 40` (`home-tile.ts:31`). Fixed-width tracks means the row always ends
in dead gutter, and a 218px tile in a 390px portrait phone wastes 40% of the
width.

**Invert it: choose the column count from the viewport, then let the tracks fill
the row completely.**

```
  < 600px      1 col     portrait phone — the tile spans the width
  600–839      2 cols
  840–1099     3 cols
  1100–1399    4 cols
  ≥ 1400       5 cols    cap
```

**The table is keyed on home's own content width, not the viewport.** Corrected
after implementation measured the difference. In wide mode home sits beside the
220px sidebar plus a 4px gutter, so its content width is `viewport − 224` and
every band fires 224px later in viewport terms — the 5-column cap is reached at
a 1624px viewport, not 1400.

That is the behaviour to want, not a defect to patch. Keying on the container
holds the track in a consistent ~280–340px band at every width and follows the
sidebar live when the gutter is dragged; keying on the viewport would put 5
tracks of 235px into the 1176px home actually has at 1400, which is narrower
tiles and fewer terminal columns in exchange for a rounder number nobody can
see.

One consequence worth stating plainly: at a 844px viewport the app is already
wide (`>= 768`), so a landscape phone gets 620px of content and **2** columns.
An earlier draft of this decision claimed 844 lands on 3; it does not.

```css
.tiles {
  grid-template-columns: repeat(var(--tile-cols), 1fr);
  gap: var(--s-4);
}
```

**Columns of terminal, never scaled pixels.** The track's measured pixel width
divides by the 5px cell (`fonts.ts:49`) to give `TILE_COLS`, clamped to the
sidebar's own `24..80` band. A 390px portrait phone yields a ~68-column tile: more
terminal at the same crispness, not the same terminal blown up. This is D1 of
`2026-09-02-sidebar-live-preview-design.md` applied to home — the exact trick
`_measureCardWidth` (`mux-sidebar.ts:891`) already plays in the drawer.

**Rows stay content-derived at 9.** `TILE_ROWS = 9` is what `home-tile.ts`
actually produces from a session's declared fields (`waitingFor`, `doing`,
`doneMeans`). Locking the tile to today's ~2.8:1 aspect instead would make a
68-column portrait tile 15 rows tall — six of them blank. A wider, shorter tile
truncates those lines less, which is the actual win.

The aspect ratio is therefore **not** enforced directly. It is what the column
table protects: multi-column is how a wide window avoids one absurd letterbox
slot, rather than a separate clamp.

**Consequence to accept: `.home`'s `max-width` has to grow.** It is `928px`
(`mux-home.ts:409`), derived from `PAGE_W = 4 × 218 + 3 × 8 = 896`
(`mux-home.ts:174-192`). Four columns is the current ceiling *because* of that
measure. Five columns needs roughly `1200px + padding`. The cascade from
`TILE_COLS` → `TILE_W` → `TILE_BOX` → `PAGE_W` → composer width is deliberate
(and commented as such); with tracks now `1fr`, `PAGE_W` stops being derived from
tile geometry and becomes a chosen page measure. That is the one real change to
the desktop layout in this design, and it wants eyes on it before it lands.

**Default view stays Cards on a phone.** `VIEW_KEY` (`mux-home.ts:61`) persists
Tiles ⇄ Cards. On first run at narrow width, default to **Cards** — a card row is
one line and scans faster while thumb-scrolling. Full-width tiles make the Tiles
option good on a phone rather than mandatory; the segmented control stays.

### D8. Composer survives a phone

- `.crow` gets `flex-wrap: wrap`; below 560px the two selects share a row and
  `.send` sits with them at the end.
- Sticky bottom respects `env(safe-area-inset-bottom)`.
- On-screen keyboard: add `interactive-widget=resizes-content` to the viewport
  meta so the layout viewport shrinks and the sticky composer rides the keyboard
  instead of hiding under it. One meta attribute; the alternative is a
  `visualViewport` resize listener and a manual translate.
- `--t-input: 16px` stays. It is load-bearing and it is commented as such.

### D9. Safe-area insets, everywhere, finally

`index.html` has set `viewport-fit=cover` for as long as it has had a viewport
meta, and `env(safe-area-inset-*)` appears in zero files. On a notched phone in
landscape the drawer currently starts under the notch.

- nav bar: `padding-top: env(safe-area-inset-top)`
- drawer: `padding-block: env(safe-area-inset-top) env(safe-area-inset-bottom)`,
  `padding-left: env(safe-area-inset-left)`
- sheet: `padding-bottom: env(safe-area-inset-bottom)`
- home composer: as above

### D10. Fix the 768 boundary while we are here

`layoutModeForWidth` says wide is `>= 768` (`breakpoint.ts:13`). `mux-dock.ts:723`
hides the tab strip at `max-width: 768px`. **At exactly 768px you get the sidebar
*and* no tabs.** Known, documented in
`docs/designs/2026-07-31-mobile-touch-actions-design.md`, never fixed. It is a
one-character fix (`767.98px`) and this is the change that touches both sides.

`'wide'` / `'narrow'` stay as the only two breakpoint values — they are wire
values the daemon keys layout storage on (`ws.ts:217`), and this design has no
need for a third.

---

## What we are NOT doing

- **No third breakpoint.** Protocol cost, no benefit here.
- **No bottom nav bar.** iOS Safari's own chrome sits at the bottom in the default
  configuration and would fight it. The bar stays at top; the *sheets* go to the
  bottom, which captures the reachability win without the collision.
- **No per-pane preview thumbnails in the sheet.** The preview pipeline is keyed
  per *workspace* (`preview-store.ts`); `home-tile.ts` is an explicit stand-in for
  a per-pane emit path that does not exist daemon-side. Out of scope.
- **`<mux-settings-surface>` is not fixed here.** It has a hardcoded 156px inner
  sidebar and zero media queries — on a 360px phone the content column gets
  ~180px. It is the worst surface in the app on mobile and it deserves its own
  pass. Noted, not smuggled in.

---

## Mockups

Built as a **fifth surface in the existing demo harness**, not a Figma file — the
mockup imports the real `<mux-home>` and `<mux-start-card>` and the real theme
tokens, so what you look at is what the components actually do at that width.

```
web/demo-mobile/index.html          the mockup shell
web/src/demo/mobile-demo.ts         state machine + fixtures
vite.mobile-demo.config.ts          → web/dist-mobile-demo/
```

Its own root and outDir, parallel to `vite.demo.config.ts`, for the reason that
config already records: `web/embed.go` compiles `dist/` into the binary, so a
second input in the production config would ship the mockup to every user.

**Responsive shell.** Opened on a desktop it renders the states side by side in
phone frames — a contact sheet. Opened on a phone it goes full-bleed and
interactive. Same page, so one tunnel URL serves both the review and the feel.

States:

1. Nav bar closed — terminal behind
2. Workspace drawer open — Start card + preview cards
3. Pane sheet open — variant A, popover sheet
4. Pane picker — variant B, real `<select>`, tappable
5. Home, cards view
6. Home, tiles view — **portrait, 1 column, full width** (D7)
7. Home, composer focused with keyboard reserve
8. Home tiles — **landscape 844×390, 3 columns** (D7)
9. Home tiles — **tablet/desktop 1200px, 4 columns** and **1400px, 5 columns** (D7)

States 6, 8 and 9 exist to make the D7 column table judgeable at the three widths
that decide it. The frame's own width drives the column count — the mockup does
not hardcode a count per state.

Served over a muxterm tunnel.

---

## Verification

Per `AGENTS.md`: no unit tests. Real browser, real device.

**Mockup stage (now):** open the tunnel on an actual phone, tap every state.
Specifically: does the `<select>` variant feel better than the sheet? Is the
56px row right? Does the drawer at 86vw leave enough terminal visible to feel
non-modal?

**Implementation stage (after sign-off):**

- `playwright-cli` at 390×844 (iPhone 14) and 360×800 (Pixel), per the
  `/muxterm-verify` skill
- Fresh workspace per run — `AGENTS.md:64`, fixture rot is real and it cost
  hours once
- The 768px boundary explicitly: 767, 768, 769
- Rotate to landscape with a notch — safe-area insets
- Drawer closed for 60s with an active workspace — confirm no canvas repaint
- `cd web && npm run check:fast` (0 errors) and `go build ./...` before commit

---

## Open questions

**Resolved**

- ~~Sheet or `<select>` for panes?~~ **Sheet (variant A, popover).** Decided on
  the device. The `<select>` variant stays in the mockup as the record of what was
  traded away — per-row `✕`, the bell dot, the pane count.
- ~~Does `+ New pane` belong in the sheet, and where?~~ **In the sheet, first row,
  pinned.** See Surface 2.

**Open**

1. **`+ New workspace` in the drawer — first or last?** It is currently pinned at
   the *bottom*, which is the better thumb reach in a full-height drawer and
   matches the desktop sidebar. But the pane sheet just went first-and-pinned, and
   two `+ New …` actions sitting at opposite ends of two adjacent surfaces is the
   kind of inconsistency that costs a beat every time. Consistency argues first;
   reach and desktop parity argue last. **Wants a look, not an argument.**
2. **Should the drawer also duplicate Home as a pinned bottom action?** The Start
   card at the top is the natural home for it and matches desktop, but the top of
   a drawer is the hardest part of a phone to reach.
3. **Does the drawer close on workspace switch?** Almost certainly yes — the point
   of switching is to see the terminal. But there is a "browse the previews" mode
   where staying open is nicer.
4. **Tile rows: content-derived 9, or aspect-locked?** D7 chooses 9; the mockup's
   state 6 A/B toggle exists to overrule it. Measured: aspect-locked at 68 columns
   is 15 rows with 10 trailing blanks.

---

## Decisions taken without review

The four open questions were unresolved when implementation started. Rather than
block, each took its stated default. Each is cheap to reverse; none is load-bearing
for the rest of the design. Recorded here so a later reader knows these were
defaults, not conclusions.

| Question | Taken | Reversal cost |
|---|---|---|
| `+ New workspace` position in the drawer | **last** (pinned bottom) — better thumb reach in a full-height drawer, and matches the desktop sidebar | one CSS order change |
| Home duplicated as a pinned bottom drawer action | **no** — the Start card at the top is the same control desktop uses; a second one is a second thing to learn | additive |
| Drawer closes on workspace switch | **yes** — the point of switching is to see the terminal | one `hidePopover()` call |
| Tile rows | **9, content-derived** — aspect-locking at 68 columns measures 15 rows with 10 trailing blanks | `TILE_ROWS` is already a parameter |

The `+ New workspace` default is the one that stays genuinely open: the pane sheet
puts `+ New pane` first-and-pinned, so the drawer and the sheet now disagree about
where a `+ New …` action lives. Consistency argues first; reach and desktop parity
argue last. The mockup's state 2 has an A/B toggle for exactly this.
