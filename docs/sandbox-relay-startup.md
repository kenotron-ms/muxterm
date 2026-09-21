# Owner-local sandbox relay

Normal `muxterm`, `muxterm serve`, and `muxterm mcp` accepted an owner-enrolled
relay through `MUXTERM_RELAY_CONFIG=/absolute/private-client.json`. SSH calls retained
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
worker leases, and a client token renewed by updating its private config and
restarting this isolated client. The broker remained single-process with bounded
volatile queues; restart reset connections. No multi-replica durability, unattended
token renewal, Azure provisioning/attach integration, or production muxterm
installation was completed by this change. The existing Azure inventory panel
continued to describe the separate PR #150 controller, not relay connectivity.
