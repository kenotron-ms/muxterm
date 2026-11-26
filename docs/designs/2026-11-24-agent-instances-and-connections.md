# Agent instances and connections

**Status:** Muxterm product contract. Teams is the first intended connection.

Microsoft's [Agents in Teams overview](https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/overview) calls a Teams SDK conversational app an agent. The existing custom-upload Agent Bridge already provides that bot-backed entry point. Its current one-shot OpenAI command supplies replies, but does not yet give the bot Muxterm agent identity, durable Muxterm chat history, or task/tool execution. The first live integration should connect that bot to a Muxterm agent through the generic connection contract; it does not depend on Agentic User factory approval.

## Core ownership

`muxterm serve` hosts independently addressable, durable **agent instances**. Each agent has a stable `agentId`, configuration, accepted Work, and one continuation owner for each Work item. An agent may participate in several conversations, run several chats, and change harnesses or machines without changing identity. A harness session is an execution choice, not an agent.

Muxterm owns agent identity, the Work ledger, source conversation links, execution routing, and the UI for inspecting them. Slack, Discord, Telegram, Mattermost, and Teams each remain authoritative for their own conversation IDs, history, audience, permissions, and publication receipts.

A **connection** translates between one source and a Muxterm agent. It owns platform credentials, installation state, routing, delivery bookkeeping, and platform tools. Its transport may be a hosted relay, local adapter, or another arrangement. The common contract must not require a sidecar or public port on every Muxterm installation. An outbound connector in the Go service starts and stops with that service when configured. Teams, Slack, Discord, Telegram, and Mattermost are adapters to this contract; none defines Muxterm's agent, chat, Work, or receipt model.

## Stable references

| Reference | Owner | Meaning |
| --- | --- | --- |
| `agentId` | Muxterm | Continuing participant across sources and harnesses |
| `workId` | Muxterm | Accepted responsibility, origin, revision, limits, and status |
| `chatId` | Muxterm | Inspectable chat and execution history |
| `executionId` | Muxterm or harness | One execution or turn |
| `connectionId` | Connection | Authorized bridge to a source installation |
| `sourceConversation` | Source | Source-qualified room, chat, and optional thread |
| `sourceMessageId` | Source | Original contribution or reply reference |
| `deliveryId` | Connection | Stable idempotency and reconciliation key |

No one ID substitutes for another. One agent can join several conversations, and several agents can join one conversation. A source conversation and execution chat need not be one-to-one forever. The first connector may use one Muxterm chat per source thread while retaining separate agent and source identities.

## Generic connection contract

1. The connection authenticates a source event and resolves the addressed agent, actor, audience, source conversation, and original message ID. It supplies those as structured turn facts. An unknown or disabled agent is rejected without fallback.
2. Muxterm authorizes the connection for that agent and source scope. It accepts input under a stable `deliveryId`, records its disposition, and returns a receipt. After a lost response the connection inspects that same ID.
3. The agent supervisor decides whether input joins accepted Work, starts new Work, or is an ordinary conversation turn. It selects an execution chat and harness. Source audience and authorization remain attached.
4. A reply or Work outcome carries `agentId`, `workId` if any, `sourceConversation`, original `sourceMessageId`, and a publication key. The connection publishes through the source API and returns a source message ID or an explicit uncertain result.
5. Revocation, removal, and source access changes stop delivery and effects according to their scope. Goal and Work controls retain their authority rules; a connector cannot impersonate a Muxterm browser by setting a `source` field.

Agent recall of other conversations is an explicit, authorized capability with source and history coverage labels. Private transcripts are not merged into every prompt. Muxterm may display a source conversation through authorized reads, while the source remains authoritative.

## Work and continuation

Each accepted Work record names the agent, original source, current owner, result destination, revision, limits, and outcome evidence. The Muxterm supervisor drives bounded turns only when Muxterm owns continuation. When a harness owns a native durable goal, Muxterm observes it and does not run a second loop. An ambiguous effect or lost receipt triggers reconciliation or a visible blocked state before retry.

An agent can move to another Muxterm host, but only one home service owns continuation for each Work item at a time. Conflicting live claims hold delivery until the binding is resolved; recency alone does not transfer responsibility.

## Teams connection profile

**First live route: existing custom-upload app.** Keep the working Teams SDK bot registration, ZIP, and HTTPS callback. Bind its personal Teams conversation to exactly one Muxterm agent, then replace its standalone OpenAI command path with a relay connection to that agent. A source conversation is never silently switched to a different agent. The Teams chat keeps its own history; agent identity, permitted memory, and Work ownership can continue across that agent's other surfaces without silently merging transcripts. A Muxterm UI can show the linked Teams conversation through an authorized source read. Use the same authenticated source facts, receipts, and source reply boundary as other connectors. Preserve the current live runner until this replacement is verified end to end.

