# Goal: implement owner-local recovery helpers and integrations

## Outcome
Produce a committed, pushed `gb/crash-recovery/recovery-integrations-cli` implementation of bounded owner-local recovery commands plus reversible Claude Code, OpenCode, and Codex integration activation, with strict Amplifier correlation/explicit binding and no hidden session guessing.

Complete when **either** every B1-B7 item is terminal, **or** the remainder is conclusively impossible with a named blocker per item. Use `PASS`, `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN`; do not call a load-bearing residual COMPLETE.

## B1 — Exact ownership
Own only existing:
- `cmd/muxterm/cli.go`
- `cmd/muxterm/main.go`
- `cmd/muxterm/cli_test.go`
- `cmd/muxterm/main_test.go`
- `behaviors/muxterm.yaml` and `bundle.md` only if a validated additive Amplifier integration genuinely requires them

May add only:
- `cmd/muxterm/recovery_cmd.go`
- `cmd/muxterm/recovery_helper.go`
- `internal/sessiond/recovery_socket_client.go`
- `internal/recoveryhooks/manager.go`
- `internal/recoveryhooks/atomic_config.go`
- `internal/recoveryhooks/amplifier.go`
- `internal/recoveryhooks/claude.go`
- `internal/recoveryhooks/opencode.go`
- `internal/recoveryhooks/codex.go`
- fixed embedded templates under `internal/recoveryhooks/`

All sessiond server/runtime/contracts, internal/server, service, install.sh, frontend, docs, dependencies, and other tests are read-only. Existing owned tests may synchronize parsing/fixtures only; add no test case/file.

## B2 — Strict owner-local client and CLI
Implement a bounded dedicated recovery-socket client using frozen owner-local framing with finite deadlines, exact CID/type/payload correlation, strict result validation, and no partial authority on timeout/malformed/disconnect. Expose commands:
- `muxterm recovery hook claude-code|opencode|codex`
- `muxterm recovery bind --workspace <id> --pane <id> --strategy <fixed> --session-stdin`
- `muxterm recovery integrations status|install|uninstall [all|claude-code|opencode|codex] [--dry-run] [--json]`
- `muxterm recovery replacement plan --json`
- `muxterm recovery replacement commit --plan <opaque-id> --json`

Sensitive exact session IDs come from bounded stdin/prompt, never process argv, logs, browser, or durable helper files. Return stable replacement exit codes: 0 committed/current, 10 deferred, 11 unavailable/legacy, 1 malformed/operational failure. If lane A is absent, commands fail closed/unavailable and ordinary muxterm remains functional.

## B3 — Lifecycle helper minimization
Each hook helper reads at most 64 KiB strict UTF-8 JSON with duplicate-key/nesting/unknown-field rejection, extracts only exact session ID, canonical CWD, fixed event/source and root-session evidence, sends bootstrap then capture on the same authenticated socket connection, emits no stdout/stderr in ordinary unavailable/rejected cases, and exits 0 so capture cannot break the external tool. It reads no prompts, transcript contents, model output, credentials, terminal text, pane ID, generation, or ambient authority. Exact parsers:
- Claude/Codex `SessionStart`: source startup/resume/clear/compact, exact session ID, CWD, reject child/fork where unsafe;
- OpenCode root `session.created` and user-backed `session.updated`, safe complete `ses_...` ID and CWD, ignore child sessions;
- Amplifier does not pretend a universal hook exists.

## B4 — Reversible external integration management
Installation is explicit only. Resolve owner config roots; walk no-follow owner-owned non-writable path components; reject symlinks/nonregular/wrong owner/unsafe modes/duplicate JSON keys/excess size/depth; lock sibling; read/hash; apply one namespaced semantic change; re-stat/re-hash before publication; write same-directory `0600` O_EXCL temp, fsync, rename, fsync directory. Reinstall is byte-identical. Uninstall removes only a deep-equal fragment recorded in an owner-only muxterm integration manifest; edited/conflicting content is preserved and reported conflict.

Claude: append a fixed muxterm `SessionStart` command hook while preserving every existing setting/hook; never disable safety or use shell interpolation. Codex: append fixed namespaced hook preserving config and report pending trust/managed-hook restriction rather than bypassing it. OpenCode: create only the owned global `muxterm-recovery.js` plugin; never edit `opencode.json`, create package metadata, install dependencies, or overwrite differing content. Persist no capability/session/CWD/credential.

## B5 — Amplifier and exact identity policy
Do not rewrite arbitrary Amplifier bundles/cache or claim universal hook coverage. Use the existing bounded `AmplifierRecoveryStrategy.Correlate` from authoritative runtime process/CWD/time evidence; exactly one full UUID candidate may bind, zero is missing, multiple/limit/instability is ambiguous. Explicit bind accepts only a full exact UUID that passes the same owner-safe project namespace, metadata, transcript presence, and exact CWD validation. Never use `amplifier continue`, prefix/latest/mtime selection, terminal display, or whole events.jsonl. The exact resume remains `amplifier session resume --no-history <UUID>` in captured CWD and is launched only by sessiond.

## B6 — Falsifiable verification
Use temporary fixtures only; never alter the user's real Claude/OpenCode/Codex/Amplifier settings or start their conversations. Retain auditable source/commands/outputs/status/hashes under `/tmp/crash-recovery-r2/recovery-integrations-cli/`. Prove strict helper parsing; wrong reply/CID/type/timeouts; no stdout/stderr; exact payload minimization; integration dry-run/no-op/idempotent install/uninstall; preservation of unknown settings and neighboring hooks; malformed/duplicate/symlink/wrong-owner/unsafe/concurrent-change conflicts leave bytes unchanged; OpenCode creates no extra files; no capability/session/CWD leaks to manifest/log/argv; Amplifier one/zero/multiple exact correlation and explicit bind; replacement exit-code mapping. Run real installed CLI help/version only, without sessions.

## B7 — Verify and bank
Run gofmt, `make build`, Go/Linux builds, web check:fast, diff-check, focused existing owned tests, and exact Go/web baseline comparisons. No new tests. Commit only owned files with Amplifier footer, push exact branch, clean parity, then write matching ignored DONE.json last with B1-B7/evidence/residuals. Time bound 90 minutes / 60 turns.

## Scope-outs
No sessiond authority/listener/launch, service units/install.sh, browser relay/UI/origin, DTU, docs, dependencies, vendor-cloud conversation, merge, PR, or dev-local interaction. Real helper-to-runtime and four-tool recovery remain R3/DTU residuals.

## KNOWN
The dedicated decoder now accepts lifecycle bootstrap/capture, explicit bind, replacement plan, and replacement commit. Amplifier app-cli lacks a universal host hook; strict correlation and explicit full-ID binding are the honest current paths.
