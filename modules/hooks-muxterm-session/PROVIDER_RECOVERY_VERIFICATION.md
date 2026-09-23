DOES MUXTERM CLASSIFY NOW SUCCEED AGAINST claude-haiku-4-5 — YES.

On 2026-09-22 the real configured `provider-openai` completed classify and label with the requested model `claude-haiku-4-5`. The installed provider and existing credentials/settings supplied the network calls. A small coordinator adapter returned that provider; this was not a live Amplifier coordinator. No provider mock or stub supplied these responses. This verification established success for that requested model ID through the configured endpoint, not the identity of its underlying backend.

The original v0.38.0 helper caught every provider exception, retried the same kwargs without the model override, then swallowed the final failure at DEBUG. With no model override, it swallowed the first failure at DEBUG. The unsupported temperature therefore survived the retry.

PR #167 was already merged into main before this work began. It removed temperature from BOTH classify.py and label.py and added one retry that removes an explicitly rejected parameter. This follow-up retained those changes and tightened an ambiguity in that matcher: a bare quoted value followed by `is not supported` no longer qualified as an unsupported parameter. For example, `'temperature' is not supported as a value for mode` now propagated unchanged on the first attempt. The matcher required the word `parameter` in both supported message forms.

Both calls retained the strict JSON schema, max_output_tokens, and the unchanged `metadata={"stream": False}` handling and comment. No determinism requirement justified temperature. The schema constrains structure, not identical wording.

Recovery contract: an Amplifier InvalidRequestError or native HTTP 400/422 exception with `Unsupported parameter: 'name'` or `Parameter 'name' is not supported` qualified only when that name was present in request kwargs and was not model, messages, or metadata. Exactly one retry removed it and kept the requested model. A second rejection propagated. Authentication, rate limits, bad model names, generic invalid requests, ambiguous unsupported values, unknown parameters, and protected parameters propagated without this retry. Timeouts retained the bounded None outcome.

Persistent provider failures logged at WARNING before propagation; the existing state.py boundary caught them and retained the structural verdict/current label. Operators saw WARNING on the Amplifier process stderr/log output, not just DEBUG. There was no new dashboard error indicator.

Live output from the browser terminal:

```text
REAL configured provider: provider-openai base_url: https://api.openai.com/v1
LIVE classify: (False, 'fixed auth redirect loop; build passed')
LIVE label: auth redirect
ERROR:amplifier_module_provider_openai:[PROVIDER] OpenAI API error: {"message": "Unsupported parameter: 'temperature' is not supported with this model.", "type": "invalid_request_error", "param": "temperature", "code": null}
LIVE original temperature rejection: InvalidRequestError {"message": "Unsupported parameter: 'temperature' is not supported with this model.", "type": "invalid_request_error", "param": "temperature", "code": null}
ERROR:amplifier_module_provider_openai:[PROVIDER] OpenAI API error: {"message": "Unsupported parameter: 'temperature' is not supported with this model.", "type": "invalid_request_error", "param": "temperature", "code": null}
WARNING:amplifier_module_hooks_muxterm_session.classify:muxterm live-retry: provider rejected unsupported parameter 'temperature'; retrying once without it (model='claude-haiku-4-5')
LIVE retry response: {"needs_input":false,"summary":"fixed the auth redirect loop; build passed"}
```

Fault injection used the explicitly named **fixture** `RejectingProviderFixture`. It raised real Amplifier exception classes without network calls; its output was not evidence that the live endpoint returned auth, rate-limit, or model errors. The throwaway script was not committed as a unit test.

```text
WARNING:amplifier_module_hooks_muxterm_session.classify:muxterm fault-injection: provider call failed: invalid credentials
FIXTURE attempt=1 model=claude-haiku-4-5 temperature=0.0 stream=False
FIXTURE propagated=AuthenticationError same_exception=True calls=1
WARNING:amplifier_module_hooks_muxterm_session.classify:muxterm fault-injection: provider call failed: quota exceeded
FIXTURE attempt=1 model=claude-haiku-4-5 temperature=0.0 stream=False
FIXTURE propagated=RateLimitError same_exception=True calls=1
WARNING:amplifier_module_hooks_muxterm_session.classify:muxterm fault-injection: provider call failed: model does not exist
FIXTURE attempt=1 model=claude-haiku-4-5 temperature=0.0 stream=False
FIXTURE propagated=NotFoundError same_exception=True calls=1
WARNING:amplifier_module_hooks_muxterm_session.classify:muxterm fault-injection: provider rejected unsupported parameter 'temperature'; retrying once without it (model='claude-haiku-4-5')
WARNING:amplifier_module_hooks_muxterm_session.classify:muxterm fault-injection: provider call failed: Unsupported parameter: 'temperature' is not supported with this model.
FIXTURE attempt=1 model=claude-haiku-4-5 temperature=0.0 stream=False
FIXTURE attempt=2 model=claude-haiku-4-5 temperature=None stream=False
FIXTURE propagated=InvalidRequestError same_exception=True calls=2
WARNING:amplifier_module_hooks_muxterm_session.classify:muxterm fault-injection: provider call failed: invalid response schema
FIXTURE attempt=1 model=claude-haiku-4-5 temperature=0.0 stream=False
FIXTURE propagated=InvalidRequestError same_exception=True calls=1
WARNING:amplifier_module_hooks_muxterm_session.classify:muxterm fault-injection: provider call failed: 'temperature' is not supported as a value for mode
FIXTURE attempt=1 model=claude-haiku-4-5 temperature=0.0 stream=False
FIXTURE propagated=InvalidRequestError same_exception=True calls=1
WARNING:amplifier_module_hooks_muxterm_session.classify:muxterm fault-injection: provider rejected unsupported parameter 'temperature'; retrying once without it (model='claude-haiku-4-5')
WARNING:amplifier_module_hooks_muxterm_session.classify:muxterm fault-injection: provider call failed: Parameter 'temperature' is not supported
FIXTURE attempt=1 model=claude-haiku-4-5 temperature=0.0 stream=False
FIXTURE attempt=2 model=claude-haiku-4-5 temperature=None stream=False
FIXTURE propagated=InvalidRequestError same_exception=True calls=2
```

Verification used `make dev-local` with a fresh TMPDIR and a fresh initial workspace, a real sessiond, and playwright-cli at 127.0.0.1:8313. The browser typed the direct Python provider-call command and displayed the output above; the screenshot was visually inspected. This verified direct classify/label/retry calls in a browser terminal, not automatic fleet-row transitions. Another lane briefly occupied 8313 during setup and then stopped its own server. The successful run used this worktree's own server and sessiond. No other lane was stopped or changed. The muxterm-verify skill was not available in the accessible skill locations, so playwright-cli supplied browser verification.

Local artifacts: `/home/ken/artifacts/muxterm-provider-recovery-review/`, including `browser.png`, `browser-live.out`, `faults.out`, `live.py`, and `faults.py`.

Static check results recorded from command exits:

```text
go build ./...: exit 0
npm run check:fast: exit 0 (existing lint warnings)
python3 -m compileall -q modules/hooks-muxterm-session: exit 0
git diff --check: exit 0
```

No unit tests were written or run. The first dev build ran before Vite produced embedded assets and failed with `pattern dist/*: no matching files found`; after Vite completed, Go build and dev-local startup succeeded.

Deployment: these Python hook changes require a hook module refresh/reinstall and new Amplifier sessions to load them. A muxterm binary release is not required. Existing sessions keep their already-imported code. This verification selected the worktree module via PYTHONPATH; it did not update the production installation. No production service restart, production config write, Amplifier source change, merge, release, or Azure provisioning was performed.
