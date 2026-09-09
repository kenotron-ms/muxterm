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

---

# Second pass — the chief of staff, and the evidence that was missing

Everything below is a **second, independent run** on `127.0.0.1:8315`, against a
throwaway root at `/tmp/mux-cred-evidence` used as `HOME`, `XDG_RUNTIME_DIR`,
`XDG_DATA_HOME` and `XDG_CONFIG_HOME`, with `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY` **unset in the server's environment**. Production on 9090/8311
was never restarted and the real `~/.amplifier/keys.env` was never opened at
all, for reading or writing.

## 1. A genuinely unconfigured machine

The sandbox `HOME` contained nothing but the three XDG directories. No
`.amplifier` at any point. `GET /api/credentials`, verbatim:

```
"present": false,  "origin": "none",
"inMuxterm": false, "inEnvironment": false, "inAmplifierFile": false,
"verdict": { "state": "unknown" },
"blocked": true,
"blockedReason": "Lanes cannot run on this machine: no Anthropic credential is configured.",
"amplifierKeysFound": false,
"amplifierHomeFound": false
```

`amplifierHomeFound: false` is reported and **nothing was created**. muxterm
did not conjure a config tree for a tool that is not installed.

## 2. Present-but-rejected, reported apart from absent

A `keys.env` was then written by hand containing a header comment, an
**obviously fake** Anthropic key, and an unrelated token muxterm knows nothing
about. Detection, before any check:

```
present: True   origin: amplifier   inAmplifierFile: True   verdict: unknown
```

Note `verdict: unknown`, not `ok`. Presence is never read as health. Asking the
vendor:

```
verdict.state      : rejected
verdict.httpStatus : 401
present            : True          <- still present
blockedReason      : "Lanes will fail on their first turn: Anthropic rejected
                      the credential this machine is using."
```

Two different sentences for two different machines. "Configured" is never said
about either.

The server does this **at startup**, before anyone spawns anything:

```
14:49:12 muxterm listening on 127.0.0.1:8315
14:49:12 ai: verify Anthropic: rejected (HTTP 401)
```

## 3. The bootstrap rule, demonstrated rather than asserted

At the moment detection ran and the form was served, the server had **no child
processes at all**:

```
muxterm-cred(2013234)-+-{muxterm-cred}(2013237)   <- threads, not processes
                      |-{muxterm-cred}(2013238)
                      ... 12 threads, 0 children
```

No sidecar, no python, no amplifier, nothing to resolve a bundle. The whole
onboarding surface — detection, form, validation, save — is Go handlers and a
web bundle. A credential screen that needed credentials to render would look
like a broken product rather than an unconfigured one.

## 4. amplifier's keys.env, before and after everything

The file was fixed at mode `600` and `sha256 011ce704…d33c6` before the run.
After detection, a vendor check, a browser save, a chief-of-staff respawn, two
lane launches and a second save:

```
sha256 before == after : YES -- byte-identical
mode   before == after : YES (600)
.bak files created     : 0
```

Zero, because **nothing was rewritten**. muxterm stores its own credential in
its own directory and injects it into the environment of what it starts:

```
700  ken:ken  $SANDBOX/config/muxterm
600  ken:ken  $SANDBOX/config/muxterm/anthropic_key
```

That is the whole of requirement 2, met by not doing it. See
`internal/sessiond/lane_env.go` for the argument and the alternative.

## 5. Write-only, checked against raw bytes on every surface

After a real key was saved, every response body, every log file, the runtime
directory and the data directory were searched for the whole key, its first 12
characters, its first 6, its last 8 and its **last 4**:

```
surface                            full    p12     p6  last4  last8   result
GET /api/credentials                  0      0      0      0      0   clean
GET /api/ai/status                    0      0      0      0      0   clean
POST /api/credentials/../check        0      0      0      0      0   clean
GET /api/config                       0      0      0      0      0   clean
PUT response body                     0      0      0      0      0   clean
server log (all 60 KB)                0      0      0      0      0   clean
runtime: cos.json                     0      0      0      0      0   clean
runtime: server.url                   0      0      0      0      0   clean
runtime: sessiond.log                 0      0      0      0      0   clean
data: restore-snapshot.json           0      0      0      0      0   clean
```

The browser DOM was scanned the same way, through every shadow root: `0 0 0`.
`GET /api/ai/status` answers `{"enabled":true,"source":"settings"}` — nothing
else.

The one credential line the logs do carry names the **variable**, never a value:

```
sessiond: amplifier pane starts with muxterm-stored credentials: [ANTHROPIC_API_KEY]
cos: sidecar starts with muxterm-stored credentials: [ANTHROPIC_API_KEY]
```

