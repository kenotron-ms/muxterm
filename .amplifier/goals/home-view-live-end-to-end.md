# Goal — the muxterm home view is live on main and proven end to end

## Outcome

The five stacked PRs are merged to `main`, and a real Amplifier session started
from the composer box in a browser has been observed reporting its own state
into the home view — with no snapshot file written by hand.

## Exit

Complete when **either** every numbered item below reaches a terminal state,
**or** it is conclusively demonstrated that the remainder cannot, naming the
blocker for each. Items ending FAIL or BLOCKED are residuals to report, not
failures of this goal.

Terminal states per item: `PASS` / `FAIL-<named reason>` / `BLOCKED-<named reason>`.

A single BLOCKED item never blocks the goal. Record it and move to the next item.

## Part A — Land the code

**A1. Merge in dependency order.** #48 first, then #49, #50, #51, #52. Merge
them yourself with `gh pr merge`; do not wait for a reviewer.
→ FAIL-`merge-conflict-<pr>` if a conflict cannot be resolved from the
branches' own contents. → BLOCKED-`push-denied` if the remote refuses.

**A2. Open and merge a PR for the work that is only on `hv-integration`.**
That is the browser wiring commit plus the two design commits. Same rule: merge
it yourself.
→ FAIL-`<named reason>` if it cannot be opened or merged.

**A3. Read the combined diff before merging, not only per-branch diffs.** Use
three-dot form (`git diff main...<branch>`). Report anything two branches
introduce at different paths that does the same job.
→ PASS with findings listed, or PASS with "no cross-branch duplication found".

**A4. Gates green after every merge**, re-run each time: `go build ./...`
clean, and `cd web && npm run check:fast` reporting 0 errors. Baseline is 8
warnings / 0 errors; more warnings is acceptable, any error is not.
→ FAIL-`gate-<name>` naming the first merge that broke it.

## Part B — Make one session real

**B1. Install the updated hook** (`modules/hooks-muxterm-session`, containing
`state.py`) into an environment an Amplifier session will actually load. The
currently installed module is version 0.2.0 and does not write snapshots.
→ BLOCKED-`hook-needs-global-install` is a legitimate terminal state if this
cannot be done without modifying the user's global Amplifier environment. Report
what would be required and stop; do not force it.

**B2. Start a session from the composer box** in a browser against
`http://127.0.0.1:8479/`. Type a prompt, press Enter. Confirm a pane appears and
the prompt is typed into it.
→ FAIL-`dispatch-<named reason>` if the pane is not created or the prompt does
not reach the PTY.

**B3. That session runs and reaches a terminal state on its own.** Give it work
that finishes within this session, such as printing a short answer.
→ FAIL-`session-<named reason>`.

**B4. Its state reaches the home view without a hand-written file.** Observe it
in `Working` while it runs, and in its terminal group afterwards.
→ FAIL-`state-not-observed` with the last state actually seen.
→ BLOCKED-`depends-on-B1` if B1 is BLOCKED.

## Part C — Click through the eight designed behaviours

Each is independently terminal. A FAIL on one does not stop the rest.

**C1. Start card count equals the sum of the sidebar workspace badges.** Read
both from the rendered DOM and compare the numbers.

**C2. The N-to-zero transition.** Drive the live set to empty and confirm the
count reaches 0. The `sessions` field is `omitempty` on the wire, so that frame
carries no field at all; frame arrival is the signal and a missing field is the
empty set. Report the observed count before and after.

**C3. Grouping placement holds with live data** for `Needs input`, `Working`,
`Ready for review` (session has an open PR), and `Completed` (merges done,
failed and stopped). Report any row that lands in the wrong group.

**C4. An interactive session that ends its turn and waits does NOT appear in
`Needs input`.** Its resting state is `stopped`.

**C5. An autonomous session whose loop stops DOES appear in `Needs input`.**

**C6. Tiles/Cards toggle persists across a page reload.**

**C7. `ctrl+backtick` toggles the home view, and a bare backtick still types a
backtick into a terminal pane.**

**C8. Keyboard and row interactions work**: `j`/`k` move, `space` peeks,
`enter` opens the pane, `esc` dismisses. Report each verb individually.

Each C item: → `PASS` with the observed evidence, or
→ `FAIL-<what was observed instead>`, or → `BLOCKED-<named reason>`.

