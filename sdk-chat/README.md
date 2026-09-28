# SDK chat sidecar

The muxterm binary embeds this sidecar, `package.json`, and the exact npm lockfile.
On first use it extracts them to a versioned cache and runs `npm ci --ignore-scripts`
there. Node.js and npm are required; dependency installation errors stop chat
creation with a clear error. Go starts the sidecar lazily and supervises it
through a versioned NDJSON Unix socket. It uses the existing Codex and Claude login state; no settings file is
written. The sidecar accepts `start`, `resume`, `send`, `interrupt`,
`capabilities`, and `close` operations. Unsupported service attribution and
busy Codex input return explicit errors.

The sidecar path defaults to the extracted copy embedded in the binary.
`MUXTERM_SDK_CHAT_SIDECAR` can point to an explicit copy.
Amplifier uses a separate Python sidecar on its own Unix socket. The binary embeds
its script and loop-live requirements file. Go starts it with the selected Amplifier
CLI interpreter; the script installs loop-live if missing, then resolves the
existing CLI settings for each project's provider and model. Missing dependencies
or a missing provider/model fail chat creation visibly. Go persists normalized
events and marks interrupted turns uncertain without replaying memory-only inputs.
`MUXTERM_SDK_CHAT_AMPLIFIER_SIDECAR` overrides the embedded script for development.
