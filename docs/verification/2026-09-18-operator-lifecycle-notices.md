# Verification — Operator lifecycle notices (2026-09-18)

Reproduce with `make verify-lifecycle`. It expands the Makefile's `DEV_ISOLATE`
macro, so every path below is isolated; it binds no production port and kills
only pids it starts. No unit tests were added (see `AGENTS.md`).

## Static checks

```
go build ./...                 clean
go vet ./...                   clean
cd web && npm run check:fast   0 errors (13 pre-existing warnings)
python3 -m py_compile internal/cos/sidecar/main.py   clean
```

## Existing Go test suite

`go test ./internal/...` fails in exactly two places, and BOTH fail identically
on unmodified `main` (confirmed by running them in a separate checkout at
`d82e79d`):

- `internal/sessiond  TestRegistryListReportsWorkspaceInfo` — `WorkspaceUUID`
  drift, unrelated to this branch.
- `internal/voice     TestTheFourExistingToolsAreUnchanged` — "the Operator" vs
  "Operator" wording drift, unrelated to this branch.

No other package fails. This branch introduces no test regression.

## End-to-end run against a real, isolated sessiond

```
```
=== isolated environment ===
  XDG_RUNTIME_DIR = /tmp/muxterm-lifecycle-verify
  XDG_DATA_HOME   = /tmp/muxterm-lifecycle-verify/data
  markers file    = /tmp/muxterm-lifecycle-verify/data/muxterm/attention.json

=== starting sessiond (lifecycle notices ON) ===
  sessiond pid 841334
PASS  claude fleet adapter is ON by default (no env var set)

=== creating a real pane ===
  workspace w2 pane 1

=== 1. baseline observation must not announce anything ===
PASS  first sighting of a working lane writes no marker

=== 2. autonomous working -> done, pane still alive ===
PASS  one finished marker
PASS    attributed to the right session
PASS    records the transition it saw

=== 3. autonomous working -> blocked ===
PASS  one blocked marker
PASS    carries the declared reason
PASS    is unresolved while it is blocked

=== 4. blocked -> working resolves it rather than leaving a stale ask ===
PASS  blocked marker is now resolved

=== 5. an INTERACTIVE lane is never an alarm ===
PASS  interactive transitions produce no markers at all

=== 6. no session-state subscriber was ever attached ===
PASS  every marker above was recorded with no browser attached

=== 7. delivery ledger: the one-time migration, and no backfill ===
PASS  a delivery ledger was created
PASS  every announceable pre-existing marker is recorded as already-announced
PASS  a resolved marker is not announced, so it is not seeded either
PASS  nothing was actually delivered
PASS  the migration announced itself in the log
PASS  a restart re-seeds nothing and re-announces nothing

=== 8. feature gate: with the switch OFF, nothing observes and nothing is written ===
PASS  no marker is written when the feature is off

=== delivery ledger ===
{
  "v": 1,
  "entries": [
    {
      "markerId": "verify-auto-finished-1789703625",
      "key": "verify-auto|finished",
      "kind": "finished",
      "deliveredAt": 1789703645,
      "seeded": true
    }
  ]
}

=== markers written ===
{
  "v": 1,
  "records": [
    {
      "v": 1,
      "id": "verify-auto-finished-1789703625",
      "sessionId": "verify-auto",
      "kind": "finished",
      "fromState": "working",
      "workspaceId": "w2",
      "paneId": 1,
      "project": "/home/ken",
      "name": "verify-auto",
      "mode": "autonomous",
      "doing": "all green",
      "observedAt": 1789703625
    },
    {
      "v": 1,
      "id": "verify-auto-blocked-1789703630",
      "sessionId": "verify-auto",
      "kind": "blocked",
      "fromState": "working",
      "declaredWaitingFor": "permission prompt",
      "workspaceId": "w2",
      "paneId": 1,
      "project": "/home/ken",
      "name": "verify-auto",
      "mode": "autonomous",
      "observedAt": 1789703630,
      "resolved": true
    }
  ]
}

RESULT: all checks passed
```
