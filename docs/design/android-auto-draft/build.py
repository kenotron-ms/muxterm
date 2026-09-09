#!/usr/bin/env python3
"""Generate the Android Auto draft UI page.

This is a DRAFT to design against, not a final design. Every car screen below is
drawn inside the limits the Car App Library actually imposes -- see
docs/design/android-auto-ui.md for the citations.

Run:  python3 build.py     ->  writes index.html next to this file
"""

from __future__ import annotations

import html
import pathlib
import re

OUT = pathlib.Path(__file__).with_name("index.html")

# --------------------------------------------------------------------------
# The one number everything hangs off. ConstraintManager.getContentLimit(
# CONTENT_LIMIT_TYPE_LIST) is queried at runtime; 6 is the library's compiled-in
# fallback (car/app/app/src/main/res/values/integers.xml). Hosts may allow more.
# --------------------------------------------------------------------------
ROW_LIMIT = 6

# Secondary-text budget. The design guidance caps glanceable text at
# "1-3 lines and 120 characters"; a row title eats ~30 of that.
SECONDARY_MAX_CHARS = 60


# --------------------------------------------------------------------------
# Truncation rule (D3). Decided, not deferred.
# --------------------------------------------------------------------------
def shorten(text: str, limit: int = SECONDARY_MAX_CHARS) -> str:
    """Collapse to one glanceable line.

    1. collapse all whitespace (a `doing` string may contain newlines)
    2. reduce absolute paths to their basename -- "/home/ken/workspace/x/main.go"
       reads as "main.go", which is the part a driver can actually use
    3. cut at a word boundary at `limit` chars and append a single ellipsis
    """
    t = re.sub(r"\s+", " ", text).strip()
    t = re.sub(r"(?<![\w.])(?:~|/)[\w./+-]{4,}", lambda m: m.group(0).rstrip("/").rsplit("/", 1)[-1], t)
    if len(t) <= limit:
        return t
    cut = t[:limit].rsplit(" ", 1)[0]
    if len(cut) < limit * 0.6:  # one very long token; hard cut rather than gut it
        cut = t[:limit]
    return cut + "\u2026"


# --------------------------------------------------------------------------
# Overflow rule (D3). Blocked wins space over working.
# --------------------------------------------------------------------------
def allocate(blocked: list, working: list, budget: int) -> dict:
    """Split `budget` rows between the two sections.

    - blocked may take up to budget-1 rows, so working always keeps at least one
      row whenever any lane is working
    - a section that overflows spends its LAST slot on a fixed-title overflow row
    - a section with nothing in it is not rendered at all (an empty
      SectionedItemList throws IllegalArgumentException)
    """
    if not blocked and not working:
        return {"blocked": [], "working": [], "blocked_more": 0, "working_more": 0}

    if not working:
        b_budget, w_budget = budget, 0
    elif not blocked:
        b_budget, w_budget = 0, budget
    else:
        b_budget = min(len(blocked), budget - 1)
        w_budget = budget - b_budget

    b_shown, b_more = fit(blocked, b_budget)
    w_shown, w_more = fit(working, w_budget)
    return {
        "blocked": b_shown,
        "working": w_shown,
        "blocked_more": b_more,
        "working_more": w_more,
    }


def fit(items: list, budget: int) -> tuple[list, int]:
    if budget <= 0:
        return [], len(items)
    if len(items) <= budget:
        return items, 0
    return items[: budget - 1], len(items) - (budget - 1)


# --------------------------------------------------------------------------
# Sample fleets. Shapes taken from real muxterm fleet_status output:
# label / state / waiting_for / doing.
# --------------------------------------------------------------------------
def lane(label, doing="", waiting_for=""):
    return {"label": label, "doing": doing, "waiting_for": waiting_for}


FLEETS = {
    "common": {
        "blocked": [],
        "working": [
            lane("applets release", doing="Running the release checklist"),
            lane("voice session", doing="Editing /home/ken/workspace/muxterm-voice-exit/internal/voice/tools.go"),
            lane("android icons", doing="Generating mipmap densities"),
        ],
    },
    "one-blocked": {
        "blocked": [
            lane("mac remote", waiting_for="Run `brew upgrade muxterm` on the Mac, then say go"),
        ],
        "working": [
            lane("applets release", doing="Running the release checklist"),
            lane("voice session", doing="Editing /home/ken/workspace/muxterm-voice-exit/internal/voice/tools.go"),
            lane("android icons", doing="Generating mipmap densities"),
        ],
    },
    "overflow": {
        "blocked": [
            lane("mac remote", waiting_for="Run `brew upgrade muxterm` on the Mac, then say go"),
            lane("applet controls", waiting_for="Approve the destructive migration"),
            lane("lane death", waiting_for="Which branch should this land on?"),
            lane("sidebar groups", waiting_for="Confirm the schema rename"),
        ],
        "working": [
            lane("applets release", doing="Running the release checklist"),
            lane("voice session", doing="Editing internal/voice/tools.go"),
            lane("android icons", doing="Generating mipmap densities"),
            lane("car ui draft", doing="Serving the draft on 8480"),
            lane("remote read", doing="Running go test ./internal/sessiond/..."),
            lane("publish folder", doing="Waiting on CI"),
            lane("mission control", doing="Rebasing onto main"),
        ],
    },
    "empty": {"blocked": [], "working": []},
}


# --------------------------------------------------------------------------
# Car screen rendering.
#
# Everything drawn here is the HOST's rendering, redrawn approximately. The app
# supplies text and a handful of icons and nothing else. Regions are tagged
# app / host so the overlay can label them.
# --------------------------------------------------------------------------
def e(s):
    return html.escape(s, quote=True)


def row_html(title, secondary, *, ctl_title="app", ctl_secondary="app", extra_class=""):
    return f"""
        <div class="ca-row {extra_class}">
          <div class="ca-row-title" data-ctl="{ctl_title}">{e(title)}</div>
          <div class="ca-row-sec" data-ctl="{ctl_secondary}">{e(secondary)}</div>
        </div>"""


