# webview-wrapper — reference artifacts

Companion to [`../webview-wrapper.md`](../webview-wrapper.md). These files exist so the design
is a real interface rather than a sketch. **None of them is wired into muxterm's build.**

| File | What it is | Verified? |
| --- | --- | --- |
| `native-bridge.ts` | The web-side half of the bridge (W4) | **Yes** — `tsc --noEmit` clean under the web app's own compiler options |
| `native-bridge.test.mjs` | Runtime proof of W4.5's three properties | **Yes** — 10/10 checks pass |
| `tsconfig.check.json` | The compiler options used, copied from `web/tsconfig.json` | — |
| `AndroidManifest.xml` | The complete manifest delta (W1.2) | No — no Android SDK on this machine |
| `MainActivity.kt` | The one screen: a WebView (W1.5) | No — same |
| `MuxtermChromeClient.kt` | The permission bridge (W1.3) | No — same |
| `VoiceSessionService.kt` | The foreground service (W1.2) | No — same |
| `MuxtermBridge.kt` | The native half of the bridge (W4) | No — same |

## Reproducing the verification

```sh
# type-check (needs any typescript 5.x)
npx --yes typescript@5.9 tsc -p tsconfig.check.json     # exit 0

# runtime properties
node --experimental-strip-types native-bridge.test.mjs  # ALL PASS
```

Recorded run, 2026-09-08, TypeScript 5.9 / Node v24.15.0:

```
1. absent by default
  ok   install() in a browser-like env finds nothing
  ok   every method is a safe no-op with no wrapper
2. capability-gated, not version-gated
  ok   ready announces capabilities and they gate the API
  ok   an older wrapper announcing less is handled, not version-checked
  ok   an unknown envelope version is dropped, never guessed at
  ok   an unknown message type from a newer wrapper is dropped, not thrown
3. timeouts, not hangs
  ok   a command with no reply resolves false rather than hanging
4. events the page could not learn any other way
  ok   mic.silenced and mic.resumed reach subscribers
  ok   a throwing listener does not stop the others or reach native
  ok   an attachment crosses as a URL, never as bytes
ALL PASS
```

## What the Kotlin has NOT been checked for

Honestly, since it has not been compiled: syntax, imports, API-level availability of every symbol,
and whether `androidx.webkit`'s `WebMessageListener` lambda arity matches the version you resolve.
Treat these files as a specification with working-code fidelity, not as code that has run. Every
non-obvious line carries the citation it came from, so a discrepancy is traceable rather than
mysterious.

The three things most likely to need adjusting on first compile:

1. The `addWebMessageListener` SAM lambda parameters (`view, message, sourceOrigin, isMainFrame,
   replyProxy`) — stable across recent `androidx.webkit`, but check against the version resolved.
2. `AudioRecordingConfiguration.isClientSilenced` is API 29+. The guard is present; the property
   name is worth confirming.
3. `R.drawable.ic_stat_voice` and `BuildConfig.VERSION_NAME` are generated symbols that only exist
   once there is a real Gradle module.

## Wiring the web half in, when the time comes

`native-bridge.ts` is deliberately *not* in `web/src/`. Changing the web app is out of scope for
this document, and the module is inert until someone calls it. When it is wired in:

- call `install()` once at startup — it is a no-op in a browser;
- in `voice-session-controller.ts`, `await startVoiceService(sessionId)` **before**
  `getUserMedia`, and carry on regardless of the answer;
- forward state from the existing `subscribe()` via `reportVoiceState(snapshot.state)` — the
  `state` field only, never `level`, `heard` or `spoken`;
- handle `voice.stopRequested` by calling the controller's existing `stop()`;
- handle `mic.silenced` by surfacing it — this is the event that turns muxterm's worst failure
  mode from undetectable into visible, and rendering it is the whole reason it is on the bridge.
