# Documentation map

Start with the current guides:

| Document | Purpose |
| --- | --- |
| [README](../README.md) | Install, quick start, and user-facing features |
| [Vision](../VISION.md) | Product direction and promises |
| [Architecture](../ARCHITECTURE.md) | Current components and authority boundaries |
| [Interface design](../DESIGN.md) | Current surfaces, theme, and interaction rules |
| [AGENTS.md](../AGENTS.md) | Repository safety and verification rules |

## Contracts and decisions

- [Sessiond wire protocol](../internal/sessiond/protocol.go) and [browser types](../web/src/types.ts) are the current message vocabulary. [Client protocol](muxterm-client-protocol.md) documents client-specific behavior.
- [Session-state protocol](session-state-protocol.md) describes agent hook reporting.
- [Decisions](decisions/) record durable choices, including Operator and voice ownership.
- [Designs](designs/) are dated feature designs. Check their status and current code before following an implementation proposal.

## History and research

[`plans/`](plans/) contains implementation plans and earlier architecture proposals. These are historical records and may contain commands or assumptions that are unsafe on a machine with a live muxterm. [`research/`](research/) contains investigations. [`verification/`](verification/) preserves existing release and feature evidence. Do not treat these directories as current setup instructions.

The active [browser verification skill](../.amplifier/skills/muxterm-verify/SKILL.md) uses `make dev-local` on port `8313`, following [AGENTS.md](../AGENTS.md). Production ports `8311` and `9090` are not test targets.