## Evidence

Show evidence inline as it is produced — DOM readouts, command output, file
contents, screenshots-described. State what was observed, not only that a check
passed.

## Safety — applies to every step

A person is using this machine now.

- Never run `pkill`, `killall`, or any broad process kill. Kill only a PID you
  recorded yourself.
- Never touch PID 243169 (`muxterm serve :9090`), PID 383383 (the user's
  `sessiond`, socket `/run/user/1000/muxterm/sessiond.sock`), or ports 9090,
  8477, 8478, 8313.
- Never run `make dev-local`.
- The verification target is `/tmp/hv-real/muxterm-hv serve :8479` with its
  `sessiond`. If the server must restart, kill only the server's own recorded
  PID and leave its `sessiond` running so panes survive.
- Any daemon you start must override `XDG_RUNTIME_DIR`, `XDG_DATA_HOME` and
  `XDG_CONFIG_HOME` together under a private directory. Confirm the override
  by reading `/proc/<pid>/environ` of the started process.
- Use a fresh workspace and pane for each verification run.

## Teardown — part of DONE

Before finishing, either remove or explicitly hand off, by name, every resource
this run started: headless browsers and their CDP ports, any daemon or server
started for verification, any temporary directories, any tunnel created.

State the disposition of each. Leaving the `:8479` verification stack and the
`zakxv` tunnel running is acceptable **only** if named explicitly as a handoff
for the user to inspect. Anything not named is treated as not torn down.

## SCOPE-OUTS

- Deploying anywhere, or restarting the user's own muxterm, is NOT required.
- Elapsed-time observation is NOT required. Every check completes in this run.
- Waiting for a human reviewer is NOT required and must not be waited on.
- Exercising the Claude Code adapter is NOT required. One Amplifier session is
  the proof; a second harness is optional.
- Unit tests are banned by `AGENTS.md`. Do not add `*_test.go` or `*.test.ts`.
  If an existing test breaks, fix it to match the new behaviour.
- Fixing the chrome state-colour contrast gap in `mux-sidebar.ts` /
  `mux-dock.ts` is NOT in scope; it belongs to the design system.
- Closing or reworking the older PRs #32, #33, #34 is NOT required.
- Uniform coverage is not the goal. Eight C items each resolving to their own
  terminal state satisfies Part C, including when some are BLOCKED.

## KNOWN — speed aid only, not criteria

- **`playwright-cli` is installed and working** (`@playwright/cli` 0.1.19, at
  `/home/ken/.npm-global/bin/playwright-cli`). It drives a real browser and
  returns an accessibility-tree snapshot with `[ref=eN]` handles you can click,
  fill, press and eval against. Verbs: `open` `goto` `snapshot` `find` `click`
  `fill` `type` `press` `eval` `screenshot` `console` `reload` `close`
  `localstorage-get/set` `resize`.
  It defaults to the `chrome` channel, which is not present on this host.
  `.playwright/cli.config.json` in the repo pins `"browser": "chromium"`, so
  plain `playwright-cli open <url>` now works; pass `--browser chromium`
  explicitly if a session ignores the config. Always finish with
  `playwright-cli close`, and confirm with `playwright-cli list`.
- `claude` 2.1.233 is installed if C-item work benefits from it.
- Branch `hv-integration` already contains every lane merged plus the wiring and
  design commits, with gates green.
- The `:8479` stack currently holds workspaces `parity`, `cos`, `flaky`, eight
  panes, and eight hand-written snapshots in
  `/tmp/hv-real/run/muxterm/session-state/`. Those hand-written files must be
  removed before B4 is judged, so that what appears is only what a hook wrote.

- **An open defect is already reproducible, and closing it is part of C1.**
  With all eight snapshots present and valid, the browser renders
  `All clear` / `Nothing needs input` instead of a non-zero count. Established
  so far: the files are not being rejected (all eight survive, and the store
  deletes rejected ones); an absent `v` is explicitly accepted as version 0;
  the pids are live and are the pane root shells, children of the daemon; and
  the shipped bundle does contain `session-state-subscribe`. The join in
  `resolvePaneForPID`, the subscribe actually reaching the daemon, and the
  `mode` values in those files still using the pre-rename `goal` spelling are
  the three untested paths.
- Commit messages end with `Generated with Amplifier` and
  `Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>`.
