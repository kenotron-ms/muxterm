DID A HUMAN-VISIBLE SANDBOX WORKSPACE ACCEPT TYPED INPUT AND RETURN OUTPUT - NO.

Fresh verification on 2026-09-22 at 06:02:09 UTC failed at the supplied broker endpoint. No browser typing, screenshot, or delivery-fault success was recorded in this run. Earlier successful artifacts are historical evidence, not evidence for this run.

The direct HTTP probe failed before any relay connection:

```text
$ curl --noproxy '*' -sS --connect-timeout 3 http://127.0.0.1:8088/openapi.json
curl: (7) Failed to connect to 127.0.0.1 port 8088 after 0 ms: Could not connect to server
$ ps -p 1782462 -o pid=,args=
[no output; exit status 1]
```

An earlier probe in this same run returned the same connection refusal. This was not EPERM or a socket permission failure. The instruction prohibited searching for another broker, starting a second broker, and killing PID 1782462. No replacement broker was started. No production muxterm process or configuration was changed.

The named broker source already contained the relay implementation, so no duplicate implementation was added. Source inspection returned:

```text
$ git -C /home/ken/workspace/sandboxes log -1 --oneline
33487e0 Add opt-in local muxterm relay routes to FastAPI broker
broker/app.py:814: from broker.muxterm_relay import attach_relay
broker/app.py:816: attach_relay(app)
broker/muxterm_relay.py:337: router.add_api_route(path, relay.handle, methods=["GET", "POST"])
```

The existing route list contained `/discover`, `/open`, `/worker/register`, `/worker/poll`, `/worker/reply`, `/worker/output/{id}`, and `/channels/{id}/{operation}`. Relay registration required a private configuration file:

```python
path = os.environ.get("SANDBOX_BROKER_LOCAL_RELAY_CONFIG")
if not path:
    return
```

The user's supplied process description identified a REAL running broker process with REAL HTTP routes, and its LIFECYCLE BACKEND IS A STUB: **StubBackend**. That description was not confirmed as live during this run. The source retained the default local stub selection; no Azure behavior, Entra authorization, private-disk import, or session exec was verified:

```text
broker/app.py:839: if os.environ.get("SANDBOX_BROKER_BACKEND") == "aca":
broker/app.py:851:     from broker.stub_backend import StubBackend
broker/app.py:853:     backend = StubBackend(storage_root=data_dir / "sandboxes")
```

GitHub contradicted the supplied OPEN status for PR #161:

```json
{"headRefName":"feat/https-sandbox-relay","mergeCommit":{"oid":"f036274e0944d7a479e53971ba2763e46eb2f664"},"state":"MERGED","url":"https://github.com/kenotron-ms/muxterm/pull/161"}
{"headRefName":"feat/relay-owner-enrollment","state":"MERGED","url":"https://github.com/kenotron-ms/amplifier-sandboxes/pull/16"}
```

The reporting branch began at `origin/feat/https-sandbox-relay` (`f036274`). The existing main checkout had unrelated uncommitted changes; a separate worktree held this documentation update.

Delivery status: (b) implementation already present in the named broker source; live route registration unverified. (c) no new worker provisioned. (d) connection to the mandatory endpoint failed. (e) no fresh browser proof or screenshot. (f) no fresh fault proof. The reviewed `relay-enable-faults.py` and `relay-reset-fixture.py` were **fixture** management scripts for `/opt/relay/fixture` inside a container. They were not executed against an unavailable broker, and their reference implementation was not substituted for it.

Specific blocker: no reachable broker at the mandatory URL and no process at the supplied PID, alongside the explicit prohibition on starting a replacement. No unit tests were run; this change contained only the failure evidence report. No merge or release was performed.
