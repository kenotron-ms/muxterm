# Scheduled jobs through MCP

Scheduled jobs are persistent Chat conversations with standing instructions, a cron schedule or Work event trigger, and a recorded run history. They are separate from sessiond triggers (`list_triggers` and related tools).

The MCP server exposes these tools:

| Tool | Action |
| --- | --- |
| `list_jobs` | List jobs and their latest run on one machine |
| `get_job` | Read one job definition and state |
| `create_job` | Create a job for an existing Chat |
| `update_job` | Edit a job, including `enabled` for pause and resume |
| `run_job` | Start one manual run |
| `list_job_runs` | List recent runs for one job |
| `get_job_run` | Read a run's status, summary, and log |

All seven tools accept `machine`. Omit it or use `local` for this server. For a remote, use a connected machine ID from `list_machines` (a unique connected name also works). An unknown or disconnected machine fails; the action is never redirected to local. The tools use the authenticated Jobs API and the same scoped Chat agent boundary as other Chat and Work tools. A Chat-owned MCP process needs its live Chat capability. Remote requests also require an authorized originating Chat and an active remote connection.

Create a Chat with `spawn_chat` or choose an existing Chat from `list_chat_sessions`. A Chat can own one job. For `create_job`, supply `chat_id`, `name`, `brief`, and a stable `client_ref`, plus a five-field cron `schedule`, a `work_trigger`, or both. `timezone` is an IANA zone and defaults to UTC. A Work trigger has `events` (`review`, `blocked`, or `done`) and optional `project_ids` and `labels`. The server validates these fields and reports invalid definitions or busy Chats as errors.

For an uncertain create or manual run response, retry with the **same** `client_ref` and request. A matching create returns the original job; a matching manual run returns the recorded run, even after it finishes. Reusing a reference for a different creation or run is an error. The Jobs screen does not supply a reference and retains its existing behavior.

`update_job` changes only supplied fields. Set `enabled=false` to pause future scheduled and Work event fires, and `enabled=true` to resume them. Pause does not cancel a run already in progress; `run_job` can still start a manual run while a job is paused. Set `schedule=""` to remove cron scheduling when a Work trigger remains. Set `clear_work_trigger=true` to remove Work events when a cron schedule remains. An identical Work trigger edit preserves its event cursor. Changing a trigger definition or resuming it starts its cursor at the current time.

`run_job` returns a run receipt when the run is queued. Read `get_job_run` for the eventual outcome; admission alone does not mean the Chat completed the work. `list_job_runs` returns up to 300 recent runs per job, newest first. A retained manual run with a retry reference remains retrievable by its ID and reference after it ages out of that list.
