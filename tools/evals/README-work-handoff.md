# Work handoff integration eval

This eval asks real Codex chats in an isolated muxterm DTU to create Work items
from simulated user requests. A Playwright browser creates a fresh managed
project for each scenario, starts the requesting chat, then reads the Work
record and both chat transcripts. It does not mock the Work API, MCP tools,
chat state, or dispatch path.

## Run

Provision an isolated Incus DTU with the current muxterm binary, Node 22 or
newer, and a configured Codex credential. Expose only that DTU's muxterm port
on a distinct loopback port. Never point this eval at the live 8311 or 9090
services; the runner rejects those ports. Install the web package dependencies
for Playwright and have Chrome available on the host.

```sh
MUXTERM_EVAL_URL=http://127.0.0.1:18413 \
MUXTERM_EVAL_CONTAINER=muxterm-work-handoff-eval-20261118 \
node tools/evals/work-handoff.mjs
```

The container variable identifies the DTU where the runner writes a tiny
`README.md` fixture into each fresh project. The policy scenarios also write
an `AGENTS.md` coordinator instruction. Pass scenario names after the script
to run a subset, such as `baseline explicit-a explicit-b`.
Set `MUXTERM_EVAL_OUTPUT` to change the artifact directory. The default is
`/home/ken/artifacts/work-handoff-eval-20261118/runs`.

| Scenario | Request or instruction being exercised |
| --- | --- |
| `baseline` | A natural request to create a Work item and let muxterm choose a worker. |
| `explicit-a`, `explicit-b` | Two coordinator prompts that require an unassigned item, `start_work_item`, and a separate claim. |
| `ambiguous` | A short “please start work” request with no handoff instruction. |
| `policy`, `policy-minimal` | The same short request with a full or compact coordinator policy in project `AGENTS.md`. |
| `self-claim` | A control that permits the requesting chat to implement the item itself. |

A handoff passes only when there is exactly one Work item in that scenario's
project, its `dispatch.state` is `claimed`, and `ownerSessionId` equals the
dispatch chat ID but differs from the requesting chat ID. The `ambiguous` and
`self-claim` controls are expected to fail this handoff criterion. Each run
stores the exact prompt, Work record, and raw coordinator and worker histories in a JSON artifact for
inspection. The script exits nonzero when an observed outcome differs from the
scenario's expectation; positive scenarios must also finish their small task.

## Observed in the DTU on 2026-11-18

The current Work API was built from `ce519c73`. Each run used a new managed
project and a real Codex coordinator chat. The seeded comparison used the same
short user request: “The project needs a glossary. Please start work on that.”

| Instruction | Runs | Separate owner and completed task |
| --- | ---: | ---: |
| No project policy | 1 | 0 |
| Full project policy | 2 | 2 |
| Compact project policy | 3, including two concurrent | 3 |

Without the policy, the coordinator edited `GLOSSARY.md` itself and created no
Work item. In all three compact-policy runs, the coordinator used
`create_work_item`, `start_work_item`, and `get_work_item`; the worker used
`get_work_item`, claimed with `update_work_item`, edited the file, and marked
the item done. Two earlier policy runs also handed off ownership but workers
blocked because those projects contained no source material. The fixture now
seeds a README so the documentation task can be completed.

The compact candidate placed in each project's `AGENTS.md` was:

```text
When a user asks to start work, create an unassigned Work item for this
project ({project_id}) with a next action and acceptance criteria. Call
start_work_item. Do not claim or implement in this chat. Confirm another
chat claimed the item; otherwise report the blocker.
```

The direct “create and start” prompt succeeded in one run, and two longer
coordinator prompts succeeded in one run each. A self-claim control assigned
the requesting chat and never dispatched. These small samples show the prompt
can work; they cannot establish a reliability guarantee across harnesses and
tasks.

For a product guarantee, muxterm needs one idempotent create-and-dispatch
operation that leaves work unassigned, excludes the requesting chat from worker
selection, and exposes `sent` separately from a confirmed `claimed` state.
The project policy is a useful default while that mechanism is built.
