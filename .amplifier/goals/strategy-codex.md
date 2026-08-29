# Goal: implement the Codex recovery strategy

## Outcome
Produce a committed, pushed pure `RecoveryStrategy` for exact Codex thread recovery on `gb/crash-recovery/strategy-codex`.

Complete when **either** all X1-X4 items are terminal, **or** remaining items are conclusively blocked with named reasons. Each item uses `PASS`, `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN`.

## X1 — Adapter
Own only new `internal/sessiond/recovery_strategy_codex.go`. Implement frozen interface and compile assertion. Constructor accepts only a clean absolute executable with expected basename. Strategy ID `codex`. Accept lifecycle and explicit-selection sources. Require canonical full UUID, matching fence/strategy, exact valid CWD, sane UTC evidence.

## X2 — Safe resume and proof
Build structured argv exactly `resume`, `<thread UUID>` with no `--last`, picker, fork, prompt, model, sandbox, approval, or CWD override; no shell; empty persisted environment delta. Require claimed state and exact fence. Post-launch validation requires exact UUID and canonical CWD.

## X3 — Auditable probe
Use/remove a non-test executable and retain source/evidence under `/tmp/crash-recovery-wave1/strategy-codex/`. Prove UUID/source/fence/CWD validation, exact argv via fake executable, absence of last/picker flags, rejected payload safety, observed identity mismatch. If native Codex is unavailable locally, record that exact fact as a DTU residual rather than using a shim or latest-session fallback.

## X4 — Verify and bank
Run gofmt, diff-check, `go build ./...`, probe, and exact Go baseline comparison. No new tests. Commit/footer, explicit push, never merge, valid ignored `DONE.json` last. Time bound: 45 minutes / 35 turns.

## Scope-outs
No Codex hook configuration/trust bypass, rollout parsing, callback IPC, runtime launch, storage, protocol, frontend, docs, dependencies, or real resume. Wave 2 owns integration; DTU must prove native hook/resume behavior.

## KNOWN
Codex recovery command is `codex resume <UUID>` from saved CWD. `SessionStart` lifecycle evidence is authoritative; rollout filenames and `--last` are not. Frozen contracts are read-only.
