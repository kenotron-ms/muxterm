DID A HUMAN-VISIBLE SANDBOX WORKSPACE ACCEPT TYPED INPUT AND RETURN OUTPUT - YES.

Settings → Sandboxes → Sandbox relay configured the actual broker connection
without MUXTERM_RELAY_CONFIG or a server restart. The browser filled the broker
URL, sandbox ID, display name and owner token, saved, created a new remote
workspace and typed a shell command. The returned terminal contents were:

```text
# printf 'SETTINGS_RELAY_INPUT_OK\n'; hostname
SETTINGS_RELAY_INPUT_OK
muxterm-sandbox-live-worker
#
```

The verification used the existing actual FastAPI broker on port 8088, its
Entra owner authorization and the separate Incus sandbox worker with real sessiond.
The broker's unrelated lifecycle backend remained StubBackend (stub); its JSONL
registry remained a placeholder. Neither the reference broker nor a synthetic
workspace served this Settings verification. Browser scripts were verification
rigs, not production components. No Azure resources were created for this change.

The final browser and persistent MCP runs returned:

```text
PASS Settings saved and connected without environment configuration; GET and form omitted token
PASS invalid token rejected; prior connection retained
PASS blank token retained for unchanged broker and sandbox; live rename applied
PASS browser-created remote workspace returned SETTINGS_RELAY_INPUT_OK and muxterm-sandbox-live-worker
PASS persistent MCP read remote workspaces before disconnect
PASS browser Disconnect removed sidebar host and private configuration
PASS persistent MCP rejected removed relay (attempt 1)
PASS persistent MCP rejected removed relay (attempt 2)
```

Additional real HTTP/filesystem/startup checks returned:

```text
relay file permissions: 600
PASS foreign origin rejected: HTTP 403
PASS foreign Host rejected: HTTP 403
PASS cross-site fetch rejected: HTTP 403
PASS default private configuration restored after isolated serve restart; no environment override
```

GET /api/relay returned public metadata and no token:

```json
{"url":"https://127.0.0.1","host":"sandbox:live-local","displayName":"Settings sandbox renamed","configured":true,"available":true}
```

Implementation: default private relay.json beside config.toml, optional existing
MUXTERM_RELAY_CONFIG path override, atomic mode-0600 replacement, broker validation
before persistence, write-only token, retained credentials only for an unchanged
broker and sandbox, live transport replacement, explicit host-removal notification
for all browser tabs, and a private-file watcher in the separate MCP helper that
closed obsolete relay streams. Disconnect removed the local file and connection;
it did not delete the sandbox or terminate remote shells. No input replay was added.

Build verification passed: go build ./..., go vet ./..., npm run check:fast and
npm run build. Existing frontend warnings remained. No unit tests were run or
written. The isolated serve process was restarted for code loading and persistence
verification. Production muxterm/sessiond and production configuration were not
modified. Existing user-owned local verification containers were retained.

Limits remained: one relay binding per process; loopback server and local access
only, no reverse proxy; already-provisioned sandbox and enrolled worker; manual
owner-token acquisition/renewal; separate one-hour worker enrollment renewal.
This change did not add provisioning, automatic OAuth login, or worker enrollment
to Settings. Saving verified broker authorization and worker discovery; daemon
connectivity appeared in the existing sidebar connection status.

[Settings screenshot](evidence/sandbox-live/relay-settings.png) ·
[Terminal screenshot](evidence/sandbox-live/relay-settings-terminal.png).
