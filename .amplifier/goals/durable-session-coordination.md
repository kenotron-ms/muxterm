# Outcome

Muxterm provides a reviewable, durable way for Codex, ACP, Copilot SDK, and Amplifier chat sessions to coordinate work, inspect progress and subscribed events, and choose when to attend to those events.

Finish when the four checks below have concrete evidence and each is recorded as PASS, FAIL, or BLOCKED with a named reason. The goal may end with residual FAIL or BLOCKED items when further progress is conclusively impossible in this run; report those items and their evidence rather than claiming the outcome was achieved. Show evidence in the conversation as it is obtained and summarize the final state.

1. **Work records.** PASS if a session can create, list, inspect, and idempotently update a durable work record with owner, participant sessions, status, progress, evidence, and outcome, and those fields survive a dev-local restart. Otherwise record FAIL or BLOCKED with the observed failure or named blocker.
2. **Subscriptions and inbox.** PASS if a session can subscribe to selected topics from two source sessions, receive attributable events without duplicates, read them with a resumable cursor after restart, and recover matching events across a crash between source journaling and inbox delivery. Otherwise record FAIL or BLOCKED with the observed failure or named blocker.
3. **Agent-selected attention.** PASS if MCP exposes the work and inbox mechanisms to Codex, ACP, Copilot SDK, and Amplifier sessions; the coordination guidance covers lazy next-turn reads, active in-turn waits, and explicit session messages; and a configured hook or runner can present unread events as untrusted reminder data without subscription itself waking an idle session. Demonstrate a supported ACP and Copilot SDK path. Otherwise record FAIL or BLOCKED with the observed failure or named blocker.
4. **Inspection and verification.** PASS if the browser Coordination view shows work history, inbox, and subscriptions in a real dev-local browser/sessiond run; Copilot uses the SDK with native steering in a real chat; the relevant flows above are observed end to end; `go build ./...` and `cd web && npm run check:fast` pass; and the implementation and evidence are reviewable in a pull request without transient artifacts in the repository. Otherwise record FAIL or BLOCKED with the observed failure or named blocker.

Use `make dev-local` on port 8313 for browser verification. Stop only the isolated dev-local processes started for this run, identifying their exact binary paths and PIDs; report any isolated process deliberately handed off to the user. Never disturb the installed muxterm, its sessiond, or production ports 8311 and 9090.

## SCOPE-OUTS

- No A2A endpoint, client, or protocol conformance work is required.
- No rigid Operator mode or special authority for a coordinating session is required.
- No automatic wake of an idle session on a matching subscription event is required.
- No Chat Goal creation, revision, or control is required; work records remain separate from Chat Goals.
- No unit tests, production deployment, live-service restart, or merge are required.

## KNOWN — speed aid, not an acceptance substitute

The checkout already contains MCP tools for work records, topic subscriptions, inbox reads, and session messages; a Coordination browser view; and a muxterm-coordination skill. Prior dev-local browser checks observed work updates, participant linking, inbox delivery from multiple sessions, and persistence across reload. Prior Go build, Go vet, and web fast checks passed. Inspect and strengthen the existing implementation instead of recreating it. In particular, source journaling and inbox fanout currently use separate writes, leaving a crash gap to close.
