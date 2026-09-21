DID A HUMAN-VISIBLE AZURE SANDBOX WORKSPACE ACCEPT TYPED INPUT AND RETURN OUTPUT - YES.

Verified 2026-09-21 at 04:53 UTC. The browser opened normal muxterm at
http://127.0.0.1:33984, selected the remote Azure sandbox, created Azure
playground, and typed a command through the terminal keyboard interface.

```text
# printf 'REAL_AZURE_SANDBOX_OK\n'; hostname; uname -a; pwd
REAL_AZURE_SANDBOX_OK
adc-sandbox
Linux adc-sandbox 6.12.8+ #1 SMP Thu Jul 30 23:01:31 UTC 2026 x86_64 GNU/Linux
/root
```

Azure CLI created and inspected the actual sandbox in subscription
8a673afb-d858-4a97-a490-2625396d1484, resource group rg-amplifier-sandboxes,
sandbox group sg-amplifier-sandboxes:

```json
{"id":"b23b0c3d-7b20-4c1a-8cb8-c551ab3d59aa","state":"Running","ports":[],"region":"westus2"}
```

The worker ran the existing muxterm binary and outbound agent uploaded through
Azure's authenticated file API. Real sessiond used a private Unix socket:

```text
Real Azure sessiond PID 28 socket mode 0o600
agent_pid=41
Netid State Recv-Q Send-Q Local Address:Port Peer Address:PortProcess
```

A temporary ACA broker served the actual broker PR16 relay/auth/registry modules.
It exposed only relay routes and a health check; no StubBackend lifecycle routes
were included. The JSONL registry remained the explicitly documented placeholder
registry. Enrollment was operator-driven and bound to the actual Azure sandbox ID;
the registry did not poll Azure lifecycle state. PR150's controller/Attach path was
not used or completed. Provisioning and file upload used the actual ACA CLI.

```text
ACA broker HTTPS health: {"status":"ok","sandboxId":"b23b0c3d-7b20-4c1a-8cb8-c551ab3d59aa"}
Real Entra owner enrollment accepted; worker-only bootstrap saved mode 0600.
```

Broker resource: ca-muxterm-relay-0921, existing cae-amplifier-sandboxes environment.
HTTPS host: ca-muxterm-relay-0921.wittypebble-4ae3f750.westus2.azurecontainerapps.io.
Only this host was allowed in the sandbox's deny-by-default egress policy.
The broker image build returned:

```text
runId: cc1b
status: Succeeded
image: acramplifiersandboxes.azurecr.io/muxterm-live-relay@sha256:0b907c2bc6a2b4725d225440632f349912a01cdbe613ceebbc3935019e1846ea
minReplicas: 1
maxReplicas: 1
```

The browser demo reused only the isolated Incus client. Its serve process was
restarted with the Azure relay configuration; its sessiond was retained. Production
muxterm was not restarted. The local Incus worker was not the worker in this proof.
No fixture, mock, or reference broker participated in this Azure terminal path.
The existing local fault-injection proof remained applicable code evidence; those
fault scenarios were not rerun against Azure.

Access: http://127.0.0.1:33984, Azure sandbox → Azure playground. The browser
loopback bypass required no password. Remote access used SSH forwarding to vela0.
Entra client credential expiry: 05:32 UTC. Worker lease: approximately 05:52 UTC.
Automatic renewal was not implemented. Outbound network access was limited to the
broker, so arbitrary package downloads were not available.

Azure resources created and subsequently deleted at the user’s request: one
sandbox, one temporary broker Container App, and one ACR image repository/tag.
Existing group, environment, identity and registry were reused and retained.
Post-deletion listing returned:

```text
Azure sandbox remaining: []
Temporary broker remaining: []
ACR repository remaining: []
```

The Azure demo was no longer available after cleanup. The exact cleanup script was
/home/ken/artifacts/azure-muxterm-live/cleanup.sh. No existing sandbox was modified.

Screenshot: [Azure workspace](evidence/sandbox-live/azure-browser.png).
Raw evidence: [browser output](evidence/sandbox-live/azure-browser.txt) and
[runtime output](evidence/sandbox-live/azure-runtime.txt).