def section_html(header, rows_html):
    return f"""
        <div class="ca-section-head" data-ctl="app">{e(header)}</div>{rows_html}"""


def screen(
    *,
    caption,
    note,
    fleet,
    voice_live=False,
    voice_style="actionstrip",  # actionstrip | voicerow | fab
    row_limit=ROW_LIMIT,
    empty_message=None,
):
    blocked = fleet["blocked"]
    working = fleet["working"]

    budget = row_limit
    body = ""
    voice_row = ""

    if voice_style == "voicerow":
        budget -= 1
        if voice_live:
            voice_row = row_html(
                "Voice",
                "LIVE \u2014 say \u201cthat\u2019s all\u201d to end",
                extra_class="ca-row-voice ca-row-voice-live",
            )
        else:
            voice_row = row_html(
                "Voice",
                "Off \u2014 tap to start talking",
                extra_class="ca-row-voice",
            )

    alloc = allocate(blocked, working, budget)

    if not blocked and not working:
        body = f"""
        <div class="ca-empty" data-ctl="app">{e(empty_message or "Nothing running.")}</div>"""
    else:
        if alloc["blocked"] or alloc["blocked_more"]:
            rows = "".join(
                row_html(l["label"], shorten(l["waiting_for"])) for l in alloc["blocked"]
            )
            if alloc["blocked_more"]:
                rows += row_html("More waiting", f"+{alloc['blocked_more']} more need input")
            body += section_html("NEEDS MY INPUT", rows)
        if alloc["working"] or alloc["working_more"]:
            rows = "".join(row_html(l["label"], shorten(l["doing"])) for l in alloc["working"])
            if alloc["working_more"]:
                rows += row_html("More running", f"+{alloc['working_more']} more working")
            body += section_html("ONGOING", rows)

    # Header: start header action is APP_ICON or BACK only. Title is one line.
    # Action strip: 2 actions max, only one may carry a text label.
    if voice_style == "actionstrip":
        label = "LISTENING" if voice_live else "TALK"
        strip = f"""
          <div class="ca-strip">
            <div class="ca-btn {'ca-btn-live' if voice_live else ''}" data-ctl="app-text-host-shape">
              <span class="ca-mic">{'\u25c9' if voice_live else '\u2b24'}</span>{e(label)}
            </div>
          </div>"""
    elif voice_style == "voicerow":
        strip = """
          <div class="ca-strip"></div>"""
    else:  # fab
        strip = """
          <div class="ca-strip"></div>"""

    fab = ""
    if voice_style == "fab":
        fab = f"""
        <div class="ca-fab {'ca-fab-live' if voice_live else ''}" data-ctl="app-icon-host-shape">{'\u25a0' if voice_live else '\u25cf'}</div>"""

    return f"""
    <figure class="screenwrap">
      <div class="carapp" data-ctl="host">
        <div class="ca-header" data-ctl="host">
          <div class="ca-appicon" data-ctl="app">m</div>
          <div class="ca-title" data-ctl="app">muxterm</div>
          {strip}
        </div>
        <div class="ca-body" data-ctl="host">{voice_row}{body}</div>
        {fab}
      </div>
      <figcaption><b>{e(caption)}</b> {note}</figcaption>
    </figure>"""


