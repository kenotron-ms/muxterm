# Outcome

Muxterm supports only SDK chat harnesses with at most one resident harness runtime process across chats. SDK-owned processes that run a turn and exit on their own are allowed.

# Exit and evidence

End ACHIEVED when A–D pass. End CONCLUDED-BLOCKED if safe development or verification is demonstrably unavailable. Give each check and harness PASS with evidence, FAIL with unmet behavior, or BLOCKED with a named reason and residual work. Continue independent work after a blocker. Show evidence in chat and finish with a status table. Never label FAIL or BLOCKED as achieved.

# A. Process and support gate

Inspect installed Codex, Copilot, ACP Pi, ACP OpenCode, ACP DeepSeek, Claude, and Amplifier. With two chats idle, at most one harness runtime/adapter process may remain per harness; the common muxterm sidecar is excluded. SDK-owned per-turn workers may overlap if they exit on their own after their turns; a resident process per chat fails. Measure processes separately from native session history: a resumable session ID or end-of-turn result does not prove that a child exited. Native identity, isolation, detach, and resume must work. For each harness, PASS means verified retention or removal from new-chat choices, adapter dispatch, and support docs, with existing history preserved and access/export documented. Otherwise record FAIL or BLOCKED.

# B. Shared runtime and isolation

For every retained harness, keep persistent runtime ownership outside chat adapters; concurrent first use creates at most one resident runtime. Route events, questions, tool calls, errors, cancellation, and model/config state by native session/thread ID. Preserve separate cwd, permissions, histories, goals, and MCP authorization, including two chats in one directory. Codex, if retained, uses one app-server with proven chat-scoped MCP authority. Give each retained harness and cross-chat isolation separate PASS/FAIL/BLOCKED results. No per-chat resident backend fallback.

# C. Lifecycle and failure

Close/archive releases muxterm subscriptions, routes, callbacks, and pending requests without deleting native history or closing a runtime used by other chats. Document active-work and autonomous-goal policy. Reopen/reconnect does not duplicate sessions or delivery. Shared-runtime failure clears stale adapters, reports uncertain delivery, and never replays possibly accepted input. Shutdown disposes shared clients through supported APIs. Give close/archive, reopen/reconnect, failure, and shutdown separate PASS/FAIL/BLOCKED results.

# D. Verification and handoff

On this machine, verify retained harnesses with real integrations, sessiond, and browser on isolated `make dev-local` port 8313: concurrent first use, two-chat routing, interrupt, close/archive, reopen, reconnect, failure, and shutdown. Count processes during turns and at idle; prove per-turn workers exit without muxterm reaping. Verify removed harnesses cannot create new chats and history remains accessible. Use fresh workspaces/panes. Pass `go build ./...` and `cd web && npm run check:fast`. Preserve a reviewable branch or patch and report results/residuals. Give browser integration, static checks, and handoff separate PASS/FAIL/BLOCKED results. Stop dev-local or hand its exact processes, port, and owner to the user.

# SCOPE-OUTS

- No production install, deploy, service restart, or mutation of ports 8311/9090.
- No custom eviction, cache cleanup, or forced native thread unloading.
- No native history deletion merely to remove or archive a harness/chat.
- No unit tests, production soak, merge, PR, or machine-level Codex policy change.

# SPIKE — speed aid, not acceptance evidence

The [harness spike](../../docs/spikes/shared-harness-runtime.md) found shared APIs for Codex/Copilot, concurrent DSH sessions, and an Amplifier host. Pi ACP spawns per-session processes. Claude session history persists independently of process lifetime. A dev-local browser run now confirms streamed input during an active turn and SDK-owned child exit after the turn using finite-per-turn streaming queries; remaining Claude lifecycle checks still apply. OpenCode needs MCP isolation proof. Recheck against the installed versions on this machine.
