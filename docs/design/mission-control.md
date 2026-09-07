# Mission Control — the right-hand surface as an applet host

**Design round one. A prototype and a document. No production behaviour changes.**

Companion artifact: [`mission-control-mock.html`](mission-control-mock.html) — self-contained,
no build step, no network.

```
xdg-open docs/design/mission-control-mock.html
```

Deep links, for handing someone a view rather than a click path:
`#dashboard` `#tiles` `#files` `#changed` `#prs` `#dismissed` `#alt-a` `#alt-b`,
plus `?clean=1` (hide annotations) and `?frozen=1` (stop the live ticker).

---

## The problem this round is answering

Today the right-hand half of `mux-cos.ts` is one hardcoded thing: the fleet. Its
view switch — `cards | tiles` — is pinned to the top-right of the surface chrome
(`mux-cos.ts:1515-1528`), where it reads as a property of *the surface* rather
than of *the fleet*. Anything else you might want on the right has nowhere to go.

Three things want to go there:

- **the fleet** — what it already shows;
- **files** — what changed on disk, which a lane's work is invisible without;
- **pull requests** — which is the user's stated pain: *"when a lane finishes I
  have no idea what PRs exist."*

So the right-hand side becomes a **host** with a tab strip, and each of those
three becomes an **applet**. The surface is renamed **Mission Control**. The
`cards | tiles` toggle leaves the chrome and moves inside the Dashboard applet,
which is the only thing it ever meant anything to.

---

## D1 — The applet contract

### What an applet is

**A Lit custom element plus a manifest.** Lit because every component on this
surface already is one (`mux-cos`, `mux-home`, `mux-sidebar`, `title-bar`), and
because of one specific property `theme.ts` already relies on:

> `// Custom properties inherit into shadow roots, so no component needs a copy.`
> — `web/src/lib/theme.ts:349`

An applet in a shadow root is therefore **correctly themed for free** — it reads
`--chrome-bar`, `--ink-2`, `--edge` and gets the palette, light or dark, with no
registration step and no token plumbing. That is the whole argument for Lit here.

### Registration

A module-level array, populated by side-effecting imports. No dynamic loading.

```ts
// web/src/lib/applet-registry.ts
export interface AppletManifest {
  /** Stable. Used for persistence keys, deep links, and navigation targets. */
  id: 'dashboard' | 'files' | 'prs' | string;
  /** Tab text. Title Case; the host does not transform it. */
  label: string;
  /** A lucide icon component. The host renders it at size 13; the applet
      does not choose its own size, so the strip stays even. */
  icon: LucideIcon;
  /** Custom-element tag for the applet body. */
  element: string;
  /** Optional controls for the rail. Plain lit-html, rendered by the HOST
      with the HOST's styles. See "the rail" below. */
  rail?: (ctx: AppletContext) => TemplateResult;
  /** Built-in ordering; ties broken by registration order. */
  order?: number;
}

export function registerApplet(m: AppletManifest): void;
export function applets(): readonly AppletManifest[];
```

```ts
// web/src/components/applets/applet-files.ts
registerApplet({
  id: 'files', label: 'Files', icon: Folder,
  element: 'applet-files',
  rail: (ctx) => html`<button class="toggle ..." @click=${ctx.toggleChanged}>changed only</button>`,
  order: 20,
});
```

`mux-cos.ts` imports the three built-ins for their side effect and asks the
registry for the strip. It knows nothing else about them.

### What muxterm hands an applet

**Not data.** Applets read the same singleton stores the rest of the app reads
(`homeSessions`, `cosStore`), which is how `mux-cos` already works. Inventing a
prop-drilling contract for data that is already a global observable would be pure
ceremony.

What the host *does* set, as three reactive properties on the element:

| Property | Type | Meaning |
|---|---|---|
| `active` | `boolean` | This applet's tab is the visible one. **An inactive applet must stop polling, stop animating, and hold no open connection.** This is the only rule with teeth. |
| `narrow` | `boolean` | Mirrors the host's `narrow` attribute. |
| `target` | `string \| null` | What to point at — `pr:79`, `session:8e9e…`, `path:web/src/lib/theme.ts`. Set by the host when something navigated here on purpose. The applet scrolls to it, marks it, and clears the property. |

And two events an applet may fire (`bubbles: true, composed: true`):

| Event | Detail | Meaning |
|---|---|---|
| `applet-rail-changed` | — | "Re-read my rail." The host re-renders the rail only. |
| `applet-navigate` | `{ applet, target }` | "Show that instead." This is how the Dashboard's `#84` chip reaches Pull Requests. Gated — see D3.4. |

### The rail

The control rail is the right-hand end of the tab strip. **The host paints it;
the applet only fills it, using the host's vocabulary** (`.seg`, `.toggle`,
`.live`). An applet cannot introduce its own control styling there.