## 6. The chief of staff — the gap this pass closed

Mission Control is an amplifier session too. Before this pass it was the one
agent muxterm starts that could not see muxterm's credentials, because
injection lived in sessiond and sessiond does not spawn the sidecar.

Saving a key in the browser, live, with a sidecar already running on the old
environment:

```
14:49:47 ai: verify Anthropic: ok (HTTP 200)
14:49:47 cos: respawning sidecar to pick up new credentials
14:49:47 cos: sidecar exited: signal: terminated after 4.404s
14:49:47 cos: restarting sidecar in 500ms
14:49:47 cos: sidecar starts with muxterm-stored credentials: [ANTHROPIC_API_KEY]
14:49:47 cos: sidecar started pid=2015710
14:49:54 cos: ready session=… tools=35 boot_ms=6787
```

The PUT answered `{"state":"respawning","message":"The chief of staff is
restarting with this credential."}`, and the settings surface rendered it as a
line with a `~` marker in the gutter. A second save later in the run did it
again: exited after 4m46s (ready=true), back up 1s later, ready in 1737 ms.

On a machine where no sidecar had ever been started, the same PUT answered
`{"state":"not-started","message":"The chief of staff will use this credential
the next time you open it."}` — and started nothing. A credential form is not
consent to spawn an agent session.

**No restart command was printed in either case, because none was needed.** It
is printed only for `restart-required`, when the supervisor has given up for
good.

Note what that ready line proves on its own: a chief of staff booted, resolved
its bundle and mounted 35 tools **on a machine whose `keys.env` holds nothing
but a rejected fake key**. The credential it ran on came from muxterm's store.

## 7. A lane, both ways, through the real spawn path

Identical argv (`amplifier run <prompt> --mode chat`) through
`muxterm spawn-lane`, same machine, same fake key sitting in the sandbox's
`keys.env`.

**Lane A — muxterm's store empty.** No injection line is logged, because there
is nothing to inject. amplifier boots and dies at its first turn:

```
sessiond: pane w3/1 removed: process exited code=1 runtime=3472ms
```

which is this, the Mac's failure exactly, visible only in that pane's
scrollback:

```
RuntimeError: Execution failed: AuthenticationError: {"type": "error",
  "error": {"type": "authentication_error", "message": "API key is invalid."}}
```

**Lane B — the same fake entry still in the file, a good key stored in muxterm:**

```
sessiond: amplifier pane starts with muxterm-stored credentials: [ANTHROPIC_API_KEY]

│ amplifier 2026.09.09-2e36587 | core 1.6.1           │
│ Bundle: anchors | Provider: Anthropic | default     │
> Reply with the single word READY and nothing else.
Amplifier:
READY
```

The injected environment beat the stale file, and the file was not touched.

## 8. The design rule, measured rather than eyeballed

Computed styles on the credential rows and the notice, at 390×844:

```
border-radius        0px      <- no rounded card
border-left-width    0px      <- no bolded edge as a status signal
background-color     rgba(0, 0, 0, 0)   <- no slab of chrome at all
grid-template-columns  17.5px 342.5px   <- marker in a FIXED 1.4em gutter
marker               "!" / "✗" / "✓" / "~" / "·"
```

Meaning is carried by the glyph and the sentence; colour lands on that one
character only. Because the row has no background, no border and no radius, it
has no palette-specific chrome that could break — the light-palette shot from
the first pass (`05-light-palette.png`) is the same surface.

## Screenshots (390×844, dark palette)

| File | What it shows |
|---|---|
| `06-clean-machine-notice-phone.png` | The one-line notice on a machine whose credential is present and rejected |
| `07-present-but-rejected-phone.png` | Settings → Agents, reached by pressing `Set up` on that notice |
| `08-after-save-chief-of-staff.png` | After onboarding: healthy rows, plus the chief-of-staff line |
| `09-onboarded-healthy-phone.png` | The settled healthy state |

## What is NOT covered, stated plainly

- **A remote machine.** Configuring credentials here does nothing for a lane
  spawned on the Mac or on res0. Named in `ai.RemoteGapNotice`, returned by the
  API and shown in the UI. Closing it is a separate piece of work.
- **A shell you open by hand.** Injection is applied to panes launched into a
  recognised coding-agent CLI, so `amplifier` typed at a plain muxterm prompt
  sees only what the machine itself provides. Deliberate — a credential in
  every interactive shell's environment is a wider exposure than this needs —
  and said out loud in the settings surface.
- **A keyring or OS vault.** Not attempted. The key is a `0600` file in
  muxterm's own config directory. A follow-on.
