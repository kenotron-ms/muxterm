# SDK chat sidecar

The muxterm binary embeds this sidecar, `package.json`, and the exact npm lockfile.
On first use it extracts them to a versioned cache and runs `npm ci --ignore-scripts`
there. Node.js and npm are required; dependency installation errors stop chat
creation with a clear error. Go starts the sidecar lazily and supervises it
through a versioned NDJSON Unix socket. It uses the existing Codex and Claude login state; no settings file is
written. The sidecar accepts `start`, `resume`, `send`, `interrupt`,
`capabilities`, and `close` operations. Unsupported service attribution and
busy Codex input return explicit errors.

Codex uses the CLI binary bundled by `@openai/codex-sdk` through its app-server
protocol. The SDK's `runStreamed()` wraps `codex exec --experimental-json`, which
emits complete assistant messages but no incremental text events. The
app-server's `item/agentMessage/delta` notifications provide live text for the
existing SSE renderer. Native Codex thread IDs still resume chats.

The sidecar path defaults to the extracted copy embedded in the binary.
`MUXTERM_SDK_CHAT_SIDECAR` can point to an explicit copy.

## ACP agents

Pi, OpenCode, and DeepSeek Harness run as local ACP agents through the official
`@agentclientprotocol/sdk` client. Install and configure each harness separately:

| Chat choice | Required command | ACP launch |
| --- | --- | --- |
| Pi | `pi` and `pi-acp` | `pi-acp` |
| OpenCode | `opencode` | `opencode acp` |
| DeepSeek Harness | `dsh` | `dsh --profile acp` |

Muxterm offers a choice when its command is on the server's `PATH`. The agent
uses its own provider credentials and model configuration; command presence does
not prove that a provider is ready. To use a binary outside `PATH`, set
`MUXTERM_ACP_PI_COMMAND`, `MUXTERM_ACP_OPENCODE_COMMAND`, or
`MUXTERM_ACP_DEEPSEEK_COMMAND` to its absolute executable path before starting
muxterm. For Pi, `pi` itself must also be on `PATH` because `pi-acp` launches it.

The client keeps one ACP process per chat and saves the native ACP session ID.
On reconnect it uses `session/resume` where advertised, then `session/load`.
Streaming text, thoughts, tool activity, cancellation, image prompts, and
advertised model and thinking controls flow into the existing chat UI. OpenCode
and DeepSeek Harness receive muxterm's local MCP server through ACP. The Pi ACP
adapter currently accepts MCP server definitions but does not connect them to
Pi, so muxterm does not advertise that integration for Pi.

ACP v1 has no general live input method for steering an active prompt. The
composer holds a draft while a turn runs; Stop sends `session/cancel`, and the
next prompt can be sent after the turn ends. ACP chats currently use muxterm's
existing `approval=never` policy: one-shot agent permission options may be
selected, while requests without one are cancelled. The generic ACP path does
not yet implement muxterm goals or voice-mode handoff.

Amplifier runs in the supervised Python sidecar. At startup the sidecar installs
`amplifier-module-loop-live` into its selected Amplifier CLI interpreter on every boot
(see `internal/amplifierchat/sidecar/loop-live-requirements.txt`). An installation failure stops boot.
The sidecar resolves the existing Amplifier CLI settings and fails visibly if
no provider/model is configured. Live inputs are never replayed after a crash;
Go marks interrupted turns uncertain.
