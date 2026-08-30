# Goal: execute the recoveryhooks cleanup-preservation proof

## Authorized defensive scope
This is defensive regression validation of muxterm's own atomic config writer. Work only in generated caller-owned regular files under `/tmp/crash-recovery-r3/recoveryhooks-core/proof-cleanup/`. Do not edit product source, real configuration, user paths, services, network state, permissions outside the fixture, or produce a reusable deletion/race/path-manipulation utility.

## Outcome
Produce a session-bound COMPLETE proof or a named terminal blocker showing that immutable recoveryhooks source `066fa55cbc734658f0317de7afc1575a16a0e7df` preserves a generated marker when failed publication observes a substituted temporary pathname.

Complete when **either** C1-C4 reach PASS, **or** each remainder is conclusively FAIL-named/BLOCKED-named/PENDING-HUMAN. If the provider rejects this authorized defensive validation, stop after the first surfaced rejection and record `BLOCKED-provider-cyber-policy`; do not rephrase or route around policy.

## C1 Healthy path
In a private disposable source copy and generated owner-only fixture, instrument only the harness to coordinate after the real temporary file is created: move that owned temp aside, place a generated regular marker at the original temp pathname, and trigger a bounded pre-rename failure/cancellation. Healthy source must leave the substituted marker present and byte-identical; original target must remain old/complete, and no path outside fixture changes.

## C2 Active fixture-only incorrect variant
Create an intentionally incorrect private source variant that inserts pathname unlink into the actual post-temp failure cleanup path. Execute the same coordinated harness. It must reach that active branch, delete the substituted marker, and cause validator rejection for observed marker loss. Compile/setup failure, an appended unreachable helper, or lexical token detection is not proof.

## C3 Integrity
Retain exact source hashes, variant diff, harness, commands/stdout/stderr/status, before/after fixture hashes, source-to-claim map, watchdog evidence, and fail-fast validator. Pin source to `066fa55...`; run build and Linux package build. Repository worktree must remain clean.

## C4 Terminal
Commit/push no product or proof artifact. Write ignored root DONE.json last with this lane/session, verdict COMPLETE only if C1-C3 pass, source head, items/residuals/pending_human/suite/evidence. Never merge. Time 20m/14 turns.

## Scope-outs
No lock proof, broad filesystem mutation, manifest operations, source edits, real config, tests, docs, dependencies, DTU, PR, merge, or dev-local.
