---
name: muxterm-verify
description: >
  Use when verifying muxterm works correctly end-to-end as a real user would experience it.
  Catches garbled terminal text on reconnect, pane deletions not persisting to the server,
  selected-pane state not surviving browser refresh, split layout regressions, bell dot
  indicators on pane tabs and workspace dock slots, and mobile pane picker behavior.
  Run before merging any pane, terminal, reconnect, WebSocket, or bell/attention changes.
  Invoke as /muxterm-verify.
user-invocable: true
disable-model-invocation: true
context: fork
model_role: general
allowed-tools:
  - read_file
  - delegate
---

# muxterm Verification Journey

Execute all user journeys defined in `SCENARIO.md` by driving a real browser via
`browser-tester:browser-operator`. Report pass/fail tables for all 17+ checks across the
core journey (Scenarios 1–4) and attention management scenarios (Scenarios 5–6).

**Success artifact**: Three completed pass/fail tables with actual values for all 17+ checks,
and a final PASS or FAIL verdict.

## Inputs

- `<base_url>` — Base URL for muxterm (default: `http://localhost:9090`)

## Steps

### 1. Read the Scenario

Read the full scenario document (core journey + attention management scenarios):

```
read_file("/home/ken/workspace/muxterm/SCENARIO.md")
```

**Success criteria**: SCENARIO.md is loaded and all scenarios (core + attention management)
are understood — Scenarios 1–4 (core journey, 9 checks), Scenario 5 (attention management
desktop, 5 checks), and Scenario 6 (attention management mobile, 8 checks).

### 2. Run All Journeys via Browser Operator

Delegate the full SCENARIO.md to `browser-tester:browser-operator`. Pass the complete
SCENARIO.md content as the instruction, plus the execution instructions below verbatim.

**Execution**: Delegate to `browser-tester:browser-operator` with `context_depth="none"`.

Append this block to the scenario content when delegating:

---

**Execution instructions for browser-operator:**

Base URL: `http://localhost:9090` (or the URL provided by the user).

Use a fresh browser session (no cached state). For every JS snippet in the scenario,
use agent-browser's eval mechanism.

**Shadow DOM access — use this pattern for every DOM query:**
```js
const dock = document.querySelector('mux-app').shadowRoot.querySelector('mux-dock');
```

**Garbled text detector:**
```js
function isClean(text) {
  return !/\x1b/.test(text)        // no ESC at all (CSI, DCS, OSC, ST, SS3, RIS, …)
      && !/\$\$\$\$/.test(text)    // no measurement leak artifacts
      && !/~~~~/.test(text)        // no xterm sizing garbage
      && !/\ufffd/.test(text);     // no unicode replacement chars
}
```

Run Scenarios 1–4 first (core journey), then Scenario 5 (desktop attention management,
viewport 1280×800), then Scenario 6 (mobile pane picker, viewport 390×844).

After completing all scenarios, output three combined pass/fail tables:

**Table 1 — Core journey (9 checks):**

```
| #  | Assertion                                     | Expected     | Actual | PASS/FAIL |
|----|-----------------------------------------------|--------------|--------|-----------|
|  1 | Terminal clean on fresh load                  | isClean=true |        |           |
|  2 | activePaneId === pane2Id after refresh         | true         |        |           |
|  3 | Both terminals clean after refresh             | isClean=true |        |           |
|  4 | Pane 2 absent after delete + refresh           | one tab      |        |           |
|  5 | activePaneId === pane1Id after delete+refresh  | true         |        |           |
|  6 | Pane 1 terminal clean after delete             | isClean=true |        |           |
|  7 | Split layout survives refresh                  | both panes   |        |           |
|  8 | activePaneId === pane1Id in split layout        | true         |        |           |
|  9 | Both split terminals clean                     | isClean=true |        |           |
```

**Table 2 — Attention management Desktop (5 checks, viewport 1280×800):**

```
| #  | Assertion                                     | Expected        | Actual | PASS/FAIL |
|----|-----------------------------------------------|-----------------|--------|-----------|
| A1 | Tab shows ● after background pane bell         | ● visible       |        |           |
| A2 | Tab ● clears after focusing that pane          | ● gone          |        |           |
| B1 | Dock slot shows ● for inactive workspace bell  | ● visible       |        |           |
| B2 | Dock ● clears after switching to workspace     | ● gone          |        |           |
| C1 | Tab sizing: inactive 80px / active 180px       | 80px / 180px    |        |           |
```

**Table 3 — Attention management Mobile (8 checks, viewport 390×844):**

```
| #  | Assertion                                     | Expected        | Actual | PASS/FAIL |
|----|-----------------------------------------------|-----------------|--------|-----------|
| A1 | Tab strip hidden at 390px viewport             | hidden          |        |           |
| A2 | Pane picker trigger visible in title bar       | visible         |        |           |
| A3 | Breadcrumb shows › separator and ▾ indicator   | › and ▾ present |        |           |
| B1 | Dropdown opens on picker tap                   | dropdown shown  |        |           |
| B2 | Dropdown shows ● on pane with bell             | ● visible       |        |           |
| B3 | Bell ● clears after switching to that pane     | ● gone          |        |           |
| C1 | Dock bar visible at mobile viewport            | visible         |        |           |
| C2 | Workspace switch works via dock bar            | ws switched     |        |           |
```

Final verdict: **PASS** (all 17+ checks green) or **FAIL** (list failing checks with actual values).

---

**Success criteria**: browser-operator has walked through all 6 phases and returned three
completed tables with actual values for all 17+ checks.

### 3. Report Results

Relay all three pass/fail tables and the final verdict back to the user.
If any checks failed, highlight the actual values observed so the bugs are clearly visible.

**Success criteria**: User has a clear PASS/FAIL verdict with evidence for all 17+ checks
across the core journey, attention management desktop, and attention management mobile scenarios.
