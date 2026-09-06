# Remote sessiond — UX

Companion to `2026-09-05-remote-sessiond-design.md`, which covers the transport.
Interactive wireframes: `docs/designs/wireframes/remote-sessiond-wireframes.html`
(six screens, tab-switchable, tokens lifted from `theme.ts`).

## Outcome

Workspaces on other machines appear in the sidebar as their own collapsible groups, and
sessions on other machines appear in Home without disturbing the grouping that makes Home
useful. A user with no remotes sees a screen identical to today's.

## Scope and Non-goals

In scope: the wide-breakpoint sidebar (`mux-sidebar.ts`), the Home view (`mux-home.ts`), a
Remotes section in `mux-settings-surface.ts`, a connect dialog, and the disconnected states
for all of them.

Not in scope: the narrow breakpoint (`<768px`, where `mux-title-bar` replaces the sidebar
entirely and host grouping has no obvious home yet), tiles view for remote sessions, and any
tunnels UI.

## Decisions

### D1. Machine is a property, not a group — everywhere except the sidebar

The sidebar answers *where is my stuff*. That question is spatial, so it groups by host.

Home answers *what needs me right now*. Grouping that by machine means scanning five groups
to find two things, which destroys the feature. Home therefore keeps its existing
`Needs input / Running / Completed` grouping (`session-state.ts:160-164`) and machine becomes
a badge.

This is not a new principle. `SessionState.pr` is already documented in the source as "a PR
number — a property, not a group." Host gets the same treatment for the same reason.

### D2. Mark the exception, not the norm

Local is unmarked. No `vela0` badge on local sessions, no `LOCAL` tag on the local fleet
chip, no "this machine ·" prefix on the local group header. Only remote is tinted.

Consequence, and the point: **a user with zero remotes sees today's UI.** The feature costs
nothing until it is used.

### D3. One new token

```css
--remote: var(--chrome-driver-accent);   /* #bb9af7 — "this is elsewhere" */
```

That is the entire palette addition. It reuses the role `.badge.autonomous` already plays:
*this one is different*. Connection state reuses the existing vocabulary exactly —
`--mux-ok` connected, `--mux-warn` reconnecting, `--mux-error` unreachable,
`--chrome-text-dim` never-connected.

### D4. Two new components

`.hg-head` — a collapsible host group header: chevron, status dot, name, optional needs
pill. `.fleetstrip` — a row of per-host chips at the top of Home, click to filter.

Everything else reuses what exists: `.sb-heading` was built to introduce a second section,
`.badge` geometry, the `filter: saturate(.25) opacity(.55)` ghosting already applied to idle
preview cards, and `muxterm deploy <host>` behind "Install & connect."

### D5. The start card becomes fleet-wide, and degrades honestly

`✽ NEEDS INPUT · 3` must count across all connected hosts or it under-reports the moment a
machine is connected. It gains a per-host split beneath the number.

When a host drops, the split shows `?` for that host rather than dropping its contribution to
zero. **Zero is a claim you cannot make about a host you cannot see.** This is the one place
where an extra line of UI is load-bearing rather than decorative.

### D6. Group summary pills show only while collapsed

`.hg-head:not(.collapsed) .hg-needs { display: none }`. Expanded, the workspace cards carry
their own pills; the header summary would be saying it twice.

### D7. Discovery sections are per-transport; the rest of the UI is not

SSH is one transport. Amplifier Sandboxes is the next (see `…-design.md` D2/D2b), and its
discovery is a REST list, not a config file.

Only **one** part of the UI knows this: the settings pane renders one section per transport
that reports candidates — `From ~/.ssh/config`, `Sandboxes`, and so on — plus a manual-entry
field that always exists. Everything else — group headers, badges, fleet chips, drop states —
takes a `HostRef` and does not know or care how the stream is obtained.

Two consequences worth naming, both from Sandboxes:

- **Display name is not identity.** SSH aliases happen to be both; sandbox ids are
  server-assigned UUIDs whose human names are mutable labels. The UI shows the label and
  keys on the id.
- **Never-connected candidates may cost money to start.** An ssh host is either up or not;
  a suspended sandbox resumes on contact. "Connect" is a heavier verb for some transports
  than others, which is an argument for open question 3 resolving toward *settings only*.

### D8. Disconnection is a state, not an error

- Panes keep running — sessiond owns the PTYs on that host.
- Workspaces **ghost, never vanish**: dashed border, desaturated canvas. Removing them would
  imply they died.
- The pane goes **read-only** rather than explaining that input will be discarded. Behavior
  instead of copy.
- A `dropbar` appears under the tab strip *only* in this state, carrying a countdown and a
  retry button — the two things a user can act on.

## The YAGNI pass

A first draft carried explanation inside the interface. It was cut. Recording what went and
why, because the same instincts will regrow:

| Cut | Why |
|---|---|
| Connected-host status rail under the tabs | The tab pin already names the host. The rail now appears *only* on drop. |
| `rtt` · uptime · remote version · pane totals | Telemetry nobody acts on. |
| "Panes on a disconnected host keep running…" | The ghosted card *is* the explanation. |
| "Anything ssh can reach, muxterm can reach…" | Marketing copy in a settings pane. |
| "Parsed from ~/.ssh/config, following Include…" | The section is titled `From ~/.ssh/config`. |
| Behavior section — 3 toggles, 3 sublines | Reconnecting is just what it does. Add a toggle when someone asks. |
| Toggle sublines ("Exponential backoff, 1s → 30s") | Guarded subtitles. The label was the whole story. |
| `not connected`, `LOCAL`, `OFF`, `muxterm found` | The dot colour and the button verb already say it. |
| Lede subtitle "2 machines connected · 1 reconnecting" | The fleet strip is directly below it. |
| "3 hosts" header badge; footer host/pane counts | The list underneath is the count. |
| "Show diff" button | Approve / Deny / Open. Three is the budget. |
| "input is queued locally and discarded on reattach" | Became behaviour: the pane goes read-only. |
| Probe steps: protocol check, latency, binary path | Invisible successes. Three lines, not five. |
| "Add machine" chip in Home | Two entry points is enough — sidebar and settings. |

The rule that produced all of it: **explanation does not belong inside the UI being
explained.** If a control needs a subtitle to be understood, the control is wrong.

## Components and Boundaries

| Component | Change |
|---|---|
| `mux-sidebar.ts` | `.hg-head` groups; remote cards tinted; "+ Connect machine" |
| `mux-start-card.ts` | per-host split; `?` for unreachable hosts |
| `mux-home.ts` | `.fleetstrip`; host badge on cards and rows; stale row treatment |
| `mux-settings-surface.ts` | fourth nav item + `_renderRemotes()` |
| `mux-connect-dialog.ts` | **new** — ssh-config picker, probe trace |
| `mux-dock.ts` | host pin on remote tabs; `dropbar` |
| `theme.ts` | `--remote` |

## Failure Handling

| State | Sidebar | Home | Tab |
|---|---|---|---|
| connected | green dot | green chip | purple pin |
| reconnecting | amber dot, `reconnecting`, ghosted cards + banner | dashed amber chip | amber `⟳` pin, dropbar |
| unreachable | red dot in settings only | dashed chip | — |
| never connected | hollow dot, collapsed, no label | dimmed chip | — |

## Verification

Per AGENTS.md, real browser only.

1. Zero remotes configured — confirm the sidebar and Home are pixel-identical to `main`.
2. One remote connected — group appears, cards render, previews stream.
3. Collapse/expand — confirm the needs pill appears and disappears per D6.
4. Kill the link — cards ghost, start card shows `?`, pane refuses input, dropbar counts down.
5. Reattach — clean screen, no garbage, settle barrier satisfied.
6. Fresh workspace per run.

## Assumptions and Risks

- **Assumes few hosts.** Preview cards are 104 px tall; at ten connected hosts the sidebar is
  a scroll marathon. Collapsed-by-default for remotes mitigates it; a real fleet would need
  a different affordance.
- **The fleet strip is the least certain element.** The sidebar already shows per-host needs
  counts. It may not earn its space.
- **Host pins consume tab width.** At the 180 px `--mux-tab-max-width` a pin eats ~55 px of
  the name.
- **`instanceLabel()` already shows the local hostname** in the sidebar header
  (`instance-identity.ts:76-79`), so the local group header repeats it. Accepted for
  symmetry; the alternative is an asymmetric first section.
- **"Reconnecting" is styled as a mild alarm, which is right for SSH and wrong for
  Sandboxes.** Amplifier Sandboxes auto-suspend by design and resume on contact, so a
  reconnect there is routine rather than a fault. Deliberately not designing a separate
  `suspended` state yet — one visual state until a second transport actually exists — but
  the amber treatment is the first thing that will need revisiting when it does.

## Open questions

1. **Host pins on tabs** — every remote tab, or only when more than one host has tabs open?
2. **Fleet strip** — keep, or is the sidebar enough?
3. **Never-connected ssh-config hosts in the sidebar** — show them there at all, or only in
   settings until the first successful connect?

## Shared Seams

- `2026-09-02-sidebar-live-preview-design.md` — the preview card and its ghosting filter,
  which D8 reuses for the disconnected state.
- `2026-06-12-sidebar-and-tunnels-design.md` — the second sidebar section that never shipped.
- `2026-07-01-native-companion-apps-ux-design.md` — its "Reaching host → SSH auth →
  Attaching" progress trail is the ancestor of the connect dialog's probe trace.