This is deliberate. The rail sits inside shared chrome, one row from the tab
strip. If three applets each styled their own controls, the strip would look like
three different products. The mechanism that enforces it is also the smallest
one available: `rail` is a plain function returning lit-html that the **host**
renders into the **host's** light DOM with its own styles in scope. No second
custom element, no `::part` surface, no slot choreography.

The cost is real and worth naming: an applet cannot put a control in the rail
that the host has no style for. Adding a new control kind is a host change. For
three built-ins that is correct; for third-party applets it would not be.

### What an applet may and may not do

**May**

- render into its body and own that scroller;
- read the app's stores;
- persist its own preferences under `muxterm.applet.<id>.*`;
- ask the host to navigate, or to re-read its rail;
- run a poller — **only while `active`**.

**May not**

- touch the topbar, the conversation, the divider, or any other applet's DOM;
- open a popover, dialog or sheet outside its own body — the host owns the top layer;
- hold a connection or a timer while `active === false`;
- define its own colours. It uses `--chrome-*` / `--ink-*` / `--edge`, or it is wrong;
- block. `render()` is synchronous and cheap; data arrives through stores;
- put a destructive action in the rail (see D3.9).

### Third-party applets: out of scope, and not designed for

Round one ships **built-ins only**. The registry is a module array, not a plugin
loader. Before a third party could ship one, three things that do not exist would
have to:

1. a **versioned, typed API surface** — right now the contract is "whatever the
   built-ins happen to use", which is fine for three files in one repo and
   nothing at all to an outside author;
2. a **loading mechanism that is not "import arbitrary JS into the app's
   origin"** — muxterm serves a terminal multiplexer; an applet with DOM access
   has the same reach as the app;
3. an answer for **a hung or hostile applet** — today it would take the surface
   down with it.

The manifest shape above is deliberately plugin-shaped so the door is not nailed
shut. That is the only concession this round makes to it.

---

## D2 — Where pull request data comes from

### What exists today

| Fact | Evidence |
|---|---|
| `SessionState` carries a PR number | `internal/sessiond/sessionstate.go:182-188` — `PR int \`json:"pr,omitempty"\`` |
| It reaches the browser | `internal/mcp/fleet.go:261` emits `"pr"`; the CLI prints a `PR` column, `cmd/muxterm/fleet_cmd.go:104-110` |
| The UI already draws it | `web/src/components/mux-home.ts:1696` — `<span class="badge pr">#${s.pr}</span>` |
| Exactly one thing can write it | `muxterm session report --pr N` — `cmd/muxterm/session_report_cmd.go:50` |
| **Nothing does** | the Amplifier hook (`modules/hooks-muxterm-session/`) never sets it; grep finds no `pr` in `classify.py`, `label.py`, `state.py` |
| **Verified live** | every session in the running fleet reports `"pr":0` |

So the field is plumbed end to end, rendered, printed — and dead. It has no
producer.

### Is a lane declaring its PR the right source of truth?

**Yes — as one source, and the only one that can answer the attribution
question.** No GitHub API can tell you *which lane opened this PR*. Only the lane
knows. Keep the field, and start writing it.

**No — it cannot be the list**, for three reasons, and the second is the user's
actual complaint:

1. **It is not written today.** Dead until a producer calls it. That producer is
   a small, contained change: after `gh pr create` succeeds, report the number.
2. **A lane that exited takes its declaration with it.** Session snapshots are
   reaped; `pr` dies with the row. *"When a lane finishes I have no idea what PRs
   exist"* is precisely this. A list assembled from live sessions is a list that
   forgets the moment the work is done — the exact moment you need it.
3. **A PR opened by hand has no lane at all.** #73 in the mock is that case, and
   it is drawn with an explicit `— no lane` marker rather than being hidden.

**Therefore: the lane declaration is an attribution hint, not the list.** The
list has to be durable on its own.

### The proposal: a watchlist owned by sessiond

A file beside the session spool, keyed `owner/repo#number`. Entries enter three ways:

- **a.** a session snapshot carrying non-zero `pr` — auto-add, and record the
  declaring lane so the applet can link back to it;
- **b.** a repo scan — `gh pr list` over every repo that a known workspace's cwd
  resolves to, at startup and on demand. This is what catches hand-opened PRs and
  PRs from lanes that already exited;
- **c.** explicit user add — not built this round, but the shape allows it.

Entries leave **only by user dismissal**. A merged or closed PR stays visible
until dismissed, so "it merged while I was at lunch" is still legible when you
get back. Dismissal is **muxterm state, never GitHub state** — the mock says so
in the dismissed panel, in those words.

### Live status without a credential in the browser

**The browser never holds a token.** That is the constraint; everything follows
from it.

- **sessiond polls, using the host's already-authenticated `gh` CLI** — the same
  credential the lanes already use. muxterm asks for no new credential and stores
  none. One call per repo per cycle:
  `gh pr list --json number,title,state,isDraft,statusCheckRollup,reviewDecision,headRefName,updatedAt`