# --------------------------------------------------------------------------
# Page
# --------------------------------------------------------------------------
CSS = """
:root{
  --paper:#faf9f7; --ink:#16161a; --rule:#c9c7c1; --dim:#5c5a55;
  --flag:#8a3324;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--paper); color:var(--ink);
  font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 90px}
h1{font-size:26px;line-height:1.2;margin:0 0 6px;font-weight:650;letter-spacing:-.01em}
.sub{color:var(--dim);margin:0 0 22px;font-size:15px}
h2{font-size:19px;margin:44px 0 4px;font-weight:650;border-top:1px solid var(--rule);padding-top:16px}
h3{font-size:15px;margin:26px 0 4px;font-weight:650;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
p{margin:8px 0 12px;max-width:74ch}
ul{margin:8px 0 12px;padding-left:20px;max-width:74ch}
li{margin:3px 0}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
a{color:#1a4f8a}
.flag{color:var(--flag);font-weight:650}
table{border-collapse:collapse;width:100%;max-width:900px;margin:10px 0 16px;font-size:14px}
th,td{border-bottom:1px solid var(--rule);padding:7px 10px;text-align:left;vertical-align:top}
th{font-weight:650;background:#f0efeb}

/* controls */
.bar{
  position:sticky;top:0;z-index:50;background:var(--paper);
  border-bottom:1px solid var(--rule);padding:9px 0 9px;margin:0 0 4px;
  display:flex;gap:18px;flex-wrap:wrap;align-items:center;font-size:14px}
.bar label{display:inline-flex;gap:6px;align-items:center;cursor:pointer;user-select:none}
.bar .navlinks{margin-left:auto;display:flex;gap:14px;flex-wrap:wrap}
.bar .navlinks a{text-decoration:none;border-bottom:1px solid var(--rule)}

/* screen grid */
.grid{display:flex;flex-wrap:wrap;gap:26px;margin:14px 0 6px;align-items:flex-start}
.screenwrap{margin:0;width:420px;max-width:100%}
figcaption{font-size:13.5px;color:var(--dim);margin-top:7px;line-height:1.45}
figcaption b{color:var(--ink);font-weight:650}

/* ---- the car screen. 420x252 ~ a 800x480 head unit, scaled. ---- */
.carapp{
  width:100%;aspect-ratio:5/3;display:flex;flex-direction:column;position:relative;
  overflow:hidden;background:#eceff1;color:#11181c;
  font-family:Roboto,-apple-system,"Segoe UI",sans-serif;
  border:1px solid var(--rule);
}
body.night .carapp{background:#101418;color:#e6edf3;border-color:#33393f}
.ca-header{
  flex:0 0 17%;display:flex;align-items:center;gap:10px;padding:0 12px;
  background:#e2e6e9;border-bottom:1px solid #cdd3d7}
body.night .ca-header{background:#1a1f24;border-bottom-color:#2b3238}
.ca-appicon{
  width:22px;height:22px;flex:0 0 22px;background:#37474f;color:#fff;
  display:grid;place-items:center;font-size:13px;font-weight:700}
body.night .ca-appicon{background:#cfd8dc;color:#11181c}
.ca-title{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ca-strip{margin-left:auto;display:flex;gap:8px;align-items:center}
.ca-btn{
  display:inline-flex;align-items:center;gap:6px;padding:5px 12px;
  font-size:12px;font-weight:700;letter-spacing:.05em;
  background:#cfd6da;color:#11181c}
body.night .ca-btn{background:#2b3238;color:#e6edf3}
.ca-btn-live{background:#11181c;color:#fff}
body.night .ca-btn-live{background:#e6edf3;color:#11181c}
.ca-mic{font-size:9px;line-height:1}

.ca-body{flex:1 1 auto;overflow:hidden;padding:0}
.ca-section-head{
  padding:7px 12px 3px;font-size:11px;font-weight:700;letter-spacing:.09em;
  color:#4a5560;background:#e6eaed}
body.night .ca-section-head{color:#93a1ad;background:#161b20}
.ca-row{padding:7px 12px;border-bottom:1px solid #dde2e5}
body.night .ca-row{border-bottom-color:#242a30}
.ca-row-title{font-size:14px;font-weight:600;line-height:1.25;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ca-row-sec{font-size:12.5px;line-height:1.3;color:#48545f;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
body.night .ca-row-sec{color:#98a6b2}
.ca-row-voice .ca-row-title{letter-spacing:.02em}
.ca-row-voice-live{background:#11181c}
.ca-row-voice-live .ca-row-title{color:#fff}
.ca-row-voice-live .ca-row-sec{color:#c9d4dd}
body.night .ca-row-voice-live{background:#e6edf3}
body.night .ca-row-voice-live .ca-row-title{color:#11181c}
body.night .ca-row-voice-live .ca-row-sec{color:#3c464f}
.ca-empty{padding:26px 14px;font-size:14px;color:#48545f;text-align:center}
body.night .ca-empty{color:#98a6b2}
.ca-fab{
  position:absolute;right:12px;bottom:12px;width:38px;height:38px;border-radius:50%;
  display:grid;place-items:center;font-size:13px;background:#cfd6da;color:#11181c}
body.night .ca-fab{background:#2b3238;color:#e6edf3}
.ca-fab-live{background:#11181c;color:#fff}
body.night .ca-fab-live{background:#e6edf3;color:#11181c}

/* ---- control overlay ---- */
body.ctl [data-ctl]{position:relative}
body.ctl [data-ctl="host"]{outline:1px dashed #b0451f;outline-offset:-1px}
body.ctl [data-ctl="app"]{outline:1px solid #1a6b3c;outline-offset:-1px}
body.ctl [data-ctl^="app-"]{outline:1px dotted #6a4fa0;outline-offset:-1px}
body.ctl .carapp::after{
  content:"HOST DRAWS EVERYTHING OUTSIDE THE GREEN";
  position:absolute;left:0;right:0;bottom:0;background:#b0451f;color:#fff;
  font:10px/1.5 ui-monospace,monospace;letter-spacing:.05em;text-align:center;padding:1px 0}
.key{display:flex;gap:20px;flex-wrap:wrap;font-size:13px;margin:6px 0 0;color:var(--dim)}
.key span{display:inline-flex;align-items:center;gap:6px}
.sw{width:16px;height:12px;display:inline-block}
.sw-host{outline:1px dashed #b0451f}
.sw-app{outline:1px solid #1a6b3c}
.sw-mix{outline:1px dotted #6a4fa0}

.callout{border-left:none;background:#f0efeb;border-top:1px solid var(--rule);
  border-bottom:1px solid var(--rule);padding:11px 14px;margin:14px 0;max-width:74ch}
.callout p{margin:0 0 6px}
.callout p:last-child{margin:0}
@media (max-width:520px){ .screenwrap{width:100%} .wrap{padding:18px 14px 70px} }
"""

JS = """
const b=document.body;
document.getElementById('night').addEventListener('change',e=>b.classList.toggle('night',e.target.checked));
document.getElementById('ctl').addEventListener('change',e=>b.classList.toggle('ctl',e.target.checked));
"""


def grid(*screens):
    return '<div class="grid">' + "".join(screens) + "</div>"


