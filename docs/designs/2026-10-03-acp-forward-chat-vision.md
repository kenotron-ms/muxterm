# Chat vision: ACP first, harness aware

**Date:** 2026-10-03
**Status:** Product direction, not an implemented feature or compatibility claim.

## The experience

Muxterm should be a home for coding-agent conversations. A person chooses a familiar harness, starts or resumes a chat, sees its work and decisions, and can steer, interrupt, or give it a durable goal. The chat remains available across browser reconnects. The agent's own capabilities should come through without forcing every harness into the smallest common feature set.

**ACP is the default connection between muxterm and compatible agents.** Muxterm remains the host: it owns the browser experience, durable chat record, viewer synchronization, voice interface, and the working environment around the agent. Its ACP client should handle the standard session, prompt, update, permission, and cancellation contract once. Harness-specific integration then adds the behavior that makes each popular agent feel complete in muxterm.

This direction concerns coding-agent chats. It does not revive Operator, replace sessiond's PTYs, or turn workspaces into separate Mission Control conversations.

## Two layers of support

1. **General ACP path.** A configurable ACP executable can create or resume a session, stream text and tool activity, ask for permission, accept attachments it advertises, and complete or cancel a turn. The UI exposes negotiated capabilities rather than assuming that a listed agent supports every option.
2. **Curated harness profiles.** For a small, maintained set of widely used agents, muxterm supplies a tested launch recipe and deliberate mappings for authentication, model and mode controls, session recovery, steering, subagents, permissions, and goals. A profile describes an agent's actual ACP behavior and extensions. An advanced user can still configure another ACP agent without waiting for a curated profile.

The first integration wave is Pi, OpenCode, and DeepSeek Harness. Bring each to a usable coding chat with verified prompt streaming, tools, cancellation, settings, and recovery before moving Codex and Claude onto ACP. Codex and Claude keep their existing native chat paths during that work. Gemini CLI, GitHub Copilot CLI, Goose, and Qwen Code remain candidates after the first wave. This is a research queue, **not** a claim that all agents have equivalent ACP support or will ship together. Recheck launch commands and capabilities against pinned agent versions.

## One `/goal` experience, with explicit ownership

`/goal` means a **durable completion objective for one chat session**, not a synonym for a long prompt or a visible plan. The chat shows the objective, current state (`active`, `paused`, `blocked`, `limited`, or `complete`), who drives continuation, and what happened in the latest turn. The current turn can finish while the goal remains active. A goal and its status must survive a browser disconnect; recovery after an agent restart depends on the agent's actual session support.

There are two execution paths:

| Path | When used | Continuation owner |
| --- | --- | --- |
| Agent goal | The connected agent advertises a usable goal control extension or another verified native goal contract. | The agent sets the goal state and advances its own work. Muxterm sends only advertised controls and displays authoritative goal updates. |
| Muxterm goal | The agent lacks a usable goal contract but supports the ACP turns and session recovery needed for a host-run loop. | Muxterm stores the objective and sends the next ACP prompt only after the previous turn settles. It checks progress and completion, and stops on success, a blocker, an explicit limit, or user action. |

**Exactly one side drives continuation.** A native goal must not be wrapped in a second muxterm loop. A host-run goal must not be represented as an agent-native goal in the UI. The per-chat record identifies the goal owner, agent/session identity, objective, limits, state, and last confirmed progress. A failed or uncertain turn is not automatically retried as if nothing happened; muxterm should reconcile the session first and show uncertainty when it cannot.

For a host-run goal, a normal ACP `end_turn` means *that turn ended*. It does not prove the objective was met. Completion needs the stated stop condition and observable evidence where available; an agent's own claim can be shown separately from verification. The runner needs limits on turns, time or spend, no-progress detection, and a `blocked` state for decisions or permissions that need a person. `Stop` cancels the current turn; `Pause goal` also disarms future turns. `Clear goal` removes the objective without deleting the chat.

This is the self-healing opportunity: when a turn leaves work unfinished, muxterm can keep the objective in view, give the agent the observed gap, and let it try the next step in the same recoverable chat. Recovery should use real turn and session evidence. Repeated failure, missing session history, or unclear effects move the goal to `blocked` or `limited` rather than producing an invisible retry loop.

Do not send `/goal …` blindly through `session/prompt`: ACP does not define that slash command, so another agent may treat it as ordinary text. The composer should interpret muxterm's goal command and choose the negotiated native control or host-run path. The same rule applies to steering: use a verified extension when available, otherwise queue input for a later turn or offer interruption with a clear receipt.

## Harness-specific opportunity

Codex's ACP adapter documents an experimental, provider-neutral `_session/goal` extension with `set`, `pause`, `resume`, and `clear`. Claude's adapter documents the same extension shape but requires clients to honor its advertised action subset. This is an integration seam to test, not an ACP v1 guarantee. [Codex goal extension](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/goal-extension.md); [Claude goal extension](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/docs/goal-extension.md).

DeepSeek Harness has its own durable goal domain and continuation driver, but its official ACP server is documented as an automation surface rather than a human-facing goal control API. A curated DeepSeek profile could use a verified richer adapter or a muxterm-owned goal; it should not assume the internal `/goal` command is available through generic ACP. [DeepSeek goal packages](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/goal/README.md); [official ACP server](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md).

For Gemini CLI, Copilot CLI, OpenCode, Goose, Qwen Code, and future agents, discover what the running ACP connection actually advertises. A plan update, slash-command listing, or successful long prompt does not by itself establish durable goal support. The generic muxterm goal runner is the fallback when its session and turn semantics can be verified. [ACP prompt lifecycle](https://agentclientprotocol.com/protocol/v1/prompt-turn).

## What to build toward

1. Establish the general ACP chat path and retain muxterm's server-owned chat ID, event history, and browser fanout. Treat the ACP session ID as an agent-owned resume pointer.
2. Add curated profiles one at a time, checking real behavior for login, permissions, streaming, cancellation, resume, steering, and any goal extension. Record unsupported capabilities honestly.
3. Add a goal state and controls to the chat UI. First prove one native goal profile; then prove a host-run goal against an agent without native goals, including pause, reconnect, limits, and blocked recovery.
4. Bring voice and other muxterm host features to ACP chats through the same chat controls. Voice input is a way to issue a prompt or steer; it does not create a second goal owner or bypass an approval.

The measure of success is that a user can choose a popular harness and pursue a goal through one coherent muxterm chat, while muxterm makes clear which behavior belongs to the agent and which behavior it supplies itself.
