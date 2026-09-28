# SDK chat sidecar

`sidecar.mjs` hosts Codex and Claude in one Node process. Go starts it lazily and
connects over a private Unix socket. Each line is JSON with `version: 1`.
Requests carry `id`, `op` and a Go session ID. Replies echo `id`; unsolicited
frames carry a normalized `event`. Go persists an event before waking browser
subscribers. A disconnected sidecar marks active work `uncertain`; no accepted
input is replayed. A person can explicitly resume a saved harness session ID.

The public contract is `Start(config)`, `Send({kind, source, id, content})`,
`Events()`, `Interrupt(turn_id)`, `Resume(session_id)`, `Capabilities()` and
`Close()`. Events include `session.started`, `assistant.delta`, `tool.started`,
`tool.completed`, `turn.completed` and `error`. The Go API maps these operations
to `/api/sdk-chats`. Codex's TypeScript SDK has no live input or attributed
service input in version 0.158.0; requests for either return `unsupported`.
Claude accepts attributed service input through `origin: task-notification`.
Its SDK uses a user transport envelope for that origin; Go retains `kind=service`
and the source, and Codex rejects the request rather than relabeling it human.

`make sdk-chat-deps` installs the locked Node packages for source-tree builds.
An installed binary needs the sidecar directory and its Node packages alongside
it as `sdkchat/`, or `MUXTERM_SDK_SIDECAR_DIR` pointing to that directory.
The sidecar does not read or write muxterm's production configuration files.
Amplifier is unavailable in this build.