def build():
    common = FLEETS["common"]
    one = FLEETS["one-blocked"]
    over = FLEETS["overflow"]
    empty = FLEETS["empty"]

    parts = []

    # ---- D2 states, voice option A: action strip ----
    parts.append("<h2 id='states'>D2 &middot; The states</h2>")
    parts.append(
        "<p>Six states, drawn with <b>voice option A</b> (the action-strip button). "
        "The same six with option B are further down. Every screen obeys the same row budget: "
        f"<b>{ROW_LIMIT} rows</b>, the library's fallback for "
        "<code>getContentLimit(CONTENT_LIMIT_TYPE_LIST)</code>. Real hosts may allow more; none allow fewer.</p>"
    )

    parts.append("<h3>1 &middot; The common case</h3>")
    parts.append(
        "<p>Nothing blocked, three lanes working. <b>What it teaches:</b> when nothing needs you, "
        "the screen should look calm and finish in one glance. The NEEDS MY INPUT section is not "
        "rendered at all &mdash; an empty section is illegal "
        "(<code>addSectionedList</code> throws on an empty list), and an empty heading would read as a fault.</p>"
    )
    parts.append(
        grid(
            screen(
                caption="Common case, voice off",
                note="Three working lanes. One section. The button reads TALK.",
                fleet=common,
                voice_live=False,
            ),
            screen(
                caption="Common case, voice LIVE",
                note="Same data. The button reads LISTENING and inverts. State is carried by the word, not the colour &mdash; see D4.",
                fleet=common,
                voice_live=True,
            ),
        )
    )

    parts.append("<h3>2 &middot; One lane blocked &mdash; the reason you looked</h3>")
    parts.append(
        "<p><b>What it teaches:</b> the blocked lane has to be the first thing your eye lands on, "
        "and it has to say what it wants without you tapping. The section header does that work: "
        "it is fixed text at the top, above everything else. Position, not colour, carries the priority "
        "&mdash; because colour is not ours (D4).</p>"
    )
    parts.append(
        grid(
            screen(
                caption="One blocked, voice off",
                note="Blocked section first and it always wins the top slot. Three working lanes still fit under it.",
                fleet=one,
                voice_live=False,
            ),
            screen(
                caption="One blocked, voice LIVE",
                note="The case this whole app exists for: you glance, you see what it wants, you answer out loud.",
                fleet=one,
                voice_live=True,
            ),
        )
    )

    parts.append("<h3>3 &middot; Overflow &mdash; more lanes than rows</h3>")
    parts.append(
        f"<p>Four blocked and seven working against a {ROW_LIMIT}-row budget. "
        "<b>What it teaches:</b> the split is not even. Blocked takes as many rows as it needs up to "
        f"{ROW_LIMIT - 1}, working keeps at least one row so you can still tell that work is happening, "
        "and each section that overflows spends its last slot on a counting row. "
        "There is no scrolling to design for here &mdash; a driver will not scroll, and the host may stop them.</p>"
    )
    parts.append(
        grid(
            screen(
                caption="Overflow, voice off",
                note="4 blocked + 7 working, 6 rows. All four blocked lanes survive intact; working is cut to one lane plus a counting row. That asymmetry is the rule, not an accident.",
                fleet=over,
                voice_live=False,
            ),
            screen(
                caption="Overflow, voice LIVE",
                note="Same allocation. The counting rows have fixed titles on purpose &mdash; see the refresh trap in D3.",
                fleet=over,
                voice_live=True,
            ),
        )
    )

    parts.append("<h3>4 &middot; Nothing running &mdash; the empty state</h3>")
    parts.append(
        "<p><b>What it teaches:</b> an empty list with two headings and no rows looks broken, so there are "
        "no headings at all &mdash; one plain sentence instead. This is also the state you see most often, "
        "because most of the time nothing is running.</p>"
    )
    parts.append(
        grid(
            screen(
                caption="Empty, voice off",
                note="No sections. One sentence. Still one tap from talking.",
                fleet=empty,
                voice_live=False,
                empty_message="No lanes running.",
            ),
            screen(
                caption="Empty, voice LIVE",
                note="You can start a conversation from an empty screen &mdash; that is how work gets started from the car.",
                fleet=empty,
                voice_live=True,
                empty_message="No lanes running.",
            ),
        )
    )

    # ---- voice options ----
    parts.append("<h2 id='voice'>Voice &mdash; three ways, two of them real</h2>")
    parts.append(
        "<p>Voice is the interaction; the screen is only a glance surface. So the live/not-live state has to be "
        "unmistakable, and the control has to be one tap. The template gives three places to put it, and "
        "<b>you cannot have the first and the third at the same time</b> &mdash; the design guidance says not to "
        "put an action strip and a floating action button on the same template. Mocked all three; pick one.</p>"
    )

    parts.append("<h3>Option A &mdash; action-strip button (drawn above)</h3>")
    parts.append(
        "<ul>"
        "<li><b>Yes:</b> it is the only control on this template that may carry a <i>word</i>. "
        "One label button is allowed per action strip. TALK / LISTENING is unmistakable without colour.</li>"
        "<li><b>No:</b> it is small, it sits top-right in the header, and it costs a template step to change "
        "if the host does not support app-driven refresh &mdash; the action strip is not row content, so it "
        "falls outside the refresh rule's list of things you may change for free.</li>"
        "<li><b>Also:</b> <code>ListTemplate.Builder.setActionStrip()</code> is deprecated as of Car App "
        "Library 1.7.0 in favour of <code>Header.Builder.addEndHeaderAction()</code>. Same control, newer "
        "spelling &mdash; but it means option A is the one that has already moved once.</li>"
        "</ul>"
    )

    parts.append("<h3>Option B &mdash; a pinned voice row</h3>")
    parts.append(
        "<p>The row title stays the fixed word <span class='mono'>Voice</span> and the state lives in the "
        "secondary text. That makes it the <b>only</b> option whose state changes are free under the refresh rule "
        "(D3) &mdash; secondary text is the one thing you may change without spending a step. "
        f"It costs one of the {ROW_LIMIT} rows, so the fleet budget drops to {ROW_LIMIT - 1}.</p>"
        "<p><b>And it can be a real switch.</b> <code>ROW_CONSTRAINTS_FULL_LIST</code> allows a "
        "<code>Toggle</code> on a row, and the refresh rule grants toggle rows an extra freedom: the row "
        "<i>title</i> may change too, as long as the toggle state changed with it. So a voice row can be "
        "an actual on/off switch that reads <span class='mono'>Voice</span> / "
        "<span class='mono'>Listening</span> in the title and still costs nothing. That is the strongest "
        "form of option B. The price: a toggle row may not also have an <code>OnClickListener</code>, so "
        "the switch is the only thing that row does.</p>"
    )
    parts.append(
        grid(
            screen(
                caption="B · common case, voice off",
                note="Voice row pinned at the top, above the sections. Fleet budget drops to 5.",
                fleet=common,
                voice_live=False,
                voice_style="voicerow",
            ),
            screen(
                caption="B · common case, voice LIVE",
                note="The row inverts and the text says LIVE. Both the word and the fill change, so it reads either way.",
                fleet=common,
                voice_live=True,
                voice_style="voicerow",
            ),
            screen(
                caption="B · one blocked, voice LIVE",
                note="The cost is visible here: the voice row pushes the fleet down a slot.",
                fleet=one,
                voice_live=True,
                voice_style="voicerow",
            ),
            screen(
                caption="B · overflow, voice LIVE",
                note="The cost, at its worst: on a 5-row budget all four blocked lanes still survive, so working collapses to its counting row alone. No working lane is named at all.",
                fleet=over,
                voice_live=True,
                voice_style="voicerow",
            ),
            screen(
                caption="B · empty, voice off",
                note="Empty fleet, voice still present. Arguably the best argument for option B.",
                fleet=empty,
                voice_live=False,
                voice_style="voicerow",
                empty_message="No lanes running.",
            ),
            screen(
                caption="B · empty, voice LIVE",
                note="Talking with nothing running &mdash; the state that starts the work.",
                fleet=empty,
                voice_live=True,
                voice_style="voicerow",
                empty_message="No lanes running.",
            ),
        )
    )

    parts.append("<h3>Option C &mdash; floating action button</h3>")
    parts.append(
        "<p><span class='flag'>Drawn so it can be rejected on sight.</span> A FAB is "
        "<b>icon-only and must carry a background colour</b> &mdash; the API refuses one without both an icon "
        "and a background <code>CarColor</code>. It is the biggest, easiest target on the screen and the "
        "worst at saying what it is doing, because it can say nothing at all. "
        "It also excludes the action strip, and <code>ListTemplate.Builder.addAction()</code> requires "
        "Car API 6 &mdash; the same floor as app-driven refresh.</p>"
    )
    parts.append(
        grid(
            screen(
                caption="C · FAB, voice off",
                note="A dot. Is voice off, or is the app not connected? You cannot tell without colour, and colour is the host's.",
                fleet=common,
                voice_live=False,
                voice_style="fab",
            ),
            screen(
                caption="C · FAB, voice LIVE",
                note="A square. Better than nothing, still a guess. This is the option the constraints argue against.",
                fleet=common,
                voice_live=True,
                voice_style="fab",
            ),
        )
    )

    return "".join(parts)


