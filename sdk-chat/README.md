# SDK chat sidecar

The muxterm binary embeds this sidecar, `package.json`, and the exact npm lockfile.
On first use it extracts them to a versioned cache and runs
`npm ci --ignore-scripts` there. Node.js and npm are required;
dependency installation errors stop chat
creation with a clear error. Go starts the sidecar lazily and supervises it
through a versioned NDJSON Unix socket. It uses the existing Codex, Claude, and
GitHub Copilot login state; no credentials are written. The sidecar accepts `start`, `resume`, `send`, `interrupt`,
`capabilities`, and `close` operations. Unsupported service attribution and
busy Codex input return explicit errors.

Codex uses the user's installed `codex` command through its app-server
protocol. Set `MUXTERM_CODEX_COMMAND` to an absolute path before starting muxterm
if the command is outside `PATH`. One app-server serves all Codex chats; each native thread receives its
own working directory and MCP configuration. The app-server's
`item/agentMessage/delta` notifications provide live text for the existing SSE
renderer. Native Codex thread IDs still resume chats.

Claude uses the user's `claude` command through the Agent SDK's
`pathToClaudeCodeExecutable` option. The SDK is a small protocol client; its
optional platform packages are installed alongside the Copilot SDK runtime.
Set `MUXTERM_CLAUDE_COMMAND` to an absolute path before starting muxterm if the
Claude command is outside `PATH`. Claude uses a finite streaming-input query
per turn: steering remains available during the turn, then the SDK-owned child
exits and a later turn resumes the same native session ID.

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

## GitHub Copilot SDK

Copilot chats use `@github/copilot-sdk` and the user's Copilot login state.
Muxterm lists the SDK's models and reasoning choices, resumes native sessions,
streams answers and tool activity, and forwards immediate steering requests.
It registers muxterm MCP plus enabled GitHub, Microsoft personal, and remote
connectors. The muxterm MCP server receives a per-session origin token.
One SDK client owns the Copilot runtime; archiving a chat disconnects only its
native session. A failed runtime marks accepted work uncertain and requires an
explicit new input to recover it.

## Pi and DeepSeek native SDKs

Pi uses `@earendil-works/pi-coding-agent` in the sidecar. Its own session file
is stored under muxterm's data home and resumes by that path. Pi loads its
usual model credentials and project instructions. Muxterm registers its MCP
connectors through Pi's SDK extension loader with the chat's origin token, and
uses Pi's native streaming, tool events, model and thinking controls, steering,
and cancellation.

OpenCode 2 uses the documented `opencode acp` transport. Each chat owns an
ACP process because OpenCode shares MCP servers across sessions in one process's
directory. The process stops when the chat is archived; the saved session ID
resumes in a new process. ACP supplies model choices, streamed text, tool
activity, turn status, cancellation, and continuation.

