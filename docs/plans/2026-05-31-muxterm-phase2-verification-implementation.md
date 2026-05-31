# muxterm Phase 2 — Verification Lifeline Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Replace the existing OCR-based terminal verification with a 3-source fidelity model (tmux `capture-pane` oracle · xterm.js `StructuredSnapshot` logical render · `playwright-cli` physical render) so that Phase 3 (the dock) can re-parent panes self-verifyingly.

**Architecture:** A pure serializer (`snapshot.ts`) turns an xterm.js Terminal's buffer into a `StructuredSnapshot` (grid of styled cells + cursor + scroll metadata, *to the trailing blank*). The singleton `terminalRegistry` gains `snapshot(paneId)` and exposes it on `window.__muxterm` so `playwright-cli eval` can read it in real browsers. Two **pure** comparison helpers encode the CONTENT and LAYOUT fidelity invariants and are reused by both Vitest unit tests and a `playwright-cli`-driven E2E proof against the running `make dev` server. OCR (screenshots + tesseract) is deleted entirely.

**Tech Stack:** Frontend = Lit v3 + `@xterm/xterm@^6.0.0` (v6.0.0 installed) + `@xterm/addon-fit`. Tests = Vitest (happy-dom, `web/src/**/*.test.ts`) + the `playwright-cli` skill for E2E. Backend = Go (`localhost:8080`). tmux control mode is the oracle.

---

## Context the implementer MUST know before starting

You know nothing about this codebase. Read these facts; they are load-bearing.

1. **The OCR hookup is exactly one file: `tools/ocr`.** It is a standalone `uv run` Python script (shebang `#!/usr/bin/env -S uv run --script`) that screenshots the browser via `playwright-cli`, preprocesses with ImageMagick (`magick`), and runs `tesseract`. Grep confirms **nothing references it** — no Makefile target, no Go code, no TS import, no shell script. Deleting it is safe and self-contained.

2. **`web/src/components/pane.ts` is NOT OCR code.** It has `getVisibleContent()` and `getBufferLines()` methods whose *comments* say "no OCR needed". These are already xterm-buffer readers. **Do not delete or modify them in this phase.** They only show up in an OCR grep because of the word "OCR" in a comment.

3. **Vitest mocks xterm.** `web/vite.config.ts` aliases `@xterm/xterm` and `@xterm/addon-fit` to `web/src/__tests__/setup.ts`, a hand-written mock `Terminal` class. **That mock has NO `buffer` property.** Therefore you CANNOT construct a real xterm Terminal with a populated buffer inside a Vitest test. This is why the serializer is written as a **pure function over a minimal structural interface** and unit-tested with a hand-built fake buffer fixture. The *real* xterm v6 buffer API is exercised in the E2E task (Task 7) against the real browser, not in Vitest.

4. **The registry is a module-level singleton** keyed by numeric pane id (the tmux `%N` number, as a `number`). See `web/src/lib/terminal-registry.ts`. Tests reset it with `terminalRegistry.prune(new Set())` in `afterEach`.

5. **`make dev` is already running** (Vite watch + `air` Go hot-reload). The server is on **`http://localhost:8080`** (confirmed in `cmd/muxterm/cli.go`: default `Addr: "localhost:8080"`). Do not start another server. A tmux session with at least one live pane must be attached in the browser for Task 7.

6. **Run unit tests from `web/`:** `cd web && npm test` (which is `vitest run`). There is also `make test-web` from repo root. Go tests (`make test`) are not touched by this phase.

7. **Scope boundaries.** IN: OCR removal, `StructuredSnapshot` + window exposure, the two fidelity helpers, one E2E proof. OUT/DEFERRED (do NOT build): the dock (Phase 3), pop-out/chrome (Phase 4), config/polish (Phase 5), the driver app, Tier-2 `MUXTERM_CTL`, PWA/WCO, multi-viewer, float, phone. The snapshot is a **client-side test/diagnostic primitive — NOT a driver dependency** (the portable driver reads screens via `capture-pane`).

**Source of truth:** `docs/plans/2026-05-30-muxterm-panes-multisession-driver-design.md` → "Testing / Verification Strategy". Storyboard: `docs/plans/mockups/2026-05-30-muxterm-chrome/storyboard.svg`.

---

## Task list (7 tasks)

1. Remove the OCR hookup (`tools/ocr`)
2. Create `StructuredSnapshot` types + pure serializer (`web/src/lib/snapshot.ts`)
3. Wire `snapshot(paneId)` into the registry + expose on `window.__muxterm`
4. Content-fidelity helper (`web/e2e/helpers/fidelity.ts`) + unit test
5. Layout-fidelity helper (extend `fidelity.ts`) + unit test
6. Harness notes doc (`web/e2e/verification.spec-notes.md`)
7. E2E proof: `capture-pane == snapshot` on a real pane via `make dev`

---

