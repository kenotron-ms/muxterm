# SDK chat sidecar

`make dev-local` and `make build` install the pinned Node dependencies when absent.
Go starts this sidecar lazily and supervises it through a versioned NDJSON Unix
socket. It uses the existing Codex and Claude login state; no settings file is
written. The sidecar accepts `start`, `resume`, `send`, `interrupt`,
`capabilities`, and `close` operations. Unsupported service attribution and
busy Codex input return explicit errors.

The sidecar path defaults to `sdk-chat/sidecar.mjs` beside the source tree used
to build muxterm. `MUXTERM_SDK_CHAT_SIDECAR` can point to a packaged copy.
A release package must include this directory and its installed dependencies.
Amplifier requires a separate Python sidecar and is unavailable in this build.
