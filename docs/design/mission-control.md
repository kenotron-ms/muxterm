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

---

# Round two — the decisions are settled, and three applets are built

**Round one proposed. This round decided, and shipped.** Everything above stands
as written; nothing in it is retracted except where this section says so
explicitly. The ten items in D3 now each carry an answer, and the shell they
were blocking is code.

## S1 — The ten, settled

### Settled by the user, not by this round

**D3.1 — attention policy. ADOPTED as recommended.** Flag by default; take the
wheel only when the user asked, or when the surface has been idle past a
threshold. **Urgency alone never promotes a flag to a jump.**

The enforcement is structural rather than a rule someone has to remember:
`AppletAttentionDetail` carries `applet` and an optional `count`, and *no
severity field at all*. An applet convinced its news is important has nothing to
argue up with. The threshold is `IDLE_MS = 90_000`, and it is a claim about the
person rather than about the data — someone who has not touched this surface in
a minute and a half is not reading it, and moving it costs them nothing; someone
who touched it four seconds ago is, and moving it costs them their place.

The one asymmetry worth naming: an auto-jump records a gesture, so the surface
never yanks twice in a row. The second lane to block while you are away leaves a
flag, not a second jump.

**D3.3 — the naming, and PR #73. OVERRULED, in the specific.** Round one
recommended letting #73 land first and renaming only afterwards. That is void:
#73 is being **closed**, not merged — its rename was overruled and its markdown
work was superseded by #79. There is no competing rename, so the title rename
happens here.

The surface is **Mission Control**. The applet stays **Dashboard**. "Chief of
staff" is the *role* the assistant plays, not a name to erase; **muxterm** is
the product name. Round one observed that "Dashboard" meant three different
things and that renaming the surface would fix one and make the other two more
visibly wrong. All three are fixed:

| Was | Now | Where |
|---|---|---|
| `<h1>Dashboard</h1>` — the surface | `<h1>Mission Control</h1>` | `mux-cos.ts` topbar |
| `Dashboard` — the narrow-mode title | `Mission Control` | `title-bar.ts` |
| "the **Dashboard** splits it, routes it" — *the assistant* | "your **chief of staff** splits it, routes it" | `mux-cos.ts` zero state, and the confirm copy |

**Destructive actions across machines. SETTLED, and separate from the rail
rule.** Closing does not cross a machine boundary. An applet that grows
machine-awareness **may read across machines and must never destroy across
one.** This is a stronger constraint than D3.9 and it survives even where D3.9
would permit the control: a delete button in an applet's *body*, next to the
thing it deletes, is still forbidden when the thing lives on another machine.

### D3.2 — where the Dashboard's `cards | tiles` preference lives. **ADOPTED.**

Namespaced to `muxterm.applet.dashboard.view`, with the one-time migration round
one described: read the new key; if absent, read `muxterm.dashboard.fleetView`,
write it forward, and remove the old one.

*Why adopt:* the cost is five lines today and an argument later. The moment a
second applet wants a preference, the flat spelling is already a convention and
every key after it inherits the ambiguity. Files and Pull Requests each landed
with preferences in this same round — the window round one was worried about was
about ten minutes wide.

### D3.4 — cross-applet navigation. **ADOPTED.**

Yes, an applet may pull the surface to another applet — **only in direct
response to a user gesture, never on a data change.** `applet-navigate` and the
host's public `show()` are the "the user asked" arm of the attention policy, and
they switch immediately and unconditionally.

*Why adopt:* it is the same rule as D3.1 with the same justification, and having
one rule instead of two is worth more than any refinement either could get
separately. The gate is that the event has exactly one legitimate producer — a
click handler.

### D3.5 — does a dismissed PR come back? **ADOPTED.**

Never, automatically. Not on a state change, not on a re-scan, not when checks
fail. A dismissal that undoes itself is not a dismissal.

Dismissal is **muxterm state and never GitHub state**, and the dismissed panel
says so in those words. The set is keyed `owner/repo#number` and nothing is ever
pruned from it. If people turn out to miss things, the answer is an explicit
per-row "tell me if this changes", not a global rule that surprises everyone.

### D3.6 — what the Files applet is rooted at. **SETTLED: a picker, and the root is machine-scoped.**

Round one called this genuinely unsettled and recommended "the active pane's cwd,
with a picker across known workspaces". **Half adopted, half overruled.**

