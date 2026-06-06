---
name: muxterm-verify
description: >
  Use when verifying muxterm works correctly end-to-end as a real user would experience it.
  Catches garbled terminal text on reconnect, pane deletions not persisting to the server,
  selected-pane state not surviving browser refresh, and split layout regressions.
  Run before merging any pane, terminal, reconnect, or WebSocket changes.
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

Execute the user journey defined in `SCENARIO.md` (project root) by driving a real
browser via `browser-tester:browser-operator`. Report a 9-check pass/fail table.

**Success artifact**: A completed pass/fail table with actual values for all 9 checks,
and a final PASS or FAIL verdict.

## Inputs

- `` — Base URL for muxterm (default: `http://localhost:9090`)

## Steps

### 1. Read the Scenario

Read the full scenario document:

```
read_file("/home/ken/workspace/muxterm/SCENARIO.md")
```

**Success criteria**: SCENARIO.md is loaded and its 4 phases and 9 assertions are understood.

### 2. Run the Journey via Browser Operator

Delegate the full scenario to `browser-tester:browser-operator`. Pass the complete
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

After completing all 4 phases, output this table with actual observed values:

```
| # | Assertion                                     | Expected    | Actual | PASS/FAIL |
|---|-----------------------------------------------|-------------|--------|-----------|
| 1 | Terminal clean on fresh load                  | isClean=true |       |           |
| 2 | activePaneId === pane2Id after refresh         | true        |        |           |
| 3 | Both terminals clean after refresh             | isClean=true |       |           |
| 4 | Pane 2 absent after delete + refresh           | one tab     |        |           |
| 5 | activePaneId === pane1Id after delete+refresh  | true        |        |           |
| 6 | Pane 1 terminal clean after delete             | isClean=true |       |           |
| 7 | Split layout survives refresh                  | both panes  |        |           |
| 8 | activePaneId === pane1Id in split layout        | true        |        |           |
| 9 | Both split terminals clean                     | isClean=true |       |           |
```

Final verdict: **PASS** (all 9 green) or **FAIL** (list failing checks with actual values).

---

**Success criteria**: browser-operator has walked through all 4 phases and returned
a completed table with actual values for all 9 checks.

### 3. Report Results

Relay the full pass/fail table and final verdict back to the user.
If any checks failed, highlight the actual values observed so the bugs are clearly visible.

**Success criteria**: User has a clear PASS/FAIL verdict with evidence.
