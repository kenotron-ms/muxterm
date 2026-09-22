DID A HUMAN-VISIBLE SANDBOX WORKSPACE ACCEPT TYPED INPUT AND RETURN OUTPUT - NO.

This run stopped at the supplied broker endpoint: direct shell requests to
http://127.0.0.1:8088 returned connection refusal. The supplied PID had no process
row. No EPERM, socket restriction, or permission error occurred. No broker was
started, restarted, killed, or substituted. The instruction prohibited starting
a replacement or hunting for another broker.

Observed on this run:

```text
$ date -u '+%Y-%m-%dT%H:%M:%SZ'
2026-09-22T05:12:36Z
$ ps -p 1782462 -o pid=,args=
[no output]
$ curl --noproxy '*' --retry 2 --retry-connrefused --retry-delay 1 --connect-timeout 3 -sS http://127.0.0.1:8088/discover
curl: (7) Failed to connect to 127.0.0.1 port 8088 after 0 ms: Could not connect to server
curl: (7) Failed to connect to 127.0.0.1 port 8088 after 0 ms: Could not connect to server
curl: (7) Failed to connect to 127.0.0.1 port 8088 after 0 ms: Could not connect to server
```

The broker relay source already existed in the specified tree. No duplicate
implementation was added. Its factory already registered the relay:

```python
# /home/ken/workspace/sandboxes/broker/app.py
from broker.muxterm_relay import attach_relay
attach_relay(app)
return app
```

The supplied broker description was: a REAL running broker process with REAL
HTTP routes, and its LIFECYCLE BACKEND IS A STUB, specifically StubBackend.
That described the previously running service; this run did not find a running
service at its supplied endpoint. Source inspection confirmed the default backend:

```python
else:
    from broker.stub_backend import StubBackend
    backend = StubBackend(storage_root=data_dir / "sandboxes")
```

No Azure, ACA deployment, Entra authorization, private-disk import, or session
exec result was established by this run. The historical fault scripts were
verification fixtures; no fixture, mock, reference implementation, or simulation
was substituted for the unavailable broker.

The task's PR state and failure-record description were stale on September 22, 2026. GitHub returned:

```json
{"headRefName":"feat/https-sandbox-relay","state":"MERGED","url":"https://github.com/kenotron-ms/muxterm/pull/161"}
{"headRefName":"feat/local-muxterm-relay","state":"MERGED","url":"https://github.com/kenotron-ms/amplifier-sandboxes/pull/14"}
```

No merge or release was performed in this run. The existing sandbox-live-build.md
contained historical successful browser and fault records, including subsequent
broker restarts. Those records were not counted as fresh verification. The prior
sandbox-relay-integration.md was preserved at
/home/ken/artifacts/sandbox-relay-integration-prior-20260922.md.

Delivery status: (b) existing relay implementation inspected; (c) no new runtime
provisioned; (d) connection to 8088 failed; (e) no fresh browser typing proof or
screenshot captured; (f) no fresh delivery-fault verification executed. Input
idempotency, ordering, deduplication, and no replay after uncertain delivery were
not established in this run. No terminal output was fabricated or copied from
historical runs as fresh evidence.

Production muxterm, production configuration, existing containers, Amplifier
source, and Azure resources received no mutations from this run. No unit tests
were written or run. The only changes were this report and its documentation PR,
based on feat/https-sandbox-relay at f036274.

Documentation PR: https://github.com/kenotron-ms/muxterm/pull/164

Additional source evidence from this run: relay activation remained opt-in.
No live activation state was established because the endpoint refused connections.

```python
# broker/muxterm_relay.py: attach_relay
path = os.environ.get("SANDBOX_BROKER_LOCAL_RELAY_CONFIG")
if not path:
    return
```

The requested relay-enable-faults.py and relay-reset-fixture.py were read, not
executed. Both targeted an owned container fixture under /opt/relay/fixture;
the reset script terminated that fixture's processes, including its reference
broker. Running that reset supplied no proof about the unavailable 8088 service.
Source excerpt:

```python
assert pathlib.Path('/run/systemd/container').exists()
root=pathlib.Path('/opt/relay/fixture')
for name in ('serve','worker','broker','remote','local'):
```

No fresh terminal contents or screenshot existed for this attempt. Historical
screenshots were not reused. The concrete blocker was connection refusal at the
required broker URL, with no process at the supplied PID; it was not a permission
failure. The explicit prohibition on starting another broker remained in force.
