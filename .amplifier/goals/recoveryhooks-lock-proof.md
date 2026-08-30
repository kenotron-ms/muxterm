# Goal: execute the recoveryhooks physical-lock proof

## Authorized defensive scope
This is defensive regression validation of muxterm's own atomic config writer. Work only in generated caller-owned temporary fixture roots under `/tmp/crash-recovery-r3/recoveryhooks-core/proof-lock/`. Do not edit product source, real configuration, user paths, services, network state, permissions outside the fixture, or create a reusable race/path utility.

## Outcome
Produce a session-bound COMPLETE proof or a named terminal blocker showing whether immutable recoveryhooks source `066fa55cbc734658f0317de7afc1575a16a0e7df` serializes two managers with distinct integration labels that target one descriptor-authoritative parent.

Complete when **either** L1-L4 reach PASS, **or** each remainder is conclusively FAIL-named/BLOCKED-named/PENDING-HUMAN. If the provider rejects this authorized defensive validation, stop after the first surfaced rejection and record `BLOCKED-provider-cyber-policy`; do not rephrase or route around policy.

## L1 Healthy path
Copy only the exact two reviewed source files into a private disposable module. Drive two manager instances/integration labels against one generated owner-only target parent. Hold the first physical lock; the second must return busy until release, then acquire successfully. Use bounded watchdogs and prove no source/fixture path outside the generated root changes.

## L2 Active fixture-only incorrect variant
Create an intentionally incorrect private source variant in the same `/tmp` proof package that derives two valid distinct lock names from the two labels while preserving all setup/validation. Execute the same concurrent harness. It must demonstrate simultaneous lock acquisition, and the validator must reject it for that observed reason. Setup/compile failure or lexical token detection is not proof.

## L3 Integrity
Retain exact source hashes, variant diff, harness, commands/stdout/stderr/status, fixture tree before/after, source-to-claim map, and fail-fast validator. Pin reviewed source hash to `066fa55...`. Run build and Linux package build. Repository worktree must remain clean.

## L4 Terminal
Commit/push no product or proof artifact. Write ignored root DONE.json as literal final filesystem action with this lane/session, verdict COMPLETE only if L1-L3 pass, source head, items/residuals/pending_human/suite/evidence. Never merge. Time 20m/14 turns.

## Scope-outs
No cleanup/deletion proof, manifest operations, source edits, real config, tests, docs, dependencies, DTU, PR, merge, or dev-local.