### Task 1: Remove the OCR hookup

**Files:**
- Delete: `tools/ocr`

**Step 1: Prove `tools/ocr` exists and find every reference to it**

Run (from repo root):
```bash
ls -la tools/ocr && \
grep -rIn --exclude-dir=node_modules --exclude-dir=.git \
  -e 'tools/ocr' -e 'tesseract' -e 'magick' . \
  | grep -vi 'no OCR' | grep -v 'docs/plans/'
```
Expected: the first line shows `tools/ocr` exists (e.g. `-rwxr-xr-x ... tools/ocr`). The grep prints **no lines** (no source, Makefile, or script references it — only the design/plan docs mention OCR, and those are excluded). This confirms deletion is safe.

> If the grep prints any line pointing at real code (a `.go`, `.ts`, `.sh`, or `Makefile`), STOP and report it — the removal is not self-contained and the plan needs revision.

**Step 2: Delete the file**

Run:
```bash
git rm tools/ocr
```
Expected: `rm 'tools/ocr'`.

**Step 3: Verify it is gone and nothing broke**

Run:
```bash
test ! -e tools/ocr && echo "OCR removed" && \
grep -rIn --exclude-dir=node_modules --exclude-dir=.git -e 'tools/ocr' -e 'tesseract' . \
  | grep -v 'docs/plans/' || echo "no references remain"
```
Expected: prints `OCR removed` then `no references remain`.

Run the web suite to confirm the frontend is unaffected:
```bash
cd web && npm test
```
Expected: PASS (all existing tests green; OCR was never part of the TS build).

**Step 4: Commit**

Run:
```bash
git commit -m "chore(verify): remove OCR verification hookup (tools/ocr)"
```

---

### Task 2: Create `StructuredSnapshot` types + pure serializer

