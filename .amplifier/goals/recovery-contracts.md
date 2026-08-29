# Goal: freeze crash-recovery contracts

## Outcome

Produce one committed, pushed Wave 0 contract slice on branch `gb/crash-recovery/recovery-contracts` that compiles independently and freezes the additive Go and TypeScript recovery vocabulary required by every later crash-recovery lane.

Complete when **either** every item below reaches a terminal state, **or** it is conclusively demonstrated the remainder cannot, naming the blocker for each. Items ending `FAIL-named` or `BLOCKED-named` are residuals, not failures of the goal.

## Terminal states

For every item, record exactly one of: `PASS`, `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN`.

### C1 — Shared internal model

Own and add only `internal/sessiond/recovery_types.go` and `internal/sessiond/recovery_strategy.go`.

Define typed, bounded contracts for:
- workspace-qualified pane identity;
- fixed built-in strategy IDs: Amplifier, Claude Code, OpenCode, and Codex;
- recovery statuses and generation-fenced claim/attempt/outcome state;
- exact opaque session capture with schema/version, source, timestamps, working-directory binding, and redaction-safe failure codes;
- structured launch executable, argv, CWD, and a minimal allowlisted environment delta;
- adapter capture, validation, resume construction, and observed-identity validation.

The core interface must not expose raw shell command evaluation, unrestricted strategy loading, “latest” session selection, browser-provided launch authority, terminal-text identity, ambient credentials, or unbounded fields.

### C2 — Lifecycle integration contract

Own and add only `internal/sessiond/recovery_integrations.go` for interfaces and types, not runtime behavior.

A lifecycle capture must carry a high-entropy per-launch capability bound to workspace ID, pane ID, root process generation, selected strategy, and capture epoch. Contracts must permit rejection of stale, duplicate, cross-pane, wrong-strategy, expired, malformed, and conflicting events. User hook/config preservation and integration-health states must be explicit.

### C3 — Additive daemon protocol

Own updates to `internal/sessiond/protocol.go` only.

Extend rather than rename or reinterpret frozen messages. Add the minimum vocabulary for:
- daemon/schema/capability negotiation;
- composition-projected redacted pane recovery information;
- live pane recovery transitions;
- exact retry and explicit selection intents;
- lifecycle capture through the owner-local daemon boundary;
- replacement planning/commit and redacted outcomes;
- active pane persistence where needed.

Raw session IDs, transcript paths, CWDs, executable paths, argv, environment values, callback capabilities, and raw tool errors must not be projected to browsers. Explicit recovery selection may carry an exact opaque candidate only over the privileged daemon path and must remain bounded.

### C4 — TypeScript mirror

Own updates to `web/src/types.ts` only.

Mirror only browser-visible additive fields and messages. Browser recovery information is limited to status, fixed strategy label, stable redacted detail code, history-boundary flag, and whether retry/selection is available. The browser must have no type that grants launch, persistence, strategy-selection, CWD, callback-token, or external-session authority.

### C5 — Compatibility and scope discipline

Maintain source compatibility wherever an additive zero-value can do so. Existing fakes or mirror tests may receive compile-only updates only if current signatures otherwise fail. Do not add test cases or test files. Do not implement runtime persistence, storage, journal logic, history, adapters, callback commands, process launch, UI, service lifecycle, or documentation.

Exclusive ownership is limited to:
- `internal/sessiond/recovery_types.go`
- `internal/sessiond/recovery_strategy.go`
- `internal/sessiond/recovery_integrations.go`
- `internal/sessiond/protocol.go`
- `web/src/types.ts`
- existing protocol/mirror test files only when compile-only adjustment is unavoidable.

A needed edit outside this list is a residual: record it and stop rather than crossing lane ownership.

### C6 — Verification

Run and record exact output and exit status for:
- `git diff --check`
- `go build ./...`
- `cd web && npm run check:fast`
- focused existing protocol/mirror compile checks that already exist.

The full baseline is not green and must not be weakened:
- `make build`: PASS at batch start.
- `check:fast`: PASS with 8 existing warnings.
- Go suite: 4 existing failures (`internal/proxy`, `internal/service`, two `internal/sessiond` browser-action cases).
- Web suite: 19 existing failures and 153 passes.

Do not write new unit tests. Real browser/DTU proof belongs to later integration lanes.

### C7 — Banking and handoff

Work only in the assigned worktree. Do not touch the main checkout or sibling worktrees. The code anchor is `main@be5355e2451e367e08e872407dfd0841198b27a8`; the lane base is the committed batch-seed revision containing this goal and the approved design, as recorded by the orchestrator manifest.

Commit coherent work early with the required Amplifier commit footer. Push `HEAD` explicitly to `refs/heads/gb/crash-recovery/recovery-contracts`. Never merge to main or the integration branch. Include concise downstream compatibility notes in the final report.

Time bound: 40 minutes and 35 goal turns. Exceeding either bound is terminal `BLOCKED-named: BUDGET`; do not skip verification to fit the bound.

As the final act, write ignored `DONE.json` in the worktree root with fields: `lane`, this lane’s own `session_id`, `verdict` exactly `COMPLETE|BLOCKED|PARTIAL`, `branch`, `head`, `pushed`, per-item `items` with terminal states, `residuals`, `pending_human`, and `suite`.

## Scope-outs

- No runtime recovery implementation.
- No journal, snapshot, or terminal-history persistence.
- No tool-specific adapter behavior.
- No callback CLI or integration installation.
- No frontend state or visual component.
- No service, installer, DTU, documentation, dependency, or release changes.
- No new tests.
- No merge to the integration branch or main.

## KNOWN — speed aid, not completion criteria

- Governing design: `docs/designs/2026-08-29-strategy-based-terminal-crash-recovery-design.md`.
- `sessiond` remains structure, activity, persistence, and recovery authority; browser state is presentation only.
- Pane IDs are workspace-local and must always be workspace-qualified.
- Close tickets remain ephemeral and must not become durable recovery state.
- Same-UID/root tamper resistance is outside the current threat model; corruption, unsafe ownership, symlinks, and malformed state must still fail closed.
- Existing divergent `origin/session-crash-recovery` is research only; do not cherry-pick it.
