# Touch-Scroll Propagation Fix — Implementation Plan

**Status:** ✅ IMPLEMENTED & VERIFIED in a live browser (2026-06-26).
**Root-cause doc:** `docs/research/touch-scroll-propagation.md`
**Target:** `web/src/lib/terminal-registry.ts` (manual touch-scroll handler)

## Summary

Touch-drag scrolling on the Android tablet does not reach inner TUIs
(`opencode`, `claude code`, `vim`) because the manual `touchmove` handler calls
`term.scrollLines()`, which only moves xterm.js's local scrollback. On the
**alternate screen** (where those apps live) there is no scrollback, so it is a
no-op and nothing ever reaches the PTY.

The fix **branches on the active buffer type**:

- **Alternate screen** → dispatch a synthetic `WheelEvent` into `.xterm-screen`;
  xterm's own wheel handler translates it to arrow keys / SGR mouse reports that
  reach the PTY.
- **Normal screen** → keep `term.scrollLines()` (accumulating sub-line
  fractions) for local scrollback.

> ⚠️ **Why not "synthetic wheel for everything"?** The first implementation
> dispatched a synthetic wheel in *all* cases. It fixed the alt-screen (Step 5)
> but **broke normal-screen scrollback** (Step 6). Root cause, confirmed in the
> xterm v6 source: the `.xterm-screen` wheel handler only emits bytes when
> `!buffer.hasScrollback` (alt-screen). On the normal screen it does nothing and
> relies on the **browser's native scroll** of `.xterm-viewport` — and a
> synthetic `dispatchEvent()` does **not** trigger native default actions, so a
> synthetic wheel scrolls nothing. Hence the explicit branch.

## Proof (done before writing this plan — app untouched)

A standalone harness (real xterm.js v6, driven by headless Chromium via
Playwright) injected the exact escape sequences each app type emits, then
dispatched synthetic `new WheelEvent('wheel', { deltaY, deltaMode: 0 })` into
`.xterm-screen` and captured what xterm's `onData` produced (i.e. the exact
bytes that would be sent to the PTY):

| Terminal state                       | buffer    | wheel-up `onData` | wheel-down `onData` |
| ------------------------------------ | --------- | ----------------- | ------------------- |
| Normal screen (default)              | normal    | `[]` (local scrollback) | `[]` |
| Alt-screen `1049h` (opencode/vim)    | alternate | `\x1b[A`          | `\x1b[B`            |
| Alt-screen + app-cursor `1h`         | alternate | `\x1bOA`          | `\x1bOB`            |
| Mouse SGR tracking `1000h,1006h`     | alternate | `\x1b[<64;..M`    | `\x1b[<65;..M`      |
| Normal again `1049l`                 | normal    | `[]`              | `[]`                |

**Conclusion:** synthetic wheel → correct arrow keys / app-cursor / SGR mouse
report in every alt-screen mode, and harmless local-scrollback behavior on the
normal screen. This is exactly the behavior the current handler fails to produce.
`deltaMode: 0` (pixel) works — xterm quantizes pixels → lines itself.

Harness location (outside the app, reusable):
`/var/folders/_j/.../T/opencode/wheel-harness/` (`prove.js` is the key file).

### Caveats surfaced during proof

1. `opencode` did not enter alt-screen when spawned in the headless harness PTY,
   so the table above injects the real mode sequences directly into xterm. The
   final browser verification must use a **live opencode/vim pane in muxterm** to
   confirm end-to-end.
2. `/usr/bin/vim` could not be spawned by node-pty in the harness (`posix_spawnp
   failed` — macOS restricts the arm64e platform binary). Irrelevant to the
   result; direct mode injection is the more precise test anyway.

## Implementation

> **Scope guardrail — read before starting.** This is a single-handler change in
> ONE file: `web/src/lib/terminal-registry.ts`, the `touchmove` listener inside
> the block at lines 412-435. Do **not** modify `attach()`, `TERMINAL_CONFIG`,
> the `PaneEntry` type, `onData`, `touchstart`, or `touch-action`. Do **not**
> add element caching, refactor the surrounding block, or "improve" anything
> outside the steps below. Each step is self-contained and ends with a check —
> do them in order and stop at the first failing check.

### Step 1 — Replace the `touchmove` body

In the `touchmove` listener (currently lines 422-434), replace the entire
listener body. Keep the `'touchmove'`/`{ passive: false }` registration and the
final `e.preventDefault()` exactly as-is.

Replace this:

```ts
const y = e.touches[0].clientY;
// Positive delta = finger moved up = scroll down (content moves up).
_accumulated += _touchY - y;
_touchY = y;
const cellH = term.options.fontSize ?? 13;
const lines = Math.trunc(_accumulated / cellH);
if (lines !== 0) {
  term.scrollLines(lines);
  _accumulated -= lines * cellH;
}
e.preventDefault();
```

With this:

```ts
const y = e.touches[0].clientY;
// Finger up (y decreases) = scroll content down = wheel deltaY > 0.
const deltaY = _touchY - y;
_touchY = y;
if (deltaY !== 0) {
  // Route through xterm's OWN wheel pipeline so it does the correct,
  // mode-aware translation: alt-screen -> arrow keys (\x1b[A / \x1bOA),
  // mouse-tracking -> SGR wheel report, normal screen -> local scrollback.
  // Hand-rolled term.scrollLines() was a no-op on the alt-screen, which is
  // why opencode/claude/vim never received touch scroll.
  // Proven in docs/plans/2026-06-26-touch-scroll-propagation-fix.md.
  const screenEl = hostEl.querySelector('.xterm-screen') as HTMLElement | null;
  if (screenEl) {
    screenEl.dispatchEvent(new WheelEvent('wheel', {
      deltaY,
      deltaMode: 0, // pixels; xterm quantizes to lines itself
      bubbles: true,
      cancelable: true,
    }));
  } else {
    // Fallback: terminal not opened yet — preserve old scrollback behavior.
    const cellH = term.options.fontSize ?? 13;
    term.scrollLines(Math.trunc(deltaY / cellH));
  }
}
e.preventDefault();
```

**Check:** `cd web && npm run check:fast` → 0 errors. (`tsgo` will now flag
`_accumulated` as unused — that is expected and removed in Step 2. If it errors
here, that is fine; proceed to Step 2 before re-running.)

### Step 2 — Remove the now-dead `_accumulated` variable

The new body no longer uses `_accumulated`. Remove its declaration and its reset:

- Delete `let _accumulated = 0;` (currently line 414).
- In the `touchstart` listener, delete the line `_accumulated = 0;` (currently
  line 420). Leave `_touchY = e.touches[0].clientY;` untouched.

Do **not** touch `_touchY` — it is still required.

**Check:** `cd web && npm run check:fast` → 0 errors, no "unused variable"
warning for `_accumulated`.

### Step 3 — Compile the whole project

**Check:** `go build ./...` → compiles clean (the embedded web build must be
valid). No code edits in this step.

> **Stop here for code edits.** Steps 4+ are runtime verification only. Do not
> make further source changes unless a verification step fails and points to a
> specific line.

## Verification (per AGENTS.md — no unit tests, real browser required)

### Step 4 — Build and launch

```bash
make build
./bin/muxterm &
```

**Check:** `./bin/muxterm` starts and serves the UI without error.

### Step 5 — Primary case: alt-screen TUI (THE bug)

Open a pane, run an alt-screen pager (`less` on a 400-line file; `opencode` /
`vim` equivalent), then dispatch a real touch-drag over the terminal.

**Check:** the inner app's content scrolls in the drag direction.
✅ **PASS** (live browser, 2026-06-26): rows `1–6` → `9–14` on finger-up drag.

### Step 6 — Regression: normal shell scrollback

In a plain shell pane with scrollback (`seq 1 300`), touch-drag down.

**Check:** the shell scrollback still scrolls (no regression).
✅ **PASS after the buffer-type branch** (live browser): top rows `257–261` →
`222–226` on finger-down drag. (Before the branch fix this FAILED — rows did not
move — which is what surfaced the synthetic-wheel limitation.)

### Step 7 — Regression: tap-to-focus

Single-tap a pane.

**Check:** the pane still selects/focuses.
✅ **PASS** (live browser, real `touchscreen.tap()`): active element →
`TEXTAREA.xterm-helper-textarea`. (An earlier "fail" was a test artifact:
synthetic `dispatchEvent` touches don't trigger native tap→click→focus
synthesis; the code path is unchanged from before.)

### Step 8 — Direction sanity

**Check:** finger-up scrolls content forward/down.
✅ **PASS** — confirmed in Steps 5 (forward) and 6 (backward) above.

## Verified result

| Step | Case | Result |
| ---- | ---- | ------ |
| 1–2  | code change + `npm run check:fast` (0 errors) | ✅ |
| 3    | `go build ./...` | ✅ |
| 4    | `make build` + launch (HTTP 200) | ✅ |
| 5    | alt-screen TUI scrolls on touch-drag | ✅ |
| 6    | normal-screen scrollback (no regression) | ✅ |
| 7    | tap-to-focus | ✅ |
| 8    | drag direction | ✅ |

Live verification harness (real Chromium via Playwright, drives muxterm at
`localhost:8311`): `/var/folders/.../T/opencode/wheel-harness/` —
`verify-live.js` (alt-screen) and `verify-live-67b.js` (normal + focus).

## Key references

- `web/src/lib/terminal-registry.ts` — touch-scroll handler (buffer-type branch)
- `web/src/lib/terminal-registry.ts:344-358` — `onData` → PTY (ready-gated)
- `web/src/lib/terminal-registry.ts:297-301` — `touch-action:none` host element
- `web/package.json:19-25` — xterm.js v6 + addons
- `docs/research/touch-scroll-propagation.md` — full diagnosis