HEAD = f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>muxterm in the car &mdash; Android Auto draft</title>
<link rel="icon" href="data:,">
<style>{CSS}</style>
</head><body>
<div class="wrap">

<h1>muxterm in the car &mdash; Android Auto draft</h1>
<p class="sub">A conversation piece, not a design. Drawn inside what the Car App Library actually
permits, so that what you decide next is buildable. Checked against Android developer documentation
on <b>2026-09-09</b>. Full citations: <span class="mono">docs/design/android-auto-ui.md</span>.</p>

<div class="bar">
  <label><input type="checkbox" id="night"> Night mode</label>
  <label><input type="checkbox" id="ctl"> Show what the host controls</label>
  <div class="navlinks">
    <a href="#truth">Read this first</a>
    <a href="#spotify">Why Spotify looks richer</a>
    <a href="#template">D1 template</a>
    <a href="#states">D2 states</a>
    <a href="#voice">Voice</a>
    <a href="#overflow">D3 overflow</a>
    <a href="#daynight">D4 day/night</a>
    <a href="#decide">Decide</a>
  </div>
</div>

<div class="key">
  <span><i class="sw sw-app"></i> app supplies this</span>
  <span><i class="sw sw-mix"></i> app supplies text or icon, host draws the shape</span>
  <span><i class="sw sw-host"></i> host draws this &mdash; varies by car</span>
</div>
"""


TRUTH = """
<h2 id="truth">Read this first</h2>
<div class="callout">
<p><b>None of this is a picture of what the car will look like.</b> Android Auto apps do not draw.
They hand the head unit a <i>template</i> &mdash; a structured object &mdash; and the head unit renders
it in its own styling. The fonts, the colours, the spacing, the row height, the header chrome, the
scroll behaviour: all of it belongs to the manufacturer, and it differs between a Pixel-tethered
Android Auto session and a built-in Automotive OS car.</p>
<p>So the screens below are <b>faithful to the structure</b> and <b>approximate about everything else</b>.
Tick <b>Show what the host controls</b> above to see the line. What is inside the green is yours to
decide. What is outside it is not, and no amount of design work will make it yours.</p>
</div>

<table>
<tr><th style="width:34%">Yours (the app)</th><th>Not yours (the host, and it varies by car)</th></tr>
<tr>
<td>Which template. How many sections and their headers. Row titles. Row secondary text (up to 2 lines).
Which icons. Up to 2 accent colours, offered. What the buttons do.</td>
<td>Fonts and type sizes. Layout, row height, padding, margins. All background and chrome colour.
Day/night switching. How many rows are actually shown. Whether text is truncated further while driving.
Whether your accent colour is used at all &mdash; it is dropped if it fails contrast.</td>
</tr>
</table>
"""


SPOTIFY = """
<h2 id="spotify">Why Spotify looks richer than this</h2>
<p>This is the first thing anyone says when they see this draft, and it deserves a straight answer
rather than a defence. Spotify and Audible <i>are</i> far richer in the car. Here is why, and it is
not what it looks like.</p>

<div class="callout">
<p><b>They are not template apps.</b> They are <i>media</i> apps, on a completely separate API that
predates the Car App Library: a <code>MediaBrowserService</code> that serves a tree of
<code>MediaItem</code>s, plus a <code>MediaSession</code> for playback. The app hands over a content
hierarchy; Android Auto walks it and renders the browse UI. There is not a
<code>ListTemplate</code> anywhere in it.</p>
<p><b>And they control their appearance <i>less</i> than we do, not more.</b> Google's own media
design guidance: &ldquo;Because most aspects of the media UI are controlled by car makers and
Google, the design-related tasks for app developers are relatively simple.&rdquo; A media app supplies
text, album art, an app icon and <b>one</b> accent colour. That is the whole surface. Spotify in the
car does not look like Spotify on your phone for exactly the reason this draft keeps insisting on.</p>
</div>

