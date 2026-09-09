# muxterm in the car — Android Auto UI rationale

A draft to design against, not a specification. The drawn version lives in
`docs/design/android-auto-draft/index.html`; regenerate it with
`python3 docs/design/android-auto-draft/build.py`.

**Scope.** The app shows two things and nothing else: **NEEDS MY INPUT** (sessions in state
`blocked`, with `waiting_for`) and **ONGOING** (sessions in state `working`, with `doing`).
`done`, `failed` and `stopped` never appear. There are no terminals, no drill-down, no
navigation stack — one screen. Everything the user wants to *do*, they do by talking to the
chief of staff, so the screen is a glance surface with a voice control on it.

---

## The constraint that shapes everything

An Android Auto app does not draw. It hands the head unit a *template* — a structured object —
and the head unit renders it in its own styling. Fonts, type sizes, layout, row height, padding,
all chrome and background colour, day/night switching, and how much text survives while driving
are the host's, and they differ between a phone-projected Android Auto session and a built-in
Automotive OS car.

| Ours (the app) | Not ours (the host, and it varies by car) |
|---|---|
| Which template; how many sections and their header text; row titles; row secondary text; which icons; up to two accent colours *offered*; what the controls do. | Fonts and sizes; layout, row height, padding; all background and chrome colour; day/night switching; how many rows are actually shown; further truncation while driving; whether our accent colour is used at all. |

