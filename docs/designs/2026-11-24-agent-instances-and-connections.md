# Agent instances and connections

**Status:** Muxterm product contract. Teams is the first intended connection.

## Core ownership

`muxterm serve` hosts independently addressable, durable **agent instances**. Each agent has a stable `agentId`, configuration, accepted Work, and one continuation owner for each Work item. An agent may participate in several conversations, run several chats, and change harnesses or machines without changing identity. A harness session is an execution choice, not an agent.

Muxterm owns agent identity, the Work ledger, source conversation links, execution routing, and the UI for inspecting them. Slack, Discord, Telegram, Mattermost, and Teams each remain authoritative for their own conversation IDs, history, audience, permissions, and publication receipts.

A **connection** translates between one source and a Muxterm agent. It owns platform credentials, installation state, routing, delivery bookkeeping, and platform tools. Its transport may be a hosted relay, local adapter, or another arrangement. The common contract must not require a sidecar or public port on every Muxterm installation. An outbound connector in the Go service starts and stops with that service when configured.

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

The intended Teams shape is an **Agentic User factory**: one shared blueprint and relay, with a separate named Teams Agentic User per Muxterm agent. The relay resolves activities by tenant ID and addressed Agentic User ID, not by Teams conversation ID alone. It stores the per-agent identity client ID and Agentic User object ID, plus Teams conversation, thread, activity, and service URL references. It sends as the addressed Agentic User. Teams owns thread history and membership.

The relay runs on the dedicated `teamsbot-relay` Incus instance. Each Muxterm Go service opens an authenticated outbound connection. The relay runs no model; the old standalone OpenAI runner must stop before the same events are forwarded to Muxterm. The current custom-upload bot stays online until the Agentic User path is verified. Its app registration cannot be silently reinterpreted as a factory blueprint.

This Teams profile requires a development tenant able to register an agent identity blueprint, admin activation and consent, and preview Agentic User support. Provisioning uses Microsoft Graph beta. These are external prerequisites, not part of Muxterm's generic agent contract.

## Implementation checkpoint

The first Go slice persists agent records, optional defaults, chat associations, and source conversation links. Its in-process connection admission method accepts a person-authored message for an existing link, saves a receipt before harness dispatch, and reconciles a lost acknowledgment from the chat's durable `input.accepted` event. It carries source and audience facts as structured receipt data and into the harness input. A connector can read a completed turn from the linked chat's durable event history. It does not yet create a chat for an unseen source conversation, publish replies, supervise agent-owned Work, or run a platform connector. Those behaviors remain required before any live integration cutover.

## Qualification

Prove that one agent has two separate source conversations and Work records; one source conversation has two agents without cross-routing; inputs and publications deduplicate after reconnect; and a host change preserves agent identity and Work ownership. The Teams profile then proves live per-agent identity, threaded replies, Muxterm-visible chat history, and revocation. Other adapters use the same receipts and turn facts with their own authorization.

This direction follows Constellation's [Agent Instance](https://github.com/microsoft/amplifier-constellation/blob/main/contracts/agent-instance.md), [Conversation](https://github.com/microsoft/amplifier-constellation/blob/main/contracts/conversation.md), and [Connection](https://github.com/microsoft/amplifier-constellation/blob/main/contracts/connection.md) contracts. The Teams profile follows Microsoft's [Agentic User factory](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/agentic-identity/agent-factory/build-agent-factory) and [routing guidance](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/agentic-identity/agent-factory/route-messages).
