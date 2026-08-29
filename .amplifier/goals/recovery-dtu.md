# Goal: establish the recovery DTU and acceptance driver

## Outcome
Produce a committed, pushed recovery-specific DTU profile and fail-loud real-browser acceptance driver on `gb/crash-recovery/recovery-dtu`, and prove its preflight in one disposable launched DTU.

Complete when **either** all D1-D5 items are terminal, **or** remaining items are conclusively blocked with named reasons. States are `PASS`, `FAIL-named`, `BLOCKED-named`, `PENDING-HUMAN`.

## D1 — Required specialized delegation
Before authoring or launching DTU work, delegate to `digital-twin-universe:dtu-profile-builder` with this goal, repo/worktree path, required four CLI tools, and exact acceptance needs. Use its profile/launch guidance. Do not drive `amplifier-digital-twin` directly except through the specialist's prescribed validation handoff.

## D2 — Exclusive artifacts
Own only:
- new `.amplifier/digital-twin-universe/profiles/muxterm-crash-recovery.yaml`
- new `web/e2e/crash-recovery.mjs`

The profile path is normally ignored; force-add exactly this profile, never broad ignored content. No other file edits.

Profile must build the exact `MUXTERM_REF` on Ubuntu 24.04, expose a real HTTP port, use private persistent/runtime state, real PTYs and Chromium/playwright-cli, and install pinned native versions of Amplifier app-cli, Claude Code, OpenCode, and Codex. Forward only required provider credentials via passthrough, never persist/log them. Readiness reports exact versions, binary/build health, owner-only directories, and muxterm health. No `latest` selectors.

## D3 — Fail-loud driver
Driver syntax: `node web/e2e/crash-recovery.mjs --url <url> --scenario preflight|structural|amplifier|claude|opencode|codex|all`. It uses fresh browser/workspace/pane/daemon fixtures. `preflight` proves environment/readiness now. Other scenarios must return a clear nonzero `runtime-capability-missing` until Wave 2 exists—never skip and pass. Encode eventual checks for exact structure/CWD/history, immediate acknowledged-mutation crash, unknown-command non-replay, exact target-versus-decoy session for each tool, no interrupted-turn replay, idempotent launch, host-style boot, corruption/missing dependency isolation, browser states/redaction, and output-tail bound.

## D4 — Disposable preflight proof
Launch exactly one DTU from the committed worktree/ref via the specialist, record its exact ID/access/versions/readiness, run `--scenario preflight` successfully in real Chromium, demonstrate one non-preflight scenario fails specifically `runtime-capability-missing`, and destroy only that DTU after evidence. Retain launch/readiness/driver/output JSON under `/tmp/crash-recovery-wave1/recovery-dtu/`. If credentials or a pinned CLI are unavailable, mark that item `BLOCKED-named` without silently dropping it.

## D5 — Verify and bank
Run `node --check web/e2e/crash-recovery.mjs`, `go build ./...`, web check:fast, diff-check, and profile validation prescribed by DTU specialist. Add no tests. Commit/footer, push explicit branch, never merge, valid ignored `DONE.json` last. Time bound: 70 minutes / 55 turns.

## Scope-outs
No crash-recovery runtime or fake passing scenarios; no source, strategy, frontend, service, docs, dependency, release, or unrelated DTU profile edits. Full `all` pass is Wave 2/final integration.

## KNOWN
User explicitly requires DTU validation. All four strategies are table stakes. Existing host dev-local on 8313 is off-limits. DTU evidence cannot substitute for final committed-tree rerun.
