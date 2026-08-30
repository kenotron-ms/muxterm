# Goal: build the atomic recovery integration transaction core

## Outcome
Produce a committed, pushed `gb/crash-recovery/recoveryhooks-core` vendor-neutral package that safely, durably, and reversibly applies one namespaced semantic config fragment without following symlinks or storing recovery authority.

Complete when **either** B1-B6 are all terminal, **or** each remainder is conclusively `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN`. A load-bearing residual forbids COMPLETE.

## B1 — Exact ownership
May add only `internal/recoveryhooks/manager.go` and `internal/recoveryhooks/atomic_config.go`. No existing file, vendor adapter, CLI, sessiond, generic config, test, docs, dependency, frontend, or service edit. Add no test file/case.

## B2 — Minimal vendor-neutral contract
Define package-local bounded values for integration/anchor/operation, `ConfigAnchor`, `ConfigTarget`, content-free `ManifestEntry`, `CurrentFile`, `EditDisposition` (noop/change/conflict), `EditPlan`, `SemanticEditor`, `ManagerOptions`, redacted `Result`, and `OpenManager/Install/Uninstall/Status/Close`. The semantic editor receives bounded current bytes and returns a complete candidate plus in-memory canonical managed fragment. Manifest stores only integration, anchor, relative path, kind, locator, and fragment SHA-256—never config bytes, backup, callback payload, capability, session ID, CWD, socket path, credential, environment, or transcript path.

## B3 — Descriptor-relative authority and atomic durability
Hold validated descriptors for owner-controlled absolute anchors/state root. Reject empty/dot/dotdot/absolute/NUL/backslash aliases, excessive depth/bytes, symlink parent/leaf, non-directory parent, nonregular leaf, wrong owner, group/world-writable mutable component, hard-link ambiguity where unsafe, and object replacement races. Descend/create only with descriptor-relative no-follow operations. New owned dirs/files are 0700/0600.

Per-target sibling lock; bounded read through descriptor; strict editor plan before mutation; re-stat/re-hash original; create unique same-directory 0600 O_EXCL temp; complete write; fsync temp; verify; atomic rename; fsync parent. Any parse/editor/cancel/race/I/O failure leaves original path bytes/object unchanged and removes only owned temp. New file publication is equally durable. No check-then-open path authority.

## B4 — Reversible manifest semantics
Publish manifest with the same hardened transaction pattern and bounded entry count. Install is byte-identical/idempotent when managed semantic fragment already matches. Uninstall removes only a deep-equal fragment matching manifest locator and canonical hash; modified/moved/conflicting content remains untouched with conflict result. Already absent is noop. Status is read-only. Crash points cannot leave a partial recognized manifest/config or authorize deletion of user content. Close releases descriptors/locks idempotently.

## B5 — Falsifiable filesystem proof
Use synthetic temporary roots only under `/tmp/crash-recovery-r3/recoveryhooks-core/`; retain minimal probe source, exact commands/outputs/status/hashes, source-to-claim map, crash/fault matrix, and validator. Prove successful install/reopen/uninstall/noop; neighboring user bytes/semantic hooks survive; modified fragment conflict preserves bytes; symlink parent/leaf, FIFO, wrong owner where feasible, unsafe mode, hard link, traversal, duplicate/deep/oversized input, concurrent replacement all fail outside-root-safe. Inject termination/errors around lock/read/temp write/fsync/revalidate/rename/dir fsync/manifest publication; reopen must see old or complete new state only. Scan evidence/manifest for forbidden authority data. Include negative controls for removed no-follow, skipped fsync, unchecked race, and broad uninstall.

## B6 — Verify and bank
Run gofmt, diff-check, `make build`, Go/Linux builds, web check:fast, direct probe/validator, and exact known baselines. Commit only two new files with footer, push exact branch, clean parity, then session-bound ignored DONE last with B1-B6/evidence. Time 70 minutes / 45 turns. Never merge.

## Scope-outs
No Claude/Codex/OpenCode adapter or tool path, Amplifier behavior, CLI, sessiond listener/authority, real user config, browser/service, tests, docs, dependencies, DTU, PR, merge, or dev-local. Vendor adapters and CLI are dependent lanes.

## KNOWN
No `internal/recoveryhooks` package exists at base. Do not reuse generic `config.Write`; it lacks this authority/durability contract.
