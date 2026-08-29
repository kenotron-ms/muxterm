# Goal: make recovery contracts semantically safe

## Outcome

Produce a committed, pushed corrective contract slice on `gb/crash-recovery/recovery-contract-semantics` that resolves the three load-bearing Wave 0 review defects and proves those semantics with a temporary executable contract probe.

Complete when **either** every item reaches a terminal state, **or** it is conclusively demonstrated the remainder cannot, naming the blocker for each. Items ending `FAIL-named` or `BLOCKED-named` are residuals, not failures of the goal. Record each item as `PASS`, `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN`.

## S1 — Negotiation must be reachable

Repair protocol hello handling so bounded, syntactically valid, nonzero offered schema versions reach daemon compatibility evaluation even when they differ from the current version. Bounded unknown future capability names must not cause pre-dispatch rejection; the daemon can return the recognized intersection and a redacted `compatible=false / schema-incompatible` result. Reject only malformed, zero, duplicate, over-capacity, control-bearing, or overlong offers at ingress. Preserve strict validation for server-produced negotiation results.

## S2 — Authority-bearing results must be discriminated

Replace lifecycle and candidate resolver return contracts with validated discriminated results:
- success contains exactly one fully validated resolution and no rejection;
- failure contains no resolution and exactly one compatible redacted detail/rejection code.

Make invalid mixed/empty states impossible to construct through the public contract or rejected by canonical construction before consumers can observe them. Exact external session identity remains daemon-local and never serializes to browser JSON.

## S3 — Reject oversized fixed arrays before truncation

Go JSON decoding into fixed arrays silently discards excess elements. Add bounded temporary wire decoding and explicit copy only after length validation for every recovery fixed-array wire type, including:
- lifecycle capability: exactly 32 bytes;
- protocol capability lists;
- argv and environment entries;
- replacement pane census and shell-only acceptance sets;
- browser candidate handles/lists;
- any other changed recovery array reachable from JSON.

Require count/array consistency, reject over-capacity, duplicate/disallowed entries, and nonzero unused slots. Do not allocate or process beyond existing recovery-specific byte/count bounds.

## S4 — Preserve prior security and scope

Preserve workspace-qualified active selection, daemon-owned replacement census, server-issued lifecycle leases, decode-into-temporary destination immutability, structurally separate owner-local messages, browser opaque candidate handles, fixed four-strategy roster, structured executable/argv/CWD/allowlisted environment, and redacted browser projection. Do not restore a generic `Message.UnmarshalJSON` behavior change or broaden generic transport limits.

Own only:
- `internal/sessiond/protocol.go`
- `internal/sessiond/recovery_integrations.go`
- `internal/sessiond/recovery_strategy.go`
- `internal/sessiond/recovery_types.go`
- `web/src/types.ts`

A required edit outside ownership is a named residual. No runtime, store, adapter, relay, UI, docs, dependencies, or committed tests. Do not load skills, delegate, research, or inspect unrelated branches.

## S5 — Direct executable semantic probe

Create a temporary non-test executable inside the module, run it, capture its exact output, and remove it before commit. The probe must exercise production contract APIs and fail nonzero unless all checks pass:
1. a mismatched but bounded schema hello decodes and reaches an incompatible negotiation result;
2. unknown bounded capability offers decode and only recognized capabilities appear in the negotiated intersection;
3. success/failure lifecycle and candidate results cannot expose authority on failure;
4. rejected canonical decode leaves caller destination unchanged;
5. oversized capability, argv, environment, pane-census, and candidate arrays are rejected rather than truncated;
6. unknown fields and trailing JSON are rejected;
7. unchanged generic `Message` decoding still accepts a representative existing non-recovery message.

This probe is verification-only, is not a unit test, and must not remain in the repository or commit.

## S6 — Fresh verification

Run and record:
- gofmt on changed Go files;
- `git diff --check 14fca62...HEAD` plus dirty-tree check;
- `go build ./...`;
- `cd web && npm run check:fast`;
- existing TypeScript protocol mirror check and `tsc --noEmit`;
- temporary executable semantic probe;
- `TMPDIR=/tmp go test -count=1 ./...` only to compare the known four Go baseline failures.

Do not add tests or chase the known baseline. Baselines: `check:fast` has 8 warnings/0 errors; Go suite has exactly four known failures; web full suite has 19 failures/153 passes.

## S7 — Bank and hand off

Work only in the assigned worktree. Base is the committed seed containing this goal on top of `14fca62c15754d83012c6d72c90e150f7b523859`. Commit coherent work with the required Amplifier footer and push explicit `HEAD:refs/heads/gb/crash-recovery/recovery-contract-semantics`. Never merge to integration or main.

Time bound: 35 minutes / 25 goal turns. Exceeding either is terminal `BLOCKED-named: BUDGET`; do not skip verification.

As the final act, write ignored root `DONE.json` with `lane`, this lane's own `session_id`, `verdict` exactly `COMPLETE|BLOCKED|PARTIAL`, `branch`, `head`, `pushed`, item terminal states, `residuals`, `pending_human`, and `suite`.

## Scope-outs

- No runtime persistence or recovery behavior.
- No store, journal, snapshots, history, adapters, callbacks, relay, frontend state/UI, service, installer, DTU, docs, dependency, or release changes.
- No committed tests or temporary probe artifact.
- No merge to integration or main.

## KNOWN — speed aid only

- Parent contract head `14fca62c15754d83012c6d72c90e150f7b523859` passed targeted security review but failed the three semantic findings above.
- Review package: `/tmp/crash-recovery-contracts-final-review.md`.
- Same-UID/root compromise is outside this threat model; malformed, oversized, stale, or ambiguous data still fails closed.
- `DONE.json` is ignored and must not be committed.
