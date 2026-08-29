# Goal: implement the OpenCode recovery strategy

## Outcome
Produce a committed, pushed pure `RecoveryStrategy` for exact managed OpenCode session recovery on `gb/crash-recovery/strategy-opencode`.

Complete when **either** all O1-O4 items are terminal, **or** remaining items are conclusively blocked with named reasons. Each item uses `PASS`, `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN`.

## O1 — Adapter
Own only new `internal/sessiond/recovery_strategy_opencode.go`. Implement frozen interface and compile assertion. Constructor accepts a clean absolute executable with expected basename. Strategy ID `opencode`. Accept managed-session and explicit-selection sources only; reject ordinary lifecycle/recency inference. Require a bounded complete `ses_` ID using safe ASCII letters/digits/underscore/hyphen, matching fence/strategy, exact valid CWD, and sane observations.

## O2 — Safe resume and proof
Build structured argv exactly `--session`, `<full session ID>` with no continue/picker/fork/auto/model/provider/attach/prompt/project positional argument, no shell, and empty persisted environment delta. Require claimed state and exact fence. Post-launch validation requires exact managed ID and canonical CWD.

## O3 — Auditable probe
Use/remove a non-test executable and retain source/evidence under `/tmp/crash-recovery-wave1/strategy-opencode/`. Prove managed-source acceptance; lifecycle/prefixless/unsafe ID rejection; exact argv via fake executable; no unsafe flags; fence/CWD/result safety; exact observed identity. Record real `opencode --help`, `opencode run --help`, and version without launching a session.

## O4 — Verify and bank
Run gofmt, diff-check, `go build ./...`, probe, and exact Go baseline comparison. No new tests. Commit/footer, explicit push, never merge, valid ignored `DONE.json` last. Time bound: 50 minutes / 38 turns.

## Scope-outs
No plugin file/config mutation, SDK/event parsing, callback IPC, runtime registration, session-store scanning, storage, protocol, frontend, docs, dependencies, or real resume. Wave 2 owns managed integration; DTU must prove exact event payload/root-session distinction and `--pure` degradation.

## KNOWN
Interactive resume is `opencode --session <session ID>` in exact CWD. Unmanaged interactive selection is never guessed. Frozen contracts are read-only.
