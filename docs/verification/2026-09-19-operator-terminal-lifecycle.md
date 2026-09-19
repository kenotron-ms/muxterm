# Operator terminal lifecycle delivery: observed through the browser

Verified 2026-09-19 against 558a671 plus this change, using `make dev-local`
on port 8313 and `make verify-lifecycle` on its separate Makefile-isolated
runtime. Production PIDs 1070879/1070880 and ports 9090/8311 were only inspected,
never restarted or written to. No Amplifier or Codex source/config was changed.

## First failing step in production

The actual switch is **MUXTERM_OPERATOR_LIFECYCLE_NOTICES**, not
MUXTERM_OPERATOR_LIFECYCLE. Both were absent from both production processes'
environments. On origin/main, `LifecycleNoticesEnabled()` returns **false**
when unset. It gates both the daemon watcher and the server notice pump.

Read-only inspection of `~/.local/share/muxterm` found:

| Lane | Durable evidence | First missing step |
| --- | --- | --- |
| cef4d97b-5fb3-4bc3-b436-ef611c32148b (user-observed done, 6/6) | No attention.json; no completion record for this session | Live lifecycle marker: watcher disabled |
| 12ce2038-fc23-45a6-89ec-bf33155dd72c | w14-p1-1789775131, outcome failed, exit -1 | Delivery: pump disabled |
| 66067767-8c37-49ba-981e-ed98f2418613 | w15-p1-1789775131, outcome failed, exit -1 | Delivery: pump disabled |

There was **no operator-notices.json**. No lifecycle submission or response can
occur through the disabled pump. The user's observed absence in the conversation
is therefore explained before the COS submit seam, not by lost sidecar origin.
Production was not mutated to produce a baseline or retroactively announce history.

Both failed records omit goalId/origin. The original CompletionRecord and
completionRows also omit them. This explains the observed disappearance on the
fleet cards. Neither marker conversion nor delivery eligibility reads those
fields: provenance loss is real, but is not what suppressed these notices.

## Path traced and fix

- `sessionwriter.go` atomically writes validated declarations using the
  `sessionstate.go` done/failed/stopped vocabulary. `sessionstore.go` joins these
  snapshots to real panes and stamps launch provenance from `lane_provenance.go`.
- `sessiond/server.go:emitSessionState` already passes the **same collected live
  rows** to `lifecycle_watch.go:observe` before publishing fleet state. Done and
  stopped do not have to wait for pane exit. The missing connection was the
  default-off gate, not a missing terminal-state detector.
- For crashes, `recordPaneCompletion` and `completion.go` already compute the
  outcome once from the last declaration/process exit. The same CompletionRecord
  supplies `completionRows`/`mergeCompletionRows` for cards and the notice pump.
  No second verdict, finish detector, or later source of truth was added.
- Both halves now default on; explicit 0/false/no/off still disables them.
  Completion capture now stamps the same daemon-owned pane provenance used for
  live rows and persists/projects goalId and origin. Old records remain readable.
- `server/lifecycle_notices.go` scans the durable markers, seeds existing records
  without backfill, and uses marker ID plus session/kind to deduplicate. Its
  SubmitOrigin call enters the existing COS FIFO with origin `lifecycle`.
- `cos/queue.go` and `supervisor.go` retain that origin and causation ID.
  `cos/sidecar/main.py` emits them on turn_start/turn_end and persists them on the
  transcript for history replay. No change to this working path was needed.
- `web/src/lib/session-state.ts` consumes the existing fleet vocabulary.
  `cos-store.ts` preserves origin for live events and history; `mux-cos.ts` renders
  the lifecycle rail and the generated Operator reply, without a human bubble.

## Real browser/provider evidence

The fixture uses real bash processes in real sessiond PTYs and the shipped
`muxterm session report` producer. It does not inject markers, ledger rows,
COS events, model responses, or browser state. The Operator used the installed
Amplifier sidecar with the machine's configured real provider credentials.
The lane workload itself is a controlled shell workload, not a provider-driven
coding task.

Fresh workspaces w2/w3/w4 each reported working, then:

| Session | Actual terminal transition | Marker | Operator turn |
| --- | --- | --- | --- |
| browser-lifecycle-failed | Process sends SIGTERM to its own PID while still working; daemon records exit -1 | w3-p1-1789782210 | t-1, persisted true, origin lifecycle |
| browser-lifecycle-done | Writes an artifact and reports done, leaving its pane alive | browser-lifecycle-done-finished-1789782211 | t-2, persisted true, origin lifecycle |
| browser-lifecycle-stopped | Reports stopped, leaving its pane alive | browser-lifecycle-stopped-stopped-1789782211 | t-3, persisted true, origin lifecycle |

Playwright captured the actual browser WebSocket turn_start and turn_end frames
in FIFO order, with the matching causation IDs and real generated responses.
It then observed all three replies in Mission Control:

- Failed: “lane failed after about 5 seconds” and “process exit (exit code -1)”.
- Done: “lane finished — it declared itself done”.
- Stopped: “lane stopped” and “ending deliberately without a verdict”.

After releasing the done/stopped processes, their pane exits produced additional
completion records. The ledger stayed at three entries and the conversation
stayed at three notices: live and exit markers for the same session/kind did not
double-announce. All three completion records retained goalId and origin `cli`.
Browser reload replayed exactly three lifecycle-origin replies, with no YOU
bubble. Playwright asserted three visible lifecycle rails and one rendered
Operator response for each lane. The screenshot was inspected directly.
Restarting only the dev serve process resumed the same COS session and still
showed three lifecycle notices and zero human bubbles; the ledger was byte-for-
byte unchanged. The dev stack and browser were then stopped by explicit PID.

Evidence: [rendered conversation](operator-lifecycle-2026-09-19/operator.png),
[browser events](operator-lifecycle-2026-09-19/browser-events.json),
[replayed history](operator-lifecycle-2026-09-19/browser-replay.json),
[browser snapshot](operator-lifecycle-2026-09-19/browser-after-replay.txt),
[markers](operator-lifecycle-2026-09-19/attention.json),
[completion records](operator-lifecycle-2026-09-19/completions.json), and
[ledger](operator-lifecycle-2026-09-19/operator-notices.json).

## Reproduction and checks

Use a clean `make dev-local` runtime per AGENTS.md, ensuring no other task owns
port 8313. Open `http://127.0.0.1:8313` with `playwright-cli`. With the real Operator
provider configured, run:

```sh
python3 docs/verification/operator-lifecycle-2026-09-19/lanes.py
# Observe three notices and generated replies in Mission Control.
touch tmp/release-done tmp/release-stopped
# Reload the browser: still three notices, all lifecycle-origin.
```

The retained fixture connects to the existing Makefile-isolated dev daemon;
it does not start a server. Always create a fresh runtime for a new pass rather
than reusing the fixed session IDs. Teardown must use explicit dev PIDs only.

`make verify-lifecycle` passed: default-on done/failed/stopped, blocked/resolved,
interactive silence, observation without subscribers, migration seeding with no
submitted turns, unchanged ledger on restart, and explicit opt-out. Full output
is [retained here](operator-lifecycle-2026-09-19/make-verify-lifecycle.txt).
`go build ./...`, `go vet ./...`, and `npm run check:fast` passed (zero frontend
errors; existing lint warnings). No unit tests were written or run.
