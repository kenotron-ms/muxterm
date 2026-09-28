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
Amplifier runs in the supervised Python sidecar. At startup the sidecar installs
`amplifier-module-loop-live` into its selected Amplifier CLI interpreter on every boot
(see `internal/cos/sidecar/loop-live-requirements.txt`). An installation failure stops boot.
The sidecar resolves the existing Amplifier CLI settings and fails visibly if
no provider/model is configured. Live inputs are never replayed after a crash;
Go marks interrupted turns uncertain.
