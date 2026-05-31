# E2E — Maximize / Restore (Single-Surface Mode, Seam S1)

Prove **single-surface mode** (seam S1): maximizing a region hides its sibling
and the focused surface fills the workspace; restoring brings the dock back.
Content survives the re-parent — the registry keeps terminals alive throughout.

Continues in the same browser session as Task 13 (two regions docked,
`mux-region-divider` visible).  Uses Phase-2 harness; no OCR.

---

## Prerequisites

1. **Docked session** — complete [dock-mount.e2e.md](./dock-mount.e2e.md)
   first; the browser must have two `mux-region` elements and one
   `mux-region-divider` in the workspace shadow DOM.
2. **playwright-cli attached** — browser session still open from Task 12/13.
3. **`assert_content` available** — sourced from `dock-mount.e2e.md` below.

---

## Step 1 — Verify Two Regions Exist (Failing Baseline)

Before maximizing, confirm the workspace is in the normal docked state with two
regions side-by-side:

```bash
playwright-cli --raw eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-workspace').shadowRoot.querySelectorAll('mux-region').length"
```

Expected: `2`

This step is the **failing baseline** — if it returns anything other than `2`
the prerequisite (dock-mount) was not completed and this test cannot proceed.

---

## Step 2 — Find the Maximize Button

Confirm that the first `mux-region` exposes a `button[data-action="maximize"]`
in its shadow DOM:

```bash
playwright-cli --raw eval "(() => { const r = document.querySelector('mux-app').shadowRoot.querySelector('mux-workspace').shadowRoot.querySelector('mux-region'); return r.shadowRoot.querySelector('button[data-action=\"maximize\"]') ? 'found' : 'missing'; })()"
```

Expected: `found`

If the result is `missing`, the maximize button has not been rendered for the
region header; the feature is not yet wired up.

---

## Step 3 — Click Maximize (Enter Single-Surface Mode)

Click the maximize button on the first region and allow the DOM transition to
settle:

```bash
playwright-cli --raw eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-workspace').shadowRoot.querySelector('mux-region').shadowRoot.querySelector('button[data-action=\"maximize\"]').click()"
sleep 0.3
```

The `sleep 0.3` covers any CSS transition or microtask queue flush before the
assertion in Step 4.

---

## Step 4 — Assert Single-Surface Mode (Verify Pass)

### 4a — Region count drops to 1

Query the workspace shadow DOM for `mux-region` elements.  The sibling region
must be hidden (or removed from the DOM) so only the maximized surface is
visible:

```bash
playwright-cli --raw eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-workspace').shadowRoot.querySelectorAll('mux-region').length"
```

Expected: `1` (sibling hidden; seam S1 single mode active)

### 4b — Content survives re-parent

The registry must keep terminal pane 1 alive across the maximize re-parent.
Load the `assert_content` helper and verify:

```bash
source web/e2e/dock-mount.e2e.md
assert_content 1
```

Expected: `CONTENT OK pane 1`

If the terminal content changed, the pane was destroyed and re-created during
the DOM transition rather than being re-parented in place.

---

## Step 5 — Restore (Toggle Maximize Off)

Click the maximize button again to toggle back to the normal docked layout, then
confirm the sibling region is restored:

```bash
playwright-cli --raw eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-workspace').shadowRoot.querySelector('mux-region').shadowRoot.querySelector('button[data-action=\"maximize\"]').click()"
sleep 0.3
playwright-cli --raw eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-workspace').shadowRoot.querySelectorAll('mux-region').length"
```

Expected: `2` (restored to dock; both regions visible again)

---

## Step 6 — Close Browser

```bash
playwright-cli close
```

---

## Acceptance Criteria

| Check | Assertion |
|-------|-----------|
| Baseline region count | `2` `mux-region` elements before maximize |
| Maximize button present | `found` in first region's shadow DOM |
| Single-surface mode | `1` `mux-region` after maximize click |
| Content survived re-parent | `CONTENT OK pane 1` from `assert_content` |
| Restore to dock | `2` `mux-region` elements after second maximize click |

---

## Commit

```bash
git add web/e2e/maximize-restore.e2e.md && git commit -m "test(phase3): e2e maximize/restore single-surface mode (content survives re-parent)"
```
