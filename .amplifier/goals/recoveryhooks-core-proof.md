# Goal: prove recoveryhooks atomic safety controls

## Outcome
Produce a proof-only, session-bound PASS or named failure for immutable recoveryhooks source head `066fa55cbc734658f0317de7afc1575a16a0e7df` by executing discriminating physical-lock and unsafe-cleanup mutants; make no product-source changes.

Complete when **either** P1-P4 all reach PASS, **or** an item is conclusively FAIL-named/BLOCKED-named/PENDING-HUMAN. Time 30m/20 turns.

## P1 Active split-lock mutant
Build a minimal source copy of the exact reviewed package and an executable mutant that changes the real lock derivation/validation path so two distinct integration labels/managers targeting the same descriptor-authoritative parent use two valid distinct lock names. Drive both concurrently: healthy source must let one acquire and force the other to return busy until release; mutant must demonstrate simultaneous acquisition and cause validator failure. Setup failure or lexical token detection is not evidence.

## P2 Active unsafe-cleanup mutant
Inject pathname `Unlinkat` into an actual post-temp cancellation/failure cleanup path. Coordinate temp creation, replace its pathname with a sentinel object, then trigger that branch. Healthy source must leave the substituted sentinel present; mutant must execute its unsafe unlink, delete sentinel, and fail the validator for that observed reason. Use watchdogs and unique safe synthetic owner roots; never target real config.

## P3 Package integrity
Under `/tmp/crash-recovery-r3/recoveryhooks-core/proof-v3/`, retain exact minimal production copies, mutant sources/diffs, harness, commands, stdout/stderr/status, hashes, source-to-claim map, and one fail-fast validator. Pin production source hashes to `066fa55...`; rerun the existing ten positive primitive checks and remaining five controls, then P1/P2. No worktree/.git/cache/user identity copies. Repository must remain clean at exact seed head aside from this tracked goal commit.

## P4 Terminal
Run go build/package Linux build/diff-check and validator. Commit no production change and push no proof implementation branch. Write ignored root DONE.json last with lane `recoveryhooks-core-proof`, this session ID, verdict COMPLETE only if P1-P3 pass, source head, proof seed head, pushed truthfully, items/residuals/pending_human/suite/evidence. Never merge.

## Scope-outs
No edits to internal/recoveryhooks or any product/test file, no manifest operations/vendor/CLI/runtime, no real config, docs/dependencies/DTU/PR/merge/dev-local.