*Adopted:* it is a picker. With eleven worktrees on this machine a single root is
wrong within a day, exactly as round one predicted.

*Overruled:* not the active pane's cwd. Pane-scoping the root would make the
Files tab mean something different every time focus moved, which is the failure
D3.10 exists to prevent — and it would need pane-cwd plumbing that does not
exist. The candidates are instead the **distinct `project` paths of the live
fleet**, which the browser already holds, plus the server's own working
directory as the fallback. Chosen root and current path persist under
`muxterm.applet.files.path`.

**Should Files be machine-aware? Yes — and the decision is recorded now even
though the capability is not built.** Since round one, #90 landed
machine-scoped MCP tools: every tool takes a `machine`, `list_machines`
enumerates what is reachable, and a remote machine's workspaces are enumerable
from here. So a root's real identity is **`(machine, path)`, not `path`** — two
worktrees on two machines can share a path and are not the same place.

What that costs today is one field. `FilesRoot` carries `machine`, empty
meaning this one, and the candidate list **filters out sessions that arrived
from a remote host** — because `/api/files` can read this machine and no other,
and offering a root we cannot open would be a lie told in a dropdown.

**Remote file reads are a FOLLOW-ON, not a dependency.** The branch
`feat/remote-read-only-fs` (PR #92) is unmerged and this work does not wait for
it. When it lands, the change here is: stop filtering remote sessions out, and
pass `machine` through to the endpoint. No row shape changes.

### D3.7 — narrow and mobile. **SETTLED as scope, deferred as design.**

Today `:host([narrow])` hides `.dash` entirely and the fleet moves to a bottom
sheet. That behaviour is **preserved exactly**: in portrait the sheet renders
`<applet-dashboard insheet>` — the same applet, the same code, not a second
copy of the fleet — and `toggleFleet()`, the `fleet-state` event and the
title-bar button all still work.

**What is settled:** in portrait the host is inert. Every applet is `active =
false`, so the contract's one rule holds for free on a phone, and the sheet's
Dashboard is the only live applet. The narrow title reads Mission Control.

**What remains, named:** the sheet carries the Dashboard *only*. Three tabs plus
a rail will not fit a 360px sheet, and round one's recommendation — the sheet
gets the tab strip, the rail collapses into a `⋯` menu — is still the right
sketch and still unbuilt. **Files and Pull Requests are unreachable in portrait.**
That is the honest state; it is not a regression, because they did not exist
before.

### D3.8 — empty and error states. **ADOPTED.**

The host provides one standard presentation, exported as `appletEmpty(message)`,
`appletError(message, retry?)` and `appletStateStyles`. All three applets use
them, so three applets do not invent three idioms for the same sentence.

Two refinements the applets earned in the building:

- **A first-load line is not an empty state.** A blank panel while a git-backed
  listing takes a second reads as broken, so each applet shows a dim `Reading…`
  on first load only. It is not `appletEmpty`; it is not a state, it is a wait.
- **A failed refresh with good data on screen does not blank the screen.** One
  network blip must not erase a list you were reading. `appletError` is for
  when there is nothing to show; a dim note under the list is for when there is.

### D3.9 — destructive actions in the rail. **ADOPTED, forbidden.**

The rail sits in shared chrome; a control that destroys something belongs in the
applet body next to the thing it destroys. The Pull Requests applet is the test
case and it obeys: **dismiss is a button in the row**, and the rail carries only
`dismissed (N)`, which reveals and never destroys.

The contract carries the prohibition as prose, not as a type. Making it
mechanical would mean the host classifying arbitrary lit-html, which is more
machinery than three built-ins in one repo can justify — and the rail's real
guard is already structural: an applet can only use controls the host has styles
for, so a destructive control would have to be added to the host first.

### D3.10 — is the surface pane-scoped? **ADOPTED, with the machine axis named.**

Applets are **surface-scoped by default; any pane-scoping is opt-in per applet**,
and none of the three opt in. Switching panes must not silently change what
three tabs mean.

**Machine scope is a separate axis from pane scope, and they compose
independently.** Pane scope asks *which pane is this about*; machine scope asks
*which machine's filesystem, fleet or repos am I looking at*. An applet may be
surface-scoped and still machine-aware — Files is exactly that: it ignores pane
focus entirely, and its root carries a machine. Conflating them would mean
picking a machine by clicking a pane, which is a worse version of the problem
D3.10 already rejected.

## What this round did *not* settle

- **A durable pull-request watchlist.** The applet ships against a real source
  that is not the watchlist. See C4 below.
- **The narrow-mode tab strip.** D3.7.
- **Third-party applets.** Still out of scope and still not designed for; the
  registry is a module array, exactly as round one left it.

## C1–C4 — what was built

**C1 — the applet host.** `<mux-applets>`: a tab strip, a control rail at its
right end, and a body that mounts **every** registered applet and hides all but
one. Inactive applets stay mounted so navigation and scroll survive a tab
switch, which is precisely why the rule has to have teeth.

*Measured, not asserted:* with Pull Requests active, its 60s poll fired — 1
request at T0, 3 by T+75s. Switching to another tab froze it: **3 requests at
T+75s, still 3 after 140 further seconds inactive**, more than two poll
intervals with nothing on the wire. The Files applet, mounted for the entire
session but never activated, issued **zero** requests. No applet opens a socket;
the only WebSocket is the app's own, which predates all of this.

**C2 — the Dashboard applet.** The fleet, moved in whole. It adds no capability,
which is the point: if it works identically inside the host, the host is real.
It owns `cards | tiles` — the toggle is gone from the surface chrome and there is
exactly one of it, in the applet's rail.

The contract's rule, for a store subscription rather than a poll: the Dashboard
holds `homeSessions` and, while inactive, its entire response to a fleet change
is one integer comparison — no re-render, no DOM, no fetch, no timer. **This is
the file's one exception and it is documented as one**: a subscription to a
store that already exists opens nothing, polls nothing and paints nothing, and
without it the surface cannot tell you a lane went blocked while you were
reading a diff — which is the whole point of the flag. A flag you only get when
you look is not a flag.

**C3 — the Files applet.** Real directories, real files, real `git status`, via
`GET /api/files`. Changed entries carry git's own letter — `M A D ? R U` — in a
fixed-width leading column *and* a colour, so the distinction survives a
grayscale screenshot and a light palette. Unchanged rows get a blank of the same
width so the column cannot jitter as a worktree goes dirty under you. A
directory shows `M` when anything beneath it changed.

No poll: becoming active *is* the refresh. A directory listing that refreshes
itself while you are not looking is cost with no benefit.

**C4 — the Pull Requests applet.** Shipped against **a real source that is not
the watchlist**, which is the middle of the three acceptable outcomes, chosen
deliberately.

The source is `GET /api/prs`, which asks the host's already-authenticated `gh`
over the repos of every root the browser knows: the live fleet's local project
paths, **union everything it has ever seen** (`muxterm.applet.prs.roots`, MRU
capped at 12), falling back to the server's own working directory when it knows
none. The remembering is the load-bearing part — a lane that exits takes its row
out of the fleet at exactly the moment you want to know what it opened.

**What this is not, stated plainly.** It is not attribution: no GitHub API can
say *which lane opened this PR*, and this applet does not claim to. It is not
durable: a browser-local memory dies with the profile. The durable answer is
round one's D2 in full — a watchlist owned by sessiond, fed by
`muxterm session report --pr N` (**which still nothing calls**) plus a repo scan,
with dismissals in a separate store so a re-scan cannot resurrect them. That is
the follow-on, and it is named rather than half-built.

`SessionState.PR` is still the right attribution hint and is still dead for want
of a producer. This round did not add one; it is a small contained change —
after `gh pr create` succeeds, report the number — and it belongs with the
watchlist that consumes it.

## Two endpoints, and the authority they do not add

`GET /api/files` and `GET /api/prs` are read-only, wrapped in `protect()` like
every other `/api` route, and **add no authority over `/ws`** — the same auth
boundary already hands out a PTY, and a shell can `cat` any file the listing can
name. So the guard on the path is correctness (absolute, cleaned, a directory)
rather than a jail, and it is deliberately not a jail. Inventing a chroot here
would buy nothing while implying a boundary that the adjacent WebSocket does not
honour.

`/api/prs` degrades rather than fails: a missing or logged-out `gh` is a `200`
carrying `available:false` and a sentence a person can act on. Showing "no pull
requests" when the truth is "I could not ask" would be confidently wrong.