<p>So their richness is <b>structural</b>, not visual. That is the real list, and it is worth reading
because it is a list of things we do not get:</p>

<table>
<tr><th style="width:30%">What a media app gets</th><th>What it means, and what we have instead</th></tr>
<tr><td><b>No five-template quota</b></td>
<td>It sends <i>items</i>, not templates, so the counter that closes our app does not exist for it.
This is the single biggest difference.</td></tr>
<tr><td><b>Unbounded tree depth</b></td>
<td>Artist &rarr; album &rarr; track is just recursion on <code>onLoadChildren</code>. The only ceiling
is advice (&ldquo;avoid browsable content that extends more than three levels deep&rdquo;). We get five
<i>templates</i> per task, which is a budget, not a depth.</td></tr>
<tr><td><b>Top-level tabs</b></td>
<td>The root's children become tabs &mdash; typically up to four, browsable items only. We can have a
<code>TabTemplate</code>, but it costs us the action strip and hides the blocked lane behind a tap.</td></tr>
<tr><td><b>Grid or list, per subtree</b></td>
<td>Content-style hints let each branch declare list vs grid vs category, with group subheaders. We
choose one template and live in it.</td></tr>
<tr><td><b>Real search</b></td>
<td>Declared in <code>onGetRoot</code>, answered by <code>onSearch</code>, plus voice search through
<code>onPlayFromSearch</code>. Nothing equivalent exists for a templated list app.</td></tr>
<tr><td><b>Custom browse actions on rows</b></td>
<td>Download, favourite, add-to-queue &mdash; per-row buttons inside the browse UI. A full-list row in
our template gets a whole-row tap <b>or</b> a toggle, and nothing else (see below).</td></tr>
</table>

<p><b>Can we just be a media app?</b> No. That path is defined by serving media: a browsable content
hierarchy and a playback session. Lanes are not tracks and there is nothing to play. There <i>is</i> a
newer templated-media path (<code>androidx.car.app.category.MEDIA</code>, Car API 8) that reaches
<code>SectionedItemTemplate</code> and <code>TabTemplate</code> &mdash; but it is in beta, and Google is
explicit that &ldquo;publishing to open tracks and production tracks will be permitted at a later
date.&rdquo;</p>

<h3>The part of the gap that is ours to close</h3>
<div class="callout">
<p><b>Drill-down is available to us, and this draft turned it down on purpose.</b> Full-list rows
accept an <code>OnClickListener</code>, and <code>ScreenManager.push()</code> opens another screen with
a Back button supplied by the host. The &ldquo;five&rdquo; is a limit on <b>templates</b>, not on screens
&mdash; and <b>popping a screen gives the quota back</b>: go two templates deep, come back, and the
host restores two. A sub-flow is genuinely affordable.</p>
<p>So &ldquo;one screen, no drill-down&rdquo; is <b>a decision, not a constraint</b>. It was chosen
because the premise is that you glance and then talk &mdash; but if this draft feels thin beside
Spotify, that decision is the lever, and it is decision 5 at the bottom of this page.</p>
</div>

<p>One thing that is genuinely not available, before anyone designs around it: <b>a full-list row has
no trailing buttons.</b> <code>ROW_CONSTRAINTS_FULL_LIST</code> inherits
<code>setMaxActionsExclusive(0)</code> &mdash; its own javadoc says &ldquo;No actions (note: this is
different than the click listener which turns the entire row into a clickable &lsquo;action&rsquo;)&rdquo;.
The affordances on a lane row are exactly two, and they are mutually exclusive: <b>tap the whole
row</b> (optionally with a browsable caret), <b>or</b> carry a <b>toggle</b>. No per-lane approve
button. Whatever the row does, the whole row does.</p>
"""


TEMPLATE = """
<h2 id="template">D1 &middot; The template</h2>
<p><b>Chosen: <code>ListTemplate</code> with two <code>SectionedItemList</code>s.</b> It is the only
general-purpose template that gives two labelled groups of rows on one screen with no navigation,
which is exactly the shape of the requirement: two short lists, one screen, no drill-down.</p>

<p><span class="flag">Two sections in one template <b>are</b> possible</span> &mdash; this was worth
checking, because the rich <i>Section header</i> component is documented as
exclusive to the newer Sectioned Item template. Plain sublist headers on <code>ListTemplate</code> are
a different, older thing: <code>ListTemplate.Builder.addSectionedList()</code> has existed since 1.0.0
and rejects an empty header, and the List template design page lists
&ldquo;Include a section header when sections are present&rdquo; as a MUST. So NEEDS MY INPUT and
ONGOING can be two headed groups in one list.</p>

<table>
<tr><th style="width:22%">Rejected</th><th>What it would have cost</th></tr>
<tr><td><code>PaneTemplate</code></td>
<td>Content limit of 4 rows against the list's 6, and rows in a pane cannot be clicked
(<code>ROW_CONSTRAINTS_PANE</code> sets <code>setOnClickListenerAllowed(false)</code>) &mdash; so no tap
target for voice inside the body. Built for one static block of detail, not a changing fleet.</td></tr>
<tr><td><code>GridTemplate</code></td>
<td>A grid item is an image with a short label. Our payload is two lines of prose per lane
(<i>&ldquo;Run brew upgrade on the Mac, then say go&rdquo;</i>). A grid would either drop that text or
shrink it to nothing.</td></tr>
<tr><td><code>MessageTemplate</code></td>
<td>One message, up to 2 actions. It could state &ldquo;3 lanes working, 1 blocked&rdquo; and nothing
else &mdash; you would lose <i>which</i> lane and <i>what</i> it wants, which is the entire content.</td></tr>
<tr><td><code>TabTemplate</code></td>
<td>Puts blocked and working on separate tabs, so the blocked lane is invisible until you tap &mdash;
exactly the thing you look at the screen to avoid. It also replaces the header with tabs, which
removes the action strip, which removes voice option A.</td></tr>
<tr><td><code>SectionedItemTemplate</code></td>
<td>The genuinely better fit on paper: richer section headers, and it is the only template that
supports Banners. But it is newer (Car App Library 1.9-era) and raises the minimum host API for no
capability this screen needs. Worth revisiting if you ever want a banner.</td></tr>
<tr><td>Anything map-based</td>
<td>Gated behind the NAVIGATION / POI / WEATHER categories, and would put a map on screen that this
app has no use for.</td></tr>
</table>
"""


OVERFLOW = f"""
<h2 id="overflow">D3 &middot; Overflow and truncation</h2>

