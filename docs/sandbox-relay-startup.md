# Owner-local sandbox relay

Open **Settings → Sandboxes → Sandbox relay** on a loopback muxterm instance.
Enter the HTTPS broker URL, sandbox ID, display name, and an Entra access token,
then select **Save and connect**. The broker must already have a running,
owner-enrolled worker for that sandbox. Save validates the broker before changing
the current connection, adds the host to the sidebar, and requires no server restart.

The token is write-only in the Settings API. Successful saves clear the password
field. Leaving it blank retains the existing token only for the same broker URL
and sandbox ID; changing either requires a new token. **Disconnect relay** removes
the saved connection and token without deleting the sandbox or its running shells.
Existing streams are closed on replacement/removal, including the Operator MCP
helper's streams. No terminal input is replayed onto a replacement connection.

Settings persist atomically in the private mode-0600 file
`$XDG_CONFIG_HOME/muxterm/relay.json` (default `~/.config/muxterm/relay.json`).
Normal `muxterm`, `muxterm serve`, and `muxterm mcp` load that file automatically.
`MUXTERM_RELAY_CONFIG=/absolute/private-client.json` remains an optional path
override; Settings reads and writes that selected file. Credentials never enter
`config.toml`, generic config reads, or config broadcasts.

SSH calls retained
the existing adapter; live SSH connections were not exercised. The configured sandbox appeared in the
sidebar at startup; its existing New workspace action created a remote workspace.
The live evidence is in [sandbox-live-build.md](sandbox-live-build.md).

Client configuration (mode 0600):

```json
{"url":"https://broker.example","host":"sandbox:my-sandbox","displayName":"My sandbox","token":"ENTRA_ACCESS_TOKEN"}
```

Use an Entra access token for the broker audience with the existing `Resolve.User`
role. The actual broker requires the same owner in its private binding and its
running sandbox registry entry. Do not send this client configuration to a sandbox.
The muxterm server rejects relay enablement on a non-loopback listener or with
`behind_reverse_proxy`: installation login alone does not authorize other people
to use the owner's broker identity. Shared-server principal delegation remains
unimplemented.

After the broker owner configured its binding, create the worker's bootstrap file:

```sh
python3 tools/https-relay/enroll-worker.py \
  --client-config /private/client.json --output /private/new-worker.json
```

Transfer only the worker file into the sandbox and start it within 120 seconds.
The owner controls that delivery; the worker never supplies its own sandbox ID
or owner assertion to the broker. Start a real sessiond under the same Unix user,
with a private runtime directory, and run:

```sh
muxterm-sandbox-agent --config /private/worker.json \
  --socket /private/runtime/muxterm/sessiond.sock
```

The agent opened outbound HTTPS requests and the private Unix socket; it opened
no network listener. One-use enrollment returned a worker capability kept only
in agent memory, limited to the binding's worker routes for one hour. A restart
required a new owner-issued enrollment. There was no automatic enrollment retry
or replay of input into a fresh Unix connection.

Build the standalone agent with `go build ./cmd/muxterm-sandbox-agent`. The
experimental reference-broker executable remained available for historical
verification but was absent from this live path.

Limits: one binding per muxterm process, manually delivered enrollment, one-hour
worker leases, and a client token renewed by pasting its replacement in Settings. The broker remained single-process with bounded
volatile queues; restart reset connections. No multi-replica durability, unattended
token renewal, Azure provisioning/attach integration, or production muxterm
installation was completed by this change. The existing Azure inventory panel
continued to describe the separate PR #150 controller, not relay connectivity.
