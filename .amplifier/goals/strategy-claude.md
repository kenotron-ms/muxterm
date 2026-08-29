# Goal: implement the Claude Code recovery strategy

## Outcome
Produce a committed, pushed pure `RecoveryStrategy` for exact Claude Code session recovery on `gb/crash-recovery/strategy-claude`.

Complete when **either** all C1-C4 items are terminal, **or** remaining items are conclusively blocked with named reasons. Each item uses `PASS`, `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN`.

## C1 — Adapter
Own only new `internal/sessiond/recovery_strategy_claude.go`. Implement the frozen interface and compile assertion. Constructor accepts only a clean absolute executable whose basename is the expected Claude command. Strategy ID `claude-code`. Accept lifecycle and explicit-selection sources only. Require canonical full UUID, matching fence/strategy, exact valid CWD, and sane UTC observations.

## C2 — Safe resume and proof
Build structured argv exactly `--resume`, `<session UUID>` with no continue/picker/fork/prompt/model/provider/permission/MCP/safety flags, no shell, and empty persisted environment delta. Require claimed state and exact fence. Validate post-launch identity by exact UUID plus canonical CWD.

## C3 — Auditable probe
Use and remove a non-test executable; retain source/evidence under `/tmp/crash-recovery-wave1/strategy-claude/`. Prove source/UUID/fence/CWD validation, exact argv with a fake executable recording arguments, no unsafe flags/shell, rejected results carry no launch/capture, and observed ID/CWD mismatch. Record real `claude --help` and version evidence without starting a session.

## C4 — Verify and bank
Run gofmt, diff-check, `go build ./...`, probe, and known Go baseline comparison. No new tests. Commit/footer, explicit branch push, never merge, valid ignored `DONE.json` last. Time bound: 45 minutes / 35 turns.

## Scope-outs
No hook installation/config edit, callback normalization, lifecycle capabilities, runtime registration/launch, storage, protocol, frontend, docs, dependencies, or live conversation. Wave 2 owns integration; DTU owns exact real resume proof.

## KNOWN
Claude lifecycle `SessionStart` supplies exact ID/CWD/source; resume is `claude --resume <UUID>` in saved CWD. User hooks must later be preserved. Frozen contracts are read-only.
