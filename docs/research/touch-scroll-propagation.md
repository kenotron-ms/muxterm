# Touch-Scroll Propagation Bug (Android tablet → muxterm → inner TUI)

**Status:** Diagnosed, not yet fixed. Fix deferred to avoid disrupting a live
sessiond that the author is currently depending on.

## Symptom

On an Android tablet, touch scrolling does **not** propagate from the tablet
through muxterm to a terminal application running inside a pane (e.g. `opencode`
or `claude code`). Dragging a finger does nothing in those apps. The same
gesture worked in the earlier `amplifier-app-cli` project.

## Root cause

`web/src/lib/terminal-registry.ts:404-435` — the manual touch-scroll handler.

muxterm uses **xterm.js v6** (`web/package.json:19-25`). xterm.js v6 regressed
native touch-scroll support (upstream issue #5489), so a manual handler was
wired up: it tracks finger Y-delta on `touchstart`/`touchmove` and converts it
into a single action:

```ts
// terminal-registry.ts:430
term.scrollLines(lines);   // LOCAL viewport / scrollback only
```

`term.scrollLines()` scrolls **only xterm.js's own local viewport/scrollback**.
It never feeds xterm.js's wheel pipeline and never sends anything to the PTY.

### Why it breaks opencode / claude-code specifically

Those apps (like vim/tmux) run on the **alternate screen**, which has **no
scrollback buffer**. Therefore:

1. `term.scrollLines()` is a **no-op** on the alt-screen — there is nothing
   local to scroll.
2. The touch path **bypasses xterm.js's wheel pipeline entirely**, so xterm.js
   never performs its built-in translation of:
   - wheel → arrow keys (when on the alternate screen), or
   - wheel → SGR mouse-wheel report (when the app enabled mouse tracking).

   Nothing is ever sent to `onData` / `onInput`, so the PTY — and the inner app —
   never sees the gesture.

### Why a hardware mouse wheel still works

A real wheel produces a native `wheel` event that flows through xterm.js core,
which *does* translate it to arrow keys / SGR reports in alt-screen / mouse mode.
Touch was deliberately rewired to `term.scrollLines()` and diverges from that
pipeline.

### Why amplifier-app-cli worked

That project let touch/wheel flow through xterm.js's **native** handler (or
synthesized a wheel/arrow input that reached the PTY) instead of short-circuiting
to `term.scrollLines()`.

### Compounding factor: touch-action: none

`terminal-registry.ts:297-301` sets `touch-action: none` on the terminal host
element, which suppresses the browser's native pan/scroll/zoom. This commits
muxterm to fully synthesizing the gesture in JS — which the handler only half
does (local viewport, never the PTY).

## Input/scroll flow (browser → PTY)

```
Keystroke / xterm-internal mouse report
  xterm.js Terminal.onData / onBinary        (registry.ts:344, 363)
    └─ entry.handlers.onInput(bytes)  → WS → sessiond → PTY → app   ✅ works

Hardware wheel
  native 'wheel' → xterm.js core
    └─ alt-screen → arrow keys ; mouse-mode → SGR → onData → PTY    ✅ (xterm default)

Touch drag (Android tablet)                  ← BROKEN PATH
  hostEl 'touchmove'                         (registry.ts:422)
    └─ term.scrollLines(lines)               (registry.ts:430)
         • alt-screen apps (opencode/claude/vim): no scrollback → no-op
         • nothing sent to onData/onInput → PTY never sees the gesture  ❌
```

## Proposed fix (not yet implemented)

The touch handler must detect terminal state and route accordingly instead of
always calling `scrollLines()`:

- **Alternate screen** (`term.buffer.active.type === 'alternate'`): emit
  arrow-key sequences (`\x1b[A` / `\x1b[B`, or `\x1bOA` / `\x1bOB` in
  application-cursor-key mode) and/or SGR mouse-wheel reports via
  `handlers.onInput`, so opencode/claude-code receive scroll input.
- **Normal screen**: keep `term.scrollLines()` for local scrollback.

Cleanest approach: dispatch a **synthetic `WheelEvent`** into xterm.js's screen
element so its own (correct) wheel→arrow / wheel→mouse-report logic runs, rather
than reimplementing the translation by hand.

## Verification plan (per AGENTS.md testing policy)

No unit tests. Verify in a real browser with `playwright-cli` / the
`muxterm-verify` skill: open a pane, run an alt-screen TUI (e.g. `vim` or
`opencode`), simulate a touch drag, and confirm the inner app scrolls.

## Key references

- `web/package.json:19-25` — xterm.js v6 + addons
- `web/src/lib/terminal-registry.ts:297-301` — `touch-action:none` host element
- `web/src/lib/terminal-registry.ts:344-370` — onData/onBinary → PTY
- `web/src/lib/terminal-registry.ts:404-435` — manual touch-scroll handler (**root cause**)
- `web/src/lib/terminal-registry.ts:57-71` — terminal config (no mouse options)
- ~~`web/src/components/mux-browser-pane.ts:838-847` — browser-pane wheel handler
  (cited for contrast)~~ — **removed code.** The browser-pane feature was deleted
  from muxterm; this file no longer exists and there is no surviving equivalent.
  `terminal-registry.ts` is now the only wheel/touch handler in the codebase.