The serializer is a **pure function** over a minimal structural interface (NOT the full `Terminal`), so it is unit-testable with a fake buffer despite the Vitest xterm mock having no `buffer` (see Context fact #3).

**Files:**
- Create: `web/src/lib/snapshot.ts`
- Test: `web/src/__tests__/snapshot.test.ts`

**Step 1: Write the failing test**

Create `web/src/__tests__/snapshot.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { serializeSnapshot } from '../lib/snapshot.js';
import type { SnapshotSource, IBufferLineLike, IBufferCellLike } from '../lib/snapshot.js';

// ── Fake buffer fixture ────────────────────────────────────────────────
// The Vitest xterm mock (setup.ts) has no buffer, and a real xterm Terminal
// needs a renderer/canvas to populate one. So we hand-build a minimal buffer
// that matches the xterm v6 IBuffer/IBufferLine/IBufferCell shape the
// serializer relies on. The REAL buffer API is exercised in the E2E task.

function cell(char: string, opts: Partial<IBufferCellLike> = {}): IBufferCellLike {
  return {
    getChars: () => char,
    getWidth: () => (char === '' ? 0 : 1),
    getFgColor: () => opts.getFgColor?.() ?? -1,
    getBgColor: () => opts.getBgColor?.() ?? -1,
    isBold: () => opts.isBold?.() ?? 0,
    isInverse: () => opts.isInverse?.() ?? 0,
    isUnderline: () => opts.isUnderline?.() ?? 0,
  };
}

// Build a line from an array of chars. Trailing '' entries model blank cells.
function line(chars: string[], styled?: { col: number; cell: IBufferCellLike }): IBufferLineLike {
  return {
    // translateToString(false) returns the FULL row text including trailing blanks.
    translateToString: (trimRight?: boolean) => {
      const text = chars.map((c) => (c === '' ? ' ' : c)).join('');
      return trimRight ? text.replace(/\s+$/, '') : text;
    },
    getCell: (x: number) => {
      if (styled && x === styled.col) return styled.cell;
      return cell(chars[x] ?? '');
    },
  };
}

function makeSource(): SnapshotSource {
  const styledCell = cell('B', {
    getFgColor: () => 4,
    getBgColor: () => 0,
    isBold: () => 1,
    isInverse: () => 0,
    isUnderline: () => 1,
  });
  // 3 cols × 2 rows. Row 0: "Bi " (trailing blank). Row 1: "  " (all blank).
  const lines: IBufferLineLike[] = [
    line(['B', 'i', ''], { col: 0, cell: styledCell }),
    line(['', '', '']),
  ];
  return {
    cols: 3,
    rows: 2,
    buffer: {
      active: {
        cursorX: 2,
        cursorY: 0,
        viewportY: 0,
        baseY: 0,
        length: 2,
        getLine: (y: number) => lines[y] ?? undefined,
      },
    },
  };
}

describe('serializeSnapshot', () => {
  it('captures rows, cols, cursor, viewportY and baseY', () => {
    const snap = serializeSnapshot(makeSource());
    expect(snap.rows).toBe(2);
    expect(snap.cols).toBe(3);
    expect(snap.cursor).toEqual({ x: 2, y: 0 });
    expect(snap.viewportY).toBe(0);
    expect(snap.baseY).toBe(0);
  });

  it('preserves trailing blanks per row (rowText is "to the blank")', () => {
    const snap = serializeSnapshot(makeSource());
    // Full width = 3 chars: "Bi" + one trailing space.
    expect(snap.rowText[0]).toBe('Bi ');
    expect(snap.rowText[0].length).toBe(3);
    // Fully blank row stays 3 spaces wide, not collapsed.
    expect(snap.rowText[1]).toBe('   ');
    expect(snap.rowText[1].length).toBe(3);
  });

  it('serializes a styled cell with all attributes', () => {
    const snap = serializeSnapshot(makeSource());
    const c = snap.cells[0][0];
    expect(c.char).toBe('B');
    expect(c.width).toBe(1);
    expect(c.fg).toBe(4);
    expect(c.bg).toBe(0);
    expect(c.bold).toBe(true);
    expect(c.inverse).toBe(false);
    expect(c.underline).toBe(true);
  });

  it('produces a cols×rows cell grid', () => {
    const snap = serializeSnapshot(makeSource());
    expect(snap.cells.length).toBe(2); // rows
    expect(snap.cells[0].length).toBe(3); // cols
  });
});
```

**Step 2: Run the test to verify it fails**

Run:
```bash
cd web && npm test -- snapshot
```
Expected: FAIL — `Failed to resolve import '../lib/snapshot.js'` (the module does not exist yet).

**Step 3: Write the minimal implementation**

Create `web/src/lib/snapshot.ts`:
```ts
/**
 * snapshot — pure serializer of an xterm.js Terminal buffer into a
 * StructuredSnapshot: a cols×rows grid of styled cells plus cursor position
 * and scroll metadata, captured "to the trailing blank".
 *
 * This REPLACES OCR as muxterm's logical-render verification primitive.
 * It is a CLIENT-SIDE test/diagnostic tool only — NOT a driver dependency
 * (the portable driver reads screens via tmux capture-pane).
 *
 * Written as a pure function over a minimal structural interface so it is
 * unit-testable without a real renderer (the Vitest xterm mock has no buffer).
 * At runtime the real @xterm/xterm v6 Terminal satisfies SnapshotSource
 * structurally.
 */

export interface Cell {
  /** The character(s) in this cell (xterm getChars()). Empty string = blank. */
  char: string;
  /** Cell width: 1 normal, 2 for the left half of a wide glyph, 0 for the right half. */
  width: number;
  /** Foreground color (xterm getFgColor(); -1 = default). */
  fg: number;
  /** Background color (xterm getBgColor(); -1 = default). */
  bg: number;
  bold: boolean;
  inverse: boolean;
  underline: boolean;
}

export interface StructuredSnapshot {
  rows: number;
  cols: number;
  /** [row][col] grid of styled cells, viewport rows only. */
  cells: Cell[][];
  /**
   * Full text of each viewport row INCLUDING trailing blanks (translateToString(false)).
   * This is the "to the blank" text compared against tmux capture-pane.
   */
  rowText: string[];
  cursor: { x: number; y: number };
  viewportY: number;
  baseY: number;
}

// ── Minimal structural interfaces (subset of xterm v6 public API) ──────────

export interface IBufferCellLike {
  getChars(): string;
  getWidth(): number;
  getFgColor(): number;
  getBgColor(): number;
  isBold(): number;
  isInverse(): number;
  isUnderline(): number;
}

export interface IBufferLineLike {
  translateToString(trimRight?: boolean): string;
  getCell(x: number): IBufferCellLike | undefined;
}

export interface IBufferLike {
  cursorX: number;
  cursorY: number;
  viewportY: number;
  baseY: number;
  length: number;
  getLine(y: number): IBufferLineLike | undefined;
}

export interface SnapshotSource {
  cols: number;
  rows: number;
  buffer: { active: IBufferLike };
}

/**
 * Serialize the VISIBLE viewport of a terminal into a StructuredSnapshot.
 * Viewport rows (buffer.active.viewportY .. +rows) are captured because that
 * is what tmux capture-pane -p reports and what the browser shows.
 */
export function serializeSnapshot(term: SnapshotSource): StructuredSnapshot {
  const buf = term.buffer.active;
  const { cols, rows } = term;

  const cells: Cell[][] = [];
  const rowText: string[] = [];

  for (let r = 0; r < rows; r++) {
    const y = buf.viewportY + r;
    const line = buf.getLine(y);

    // Full row text including trailing blanks ("to the blank").
    rowText.push(line ? line.translateToString(false) : ' '.repeat(cols));

    const rowCells: Cell[] = [];
    for (let x = 0; x < cols; x++) {
      const c = line?.getCell(x);
      if (!c) {
        rowCells.push({
          char: '',
          width: 0,
          fg: -1,
          bg: -1,
          bold: false,
          inverse: false,
          underline: false,
        });
        continue;
      }
      rowCells.push({
        char: c.getChars(),
        width: c.getWidth(),
        fg: c.getFgColor(),
        bg: c.getBgColor(),
        bold: c.isBold() !== 0,
        inverse: c.isInverse() !== 0,
        underline: c.isUnderline() !== 0,
      });
    }
    cells.push(rowCells);
  }

  return {
    rows,
    cols,
    cells,
    rowText,
    cursor: { x: buf.cursorX, y: buf.cursorY },
    viewportY: buf.viewportY,
    baseY: buf.baseY,
  };
}
```

**Step 4: Run the test to verify it passes**

Run:
```bash
cd web && npm test -- snapshot
```
Expected: PASS (4 tests in `snapshot.test.ts` green).

**Step 5: Commit**

Run:
```bash
git add web/src/lib/snapshot.ts web/src/__tests__/snapshot.test.ts && \
git commit -m "feat(verify): add StructuredSnapshot serializer (replaces OCR logical render)"
```

---

### Task 3: Wire `snapshot(paneId)` into the registry + expose on `window`

Add `snapshot(paneId)` to the singleton and publish `window.__muxterm.snapshot(paneId)` so `playwright-cli eval` can read it in a real browser.

**Files:**
- Modify: `web/src/lib/terminal-registry.ts`
- Test: `web/src/__tests__/terminal-registry.test.ts` (append cases)

**Step 1: Write the failing test**

Append to `web/src/__tests__/terminal-registry.test.ts`, inserting this block immediately **before** the final closing `});` of the top-level `describe('terminalRegistry', ...)`:
```ts
  // ────────────────────────────────────────────────────────────────────
  // snapshot + window exposure
  // ────────────────────────────────────────────────────────────────────
  describe('snapshot', () => {
    it('returns null for an unknown paneId', () => {
      expect(terminalRegistry.snapshot(9999)).toBeNull();
    });

    it('is exposed on window.__muxterm.snapshot', () => {
      expect(typeof (window as any).__muxterm?.snapshot).toBe('function');
      expect((window as any).__muxterm.snapshot(9999)).toBeNull();
    });
  });
```

**Step 2: Run the test to verify it fails**

Run:
```bash
cd web && npm test -- terminal-registry
```
Expected: FAIL — `terminalRegistry.snapshot is not a function` (and the window exposure assertion also fails).

**Step 3: Write the minimal implementation**

In `web/src/lib/terminal-registry.ts`, add the snapshot import at the top (after the existing imports on lines 14–16):
```ts
import { serializeSnapshot } from './snapshot.js';
import type { StructuredSnapshot, SnapshotSource } from './snapshot.js';
```

Add a `snapshot` method to the `terminalRegistry` object. Insert it immediately **after** the `getTerminal` method (i.e. after its closing `},` near the end of the object literal), keeping the trailing comma style:
```ts
  /**
   * Serialize a pane's xterm buffer into a StructuredSnapshot (logical render,
   * "to the trailing blank"). Returns null if the pane is not ensured.
   * This is the OCR replacement — a client-side verification/diagnostic primitive.
   */
  snapshot(paneId: number): StructuredSnapshot | null {
    const entry = _map.get(paneId);
    if (!entry) return null;
    // The real @xterm/xterm Terminal satisfies SnapshotSource structurally.
    return serializeSnapshot(entry.term as unknown as SnapshotSource);
  },
```

Then, at the very **end of the file** (after the closing `};` of the `terminalRegistry` object literal), add the window exposure:
```ts
// Expose the snapshot primitive to E2E tooling (playwright-cli eval) in real
// browsers. Guarded so it is harmless under SSR / non-DOM environments.
// Under Vitest happy-dom, window exists, so unit tests can assert this too.
if (typeof window !== 'undefined') {
  (window as unknown as { __muxterm?: Record<string, unknown> }).__muxterm = {
    ...(window as unknown as { __muxterm?: Record<string, unknown> }).__muxterm,
    snapshot: (paneId: number) => terminalRegistry.snapshot(paneId),
  };
}
```

**Step 4: Run the test to verify it passes**

Run:
```bash
cd web && npm test -- terminal-registry
```
Expected: PASS (existing registry tests stay green; the two new `snapshot` cases pass).

Run the full suite to confirm no regressions:
```bash
cd web && npm test
```
Expected: PASS (all files green).

**Step 5: Commit**

Run:
```bash
git add web/src/lib/terminal-registry.ts web/src/__tests__/terminal-registry.test.ts && \
git commit -m "feat(verify): expose terminalRegistry.snapshot + window.__muxterm.snapshot"
```

---

### Task 4: Content-fidelity helper + unit test

`fidelity.ts` holds **pure** comparison functions (no `playwright` import) so it is importable by both Vitest and the E2E script. CONTENT fidelity: tmux `capture-pane` text must equal the xterm snapshot text, per row, trailing-blank-exact.

**Files:**
- Create: `web/e2e/helpers/fidelity.ts`
- Test: `web/src/__tests__/fidelity.test.ts`

**Step 1: Write the failing test**

Create `web/src/__tests__/fidelity.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { compareContent } from '../../e2e/helpers/fidelity.js';
import type { StructuredSnapshot } from '../lib/snapshot.js';

function snap(rowText: string[], cols: number): StructuredSnapshot {
  return {
    rows: rowText.length,
    cols,
    cells: [],
    rowText,
    cursor: { x: 0, y: 0 },
    viewportY: 0,
    baseY: 0,
  };
}

describe('compareContent (CONTENT fidelity)', () => {
  it('passes when capture-pane text equals snapshot text per row', () => {
    // capture-pane right-trims rows; the snapshot keeps trailing blanks.
    // The comparison normalizes by right-trimming BOTH sides per row.
    const capture = 'hello\nworld';
    const s = snap(['hello   ', 'world   '], 8);
    const result = compareContent(capture, s);
    expect(result.ok).toBe(true);
    expect(result.diffs).toEqual([]);
  });

  it('fails and reports the first divergent row', () => {
    const capture = 'hello\nWRONG';
    const s = snap(['hello   ', 'world   '], 8);
    const result = compareContent(capture, s);
    expect(result.ok).toBe(false);
    expect(result.diffs.length).toBeGreaterThan(0);
    expect(result.diffs[0].row).toBe(1);
    expect(result.diffs[0].expected).toBe('WRONG');
    expect(result.diffs[0].actual).toBe('world');
  });

  it('fails when row counts differ (lost/duplicated content)', () => {
    const capture = 'a\nb\nc';
    const s = snap(['a', 'b'], 1);
    const result = compareContent(capture, s);
    expect(result.ok).toBe(false);
    expect(result.diffs.some((d) => d.reason === 'row-count')).toBe(true);
  });
});
```

**Step 2: Run the test to verify it fails**

Run:
```bash
cd web && npm test -- fidelity
```
Expected: FAIL — `Failed to resolve import '../../e2e/helpers/fidelity.js'` (module not created yet).

**Step 3: Write the minimal implementation**

Create `web/e2e/helpers/fidelity.ts`:
```ts
/**
 * fidelity — pure comparison helpers encoding the two verification invariants
 * from the design's Testing / Verification Strategy.
 *
 *   CONTENT fidelity:  tmux capture-pane text  ==  xterm.js snapshot text
 *   LAYOUT fidelity :  xterm viewportY + dims  ==  playwright-cli measured scroll + width
 *
 * These functions are PURE (no playwright/tmux imports) so they run in Vitest
 * AND are callable from the playwright-cli-driven E2E script (see
 * web/e2e/verification.spec-notes.md). The E2E layer supplies the two real
 * inputs (capture-pane stdout; window.__muxterm.snapshot(...) JSON).
 */

import type { StructuredSnapshot } from '../../src/lib/snapshot.js';

export interface ContentDiff {
  row: number;
  expected: string; // capture-pane row (right-trimmed)
  actual: string; // snapshot row (right-trimmed)
  reason: 'mismatch' | 'row-count';
}

export interface ContentResult {
  ok: boolean;
  diffs: ContentDiff[];
}

/**
 * CONTENT fidelity: does the browser's xterm render match tmux truth?
 * tmux capture-pane -p right-trims each row; the snapshot keeps trailing
 * blanks. We right-trim BOTH per row so the comparison is exact on visible
 * content while tolerating only the known trailing-blank difference.
 */
export function compareContent(
  capturePane: string,
  snapshot: StructuredSnapshot,
): ContentResult {
  const diffs: ContentDiff[] = [];
  const captureRows = capturePane.replace(/\n$/, '').split('\n');
  const snapRows = snapshot.rowText;

  const rtrim = (s: string) => s.replace(/\s+$/, '');

  if (captureRows.length !== snapRows.length) {
    diffs.push({
      row: -1,
      expected: `${captureRows.length} rows`,
      actual: `${snapRows.length} rows`,
      reason: 'row-count',
    });
  }

  const n = Math.min(captureRows.length, snapRows.length);
  for (let i = 0; i < n; i++) {
    const expected = rtrim(captureRows[i]);
    const actual = rtrim(snapRows[i]);
    if (expected !== actual) {
      diffs.push({ row: i, expected, actual, reason: 'mismatch' });
    }
  }

  return { ok: diffs.length === 0, diffs };
}
```

**Step 4: Run the test to verify it passes**

Run:
```bash
cd web && npm test -- fidelity
```
Expected: PASS (3 `compareContent` cases green).

**Step 5: Commit**

Run:
```bash
git add web/e2e/helpers/fidelity.ts web/src/__tests__/fidelity.test.ts && \
git commit -m "feat(verify): add CONTENT-fidelity helper (capture-pane == snapshot)"
```

---

### Task 5: Layout-fidelity helper + unit test

LAYOUT fidelity: the xterm logical buffer's `viewportY` + grid dims must agree with `playwright-cli`-measured physical scroll position and width.

**Files:**
- Modify: `web/e2e/helpers/fidelity.ts` (append)
- Test: `web/src/__tests__/fidelity.test.ts` (append)

**Step 1: Write the failing test**

Append to `web/src/__tests__/fidelity.test.ts` (after the existing `describe('compareContent', ...)` block, before end of file):
```ts
import { compareLayout } from '../../e2e/helpers/fidelity.js';
import type { MeasuredLayout } from '../../e2e/helpers/fidelity.js';

function layoutSnap(viewportY: number, cols: number, rows: number): StructuredSnapshot {
  return {
    rows,
    cols,
    cells: [],
    rowText: [],
    cursor: { x: 0, y: 0 },
    viewportY,
    baseY: viewportY,
  };
}

describe('compareLayout (LAYOUT fidelity)', () => {
  const measured: MeasuredLayout = {
    scrollTop: 200, // px
    rowHeight: 20, // px per row  → scrollTop/rowHeight = 10 rows scrolled
    clientWidth: 800, // px
    cellWidth: 10, // px per cell → clientWidth/cellWidth = 80 cols
    rows: 24,
  };

  it('passes when logical viewportY and dims match measured physical render', () => {
    const result = compareLayout(layoutSnap(10, 80, 24), measured);
    expect(result.ok).toBe(true);
    expect(result.diffs).toEqual([]);
  });

  it('fails on scroll drift (viewportY disagrees with scrollTop)', () => {
    const result = compareLayout(layoutSnap(7, 80, 24), measured);
    expect(result.ok).toBe(false);
    expect(result.diffs.some((d) => d.field === 'scroll')).toBe(true);
  });

  it('fails on width miscalc (cols disagrees with clientWidth)', () => {
    const result = compareLayout(layoutSnap(10, 70, 24), measured);
    expect(result.ok).toBe(false);
    expect(result.diffs.some((d) => d.field === 'cols')).toBe(true);
  });
});
```

**Step 2: Run the test to verify it fails**

Run:
```bash
cd web && npm test -- fidelity
```
Expected: FAIL — `compareLayout` / `MeasuredLayout` are not exported from `fidelity.js`.

**Step 3: Write the minimal implementation**

Append to `web/e2e/helpers/fidelity.ts`:
```ts
export interface MeasuredLayout {
  /** Physical scroll offset of the terminal viewport, in CSS px (element.scrollTop). */
  scrollTop: number;
  /** Rendered height of one terminal row, in CSS px. */
  rowHeight: number;
  /** Rendered width of the terminal viewport, in CSS px (element.clientWidth). */
  clientWidth: number;
  /** Rendered width of one cell, in CSS px. */
  cellWidth: number;
  /** Expected visible row count (xterm term.rows). */
  rows: number;
}

export interface LayoutDiff {
  field: 'scroll' | 'cols' | 'rows';
  expected: number;
  actual: number;
}

export interface LayoutResult {
  ok: boolean;
  diffs: LayoutDiff[];
}

/**
 * LAYOUT fidelity: does the physical browser render agree with the logical
 * buffer? Converts the measured pixel facts into cell units and compares to the
 * snapshot's logical values. Catches fit miscalcs, scroll drift, responsive bugs.
 * A ±1 cell tolerance absorbs sub-pixel rounding in cellWidth/rowHeight.
 */
export function compareLayout(
  snapshot: StructuredSnapshot,
  measured: MeasuredLayout,
): LayoutResult {
  const diffs: LayoutDiff[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;

  const measuredRowsScrolled = Math.round(measured.scrollTop / measured.rowHeight);
  if (!near(measuredRowsScrolled, snapshot.viewportY)) {
    diffs.push({ field: 'scroll', expected: measuredRowsScrolled, actual: snapshot.viewportY });
  }

  const measuredCols = Math.round(measured.clientWidth / measured.cellWidth);
  if (!near(measuredCols, snapshot.cols)) {
    diffs.push({ field: 'cols', expected: measuredCols, actual: snapshot.cols });
  }

  if (!near(measured.rows, snapshot.rows)) {
    diffs.push({ field: 'rows', expected: measured.rows, actual: snapshot.rows });
  }

  return { ok: diffs.length === 0, diffs };
}
```

**Step 4: Run the test to verify it passes**

Run:
```bash
cd web && npm test -- fidelity
```
Expected: PASS (all `compareContent` + `compareLayout` cases green).

Run the full suite:
```bash
cd web && npm test
```
Expected: PASS (every file green).

**Step 5: Commit**

Run:
```bash
git add web/e2e/helpers/fidelity.ts web/src/__tests__/fidelity.test.ts && \
git commit -m "feat(verify): add LAYOUT-fidelity helper (snapshot dims == playwright-cli measured)"
```

---

### Task 6: Harness notes doc

Document how to run the 3-source harness against `make dev` — so the next engineer (Phase 3) can self-verify every pane re-parent.

**Files:**
- Create: `web/e2e/verification.spec-notes.md`

**Step 1: Write the doc**

Create `web/e2e/verification.spec-notes.md`:
```markdown
# Verification harness — how to run it

Three sources, each in its lane (see the design doc's *Testing / Verification Strategy*):

1. **tmux `capture-pane`** — the oracle ("what SHOULD exist").
2. **xterm.js `StructuredSnapshot`** — logical render "to the blank" (replaces OCR).
   Read via `window.__muxterm.snapshot(paneId)`.
3. **`playwright-cli`** — physical render ("what the BROWSER shows"): real `scrollTop`,
   `clientWidth`, element geometry.

Two invariants, encoded as pure helpers in `web/e2e/helpers/fidelity.ts`:

- `compareContent(capturePaneText, snapshot)` → CONTENT fidelity (kills blank-tab /
  duplicated-content / lost-window bugs).
- `compareLayout(snapshot, measured)` → LAYOUT fidelity (catches fit miscalcs, scroll
  drift, responsive bugs).

## Prerequisites

- `make dev` is running (Vite watch + `air`). Server: **http://localhost:8080**
  (default `Addr` in `cmd/muxterm/cli.go`).
- A tmux session is attached in the browser with at least one live pane.
- The `playwright-cli` skill is available (see the `playwright-cli` skill for setup,
  session flags, and the extension token).

## Reading a snapshot from the browser

```bash
playwright-cli open http://localhost:8080
# paneId is the numeric tmux %N (e.g. pane %1 → snapshot(1)).
playwright-cli eval "JSON.stringify(window.__muxterm.snapshot(1))"
```

## Reading the oracle from tmux

```bash
# -p prints to stdout; -t targets the global pane id %N.
tmux capture-pane -p -t %1
```

## CONTENT fidelity (one pane)

The runnable proof lives in `web/e2e/content-fidelity.mjs` (Task 7). It:
1. `tmux capture-pane -p -t %N`  → oracle text
2. `playwright-cli eval "JSON.stringify(window.__muxterm.snapshot(N))"`  → snapshot JSON
3. `compareContent(oracle, snapshot)` → asserts `ok === true`, prints diffs on failure.

Run it (with `make dev` up and a pane visible):

```bash
node web/e2e/content-fidelity.mjs --pane 1
```

## LAYOUT fidelity (one pane)

Gather the physical facts with `playwright-cli eval` against the terminal viewport
element, build a `MeasuredLayout`, then call `compareLayout(snapshot, measured)`.
Measure `scrollTop`, row height, `clientWidth`, and cell width from the live DOM
(the `mux-pane` host element / xterm viewport). LAYOUT fidelity becomes load-bearing
in Phase 3 when divider-drag resize and dock mounts change pixel boxes.

## Why no OCR

OCR (`tools/ocr`, deleted in Phase 2) screenshotted the canvas and ran tesseract —
lossy, slow, flaky on terminal fonts. The xterm buffer gives exact characters AND
styles "to the blank", with zero image processing.
```

**Step 2: Verify it renders / has no broken paths**

Run:
```bash
test -f web/e2e/verification.spec-notes.md && echo "notes present"
```
Expected: `notes present`.

**Step 3: Commit**

Run:
```bash
git add web/e2e/verification.spec-notes.md && \
git commit -m "docs(verify): document 3-source harness vs make dev"
```

---

### Task 7: E2E proof — `capture-pane == snapshot` on a real pane

Prove the CONTENT-fidelity invariant end-to-end against the running `make dev` server and a real xterm v6 buffer (exercising the real buffer API the unit tests stubbed).

**Files:**
- Create: `web/e2e/content-fidelity.mjs`

**Step 1: Write the E2E runner**

Create `web/e2e/content-fidelity.mjs`:
```js
#!/usr/bin/env node
/**
 * E2E CONTENT-fidelity proof: tmux capture-pane == window.__muxterm.snapshot.
 *
 * Prerequisites:
 *   - `make dev` running on http://localhost:8080
 *   - a tmux session attached in the browser with a live, visible pane
 *   - playwright-cli available and already attached to the browser
 *
 * Usage:
 *   node web/e2e/content-fidelity.mjs --pane 1
 *
 * Exit code 0 = invariant holds; 1 = divergence (prints diffs); 2 = setup error.
 */

import { execFileSync } from 'node:child_process';
import { compareContent } from './helpers/fidelity.ts';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const paneId = Number(arg('--pane', '1'));
const url = arg('--url', 'http://localhost:8080');

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}

try {
  // 1) Oracle: tmux capture-pane (what SHOULD exist).
  const oracle = sh('tmux', ['capture-pane', '-p', '-t', `%${paneId}`]);

  // 2) Logical render: read the snapshot from the live browser via playwright-cli.
  sh('playwright-cli', ['open', url]);
  const evalOut = sh('playwright-cli', [
    'eval',
    `JSON.stringify(window.__muxterm.snapshot(${paneId}))`,
  ]);

  // playwright-cli prints the eval result; extract the JSON object substring.
  const start = evalOut.indexOf('{');
  const end = evalOut.lastIndexOf('}');
  if (start === -1 || end === -1) {
    console.error('Could not parse snapshot JSON from playwright-cli output:\n', evalOut);
    process.exit(2);
  }
  const snapshot = JSON.parse(evalOut.slice(start, end + 1));
  if (!snapshot || !Array.isArray(snapshot.rowText)) {
    console.error('Snapshot was null/invalid — is pane %' + paneId + ' ensured and visible?');
    process.exit(2);
  }

  // 3) Assert CONTENT fidelity.
  const result = compareContent(oracle, snapshot);
  if (result.ok) {
    console.log(`✓ CONTENT fidelity holds for pane %${paneId} (${snapshot.rowText.length} rows)`);
    process.exit(0);
  }
  console.error(`✗ CONTENT fidelity FAILED for pane %${paneId}:`);
  for (const d of result.diffs) {
    console.error(`  row ${d.row} [${d.reason}]: expected=${JSON.stringify(d.expected)} actual=${JSON.stringify(d.actual)}`);
  }
  process.exit(1);
} catch (err) {
  console.error('E2E harness error:', err.message);
  process.exit(2);
}
```

> **Note on the `.ts` import:** Node ≥ 22.6 runs `.ts` imports via `--experimental-strip-types`. If the runtime errors on the TypeScript import, run with `node --experimental-strip-types web/e2e/content-fidelity.mjs --pane 1`. If your Node is older, transpile `fidelity.ts` first (`cd web && npx tsc e2e/helpers/fidelity.ts --outDir /tmp/fid --module esnext --target es2021`) and import the emitted `.js`. Confirm your Node version with `node --version` before running.

**Step 2: Confirm `make dev` is up and a pane is live**

Run:
```bash
curl -fsS -o /dev/null http://localhost:8080 && echo "dev server up" && \
tmux capture-pane -p -t %1 | head -3
```
Expected: `dev server up`, then the first ~3 rows of pane `%1`'s content. If `make dev` is not up or no tmux pane `%1` exists, fix that first (the parent session has `make dev` running — pick the visible pane's actual `%N` from `tmux list-panes -a -F '#{pane_id}'`).

