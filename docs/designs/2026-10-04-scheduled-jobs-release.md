# Scheduled jobs in SDK Chats

**Status:** Implemented for the first release on 2026-10-04.

A scheduled job is a persistent SDK chat with a schedule and standing instructions. Both manual and scheduled runs send a new turn to that same chat. The chat keeps the full conversation and tool details. Each run also has a separate durable record with its trigger, the exact instruction revision and text used, timestamps, outcome, and a bounded chronological log.

## Authoring and review

The Scheduled jobs entry in the sidebar opens a table with status, schedule, next and last run, search, filters, manual Run now, history, pause or resume, and edit controls. New job starts a chat with a natural-language prompt. The person can discuss the work with the agent, then use **Schedule** in the chat to review its name, standing instructions, schedule, timezone, and enabled state. The latest assistant answer can be brought into that editor as a draft; it is not applied without review. Editing standing instructions creates a new revision. Runs already admitted retain their original revision and text.

The schedule field accepts five-field cron expressions, `every hour`, `daily`, `every day`, and `weekdays at 9am`-style phrases. The server stores the canonical expression and the phrase entered by the person. It computes the next occurrence with the selected IANA timezone.

## Execution and recovery

The HTTP server owns this first scheduler. It stores job records under the existing isolated SDK chat data directory and run records in a `jobs/runs` subdirectory. Before dispatch it persists the due occurrence, its next fire time, and a run admission record. An occurrence already recorded cannot be dispatched twice. An active run blocks overlapping manual turns and scheduled starts; a skipped scheduled occurrence appears in history. Run now works while a schedule is paused.

When a server restarts, in-flight runs become **outcome unknown**. An overdue scheduled occurrence becomes **skipped**; the scheduler does not replay missed work. Runs use the chat's current harness permissions and can invoke the agent's normal code and tools. The run log records admissions, tool names and outcomes, and completion. Full tool detail remains in the protected chat history. Runs with no result report are marked outcome unknown.

The first release does not add a separate service-connection manager or extension marketplace. The scheduler lives in the HTTP server; moving admission into sessiond is future work if schedules must continue during an HTTP server outage. The list currently returns the latest 300 run summaries per job, while run records remain on disk.

## Browser verification

The isolated dev-local stack on port 8313 was used with a real Chrome browser and fresh workspaces. The final pass created a job from a chat, completed a manual run, revised its instructions, paused it, ran it manually while paused, resumed it, observed a scheduled run, reloaded the browser, and opened its run log and project file preview. See the committed [jobs screenshot](../verification/2026-10-04-scheduled-jobs.png) and [chat/file screenshot](../verification/2026-10-04-chat-files.png).