<h3>The row budget</h3>
<p>Ask the host: <code>constraintManager.getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_LIST)</code>.
It is a runtime number, not a constant &mdash; different cars allow different counts. The library's
compiled-in fallback, used only when the host cannot be reached, is <b>{ROW_LIMIT}</b>. Design for {ROW_LIMIT},
render what the host reports.</p>

<h3>How the space is split</h3>
<ul>
<li><b>Blocked wins.</b> The blocked section may take up to <b>{ROW_LIMIT - 1}</b> rows. It is why you looked.</li>
<li><b>Working always keeps at least one row</b> when anything is working, so &ldquo;work is happening&rdquo;
is never silently invisible. If there is room for a lane, that row names a lane; if there is not, the row
is the counting row and reads <span class="mono">+7 more working</span>. It never disappears.</li>
<li><b>An overflowing section spends its last slot on a counting row</b> &mdash; title
<span class="mono">More waiting</span> / <span class="mono">More running</span>, secondary text
<span class="mono">+3 more need input</span>.</li>
<li><b>An empty section is not rendered.</b> Not a heading with nothing under it &mdash; nothing at all.
The API enforces this anyway: <code>addSectionedList</code> throws on an empty list.</li>
</ul>

<h3>How text is shortened</h3>
<p>A row is a title plus at most 2 lines of secondary text
(<code>ROW_CONSTRAINTS_FULL_LIST</code> inherits <code>setMaxTextLinesPerRow(2)</code> from
<code>ROW_CONSTRAINTS_SIMPLE</code>), and the design
guidance caps glanceable text at &ldquo;1&ndash;3 lines and 120 characters&rdquo;. muxterm's
<span class="mono">doing</span> string is re-templated on every tool call and can be long. The rule:</p>
<ul>
<li>Collapse all whitespace to single spaces &mdash; a <span class="mono">doing</span> may contain newlines.</li>
<li>Reduce paths to their basename.
<span class="mono">/home/ken/workspace/muxterm-voice-exit/internal/voice/tools.go</span> &rarr;
<span class="mono">tools.go</span>. The basename is the part a driver can use.</li>
<li>Cut at a word boundary at <b>{SECONDARY_MAX_CHARS} characters</b> and append one ellipsis. With a ~30-character
title that lands inside the 120-character glance budget with room to spare.</li>
<li><b>Put the volatile part first.</b> The design guidance is explicit: text meant to be read while
driving must be at the beginning of the secondary text, because the host truncates to 2 lines while
driving regardless of what you sent.</li>
<li><b>Use one <code>addText</code> call, not two.</b> Two strings are each clamped to one line and each
ellipsised separately; a single string is allowed to wrap to the full 2 lines. One call gets more
words on screen.</li>
</ul>

<h3 id="trap">The trap nobody would find until they built it</h3>
<div class="callout">
<p>An Android Auto app may push only <b>5 templates per task</b>. Exhaust that and the host
<b>shows an error and closes your app</b>. A dashboard that redraws when the fleet changes will
walk into this within a minute.</p>
<p>Worse in our specific case: the docs also require that <b>the last template in a task be one of
six types</b> &mdash; Navigation, Pane, Message, MediaPlayback, SignIn, LongMessage. <b>ListTemplate is
not one of them.</b> So a one-screen list app cannot even spend its fifth step on the screen it exists
to show. Refresh is not an optimisation here; it is the only way the app works at all.</p>
<p>The escape is the refresh rule: a new template of the same type is free <i>if the structure has not
changed</i> &mdash; same title, same number of sections, same section headers, same number of rows, and
<b>the same row titles</b>. Only the secondary text and toggle state may change for free. One useful
exception: <b>on a row that carries a Toggle, the title may change too, provided the toggle state
changed with it.</b></p>
<p>And the quota is not a one-way ratchet, which this page originally implied and which is worth
correcting: <b>popping a screen gives the quota back.</b> Push a screen, spend two templates, go back,
and the host restores two &mdash; on the condition that a screen you return to sends the <i>same
template type</i> it last sent. Sub-flows are affordable. It is the <i>self-refreshing single screen</i>
that is expensive, which is exactly the thing this app is.</p>
<p>So the design above is fast and honest but not free: a lane starting, finishing, or moving from
ONGOING to NEEDS MY INPUT changes the row count and the row titles, and costs a step.
<code>ConstraintManager.isAppDrivenRefreshEnabled()</code> (Car API 6+) turns list refreshes free and is
almost certainly true on any current Android Auto host &mdash; but that is an inference, it is
queryable at runtime, and <b>the fallback has to be designed, not assumed</b>. Two named fallbacks are
in the decision list at the bottom.</p>
</div>
"""


DAYNIGHT = """
<h2 id="daynight">D4 &middot; Day and night</h2>
<p>Tick <b>Night mode</b> at the top of the page to switch every screen. Now the finding:</p>

