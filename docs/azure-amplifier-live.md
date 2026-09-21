DID A HUMAN-VISIBLE AZURE AMPLIFIER SESSION ACCEPT TYPED INPUT AND RETURN A MODEL RESPONSE - YES.

Verified 2026-09-21 05:17–05:18 UTC. The hosted amplifier-sandboxes broker
created real Azure sandbox f7ba7b0b-84ac-4ec4-a33b-ce14fda3fb09. Its CLI
submit output was:

```text
sandbox_id=f7ba7b0b-84ac-4ec4-a33b-ce14fda3fb09 state=Creating
```

The native Amplifier runtime reported:

```text
amplifier, version 2026.09.20-b507233 (core 1.6.1)
SANDBOX_PROVIDER_FILE_PRESENT
SANDBOX_SETTINGS_PRESENT
```

Operator's existing MCP `spawn_lane` tool was invoked directly with the
sandbox machine ID, workspace `Amplifier Azure proof`, harness `amplifier`,
and an opening prompt requesting a marker. The tool returned workspace w3,
pane 1 and the correct sandbox machine. No model-led Operator chat dispatch
was exercised: the verification called the same registered tool directly.

The normal muxterm browser displayed the resulting native CLI session:

```text
Amplifier Interactive Session
Session ID: a09ecd5d-c019-4ffe-8025-df853c94335e
amplifier 2026.09.20-b507233 | core 1.6.1
Bundle: anchors | Provider: Anthropic | claude-haiku-4-5-20251001
Amplifier:
AMPLIFIER_AZURE_LANE_OK
```

Playwright then clicked the terminal and typed a second prompt with real keyboard
input. The same interactive session returned:

```text
Amplifier:
AMPLIFIER_BROWSER_SECOND_TURN_OK
```

Runtime inspection found the actual CLI process and native session-store record:

```text
process 39 /opt/muxterm/bin/muxterm sessiond
process 57 /opt/muxterm/bin/agent --config /opt/muxterm/worker.json --socket /opt/muxterm/runtime/muxterm/sessiond.sock
process 125 /root/.local/share/uv/tools/amplifier/bin/python /root/.local/bin/amplifier run Reply with exactly AMPLIFIER_AZURE_LANE_OK. Do not use tools or change files. --mode chat
native session a09ecd5d-c019-4ffe-8025-df853c94335e
 tcp listeners []
 udp listeners []
 socket mode 0o600
```

The first launch exposed a real image defect and exited before creating a session:

```text
Refusing to run: this Python environment belongs to a different AMPLIFIER_HOME.
claimed by: /tmp/provider-install-home/.amplifier
```

The image had installed the Anthropic provider as an editable package under a
temporary build-time home, then deleted that directory. Broker PR16 fixed
`image/Dockerfile` to install into the runtime home. The disposable sandbox was
repaired by uninstalling that foreign editable provider and running the existing
CLI `amplifier provider install anthropic`. The successful session used this
repaired runtime; the newly built image was not registered as a new Azure disk.
No Amplifier source or local model credentials were modified or copied.

The corrected image build returned:

```text
runId: cc1e
status: Succeeded
image: muxterm-amplifier-runtime:provider-home-0921
sha256:baa39e9158e4f1a0d39acba5ad19a29ed15c7431328382e1b313a69129fd57b6
```

The temporary cloud relay used the actual broker PR16 relay/auth/registry modules.
It included no StubBackend lifecycle routes. Its manually enrolled JSONL registry
remained a placeholder. Provisioning used the hosted broker through
amplifier-app-remote; muxterm binary upload and runtime setup used Azure's API.
PR150 Attach and automatic agent bootstrap were not completed by this verification.
The real shell, real model provider, and real CLI were not fixtures or mocks.

Remaining observed limitations: the CLI emitted a session-naming hook
ModuleNotFoundError after the first response. The second response succeeded.
`fleet_status` returned an empty sessions list despite the live native session;
structured fleet observation still required integration. Neither was represented
as a passing result. The isolated client had no running Operator model sidecar,
so this proof covered Operator's tool execution, not natural-language dispatch.

[Browser screenshot](evidence/sandbox-live/azure-amplifier.png),
[browser output](evidence/sandbox-live/azure-amplifier-browser.txt),
[runtime output](evidence/sandbox-live/azure-amplifier-runtime.txt), and
[spawn result](evidence/sandbox-live/azure-amplifier-spawn.txt).

All verification resources were deleted at the user's request. Fresh lists confirmed:

```text
Azure sandbox remaining: []
Temporary broker remaining: []
Verification image repositories remaining: []
```

The sandbox, temporary relay Container App ca-muxterm-amp-0921, relay image and
corrected runtime verification image were gone. Existing infrastructure and
other sandboxes were retained. No merge or release occurred.
