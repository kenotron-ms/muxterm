# SDK chat sidecar

The muxterm binary embeds this sidecar, `package.json`, and the exact npm lockfile.
On first use it extracts them to a versioned cache and runs
`npm ci --omit=optional --ignore-scripts` there. Node.js and npm are required;
dependency installation errors stop chat
creation with a clear error. Go starts the sidecar lazily and supervises it
through a versioned NDJSON Unix socket. It uses the existing Codex and Claude login state; no settings file is
written. The sidecar accepts `start`, `resume`, `send`, `interrupt`,
`capabilities`, and `close` operations. Unsupported service attribution and
busy Codex input return explicit errors.

Codex uses the user's `codex` command through its app-server protocol. Muxterm
does not pin a Codex version or download a second CLI. The app-server's
`item/agentMessage/delta` notifications provide live text for the existing SSE
renderer. Native Codex thread IDs still resume chats. Older CLI versions without
the required app-server methods may need updating.

Claude uses the user's `claude` command through the Agent SDK's
`pathToClaudeCodeExecutable` option. The SDK is a small protocol client; its
optional platform packages, which contain another Claude executable, are not
installed. Set `MUXTERM_CODEX_COMMAND` or `MUXTERM_CLAUDE_COMMAND` to an absolute
path before starting muxterm if the corresponding command is outside `PATH`.

The sidecar path defaults to the extracted copy embedded in the binary.
`MUXTERM_SDK_CHAT_SIDECAR` can point to an explicit copy.

## Progress updates and reasoning

Muxterm records user-facing progress updates, tool activity, and answers. Codex
`agentMessage` items with phase `commentary` stream as `commentary.delta`, with
their item IDs and completion boundaries preserved. These updates describe what
the assistant is doing and appear in the work timeline.

Classify progress using protocol item types and phase fields. Do not extract or
classify it using regular expressions, headings, or paragraph positions in model
output. Pass commentary text through unchanged; use CSS for preview layout.

Codex reasoning summaries are disabled independently of reasoning effort. Reasoning
items, raw reasoning deltas, Claude thinking blocks, ACP thought chunks, and
Amplifier thinking blocks are excluded from Muxterm's event log and browser
stream. Native harness context remains under the harness's control.

Legacy `thinking.delta` events mixed reasoning and commentary without provenance.
History and reconnect streaming omit those events instead of guessing which
sentences were progress updates. Existing log files are not rewritten.

The native controls are documented in OpenAI's [App Server item and delta
protocol](https://developers.openai.com/codex/app-server#items) and
[`model_reasoning_summary` configuration](https://developers.openai.com/codex/config-reference).

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
Streaming text, tool activity, cancellation, image prompts, and
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
