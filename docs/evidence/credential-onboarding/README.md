# Credential onboarding — evidence

Everything below was produced against an **isolated** muxterm on `127.0.0.1:8455`
with `HOME`, `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR` and `XDG_DATA_HOME` all pointed
at a throwaway root (`/tmp/muxterm-cred-demo`). Redirecting `HOME` as well as the
XDG variables is stronger than the usual dev isolation: `~/.amplifier` and
`~/.config/muxterm` both land inside the sandbox, so no path can resolve back out
to the real machine's credential files. Production on 9090/8311 was never
restarted, and the real `~/.amplifier/keys.env` was never opened for writing.

`amplifier` itself was installed **into the sandbox**
(`UV_TOOL_DIR=$SANDBOX/.amplifier/uv-tools uv tool install …`) rather than
reusing the host's, because the host's amplifier refuses to run against a
redirected `AMPLIFIER_HOME` — its editable installs point at the real home's
cache, and continuing would have rewritten the user's real install. That refusal
was honoured, not worked around.

## Screenshots (390×844 — the width this actually gets configured at)

| File | What it shows |
|---|---|
| `01-notice-phone.png` | The one-line notice on a machine whose credential is present and rejected. Marker in a fixed gutter, the sentence, `Set up` / `Dismiss`. No card, no bolded edge. |
| `02-agents-section-phone.png` | Settings → Agents, reached by pressing `Set up` — it lands on the section, not on Appearance. |
| `03-rejected-not-saved.png` | A key typed in the browser, rejected by the vendor: *"Anthropic rejected this key (HTTP 401). It was NOT saved."* |
| `04-onboarded-healthy.png` | After onboarding: `✓ Lanes can run on this machine.`, and the multi-source line naming which credential actually wins. |
| `05-light-palette.png` | The same surface in a light palette. Meaning is carried by the glyph and the sentence, so nothing depends on colour. |

## The A/B that matters

Both lanes ran the identical argv (`amplifier run <prompt> --mode chat`) through
the real `spawn-lane` path, on the same machine, with the same deliberately-fake
`ANTHROPIC_API_KEY` sitting in the sandbox's `~/.amplifier/keys.env`.

**Lane A — muxterm's store empty.** The stale keys.env entry is what amplifier
sees, and the Mac's failure reproduces exactly:

```
RuntimeError: Execution failed: AuthenticationError: {"type": "error",
  "error": {"type": "authentication_error", "message": "API key is invalid."}}
exit 1                       # pane w4/1 removed: process exited code=1 runtime=719ms
```

**Lane B — the same stale entry still there, a good key stored in muxterm.**

```
sessiond: amplifier pane starts with muxterm-stored credentials: [ANTHROPIC_API_KEY]

│ Bundle: anchors | Provider: Anthropic | claude-opus-5 │
> Reply with the single word READY and nothing else.
Amplifier:
READY
```

The injected environment beat the stale file, and the file was never touched:
`mode=600`, mtime unchanged from when the fixture was written.

## Write-only, checked against the raw bytes

After a real key was saved, every response body and every log file was searched
for the whole key, its first 12 characters, its first 6, and its **last 4**:

```
surface                                         full  prefix12   suffix4   prefix6   result
GET  /api/credentials                              0         0         0         0   clean
GET  /api/ai/status                                0         0         0         0   clean
POST /api/credentials/anthropic/check              0         0         0         0   clean
GET  /api/config                                   0         0         0         0   clean
server log + runtime dir                           0         0         0         0   clean
```

`GET /api/ai/status` now answers `{"enabled":true,"source":"settings"}` — the
`keyHint` field, which returned the last four characters of the stored key, is
gone.

## Permissions after a save

```
700  ken:ken  $SANDBOX/.config/muxterm
600  ken:ken  $SANDBOX/.config/muxterm/anthropic_key
```