- **Adaptive cadence:** ~20s while any watched PR has checks in flight, 2–5 min
  otherwise, and **nothing at all when no browser is attached.** Authenticated
  `gh` gets 5000 requests/hour; one list call per repo is negligible, and the
  cadence exists to be polite, not to survive a limit.
- **Delivery reuses the existing channel** — the same stream the fleet already
  pushes on, carrying whole-list snapshots that are idempotent exactly like
  session snapshots. No new transport, no new auth surface, no new failure mode.
- **Not needed:** GraphQL batching, webhooks, a GitHub App. At ten PRs and one
  user, they are cost without benefit. Say no now; revisit if the watchlist ever
  spans many repos.

### What is still missing, concretely

1. **A producer.** Make the Amplifier hook and `/goal` lanes call
   `muxterm session report --pr <n>` after opening a PR.
2. **Repo identity on the row.** `pr: 79` is meaningless without a repo.
   `SessionState` has `project` (a path) but no owner/name. **Recommend adding
   `Repo string \`json:"repo,omitempty"\`** next to `PR` — deriving it from the
   path costs a git call per row per poll, and a worktree's remote can legally
   differ from its parent's.
3. **The durable watchlist and its poller** in sessiond.
4. **A dismissal store**, separate from the watchlist, so re-scanning cannot
   resurrect something the user put down.

---

## D3 — What this round did not settle

**1. The attention policy (P5).** Take the wheel, raise a flag, or both.
→ **Recommend: flag by default; take the wheel only when the user asked ("show
me X") or the surface has been idle past a threshold. Urgency alone never
promotes a flag to a jump.** Stealing the surface from someone who is reading is
worse than a badge they see thirty seconds late.

**2. Where the Dashboard's `cards | tiles` preference lives.** Global today
(`FLEET_VIEW_KEY`); the toggle is now applet-owned.
→ **Recommend: namespace it to `muxterm.applet.dashboard.view` now**, with a
one-time migration, before a second applet adds a preference and the flat
namespace becomes a convention.

**3. The naming collision with PR #73.** #73 —
*"Dashboard polish: brand, markdown, title-bar height, no shell for the
sidecar"*, branch `fix/dashboard-brand-markdown-titlebar`, open — renames every
user-visible "chief of staff" string to **muxterm** and edits this same topbar.
→ **Recommend: let #73 land first, then rename the title only.** Two concurrent
renames in one topbar is a guaranteed conflict for no gain.
Also settle the referent: **the surface is Mission Control; the applet stays
Dashboard.** Note that "Dashboard" today means three different things —
the surface title (`mux-cos.ts:1513`), the narrow-mode title (`title-bar.ts`),
and the agent itself in the empty-state copy (*"the Dashboard splits it, routes
it"*, `mux-cos.ts:1592-1595`). Renaming the surface fixes one of the three and
makes the other two more visibly wrong.

**4. Cross-applet navigation.** May an applet yank the surface to another
applet? The mock's `#84` chip and PR-row lane links both do.
→ **Recommend: yes, but only in direct response to a user gesture** — the same
rule as P5. Never on a data change.

**5. Does a dismissed PR ever come back?** Never / on any state change / on
changes that matter (checks fail, review requested, merged).
→ **Recommend: never, automatically.** A dismissal that undoes itself is not a
dismissal. If people turn out to miss things, add an explicit per-row "tell me if
this changes" rather than a global rule that surprises everyone.

**6. What the Files applet is rooted at.** The active pane's cwd, every lane's
worktree, or a picker.
→ **Recommend: the active pane's cwd, with a picker across known workspaces.**
Genuinely unsettled — the mock shows a single root and dodges it. With eleven
worktrees on this machine, a single root is going to feel wrong quickly.

**7. Narrow and mobile.** Not designed this round.
Today `:host([narrow])` hides `.dash` entirely and the fleet moves to a bottom
sheet. Three tabs plus a rail will not fit a 360px sheet.
→ **Recommend: the sheet gets the tab strip, and the rail collapses into the
`⋯` menu.** Decide next round; this one has no opinion worth trusting.

**8. Empty and error states.** Not mocked, and each applet needs two: "nothing
here" and "I could not reach my source" — Files on a non-git directory, Pull
Requests when `gh` is not authenticated.
→ **Recommend: the host provides one standard empty/error presentation**, so
three applets do not invent three idioms for the same sentence.

**9. Destructive actions in the rail.** Nothing in the mock deletes anything.
→ **Recommend: forbid it.** The rail sits in shared chrome; a control that
destroys something belongs in the applet body, next to the thing it destroys.

**10. Is the surface pane-scoped?** Today `.dash` shows the whole fleet no
matter which pane has focus. Files and Pull Requests are more context-sensitive.
→ **Recommend: applets are surface-scoped by default; any pane-scoping is opt-in
per applet** — otherwise switching panes silently changes what three tabs mean.