OpenCode's first web search asks for a provider through an ACP form. Muxterm
offers **Use Exa**, **Disable web search**, and **Not now**. Choosing Exa sends
OpenCode's own provider-selection responses; OpenCode remembers the selection.
The form messages and schemas were verified with OpenCode 2.3.2; if OpenCode
changes them, the adapter cancels the unfamiliar form until it is updated.
Exa's [hosted MCP](https://exa.ai/mcp) works without an API key or separate
subscription and is free at [unspecified rate limits](https://exa.ai/blog/best-web-search-mcp-servers).
Search requires network access. A rate limit means retrying later; a provider
or network error is reported by OpenCode's tool. Muxterm does not switch to a
paid provider. An explicit `websearch.provider`, `websearch: false`, or
`websearch` permission rule in the user's OpenCode config remains effective.
See [OpenCode's web search guide](https://opencode.ai/docs/websearch/) for
provider settings and permissions.

DeepSeek uses `@deepseek-ai/dsh-sdk-client` and its same-version bundled `dsh`
runtime with the `sdk` profile. Each chat owns a runtime and a launch patch
that mounts muxterm's enabled MCP servers with its origin token. Its durable
session ID survives a muxterm restart. The SDK confirms prompt admission and
reports durable assistant and tool events. DeepSeek's SDK has no turn cancel
request, so Stop closes that chat's runtime; a later message resumes its
saved session in a new runtime. The runtime uses DeepSeek's configured provider
credentials. A missing key appears as a failed turn rather than an empty reply.
Steering uses the same runtime boundary, then continues the saved session with
the new instruction.

Both native SDK adapters include enabled GitHub, Microsoft personal, and remote
connectors through the same per-chat MCP capability as the other SDK chats.
Image uploads are passed as native image blocks when the attachment store has
identified a supported raster MIME type.

## Antigravity ACP agents

Google chats use the verified Antigravity `agy` ACP adapter. Existing
Antigravity SDK chats migrate to ACP when resumed; their recorded history is
preserved. Command presence does not prove that a provider is ready.

Settings → AI shows agent installation and management separately from the
new-chat default. Only available adapters verified for live steering, native
goals, and resumable native history are offered for new chats.

In **Settings → AI**, choose **Google sign-in** or **Detected API key**.
Google sign-in uses the Google account associated with a Google AI Pro or Ultra
subscription. Antigravity's ACP login flow owns the OAuth exchange; muxterm does
not store its OAuth token.
The API-key option appears when `GEMINI_API_KEY` is in the server environment or
`~/.amplifier/keys.env`. Muxterm passes the key to the Antigravity ACP process
and never returns it to the browser. An API key uses a separate billing path.
After choosing a method, check the connection before starting a chat.

The client keeps one ACP process per supported harness and saves each native
ACP session ID. Native session initialization is serialized on a shared
connection; established sessions can run concurrently.
On reconnect it uses `session/resume` where advertised, then `session/load`.
Streaming text, tool activity, cancellation, image prompts, and
advertised model and thinking controls flow into the existing chat UI. ACP chats
receive muxterm's local MCP server and enabled GitHub, Microsoft personal, and
remote connector servers. The remote server carries authorized Google tools.

ACP v1 has no general live input method for steering an active prompt. When an
agent advertises the ACP steering extension, muxterm sends an injected steer.
Otherwise, a steer cancels the current prompt and immediately sends the new
instruction in the same ACP session, keeping the partial answer visible. Image uploads use their
detected MIME type in ACP image blocks when the agent advertises image prompts;
the filename extension does not determine the type. ACP chats currently use muxterm's
existing `approval=never` policy: one-shot agent permission options may be
selected, while requests without one are cancelled. The generic ACP path does
not yet implement muxterm goals or voice-mode handoff.

Amplifier runs in the supervised Python sidecar. At startup the sidecar installs
`amplifier-module-loop-live` into its selected Amplifier CLI interpreter on every boot
(see `internal/amplifierchat/sidecar/loop-live-requirements.txt`). An installation failure stops boot.
The sidecar resolves the existing Amplifier CLI settings and fails visibly if
no provider/model is configured. Live inputs are never replayed after a crash;
Go marks interrupted turns uncertain.

## Amplifier Unified connected host

`amplifier-unified` is a separate chat choice from the CLI-backed `amplifier`
adapter. It connects to an already-running Unified host through its version-1
HTTP/SSE client contract. Unified owns execution and session history; closing a
Muxterm chat detaches its view without stopping Unified work. The adapter sends
text, streams assistant text, resumes its native session, and forwards Stop and
rename. Unified's native steering handles text sent during an active turn.

Open Settings → AI → Amplifier Unified and choose **This computer** to install
and connect the local Unified service. Muxterm discovers its owner-only token
automatically. Choose **Existing host** to enter its HTTPS origin and control
token; Muxterm stores the token in a private file and never returns it to the
browser. Plain HTTP is accepted only for loopback hosts. The chosen Muxterm
project path must also exist on a remote Unified host.

Muxterm maintains the embedded adapter against Unified's published client
contract. It rejects unsupported protocol versions explicitly.

The current adapter projects text and turn state. Unified approvals, tool and
worker progress, attachments, provider/model controls, and full historical
transcript paging are not yet mapped into Muxterm. Use Unified's own client for
those controls. Accepted sends use stable command IDs and are never replayed
automatically after an uncertain transport result.
