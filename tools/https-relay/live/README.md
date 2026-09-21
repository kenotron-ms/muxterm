# Recorded live verification rig

These scripts were verification fixtures, executed from `/home/ken/artifacts`
against the two task-owned containers `muxterm-sandbox-live-normal` and
`muxterm-sandbox-live-worker`, plus the actual FastAPI broker on host 8088.
They contained machine-specific paths and container IDs. They were not a
production provisioner. Private configs and tokens were excluded from this PR.

`live-mcp.py` used normal `muxterm mcp` inside the client container. The fault
and worker-order scripts adapted the existing relay rig and targeted the real
worker in its separate container. `restart-live-worker.py` acquired fresh
single-use enrollment; it verified the owned agent command line before stopping
it. `restart-live-broker.py` checked the owned broker cwd and uvicorn command
before restarting the PID recorded in its private manifest. Neither targeted
production muxterm. Auth and admission scripts exercised the real broker and
normal muxterm startup with the browser/sessiond runtime alive.

Execution order after the documented private setup: browser proof, fault
verification, worker-order verification, authorization/restart verification,
admission verification, then a fresh runtime and final browser proof. The
fault proxy was the existing `../broker-integration/fault-proxy.py`; it ran
inside the client container, between TLS and the loopback host-broker bridge.
Its control port was forwarded only to host loopback 33985.

The initial host adaptation used the prior rig's TLS localhost address, failed
with connection refused at its final authorization checks, and was corrected
to the actual TLS endpoint. Earlier delivery assertions were rerun in a fresh
workspace. Disabling DHCP removed the worker IPv4 address; an explicit static
address restored its HTTPS route before the final fresh verification. Neither
harness failure was counted as a passing run.