<div class="callout">
<p><b>The app does not choose either palette.</b> The host switches day/night on its own and picks the
light or dark variant of every colour itself, to hold its own contrast ratio. The app is told
&mdash; <code>CarContext.isDarkMode()</code>, and <code>Session.onCarConfigurationChanged()</code> fires on
the switch &mdash; but being told is not the same as deciding.</p>
<p>What the app may offer is narrow: four standard <code>CarColor</code>s, or up to two custom accents
declared in the manifest with light <i>and</i> dark variants. And even those are conditional &mdash;
&ldquo;the host may use a default color instead if the colors do not pass the contrast requirements.&rdquo;
Inside a list row, the only text the app may colour at all is the <b>secondary line</b>:
<code>Row.Builder.addText</code> honours a <code>ForegroundCarColorSpan</code>, while
<code>setTitle</code> accepts only <code>DistanceSpan</code> and <code>DurationSpan</code> and ignores
every other span. The row title is not colourable at all.</p>
<p><b>Therefore: status cannot be carried by colour.</b> Not &ldquo;should not&rdquo; &mdash; cannot, reliably.
It has to be carried by <b>words</b> and by <b>position</b>. That single sentence is why this draft looks
the way it does: NEEDS MY INPUT is a literal heading at the literal top, and the voice control says
LISTENING in letters rather than turning red.</p>
</div>

<p>The two palettes drawn here are a plausible Android Auto rendering, not a specification. A car from
a different manufacturer will look different and both will be correct.</p>
"""


DECIDE = """
<h2 id="decide">What to decide next</h2>
<p>Six choices. Each is between named options, and each is genuinely open &mdash; this draft picked a
side only so there would be something to argue with.</p>

<table>
<tr><th style="width:26%">Decision</th><th>Options</th></tr>

<tr><td><b>1. Voice control</b></td>
<td><b>(A) action-strip button</b> &mdash; the only control that can carry the word LISTENING, costs no row,
costs a step to change &nbsp;|&nbsp; <b>(B) pinned voice row</b> &mdash; state changes are free under the
refresh rule, costs one of six rows &nbsp;|&nbsp; <b>(C) FAB</b> &mdash; biggest target, icon-only, cannot
say anything. A and C are mutually exclusive.
<br><i>Draft leans B, on the grounds that a free state change beats a prettier one.</i></td></tr>

<tr><td><b>2. The refresh fallback</b></td>
<td><b>(i) Trust app-driven refresh</b> &mdash; query <code>isAppDrivenRefreshEnabled()</code>, redraw freely,
and accept that an old host will close the app &nbsp;|&nbsp; <b>(ii) Fixed slots</b> &mdash; always render
exactly six rows with frozen titles (<span class="mono">Lane 1..6</span>) and put the lane label in the
secondary text, so nothing ever costs a step &nbsp;|&nbsp; <b>(iii) Rate-limit</b> &mdash; redraw structure at
most once every N seconds and let secondary text carry everything between.
<br><i>(ii) is ugly and bulletproof. This is the decision with the most engineering consequence.</i></td></tr>

<tr><td><b>3. Row order inside a section</b></td>
<td><b>Longest-waiting first</b> (the lane you have kept waiting) &nbsp;|&nbsp; <b>Most-recently-changed first</b>
(the lane that just spoke) &nbsp;|&nbsp; <b>Stable by lane creation order</b> (rows never move under your eye,
which matters at 70mph).</td></tr>

<tr><td><b>4. What a row title actually is</b></td>
<td><b>The lane label</b> (&ldquo;mac remote&rdquo;) &nbsp;|&nbsp; <b>The workspace name</b> &nbsp;|&nbsp;
<b>The project directory</b>. Labels are auto-generated today and some are poor; if the title is the label,
the labels need to be good enough to read at a glance.</td></tr>

<tr><td><b>5. What a tap on a row does</b><br><span class="flag">the Spotify question</span></td>
<td><b>Nothing</b> &mdash; rows are inert, everything happens by voice &nbsp;|&nbsp;
<b>Starts voice with that lane as the subject</b> (&ldquo;about mac remote&hellip;&rdquo;) &nbsp;|&nbsp;
<b>Speaks the row aloud</b> &nbsp;|&nbsp; <b>Opens a lane screen</b> &mdash; the full
<span class="mono">waiting_for</span> untruncated, and a couple of stock answers. Drill-down is allowed
(<code>ScreenManager.push()</code>, Back supplied by the host, and popping restores the quota it spent);
this draft skipped it because the premise is glance-then-talk, not browse. If the app feels too flat,
<b>this is the lever</b>. The design guidance also discourages information-only rows, which argues
against &ldquo;nothing&rdquo;.</td></tr>

<tr><td><b>6. What this is for</b></td>
<td><b>Personal, DHU + your own phone, never published</b> &mdash; then the app category question does not
matter &nbsp;|&nbsp; <b>Internal test track</b> &mdash; then it must declare one of seven categories, none of
which fits, and Play's PC-1 criterion is a real risk. See the honesty note below.</td></tr>
</table>

<h3>One honesty note about shipping</h3>
<div class="callout">
<p>Android Auto has an &ldquo;unknown sources&rdquo; developer toggle, and the documentation says plainly
that it <b>does not apply to apps built with the Android for Cars App Library</b>. To run in a real
vehicle, a templated app must be installed from a trusted source. The Desktop Head Unit is the honest
demo path; Internal App Sharing or an internal test track is the honest device path.</p>
<p>And there are exactly seven app categories &mdash; NAVIGATION, POI, IOT, WEATHER, MEDIA, MESSAGING,
CALLING &mdash; one of which must be declared for the host to bind at all. A fleet dashboard is none of
them. That does not block a personal build. It does block publishing, and it is better known now than
after the UI is finished.</p>
</div>

<p class="sub" style="margin-top:26px">Draft generated by <span class="mono">build.py</span> in this
directory &mdash; edit the <span class="mono">FLEETS</span> data or the allocation rule and re-run to
redraw every screen.</p>
"""


def main():
    doc = HEAD + TRUTH + SPOTIFY + TEMPLATE + build() + OVERFLOW + DAYNIGHT + DECIDE
    doc += f"</div><script>{JS}</script></body></html>\n"
    OUT.write_text(doc, encoding="utf-8")
    print(f"wrote {OUT} ({len(doc)} bytes)")


if __name__ == "__main__":
    main()
