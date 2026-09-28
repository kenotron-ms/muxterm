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
Amplifier runs in the supervised Python sidecar. At startup the sidecar installs
`amplifier-module-loop-live` into its selected Amplifier CLI interpreter on every boot
(see `internal/cos/sidecar/loop-live-requirements.txt`). An installation failure stops boot.
The sidecar resolves the existing Amplifier CLI settings and fails visibly if
no provider/model is configured. Live inputs are never replayed after a crash;
Go marks interrupted turns uncertain.
