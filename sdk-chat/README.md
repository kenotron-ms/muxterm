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

Codex uses the packaged native `@openai/codex` binary through its app-server
protocol. One app-server serves all Codex chats; each native thread receives its
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

## Pi, OpenCode, and DeepSeek native SDKs

Pi uses `@earendil-works/pi-coding-agent` in the sidecar. Its own session file
is stored under muxterm's data home and resumes by that path. Pi loads its
usual model credentials and project instructions. Muxterm registers its MCP
connectors through Pi's SDK extension loader with the chat's origin token, and
uses Pi's native streaming, tool events, model and thinking controls, steering,
and cancellation.

OpenCode uses `@opencode-ai/sdk` with the installed `opencode` command. Each
chat owns an SDK-started OpenCode server on an ephemeral loopback port. Its
server receives only that chat's MCP configuration; the server is closed when
the chat is archived. OpenCode's session ID survives a muxterm restart and its
SDK event stream supplies text, tool activity, and turn status.
Steering stops the active generation and continues in the same OpenCode
session, retaining the partial answer.

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

All three adapters include enabled GitHub, Microsoft personal, and remote
connectors through the same per-chat MCP capability as the other SDK chats.
Image uploads are passed as native image blocks when the attachment store has
identified a supported raster MIME type.

## ACP agents

Antigravity SDK is an additional API-key chat choice. It runs the pinned
`google-antigravity` Python SDK in a chat-owned process through `uv`, using a
configured `GEMINI_API_KEY`. It mounts the same per-chat muxterm, GitHub,
Microsoft personal, and remote MCP connectors. The SDK saves its conversation
in muxterm's data home. It has no live steer method: sending during a turn uses
the SDK's `ChatResponse.cancel()` and then continues the same conversation.
The composer labels this behavior explicitly and keeps the partial answer.
The existing Antigravity choice continues to use ACP for Google account sign-in.

Antigravity remains the Google-sign-in ACP agent through `@agentclientprotocol/sdk`
and muxterm's managed `agy_acp_server.par`. Existing Gemini CLI ACP chats can
still resume, but new chats use Antigravity. The agent uses its own provider
credentials and model configuration; command presence does not prove that a
provider is ready.

In **Settings → AI**, choose **Google sign-in** or **Detected API key**.
Google sign-in uses the Google account associated with a Google AI Pro or Ultra
subscription. Muxterm
starts Gemini CLI's interactive login in a managed PTY, shows the Google link,
and sends the one-time authorization code back to Gemini CLI. Gemini CLI stores
its own credentials for later ACP chats; muxterm does not exchange or store its
OAuth token. `NO_BROWSER=true gemini` in a muxterm terminal remains a fallback.
The API-key option appears when `GEMINI_API_KEY` is in the server environment or
`~/.amplifier/keys.env`. Muxterm gives Gemini CLI a separate configuration home
for API-key chats, so choosing it leaves Google sign-in credentials untouched.
Muxterm only passes the key to the Gemini child process and never returns it to
the browser. An API key uses a separate billing path. After choosing a method,
check the connection before resuming an existing Gemini CLI chat. A running
Gemini process keeps the auth choice with which it started.

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
instruction in the same ACP session, keeping the partial answer visible. Gemini
CLI currently uses this cancel-and-continue behavior. Image uploads use their
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