The consequence that matters: **status cannot be carried by colour.** Not "should not" — cannot,
reliably. The host picks the light or dark variant of every colour itself to hold its own contrast
ratio ([`CarColor`](https://developer.android.com/reference/androidx/car/app/model/CarColor): "The
host chooses the dark or light variant … to ensure the proper contrast ratio is maintained"), the
app is only *notified* of the switch (`CarContext.isDarkMode()`,
`Session.onCarConfigurationChanged()`), an app may declare only two custom colours — primary and
secondary, each requiring **both** a light and a dark variant, via the `androidx.car.app.theme`
manifest metadata — and even then "the host may use a default color instead if the colors do not
pass the contrast requirements"
([set-up-project](https://developer.android.com/training/cars/apps/library/set-up-project)).
Inside a row, the app may colour only the **secondary** line: `Row.Builder.addText` honours a
`ForegroundCarColorSpan`, while `setTitle` accepts only `DistanceSpan` and `DurationSpan` and
ignores every other span.

So status is carried by **words** and by **position**. NEEDS MY INPUT is a literal heading at the
literal top, and the voice control says `LISTENING` in letters rather than turning red.

---

## Template: `ListTemplate` with two `SectionedItemList`s

It is the only general-purpose template that gives two labelled groups of rows on one screen with
no navigation — exactly the shape of the requirement.
[`ListTemplate.Builder.addSectionedList()`](https://developer.android.com/reference/androidx/car/app/model/ListTemplate.Builder)
has existed since Car App Library 1.0.0: "Use this method to add multiple lists to the template.
Each `SectionedItemList` will be grouped under its header." It throws `IllegalArgumentException`
if the list is empty or the header is empty. (Worth knowing: a *selectable* sectioned list cannot
be combined with other sectioned lists.)

| Rejected | What it would have cost |
|---|---|
| `PaneTemplate` | Default content limit 4 rows against the list's 6, and pane rows cannot be clicked — `ROW_CONSTRAINTS_PANE` sets `setOnClickListenerAllowed(false)`, so there is no tap target for voice in the body. |
| `GridTemplate` | A grid item is an image plus a short label. Our payload is a sentence per lane ("Run `brew upgrade muxterm` on the Mac, then say go"). |
| `MessageTemplate` | One message, up to 2 actions. It could say "3 working, 1 blocked" and lose *which* lane and *what* it wants — the entire content. |
| `TabTemplate` | Puts blocked behind a tap, which is the thing the screen exists to avoid. It also replaces the header, removing the action strip. |
| `SectionedItemTemplate` | The better fit on paper (richer section headers, supports Banners) but newer, raising the minimum host API for no capability this screen needs. Revisit if a banner is ever wanted. |
| Anything map-based | Gated behind the NAVIGATION / POI / WEATHER categories, and puts a map on screen we have no use for. |

---

## Row and text limits

**Rows: ask, don't assume.**
`ConstraintManager.getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_LIST)` is a runtime
number ([constraints-api](https://developer.android.com/training/cars/apps/library/constraints-api):
"The host sets these limits, which can't be modified by client apps"). The library's compiled-in
fallback, used only when the host cannot be reached, is **6** —
`<integer name="content_limit_list">6</integer>` in `car/app/app/src/main/res/values/integers.xml`.
6 is a floor, not a cap; hosts may allow more. **Design for 6, render what the host reports.**
(`ConstraintManager` itself is `@RequiresCarApi(2)`.)

**Text: 2 lines of secondary text per row.** `ROW_CONSTRAINTS_FULL_LIST` inherits
`setMaxTextLinesPerRow(2)` from `ROW_CONSTRAINTS_SIMPLE` ("Maximum 2 lines of text below the
title"). Two details that change the design:

- **One `addText` call, not two.**
  [`Row.Builder.addText`](https://developer.android.com/reference/androidx/car/app/model/Row.Builder):
  "Each string added with this method will not wrap more than 1 line in the UI, with one exception:
  if the template allows a maximum number of text strings larger than 1, and the app adds a single
  text string, then this string will wrap up to the maximum." One call gets more words on screen.
- **Put the volatile part first.** The host truncates while driving regardless of what was sent —
  "the full text will be visible only when parked"
  ([Row design](https://developer.android.com/design/ui/cars/guides/components/row)).

---

## The overflow rule

Budget = the host's list limit (6 in the draft). Two sections compete for it.

1. **Blocked wins.** The blocked section may take up to *budget − 1* rows. It is why you looked.
2. **Working always keeps at least one row** whenever anything is working — a named lane if there
   is room for one, otherwise the counting row. "Work is happening" never becomes invisible.
3. **A section that overflows spends its last slot on a counting row**: fixed title `More waiting` /
   `More running`, secondary text `+3 more need input`. Fixed titles are deliberate — see the
   refresh rule below.
4. **An empty section is not rendered at all** — not a heading with nothing under it. The API
   enforces this anyway (`addSectionedList` throws on an empty list), and an empty heading reads as
   a fault. With nothing running at all, there are no headings: one plain sentence.
5. **No scrolling is designed for.** A driver will not scroll and the host may stop them.

Worked example, 4 blocked + 7 working against 6 rows: all four blocked rows survive intact, working
is cut to one named lane plus `+6 more working`. That asymmetry is the rule, not an accident.

**Truncation** (`shorten()` in `build.py`), applied to `waiting_for` and `doing`:

1. Collapse all whitespace to single spaces — a `doing` string may contain newlines.
2. Reduce paths to their basename:
   `/home/ken/workspace/muxterm-voice-exit/internal/voice/tools.go` → `tools.go`. The basename is
   the part a driver can use.
3. Cut at a word boundary at **60 characters** and append one ellipsis; a single unbroken token over
   that length is hard-cut rather than gutted. With a ~30-character title that stays inside the
   design guidance's 120-character glance budget.

---

## The trap: the template quota

An app may push only **5 templates per task**, and
"[if the template quota is exhausted and the app attempts to send a new template, the host displays
an error message to the user before closing the app](https://developer.android.com/training/cars/apps/library/template-restrictions)".
Worse for this app specifically: the last template in a task must be one of
`NavigationTemplate`, `PaneTemplate`, `MessageTemplate`, `MediaPlaybackTemplate`, `SignInTemplate`,
`LongMessageTemplate` — **`ListTemplate` is not among them.** A one-screen list app cannot spend its
fifth step on the screen it exists to show.

The escape is the refresh rule. From the `ListTemplate` class javadoc, a new template of the same
type is a free refresh if the previous template was loading, **or** if:

> The template title has not changed, and the `ItemList` structure between the templates have not
> changed. This means that if the previous template has multiple `ItemList` sections, the new
> template must have the same number of sections with the same headers. Further, the number of rows
> and the title (not counting spans) of each row must not have changed.

So under this design a lane starting, finishing, or moving from ONGOING to NEEDS MY INPUT changes
the row count and the row titles, and **costs a step**. Only secondary text is free.
`ConstraintManager.isAppDrivenRefreshEnabled()` (`@RequiresCarApi(6)`) lifts this — "This enables
applications to refresh lists content without being counted towards a step" — and is very likely
true on current hosts, but it is queryable at runtime and returns `false` when the host call fails.
**The fallback has to be designed, not assumed.** It is decision 2 below.

---

## Voice state

Voice is the interaction; the screen is a glance surface. So live-or-not must be unmistakable and
starting/stopping must be one tap. Three placements exist, and **A and C are mutually exclusive** —
"[Don't include both an action strip and a floating action button at the same time](https://developer.android.com/design/ui/cars/guides/components/action-strip)".

- **A — action-strip button.** The only control here that may carry a *word*: an action strip allows
  up to 2 actions "of which one … can contain a title", so the button can read `TALK` / `LISTENING`
  with no reliance on colour. Costs no row; costs a template step to change; and
  `ListTemplate.Builder.setActionStrip()` is deprecated as of 1.7.0 in favour of
  `Header.Builder.addEndHeaderAction()`.
- **B — a pinned voice row.** Title stays the fixed word `Voice`; state lives in the secondary text
  (`LIVE — say "that's all" to end`). Because the title never changes, this is the **only** option
  whose state changes are free under the refresh rule. Costs one of the six rows.
- **C — floating action button.** `ACTIONS_CONSTRAINTS_FAB` sets `setRequireActionIcons(true)` and
  `setRequireActionBackgroundColor(true)`, and permits zero custom titles: it is icon-only, must
  carry a background colour, and can say nothing. Biggest target, worst at stating its state.
  Also `@RequiresCarApi(6)`.

The draft leans **B**, on the grounds that a free state change beats a prettier one. All three are
drawn so the choice can be made on sight.

---

## Decisions for you — six, each between named options

1. **Voice control placement** — **(A)** action-strip button, the only one that can say `LISTENING`,
   costs no row, costs a step to change · **(B)** pinned voice row, state changes free, costs one of
   six rows · **(C)** FAB, biggest target, icon-only, cannot say anything. A and C cannot coexist.
   *Draft leans B.*
2. **Refresh fallback when `isAppDrivenRefreshEnabled()` is false** — **(i)** trust it anyway and
   accept that an old host closes the app · **(ii)** fixed slots: always render exactly six rows with
   frozen titles (`Lane 1`…`Lane 6`) and put the lane label in the secondary text, so nothing ever
   costs a step · **(iii)** rate-limit structural redraws to once every N seconds and let secondary
   text carry everything between. *(ii) is ugly and bulletproof; this is the decision with the most
   engineering consequence.*
3. **Row order inside a section** — **longest-waiting first** (the lane you have kept waiting) ·
   **most-recently-changed first** (the lane that just spoke) · **stable by lane creation order**
   (rows never move under your eye, which matters at 70mph).
4. **What a row title is** — **the lane label** (`mac remote`) · **the workspace name** · **the
   project directory**. Labels are auto-generated today and some are poor; if the title is the label,
   the labels have to be good enough to read at a glance.
5. **What a tap on a row does** — **nothing**, rows are inert and everything happens by voice ·
   **starts voice with that lane as the subject** ("about mac remote…") · **speaks the row aloud**.
   The design guidance discourages information-only rows, which argues against "nothing".
6. **What this is for** — **personal, DHU plus your own phone, never published**, in which case the
   app-category problem does not matter · **an internal test track**, in which case it must declare
   one of exactly seven categories (`NAVIGATION`, `POI`, `IOT`, `WEATHER`, `MEDIA`, `MESSAGING`,
   `CALLING`) and a fleet dashboard is none of them.

### One honesty note about shipping

Android Auto's "unknown sources" developer toggle "[doesn't apply to apps built using the Android
for Cars App Library](https://developer.android.com/training/cars/testing)". To run in a real
vehicle a templated app must be installed from a trusted source; the Desktop Head Unit is the honest
demo path, Internal App Sharing or an internal test track the honest device path. This does not
block a personal build. It does block publishing, and it is better known now than after the UI is
finished.
