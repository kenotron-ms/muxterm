# Existing sandbox broker integration verification

These are **verification fixture** scripts; they ran real sessiond processes,
real shells, the PR's outbound worker and browser server, and the FastAPI broker
from amplifier-sandboxes. They did not launch the Go reference broker.
The shell/workspace were real; the lifecycle backend was StubBackend.

The original broker PID 1782462 on 8088 had no relay routes and no reload mode.
The source change was loaded in an authorized separate uvicorn process on 8089.
The exact 8088 attachment was not completed. No production muxterm config changed.

The owned Incus container was `muxterm-broker-relay-proof`. Its browser 8313
was forwarded to host 8314. Container loopback 18080 was an Incus proxy device
connected to host loopback 8089. `setup.sh` configured TLS nginx and a worker
network namespace with no TCP listeners, no default route, and only outbound
TCP443 to the nginx address. This was a network-isolation simulation inside a
verification container, not hostile-workload filesystem isolation: the client
and worker shared the container filesystem, except the worker's private /tmp.

Preparation sequence inside a fresh container, after installing nginx, Python3,
iproute2, iptables, ca-certificates and copying the built muxterm and relay to
`/opt/relay/bin/`:

1. Run `setup.sh` and `start.py --prepare`.
2. Copy the private generated `fixture/broker.json` to the host. Start the updated
   sandbox broker with `SANDBOX_BROKER_LOCAL_RELAY_CONFIG` pointing to it, on 8089,
   single uvicorn worker. Do not print or commit these credentials.
3. Run `start.py --launch`. Copy parent `mcp-smoke.py` to `/opt/relay/` and replace
   its binding with `sandbox:local-broker`.
4. Open host browser URL 8314, expand HTTPS sandbox, create a workspace and type
   through Playwright's keyboard into the terminal. Capture visible output.
5. Copy `fault-proxy.py` and `fault-verify.py` to `/opt/relay/`. The existing
   `/home/ken/artifacts/relay-enable-faults.py` starts the proxy and changes only
   DTU nginx. Run `fault-verify.py`. The host broker restart case is omitted.
6. `worker-order.py` injects seq+1 at the worker boundary and asserts the target
   shell file remains absent. It restarts only the exact owned worker.
7. `reset.py` was adapted from `/home/ken/artifacts/relay-reset-fixture.py`: no
   host broker PID is present, only owned container processes are reset. Preserve
   the private config files, recreate `fixture`, run `start.py --launch`, then
   create a fresh browser workspace for the final proof.

Browser input used `page.keyboard.type(..., {delay: 20})` and Enter; it was not
an HTTP terminal-input shortcut. The screenshots and full output are linked in
`docs/sandbox-relay-integration.md`.