**One Teams conversation per Muxterm agent.** For each owner, each agent should appear as a separate top-level Teams conversation, not as an agent selector or a thread inside one bot chat. The existing Agent Bridge personal bot can supply the first agent's conversation. Adding a second separate personal chat requires another Teams participant identity: a separately registered bot/app or an Agentic User from a shared factory. A Teams thread has a root message ID inside its containing chat and does not satisfy this requirement. The central relay and Muxterm connection protocol can still be shared by all of those identities.

**Shared Teams conversations.** The personal one-to-one chat is each agent's direct address, not a limit on where it may participate. Distinct agent identities may also join the same authorized group chat or channel thread. The connector selects the addressed agent from the authenticated bot or Agentic User identity and then uses the containing Teams conversation and optional thread root as source context. Each agent keeps its own execution session and delivery receipts for that shared source conversation. Agent-authored turns need explicit peer identity, authorization, and bounded reply rules so agents can converse without a bot loop; the first Go admission slice accepts person-authored messages only. Being in a shared thread does not grant access to other agents' private chats. This follows Constellation's [Slack connector](https://github.com/microsoft/amplifier-acp-slack) model, whose setup creates a separate Slack app per agent. Its [Teams connector](https://github.com/microsoft/amplifier-acp-teams) similarly describes a bot identity per installation; that repository states live tenant validation is pending.

**Per-agent Teams identities: Agentic User factory.** This is the scalable Teams-specific profile for separate named, directory-visible agents. It extends the same Muxterm contract and needs tenant activation; it is not a prerequisite for connecting the first agent through the current bot-backed route.

The per-agent identity shape is an **Agentic User factory**: one shared blueprint and relay, with a separate named Teams Agentic User per Muxterm agent. The relay resolves activities by tenant ID and addressed Agentic User ID, not by Teams conversation ID alone. It stores the per-agent identity client ID and Agentic User object ID, plus Teams conversation, thread, activity, and service URL references. It sends as the addressed Agentic User. Teams owns thread history and membership.

The relay runs on the dedicated `teamsbot-relay` Incus instance. Each Muxterm Go service opens an authenticated outbound connection. The relay runs no model; the old standalone OpenAI runner must stop before the same events are forwarded to Muxterm. The current custom-upload bot stays online until the bot-backed route is verified. Its app registration cannot be silently reinterpreted as a factory blueprint.

The **Agentic User profile** requires a development tenant able to register an agent identity blueprint, admin activation and consent, and preview Agentic User support. Provisioning uses Microsoft Graph beta. These are external prerequisites for per-agent Teams identities, not for bot-backed agent capability or Muxterm's generic contract.

## Implementation checkpoint

The first Go slice persists agent records, optional defaults, chat associations, and source conversation links. Its in-process connection seam can create an idle chat for a new source conversation at a deterministic ID, then link it without sending an unreceipted opening turn. It admits a person-authored message, saves a receipt before harness dispatch, and reconciles a lost acknowledgment from the chat's durable `input.accepted` event. It carries source and audience facts as structured receipt data and into the harness input. A connector can read a completed turn from the linked chat's durable event history and prepare a publication intent before calling a source API. Dispatching, uncertain, and published states preserve the source send boundary across restarts. It does not yet call any source API, supervise agent-owned Work, or run a platform connector. Those behaviors remain required before any live integration cutover.

## Qualification

Prove that one agent has two separate source conversations and Work records; one source conversation has two agents without cross-routing; inputs and publications deduplicate after reconnect; and a host change preserves agent identity and Work ownership. The Teams profile then proves live per-agent identity, threaded replies, Muxterm-visible chat history, and revocation. Other adapters use the same receipts and turn facts with their own authorization.

This direction follows Constellation's [Agent Instance](https://github.com/microsoft/amplifier-constellation/blob/main/contracts/agent-instance.md), [Conversation](https://github.com/microsoft/amplifier-constellation/blob/main/contracts/conversation.md), and [Connection](https://github.com/microsoft/amplifier-constellation/blob/main/contracts/connection.md) contracts. The Teams profile follows Microsoft's [Agentic User factory](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/agentic-identity/agent-factory/build-agent-factory) and [routing guidance](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/agentic-identity/agent-factory/route-messages).