**Step 3: Run the E2E proof**

Run (adjust `--pane` to the visible pane's `%N`):
```bash
node web/e2e/content-fidelity.mjs --pane 1
```
Expected: `✓ CONTENT fidelity holds for pane %1 (N rows)` and exit code 0.

> If it prints `✗ CONTENT fidelity FAILED` with row diffs, that is the harness **working** — it found a real divergence between tmux truth and the browser render. Investigate the divergence (a genuine blank/dup/lost-content bug) rather than weakening the assertion. If it exits 2, it is a setup problem (server down, pane not visible, snapshot null) — fix the prerequisite.

**Step 4: Make the runner executable and commit**

Run:
```bash
chmod +x web/e2e/content-fidelity.mjs && \
git add web/e2e/content-fidelity.mjs && \
git commit -m "test(verify): E2E proof capture-pane == snapshot on a real pane"
```

---

## Done — Phase 2 exit criteria

- [ ] `tools/ocr` deleted; no OCR/tesseract/magick references remain in source.
- [ ] `serializeSnapshot` returns a trailing-blank-exact, styled `StructuredSnapshot` (Vitest green).
- [ ] `terminalRegistry.snapshot(paneId)` works and `window.__muxterm.snapshot` is exposed (Vitest green).
- [ ] `compareContent` and `compareLayout` pure helpers exist with unit tests (Vitest green).
- [ ] `web/e2e/verification.spec-notes.md` documents running the harness vs `make dev`.
- [ ] `node web/e2e/content-fidelity.mjs` proves `capture-pane == snapshot` on a real pane.
- [ ] `cd web && npm test` is fully green.

This verification lifeline is **build-early infrastructure** for Phase 3: every dock mount / divider-drag resize / pop-out re-parent must be checked with `compareContent` (and, for resize, `compareLayout`) against tmux truth and browser reality. Do not re-parent panes without it in hand.

**Deferred (NOT this phase):** dock (P3), pop-out/chrome (P4), config/polish (P5), driver app, Tier-2 `MUXTERM_CTL`, PWA/WCO, multi-viewer, float, phone.
