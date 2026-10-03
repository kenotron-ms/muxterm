# muxterm architecture

This is the current system overview. For exact message fields and behavior, read the linked protocol and source files. Dated plans under `docs/plans/` and `docs/designs/` record how features were developed; they are not a second current specification.

## Process and data flow

```text
Browser (Lit, dockview, xterm.js)
    │ HTTP, WebSocket, WebRTC voice
    ▼
Go HTTP server (auth, APIs, browser relay, Mission Control)
    │ local Unix socket or remote sessiond transport
    ▼
sessiond (workspaces, PTYs, VT state, agent sessions)
    │ PTYs and shell processes
    ▼
Shells and terminal programs
```

The browser is a view and input client. The HTTP server authenticates clients, serves the app, relays terminal traffic, and owns server-side conversation services. Sessiond owns terminal and workspace state independently of browser tabs and HTTP server restarts. A pane is a real PTY; sessiond keeps a VT buffer for reconnect replay and sidebar previews. See [`internal/sessiond/`](internal/sessiond/) and [`web/src/lib/terminal-registry.ts`](web/src/lib/terminal-registry.ts).

## State ownership

| State or decision | Owner | Browser role |
| --- | --- | --- |
| Workspace and pane registry, PTYs, terminal screen | sessiond | Render broadcasts and snapshots; send intents and input |
| Pane activity and permission to close a pane or workspace | sessiond | Show risk and confirmation UI; wait for authoritative outcome |
| Agent session lifecycle and fleet records | sessiond, from native harness hooks | Subscribe and present records; attach a terminal when available |
| Mission Control conversation, FIFO, approvals, persisted history | Go COS relay/supervisor and native Amplifier SessionStore | Compose turns, display events, retain drafts |
| Browser layout and focus presentation | Browser, within daemon ownership rules | Render panes and report focus/size when appropriate |

Sessiond assesses pane activity from the current root-process generation, authenticated shell lifecycle, and foreground PTY process group. Browser text, titles, and input timing are not activity authority. Close controls send intents; the daemon decides whether closure proceeds or needs confirmation. See [`internal/sessiond/close.go`](internal/sessiond/close.go) and [`web/src/types.ts`](web/src/types.ts).

## Terminal protocol

The browser uses one WebSocket per tab to the Go server. The server relays the sessiond protocol over a daemon connection. Sessiond frames have a four-byte big-endian length, a one-byte kind, and a payload. Control payloads are JSON; pane data carries a four-byte little-endian pane ID followed by terminal bytes. The exact vocabulary and field shapes live in [`internal/sessiond/protocol.go`](internal/sessiond/protocol.go) and [`web/src/types.ts`](web/src/types.ts). The [client protocol](docs/muxterm-client-protocol.md) describes additional client behavior.

On attach, the daemon sends a composition and screen replay before live pane output. The browser's terminal registry settles replay into xterm.js before treating a pane as ready. Sessiond answers terminal cursor-position (`CSI 6n`) and background-color (`OSC 11;?`) queries from its VT buffer; browser parser hooks consume those exact queries to avoid duplicate replies. See [`web/src/lib/terminal-registry.ts`](web/src/lib/terminal-registry.ts).

## Agent sessions and conversations

`muxterm claude`, `muxterm codex`, and `muxterm amplifier` install invocation-scoped native hooks. Those reports enter sessiond's durable fleet. A valid agent session can exist without a workspace or pane; a terminal is an optional attachment. Raw vendor launches are outside guaranteed fleet reporting. The [session-state protocol](docs/session-state-protocol.md) defines the reporting contract.

Mission Control is one persistent server-owned COS conversation. The Go relay admits text turns into a FIFO; a supervisor and Python sidecar run the Amplifier session and use its native SessionStore. Existing catalog metadata is read-only history-compatibility input. A missing or ambiguous established session is an error, not a reason to create a replacement history. See [`internal/server/cos.go`](internal/server/cos.go), [`internal/cos/`](internal/cos/), and [`internal/missioncontrol/`](internal/missioncontrol/).

Separate Codex and Claude chats have their own SDK chat path. They do not partition Mission Control history by workspace. See [`sdk-chat/`](sdk-chat/) and [`internal/server/sdk_chat.go`](internal/server/sdk_chat.go).

Voice Mode uses the protected `/api/cos/voice/{token,sdp,end}` browser WebRTC path and a server-owned provider sideband. Provider turn detection owns ordinary speech turns. One-shot dictation only fills a draft and never sends it. See [`internal/voice/`](internal/voice/) and the [voice decision](docs/decisions/2026-09-15-operator-composer-and-voice-contract.md).

## Development and verification

`make dev-local` runs an isolated development stack on `127.0.0.1:8313`, with its own binary, runtime, data, and COS session. Production ports `8311` and `9090` are off limits for state-changing verification. Deployment, service installation, reverse-proxy, and upgrade paths require a Digital Twin Universe. Follow [AGENTS.md](AGENTS.md) before running the app or any tests.

Static checks are `go build ./...` and `cd web && npm run check:fast`. Browser behavior requires a real browser and real dev-local sessiond; static checks alone do not prove it.
