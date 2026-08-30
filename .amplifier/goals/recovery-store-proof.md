# Goal: produce discriminating recovery-store proof

## Outcome
Produce an auditable proof package, without production changes, demonstrating that the committed recovery store at `61f642451173c60d499ec5d5a1983a07dbb358ba` survives automatic-compaction reopen before Close and that its fsync-order checker rejects representative broken implementations.

Complete when **either** P1-P4 reach `PASS`, **or** an item reaches `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN` with a conclusive reason. This lane must not change production code.

## P1 — Automatic compaction without Close

Build a temporary non-test child/parent executable against the committed store. For both configurable automatic thresholds—journal record count and journal bytes—the child must create the store, commit across the threshold, emit the acknowledged generation, and terminate with `os.Exit` or an equivalent abrupt normal-process exit that cannot run `RecoveryStore.Close` or deferred cleanup. The parent then reopens the same root and verifies exact latest generation/state plus compatible snapshot/journal bounds. Include a negative-control fixture/package in which the automatic pair is present and correctly sized but generation/replay-incompatible; the checker must reject it rather than having Close repair it.

## P2 — Checked fsync success-path proof

Create a retained Go AST/control-flow checker for the committed `FileRecoveryStore.Commit` implementation. It must prove on every success-returning path after journal append that:
- `unix.Fsync(store.journalFD)` executes unconditionally;
- its returned error is checked and an error path returns before state publication;
- in-memory generation/state publication and successful acknowledgement occur only after the checked fsync;
- no dead/constant-false branch can satisfy the check.

Run the checker against the live committed source and retain successful output. Then create disposable mutated copies outside the repository and prove the checker fails each of these representative breaks separately: missing fsync, fsync under constant-false/dead branch, ignored fsync error, state publication before fsync, and success return before fsync. Retain exact mutation scripts/files, commands, stdout/stderr/status, and hashes. Do not point negative checks at the healthy live source.

If complete formal control-flow proof is infeasible, return `BLOCKED-named` rather than a lexical false-green. Physical power-loss observation itself remains outside the host's unprivileged capability and need not be fabricated.

## P3 — Package integrity and hygiene

Place all temporary probe/checker sources and outputs under `/tmp/crash-recovery-wave1/recovery-store/proof-v4/`. Include a manifest, source-to-claim map, exact command log, hashes, and one validator that reruns or validates every positive and negative assertion. Temporary in-repo command packages may be used only while running and must be removed. At finish, repository HEAD remains `61f642451173c60d499ec5d5a1983a07dbb358ba`; tracked and untracked status are clean; no source/test/goal change is committed on the store branch.

## P4 — Terminal handoff

Run `go build ./...`, `git diff --check`, and the proof-package validator. Write ignored root `DONE.json` as the literal final filesystem action with lane `recovery-store-proof`, this session's own session ID, verdict, branch/head/pushed state, P1-P4 item states, residuals, pending_human, suite, and proof path. A proof-only lane need not push an implementation commit; report `pushed` truthfully. Time bound: 30 minutes / 22 turns.

## Scope-outs

No production edits, permanent probes, tests, commits beyond the already-seeded goal commit, pushes after launch, store behavior changes, runtime wiring, frontend, DTU, docs, merge, or other worktrees. No claim of physical power-loss observation.

## KNOWN

The production reviewer already judged the store source quality PASS and identified only these verification gaps. The first V3 package is `/tmp/crash-recovery-wave1/recovery-store/review-package-v3/`. This proof supplements it; it does not replace the earlier durability, history-boundary, permission, symlink, compaction, and sanitization evidence.
