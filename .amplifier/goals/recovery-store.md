# Goal: implement the standalone crash-recovery store

## Outcome
Produce a committed, pushed owner-only event-driven recovery store on `gb/crash-recovery/recovery-store` that durably orders mutations, compacts snapshots, retains safe bounded terminal history, and replays deterministically without runtime wiring.

Complete when **either** every item reaches a terminal state, **or** the remainder is conclusively impossible with a named blocker. Record each item as `PASS`, `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN`; negative terminals are residuals.

## R1 — Durable model and API
Own only new files:
- `internal/sessiond/recovery_store.go`
- `internal/sessiond/recovery_store_file.go`
- `internal/sessiond/recovery_history_store.go`

Define validated package contracts for persisted workspaces, panes, layouts, active-pane references, exact captures, claims, attempts, outcomes, snapshots, mutations, history segments, load/commit results, options, and a `RecoveryStore` interface. Use workspace-qualified pane identities and idempotent state-assignment mutations. Provide `OpenFileRecoveryStore`, deterministic `ApplyRecoveryMutation`, safe history construction/sanitization, load, expected-generation commit, snapshot publication, history flush, and close. Do not edit the five frozen contract files.

## R2 — Crash consistency
A structural commit validates/encodes before writing, checks expected generation, appends one schema-versioned length-bounded integrity-checked record, syncs it, and only then updates store state/returns. Compaction is triggered by bounded record count/journal bytes or clean close, never polling. Publish temporary snapshot, sync file, atomic rename, sync directory, retain previous valid snapshot, then retire covered journal. Acquire an exclusive writer lock. Ignore only a torn final record; reject corruption in the committed prefix. Keep replay ordering deterministic.

## R3 — Filesystem security
Use a durable absolute root. Directories are owner-only `0700`; files `0600`. Reject symlink roots/components/files, wrong effective-UID ownership, group/world-accessible existing state, nonregular files, traversal, and a second writer. Use no-follow/descriptor-relative operations where supported. Filenames are implementation-generated, never derived from titles, paths, session IDs, or pane/workspace IDs. Checksums detect corruption, not malicious same-UID/root tampering; declare that boundary in code comments. Persist no lifecycle capability, candidate/replacement lease, ambient environment, credential, or raw tool error.

## R4 — Inert history
Accept only plain UTF-8 display lines, never raw PTY/replay bytes. Replace invalid UTF-8; strip C0/C1 controls, ESC, DEL, Unicode format/bidi controls, CR/LF/NUL; expand tabs; bound lines, segments, total bytes, and segment count without splitting runes. Persist immutable checksummed segments. Public load returns literal strings, not ANSI streams. Hostile OSC/CSI/DCS/APC/PM/SOS/clipboard/hyperlink/image/query content must not survive as active control data.

## R5 — Auditable direct probe
Create a temporary non-test executable inside the module, run it, retain its exact source/command/stdout/stderr/status/hashes under `/tmp/crash-recovery-wave1/recovery-store/`, then remove it before commit. It must fail unless it proves: generation ordering and immediate reload after each mutation; torn-tail fallback; corrupt-middle rejection; interrupted-compaction fallback; second-writer rejection; unsafe permission/symlink rejection; deterministic replay; bounded history retention; hostile control/bidi input sanitization; no ephemeral secrets in serialized data.

## R6 — Verification and handoff
Run gofmt, `git diff --check`, `go build ./...`, `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build ./internal/sessiond`, and `TMPDIR=/tmp go test -count=1 ./...` only for exact baseline comparison. Known Go baseline is four failures; do not chase it or add tests. Commit with Amplifier footer, push explicit `HEAD:refs/heads/gb/crash-recovery/recovery-store`, never merge, then write ignored root `DONE.json` with lane/session/verdict/head/pushed/item states/residuals/pending_human/suite.

Time bound: 70 minutes / 55 turns.

## Scope-outs
No registry/server/pane/VT/runtime wiring, strategies, protocol, frontend, service, DTU, docs, dependencies, or new tests. Wave 2 owns durable-before-visible mutation wrapping, VT plain-line feeds, cold reconstruction, and process launch.

## KNOWN
Base is the committed Wave 1 seed descending from integration `5984896d0b570f950e51d80b8be1f356991ac525`. Frozen files: `recovery_types.go`, `recovery_strategy.go`, `recovery_integrations.go`, `protocol.go`, `web/src/types.ts`. `DONE.json` is ignored.
