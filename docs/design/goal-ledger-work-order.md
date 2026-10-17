# Work order: harness goals and a muxterm ledger

Human-approved scope, 2026-10-17. Execute with one implementation lane; do not
delegate further. This document is the assignment, not a new continuation engine.

## Stop condition

Muxterm exposes supported harness goal capabilities for Amplifier, Claude Code,
and Codex through a compact composer UX, records goal revisions and execution
evidence in a durable muxterm-owned ledger, and structurally restricts agent chat
communication to operator/direct-lane relationships. Real browser and sessiond
verification demonstrates implemented behavior, with screenshots and an explicit
per-harness capability/gap report. Unsupported capabilities remain visible gaps,
not simulated native support. Do not claim completion for unverified behavior.

## Approved UX

- One single-line goal banner immediately above the composer message field.
- Keep the goal text readable, truncating when necessary; expose the full condition
  on inspection. Use icon-only edit, pause/resume, cancel, and ledger controls,
  with accessible names and tooltips. Do not restore the large goal card.
- Human edits are available mid-run. Preserve the running execution until the
  supported harness boundary; distinguish saved/requested and harness-applied
  revisions. Never imply an immediate update without acknowledgement.
- Open a full editor only on demand. Open the shared ledger in a utility surface,
  not a permanently expanded composer section.
- Show human-paused state and capability gaps without expanding the normal banner.
- Standalone goal ownership must not require an operator or manager session.

## Authority and lifecycle

- Only authenticated human actions may set or revise goal conditions. Agents,
  including operators, may propose revisions but cannot apply them. A model
  claiming to act for a human is not human provenance.
- Agents may request pause/resume/cancel through scoped tools, but cannot resume
  a human-paused goal or control unrelated/peer lanes. Only a human releases a
  human pause. Preserve the distinction across restart.
- Harnesses or supported harness configuration own execution, stop evaluation,
  and continuation. Muxterm owns adapters, controls, durable records, and views.
  Do not introduce a host keep-going loop or silently restart a stopped goal.
- Preserve native lifecycle semantics. Unsupported transport/version/configuration
  capabilities must be explicit. A completed turn is not an achieved goal.
- Separate requested control, acknowledged application, achieved, blocked/failed,
  cancelled, budget-limited, and uncertain outcomes as supported by the harness.
  Preserve native detail instead of inventing equivalence.

## Ledger

- Muxterm owns durable SQLite storage. Canonical records are liberal JSON
  documents; relational columns exist only for identities, real indices, and
  transactional concurrency. Avoid duplicate independently editable state.
- Record stop condition revisions, human provenance, lane ownership, optional
  operator association, native execution references, requested/applied revisions,
  control receipts, observations, evidence references, and outcome history.
- Validate/version documents in application code. Use transactional revision
  checks and idempotent admissions. Restart uncertainty never authorizes replay.
- Shared visibility is not shared control. Authorized lanes may read scoped
  records and report their own evidence, not modify peers or smuggle instructions
  through comments/notifications that wake peers.
- No mandatory task breakdown, work pool scheduler, or manager session in this
  increment. Preserve a path to later atomic assignment claims without building
  that scheduler now.
- Consult unified OperationJournal, TaskController, and coordination views for
  durable receipts, applied revisions, and uncertainty. Do not copy its peer
  messaging or automatic peer-continuation policy.

## Structural communication boundary

- Agent chat sends are allowed only operator to direct lane or lane to direct
  operator. Deny peer and unrelated targets at the server authority boundary.
- Audit app-mediated alternative write paths, sender capability propagation,
  session sends, terminal-input routes, and topology mutations. Do not allow an
  agent to escape the policy by relinking chats or omitting caller identity.
- Preserve authenticated human controls. Document the remaining same-OS-user
  unrestricted-shell limitation; do not claim OS isolation that does not exist.

## Acceptance and safety

- Read and obey AGENTS.md, including scoped instructions. Preserve the existing
  heavily dirty tree. No commits, branches, installation, or deployment.
- Never disturb production muxterm/sessiond/proxy or use production ports
  8311/9090 for mutating verification. Use make dev-local on 8313 or a DTU only.
- No unit tests. Verify using a real browser and real sessiond, fresh fixtures,
  no source edits during browser passes, and no hand-rolled scratch server.
- Verify all three harnesses against actual available runtimes. Report supported,
  unsupported, and unverified separately. Do not substitute mockup screenshots
  or scripted adapters for claims of real native-harness behavior.
- Demonstrate persistence/reload, mid-run requested/applied revisions, human-only
  goal edits, human-pause protection, ordinary non-goal chat, direct operator
  communication, and rejected peer/bypass attempts.
- Run go build ./..., go vet ./..., and web npm run check:fast. Do not add tests.
- Store logs/screenshots under /home/ken/artifacts/ in a task-specific directory.
  Keep durable repo documentation concise and free of verification residue.
- Report changed files, verification results, gaps, and blockers concisely.
  Stop on concrete blockers rather than inventing support or widening authority.

## Existing partial work

There are unfinished, unverified goal changes in sdk_chat_goal.go, sdk_chat.go,
server.go, codex-stream.mjs, and sidecar.mjs. Reassess them; they are not an
approved implementation. Known risks include agent goal-edit authorization,
late synthetic snapshots overwriting terminal events, missing Codex cleared
notifications, stale native state, and unverified Claude SDK goal controls.
Existing peer-send restrictions were previously checked, but remaining identity,
alternative-path, and topology bypasses require this increment.
