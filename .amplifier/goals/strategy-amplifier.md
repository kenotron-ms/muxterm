# Goal: implement the Amplifier recovery strategy

## Outcome
Produce a committed, pushed reference `RecoveryStrategy` for exact Amplifier app-cli session recovery on `gb/crash-recovery/strategy-amplifier`, including strict unique disk correlation and fixed safe resume argv.

Complete when **either** every item is terminal, **or** the remainder is conclusively impossible with named blockers. States are `PASS`, `FAIL-named`, `BLOCKED-named`, `PENDING-HUMAN`; negative terminals become residuals.

## A1 — Isolated adapter
Own only new `internal/sessiond/recovery_strategy_amplifier.go`. Implement `RecoveryStrategy` and compile assertion. Constructor accepts a validated absolute Amplifier executable and absolute projects root. Strategy ID is `amplifier-app-cli`. Accept only lifecycle, verified-correlation, and explicit-selection capture sources. Validate workspace-qualified fence, canonical full UUID, exact validated CWD, timestamps, and matching strategy. No shell, raw command, terminal parsing, partial UUID, `continue`, latest session, or ambient environment.

## A2 — Exact resume
Build only a structured launch with executable fixed by constructor, CWD equal to captured canonical directory, empty persisted environment delta, and argv exactly `session`, `resume`, `--no-history`, `<full UUID>`. Require claimed state and matching capture/fence. Post-launch validation requires byte-exact full UUID and canonical CWD equality.

## A3 — Strict correlation fallback
Expose an adapter-owned correlation method. Inspect only the CWD-derived project namespace under the supplied Amplifier projects root, at most 256 session directories and 64 KiB metadata each. Reject symlinks, wrong owner, unsafe modes, malformed UUIDs/JSON, project-slug mismatch, missing/invalid `working_dir`, empty/unknown bundle, and missing parseable transcript or backup. Require directory basename, metadata `session_id`, and CWD to agree; use pane launch/observation window with two-second skew. Exactly one candidate succeeds; zero is missing; multiple/truncated/conflicting evidence is ambiguous. Never inspect transcript content or select newest.

## A4 — Auditable probe
Use a removable non-test executable. Retain exact source and outputs under `/tmp/crash-recovery-wave1/strategy-amplifier/`. Prove valid capture; malformed/partial UUID rejection; exact argv/order/no extras; claim/fence/CWD checks; observed identity match/mismatch; zero/one/multiple correlation; symlink/ownership/metadata/transcript failures; no session recency selection. Capture real local `amplifier session resume --help` and version output as compatibility evidence without starting a session.

## A5 — Verify and bank
Run gofmt, diff-check, `go build ./...`, the probe, and exact Go baseline comparison. Add no tests. Commit with footer, push `HEAD:refs/heads/gb/crash-recovery/strategy-amplifier`, never merge, write valid ignored `DONE.json` last. Time bound: 60 minutes / 45 turns.

## Scope-outs
No hook module/config injection, lifecycle lease manager, callback IPC, process launch, runtime registration, frontend, storage, docs, dependencies, or real session resume. Wave 2 owns those and DTU proves the real conversation.

## KNOWN
Amplifier reference command is `amplifier session resume --no-history <full UUID>` from the original CWD. Storage is project-scoped. A future muxterm hook can use coordinator session ID/parent ID/working directory; arbitrary bundles currently need integration work. Frozen contracts are read-only.
