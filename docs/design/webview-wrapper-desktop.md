# muxterm desktop: a thin webview wrapper

**Status:** design. Not built. Nothing in this document has been compiled or run on macOS or Windows.
**Date of research:** 2026-09-08. Every URL below was fetched on that date unless stated otherwise.
**Scope:** desktop only — macOS, Windows, Linux. Android is a sibling lane and is not reconciled here (see D4).

---

## The model, restated so it can be argued with

muxterm's web app is the product. The desktop app is a webview pointed at
`https://muxterm.ampbox.io`, and it exists only to give that webview platform capabilities a
browser tab lacks. It renders nothing of its own. It has no views, no layout, no screens.

Realtime voice already ships in the web app: WebRTC to an Azure OpenAI realtime endpoint, server
VAD, barge-in, an orb in the composer's send slot, a server-side bridge so the browser never sees
tool calls, and an `end_voice_session` tool so you can hang up by speaking. **The wrapper does not
implement voice.** At most it keeps an existing, working session healthy when the window is not in
front, and gives you a way to start one without hunting for a tab.

Whether that is worth shipping is the question D1 and D5 actually answer, and the answer is not the
one the premise assumes.

---

## Verdict table

| Item | Verdict |
|---|---|
| **D1** Does desktop have Android's background-audio problem? | **ANSWERED — essentially no.** Three OSes and both webview engines document exemptions that cover a live WebRTC session. One genuine hazard remains, Windows-only: Modern Standby's DAM phase. |
| **D2** Is Tauri the runtime? | **ANSWERED — yes for macOS and Windows, no for Linux today.** Tauri 2.11.5 ships wry 0.55.x, whose WebKitGTK backend contains zero permission handling, so `getUserMedia` cannot be granted on Linux. Fixed in wry 0.56, unreleased in Tauri. |
| **D3** What must the wrapper not do? | **ANSWERED.** Boundary stated, nine desktop-specific temptations named, each with a rule. |
| **D4** The bridge | **ANSWERED.** Two verbs in, one state declaration out. Contract written and type-checked; desktop-specific vs universal split marked for the Android lane. |
| **D5** The first slice | **ANSWERED.** Build order, biggest risk, effort, macOS first — and an honest re-scoping of what the wrapper actually adds, which is not "audio while hidden". |

---

# D1 — Does desktop even have the problem?

**Verdict: ANSWERED. No. Not in the shape Android has it.**

On Android the microphone dies when the screen goes off unless a foreground service holds it — the
OS actively takes the capability away. Nothing on desktop does that. There is no foreground-service
equivalent to build here because there is nothing to work around.

The honest way to check this is to separate three layers that fail for different reasons and have
different fixes. Conflating them is how a small problem gets designed as a large one.

## Layer 1 — OS process lifecycle: does the OS suspend a backgrounded app?

No, on all three.

**Windows.** Microsoft says it in one sentence:

> "Win32 and .NET apps are either running or not running. When a user minimizes them, or switches
> away from them, they continue to run."
>
> — [Windows application lifecycle](https://learn.microsoft.com/en-us/windows/uwp/launch-resume/app-lifecycle)

Suspension on minimise is a **UWP/packaged-app** concept. The same page says "A UWP app is suspended
shortly after the user minimizes it" — that is the sentence people misremember as applying to
everything. A Tauri or Electron app is a classic Win32 desktop app and is not lifecycle-suspended.

There is a separate mechanism, Power Throttling / QoS, and it does not stop threads. Per
[Quality of Service](https://learn.microsoft.com/en-us/windows/win32/procthread/quality-of-service),
"Minimized, or Fully Occluded → Low" QoS, which on battery "selects most efficient CPU frequency and
schedules to efficient core" — but the same table says "Processes which are determined to be playing
audio are **HighQoS**", and MMCSS tags audio threads Deadline QoS regardless. Scheduling hint, not
suspension.

**macOS.** App Nap exists. Its candidacy criteria are AND-ed, and one of them rules us out:

> "Generally, an app is a candidate for App Nap if: It isn't the foreground app · It hasn't recently
> updated content in the visible portion of a window · **It isn't audible** · **It hasn't taken any
> IOKit power management or NSProcessInfo assertions** · It isn't using OpenGL"
>
> — [App Nap](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/AppNap.html)

App Nap throttles; it never suspends. And two of the five exits are ours for free (audible whenever
the assistant speaks) or for one line of code (`NSProcessInfo.beginActivity`).

*Inference, flagged:* "audible" means playback. Apple's list does not say "capturing audio". During a
stretch where the user is thinking and the assistant is silent, the audible exemption does not
obviously apply — which is why the assertion in Layer 3 is worth taking rather than relying on
audibility.

**Linux.** No such mechanism exists at any layer of the stack. `systemd-logind`'s documented
responsibilities are session tracking, polkit-gated shutdown/sleep, inhibitor logic and hardware
keys — nothing that suspends an application because its window lost focus. And
[`logind.conf`](https://www.freedesktop.org/software/systemd/man/latest/logind.conf.html) says
`IdleAction=` "Defaults to `ignore`". *Inference, flagged: this is an argument from absence, but the
absence spans systemd, X11 and Wayland; desktop Linux has no app lifecycle model at all.*

## Layer 2 — the webview engine: does it throttle or suspend a hidden page?

This is where Android's analogue would live if it existed. It is **explicitly exempted for exactly
our case, in both engine families, in first-party sources.**

**Chromium** documents three throttling tiers and puts us in the top two, never the bottom one
(fetched and read in full today):

> **Minimal throttling** — "The page has made noises in the past 30 seconds. This can be from any of
> the sound-making APIs, but a silent audio track doesn't count."
>
> **Throttling** (1 Hz) — "**WebRTC is in use. Specifically, there's an `RTCPeerConnection` with an
> 'open' `RTCDataChannel` or a 'live' `MediaStreamTrack`.**"
>
> **Intensive throttling** (1/min) — applies only when "The page has been silent for at least 30
> seconds. **WebRTC is not in use.**"
>
> — [Heavy throttling of chained JS timers beginning in Chrome 88](https://developer.chrome.com/blog/timer-throttling-in-chrome-88), last updated 2021-01-18

A muxterm voice session satisfies **both** exemptions. The live `MediaStreamTrack` exists for the
whole call. And the page is genuinely audible whenever the assistant speaks, because the inbound
track is attached to a real, unmuted `<audio>` element —
`web/src/lib/voice-session-controller.ts:509-528`, whose own comment explains why:

> "The media element is not optional and is not for playback convenience: in Chromium an inbound
> WebRTC track produces silence in Web Audio unless something consumes it as media first (crbug
> 40094084)... The element is NOT muted — it is how the assistant is actually heard."

That is the Chromium AnalyserNode-zeros defect, and **the web app already handles it.** A
Chromium-based webview inherits the working behaviour. Nothing for the wrapper to do.

The exemption is implemented, not merely blogged: `MediaStreamTrackImpl::EnsureFeatureHandleForScheduler`
registers `SchedulingPolicy::Feature::kWebRTC` with `DisableAggressiveThrottling()`
([media_stream_track_impl.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/mediastream/media_stream_track_impl.cc)),
and separately a media stream keeps the whole renderer out of background priority
([child_process_launcher.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/child_process_launcher.cc):
`return !visible && !has_media_stream && ...`).

**WebKit** names capture explicitly, which is *stronger* than Chromium's wording.
`Page::updateTimerThrottlingState()` skips escalating throttling when the activity state contains
`IsVisible`, `IsAudible`, `IsLoading` **or `IsCapturingMedia`**
([Page.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/Page.cpp)). And
`WebPageProxy::updateThrottleState()` takes a *foreground* process assertion for either audio or
capture — the release log lines read "UIProcess is taking a foreground assertion because we are
playing audio" and "...because media capture is active"
([WebPageProxy.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/WebPageProxy.cpp)).

*Inference, flagged:* the Blink throttling machinery (`PageSchedulerImpl`, wake-up budget pools)
owns **main-thread task queues**. Capture and WebRTC encode/decode run in the audio service and on
dedicated WebRTC threads that those pools do not own. No single Chromium doc states "media is
unaffected by throttling"; the conclusion is assembled from the scheduler's scope plus the renderer-
priority exemption above.

### Two engine-level caveats that are real

**(a) WebKit process suspension exists, and Apple's own wording is narrower than Tauri's.**

`WKPreferences.inactiveSchedulingPolicy` exists (macOS 14.0+, iOS 17.0+,
[Apple docs](https://developer.apple.com/documentation/webkit/wkpreferences/inactiveschedulingpolicy-swift.enum)),
with cases whose literal descriptions are:

> `.none` — "A policy where a web view that's **not in a window** runs tasks normally."
> `.suspend` — "...**not in a window** fully suspends tasks."
> `.throttle` — "...**not in a window** limits processing, but does not fully suspend tasks."

Note "not in a window", not "not visible". Tauri's config schema paraphrases the same feature as
happening "when a view became minimized or hidden", which is broader than Apple's text. *Inference,
flagged: a minimised window is still in a window; the two phrasings are not the same claim, and I
cannot settle which is operative without a macOS build.*

The report that motivated Tauri's config
([tauri#5250, comment 2569380578](https://github.com/tauri-apps/tauri/issues/5250#issuecomment-2569380578),
2025-01-03) describes a WebSocket that would not reconnect after the machine slept, and says: "I've
tried a lot of hacks like having a local WebRTC ping pong, playing a muted audio file, creating an
audio on demand with an OscillatorNode or using an infinitely pending WebLock transaction. Nothing
worked on MacOS." That reads alarming, but every one of those hacks is specifically a thing that does
**not** set `IsAudible` or `IsCapturingMedia` — a muted file is explicitly excluded by both engines, a
loopback peer connection captures nothing. A real `getUserMedia` session is a different case. It is
weak evidence against us. Set `backgroundThrottling: "disabled"` anyway; it costs one config line.

**(b) WebView2 suspension is opt-in, and wry never opts in. Verified first-hand.**

- `TrySuspendAsync` "must be called" by the host and "The IsVisible property must be false when the
  API is called. Otherwise, the API throws COMException"
  ([Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.trysuspendasync)).
- `grep -c TrySuspend` in `wry-v0.55.1/src/webview2/mod.rs` → **0 matches**.
- wry's parent-window subclass proc handles `WM_SIZE` and **skips minimise entirely** —
  `if wparam.0 != SIZE_MINIMIZED as usize { ...SetBounds... }` (line 1225). It resizes; it never
  calls `SetIsVisible(false)`.
- Tauri's `Window::hide()` maps to `WindowMessage::Hide => window.set_visible(false)` on the **tao
  window** (`tauri-runtime-wry/src/lib.rs:3490`). Only the separate `Webview::hide()` touches the
  WebView2 controller (`:3808`).

*Inference, one step:* Microsoft's `IsVisible` doc says "WebView as a child window does not get
window messages when the top window is minimized or restored... developers should set the IsVisible
property of the WebView to false when the app window is minimized". If the host does not, Chromium
never learns the page is hidden. Net effect: **on Windows a Tauri wrapper is throttled less than a
browser tab, not more.** That test is cheap to run and worth running first (see D5).

## Layer 3 — power state: does the machine sleep?

This is the only genuine problem, and it is the same problem a browser tab has.

- **Display sleep ≠ system sleep.** Display sleep alone stops nothing. It does make the page
  `hidden` on macOS — Apple's occlusion doc counts "The screen saver is on (thereby occluding all
  apps' windows)"
  ([WorkWhenVisible](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/WorkWhenVisible.html))
  — which lands back in Layer 2, already exempted.
- **System sleep kills everything**, everywhere, and no API prevents user-initiated sleep or a lid
  close. `SetThreadExecutionState`: "**cannot be used to prevent the user from putting the computer
  to sleep**"
  ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate)).
  `kIOPMAssertionTypePreventUserIdleSystemSleep`: "The system may still sleep for lid close, Apple
  menu, low battery, or other sleep reasons"
  ([IOPMLib.h](https://github.com/opensource-apple/IOKitUser/blob/master/pwr_mgt.subproj/IOPMLib.h)).
- **Idle sleep *can* be prevented**, and this is one of the few real wrapper capabilities:
  `NSProcessInfo.beginActivity(options:reason:)` on macOS,
  `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` on Windows,
  `org.freedesktop.login1.Inhibit("idle:sleep", …, "block")` on Linux
  ([systemd inhibitor locks](https://systemd.io/INHIBITOR_LOCKS/); note the fd auto-releases if the
  process dies, which is the failure mode you want).

  **But partly already covered.** Chromium takes a `kPreventAppSuspension` wake lock with reason
  `kAudioPlayback`, labelled "Playing audio", whenever the page "was recently audible"
  ([media_web_contents_observer.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/media/media_web_contents_observer.cc),
  `MaybeUpdateAudibleState() → LockAudio()`). So during assistant speech the browser already holds
  it. I found **no** equivalent wake lock for a capture-only page — absence of evidence, flagged as
  such. The wrapper's genuine, non-duplicative contribution is holding the assertion across the
  *whole* session including the silent stretches.

### The one genuinely desktop-specific hazard: Windows Modern Standby

This is the closest thing desktop has to Android's problem, and it is worth stating precisely.

> "**A system enters modern standby when the display turns off.** This will occur in response to: the
> user pressing the power button; the user closing the lid; the user selecting Sleep…; **the system
> idling out**."
>
> **DAM phase** — "The system pauses desktop applications to reduce their power consumption during
> standby… The system suspends desktop applications." Exited when: "**All desktop applications have
> been suspended and no audio playback is occurring.**"
>
> **No-CS phase** — "Power requests will block the NoCS phase **indefinitely on AC power, and for up
> to 5 minutes on DC power. Audio and mobile hotspots are allowed to run indefinitely.**"
>
> — [Prepare software for modern standby](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/prepare-software-for-modern-standby)

So on a Modern Standby laptop, **screen off** starts the standby sequence, and a desktop app is
suspended once audio playback stops. Screen-off is triggered by idling out, so this is reachable
without the user doing anything.

*Inference, flagged and high-stakes:* the doc says "audio **playback**". It says nothing about audio
capture or a WebRTC session. A call where the far end is silent for a while, on battery, with the
screen off, is the most plausible real failure mode on desktop, and it is Windows-only.

The only documented lever is `ES_DISPLAY_REQUIRED`, which keeps the screen on — an unattractive trade
the user should own, not the wrapper. Conservative recommendation, recorded with its alternative:
**take `ES_SYSTEM_REQUIRED` only, do not force the display on, and if the Modern Standby test fails,
surface it as a user-visible setting rather than silently keeping people's screens lit.** The
alternative — always `ES_DISPLAY_REQUIRED` during a call — is rejected because a voice app that
prevents your laptop screen from sleeping is a worse citizen than one that occasionally drops a call
you were not looking at.

## D1 conclusion

**Desktop does not have Android's problem.** There is no mechanism on macOS, Windows or Linux that
takes the microphone away from a hidden window, and both webview engines document explicit exemptions
that a live `getUserMedia` + `RTCPeerConnection` session satisfies. The design is therefore much
smaller than the Android one, and it should stay small:

1. Hold an idle-sleep assertion for the duration of a session (three one-line OS calls). *Real, and
   only partly duplicated by the browser.*
2. Set `backgroundThrottling: "disabled"` on macOS 14+. *One config line, belt-and-braces.*
3. Know that Windows Modern Standby + screen off + battery + silence can still suspend you, and that
   the documented workaround is worse than the problem. *Measure before designing for it.*

That is the whole of D1's design consequence. Carry the corollary into D5: **if the browser tab
already survives being hidden, "audio while hidden" cannot be the wrapper's justification.**

## What would settle the rest, and where

| Question | Test | Where |
|---|---|---|
| Does a **browser tab** already survive 30 min hidden mid-call? | `getStats()` polling; assert `packetsSent`/`packetsReceived` keep climbing | Any desktop, today. **Do this first.** |
| Does WebKit suspend a *minimised* (as opposed to windowless) WKWebView mid-call? | Same, in the wrapper, macOS 13 (no config) vs 14+ (`backgroundThrottling: "disabled"`) | macOS build |
| Does Modern Standby's DAM suspend us? | Laptop on DC, far end silent, screen off, 10 min; then `powercfg /sleepstudy` and `powercfg /requests` | Windows laptop |
| Does the page even go `hidden` on Windows minimise under wry? | Log `visibilitychange` in the wrapper | Windows build |
| Does `coreaudiod` already hold the sleep assertion for us? | `pmset -g assertions` mid-call | macOS |
| Do PipeWire capture nodes survive screen blank? | `pactl list source-outputs`, expect `RUNNING` | Linux |

---

# D2 — The runtime

**Verdict: ANSWERED. Tauri for macOS and Windows. Not Linux, today.**

## Current version

| Crate | Version | Published |
|---|---|---|
| `tauri` | **2.11.5** | 2026-07-01 |
| `wry` (shipped by 2.11.5) | 0.55.x | 0.55.1 on 2026-05-04 |
| `wry` (latest) | **0.56.1** | 2026-08-13 |
| `tauri-plugin-global-shortcut` | 2.3.2 | 2026-05-28 |

Verified against crates.io today, and corroborated by the published config schema's own `$id`:
`https://schema.tauri.app/config/2` returns `"$id": "https://schema.tauri.app/config/2.11.5"`.

**wry is ahead of Tauri, and the gap is exactly the thing this design needs.** More below.

## The engine per platform, and what it costs

| OS | Engine | Provenance |
|---|---|---|
| macOS | **WKWebView** (WebKit) | System. Version tied to the OS. You cannot ship a newer one. |
| Windows | **WebView2** (Chromium/Edge) | Evergreen runtime, updates with Edge. Present on Windows 10 1803+ and part of Windows 11. |
| Linux | **WebKitGTK 4.1** (≥ 2.40) | Distro package `libwebkit2gtk-4.1-dev`. Whatever the distro has. |

— [Tauri prerequisites](https://tauri.app/start/prerequisites/),
[WebView2 distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)

**A wrapper whose engine differs per platform has three behaviours, not one, and this is precisely
where it bites.** You are testing against three WebRTC stacks: libwebrtc-in-Chromium on Windows,
Apple's WebRTC on macOS pinned to the user's OS version, and WebKitGTK's GStreamer-backed WebRTC on
Linux. Codec negotiation, echo cancellation, device enumeration, `getStats` shape and `AudioContext`
behaviour will differ, and macOS is the worst for version skew because an old macOS means an old
WebKit and there is no lever. *Inference: I found no Tauri or wry document asserting WebRTC parity,
and the Linux WebRTC tracking issue [wry#85](https://github.com/tauri-apps/wry/issues/85) has been
open since 2020-05-30 with 57 comments.*

Against that: the Chromium AnalyserNode-zeros defect flagged in the brief is a Chromium-only issue,
and **the web app already mitigates it** (`voice-session-controller.ts:509-528`, quoted in D1). So
the one known engine-specific defect costs the wrapper nothing.

## Microphone access — the decisive finding

I read wry's source at the exact tag Tauri 2.11.5 ships. Results, verbatim:

**macOS — auto-granted, no code required.**
[`wry-v0.55.1/src/wkwebview/class/wry_web_view_ui_delegate.rs:126`](https://github.com/tauri-apps/wry/blob/wry-v0.55.1/src/wkwebview/class/wry_web_view_ui_delegate.rs)

```rust
#[unsafe(method(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:))]
fn request_media_capture_permission(...) {
  //https://developer.apple.com/documentation/webkit/wkpermissiondecision?language=objc
  (*decision_handler).call((WKPermissionDecision::Grant,));
}
```

The WebKit layer says yes unconditionally, so the only gate is macOS TCC — a **one-time, persistent**
grant, not a foreground-only one ("The system saves the user's selection so that it doesn't have to
prompt the user again",
[AVCaptureDevice.requestAccess](https://developer.apple.com/documentation/avfoundation/avcapturedevice/requestaccess(for:completionhandler:))).
What the bundle must carry: `NSMicrophoneUsageDescription` in `Info.plist` (AVFoundation *raises an
exception* without it), `com.apple.security.device.audio-input` in entitlements
(`bundle.macOS.hardenedRuntime` defaults to `true`), and `minimumSystemVersion ≥ 12.0` because the
delegate method is macOS 12+. All three are written and included — see *Artefacts* below.

**Windows — WebView2's own prompt, with a one-way door.**
In wry 0.55.1's `webview2/mod.rs` the only `add_PermissionRequested` handler auto-allows
`COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ` and nothing else (lines 500–507). Microphone falls
through to WebView2's default, which is to prompt — not to deny. But if the user clicks Block, the
decision persists in the WebView2 profile and there is **no API to re-prompt**
([tauri#5042](https://github.com/tauri-apps/tauri/issues/5042), closed 2022;
[tauri#8606](https://github.com/tauri-apps/tauri/issues/8606) "re-access microphone", **open** since
2024-01-15). One misclick permanently breaks voice for that user. See D5 — this is the biggest risk.

**Linux — silently denied. The blocker.**
`grep -ic permission wry-v0.55.1/src/webkitgtk/mod.rs` → **0 matches in 1249 lines.** Nothing connects
`WebKitWebView::permission-request`, so a `UserMediaPermissionRequest` falls through to WebKitGTK's
default, which is deny. The same grep against wry's `dev` branch → **32 matches**: the fix landed in
wry 0.56.0 ([wry#1654](https://github.com/tauri-apps/wry/pull/1654), merged 2026-06-11), and Tauri has
merged the passthrough to `dev` (`.changes/permission-handler.md`, a `minor:feat` bump — *inference:
that ships as Tauri 2.12.0*) but **has not released it**. Confirmed absent from stable: `docs.rs/tauri/2.11.5`
`WebviewBuilder` has zero occurrences of `permission_request`.

**Consequence:** "one wrapper, three platforms" is false today. It is true for macOS and Windows, and
becomes true for Linux when Tauri 2.12 ships. Recorded, not solved.

*Additionally unresolved:* which GStreamer plugin packages WebKitGTK needs for mic capture. Tauri's
prerequisites page does not mention GStreamer at all. Settled only by building on a target distro.

## Running with no visible window; tray; shortcuts

All stable, documented, unremarkable.

- **Start hidden:** `app.windows[].visible: false` (schema default `true`). Validated — see Artefacts.
- **Hide from the Dock:** `app.set_activation_policy(tauri::ActivationPolicy::Accessory)` in `setup`.
- **Survive the last window closing:** `RunEvent::ExitRequested { api, .. } => api.prevent_exit()`.
- **Tray:** built into core `tauri` behind the `tray-icon` Cargo feature, not a plugin
  ([system tray](https://tauri.app/learn/system-tray/)). **Linux caveat:** Tauri's own docs say tray
  *events* are "Unsupported — the event is not emitted even though the icon is shown". A
  click-the-tray-icon-to-toggle design does not work on Linux; use a menu item. Linux also needs
  `libayatana-appindicator3-dev`.
- **Global shortcuts:** `tauri-plugin-global-shortcut` 2.3.2, desktop-only. Permissions are
  default-deny — "No features are enabled by default, as we believe the shortcuts can be inherently
  dangerous." Registering from **Rust** bypasses the ACL entirely, which is what this design does, so
  the remote origin gets no shortcut permission at all.

## Remote HTTPS origin + IPC — the config that actually matters

A Tauri webview can load a remote HTTPS URL, but **the IPC bridge is off for remote origins by
default**, and v1's `dangerousRemoteDomainIpcAccess` is gone. I dumped the full v2 `SecurityConfig`
and confirmed: its properties are `csp, devCsp, freezePrototype, dangerousDisableAssetCspModification,
assetProtocol, pattern, capabilities, headers`. No such key.

The v2 replacement is a capability with a `remote` block scoped by
[URLPattern](https://urlpattern.spec.whatwg.org/):

> "By default the API is only accessible to bundled code shipped with the Tauri App. To allow remote
> sources access to certain Tauri Commands it is possible to define this in the capability
> configuration file."
>
> — [Tauri capabilities](https://v2.tauri.app/security/capabilities/)

And the caveat that shapes D4:

> "**Caution** — On Linux and Android, Tauri is unable to distinguish between requests from an
> embedded `<iframe>` and the window itself."

That is why the injected script installs the host object in the **main frame only**, and why the
capability grants exactly one permission.

## Should it be Tauri?

**Yes, conservatively, for macOS and Windows now and Linux at Tauri 2.12** — but the reasoning is not
the usual one, and the usual numbers are less relevant here than they look.

The measured hello-world comparison people cite ([gethopp.app, 2025-04-09](https://www.gethopp.app/blog/tauri-vs-electron),
N=1, author's own disclaimer) is Tauri 8.6 MiB / ~172 MB RAM against Electron 244 MiB / ~409 MB.
Adjusted honestly for this case:

- That 8.6 MiB is macOS with no plugins. On Windows, add the WebView2 install mode from Tauri's own
  schema: `embedBootstrapper` +1.8 MB, `offlineInstaller` **+127 MB**, `fixedRuntime` **+180 MB**. If
  three-engine divergence forces a pinned runtime, **Tauri's Windows installer lands in Electron's
  size class anyway.**
- Electron's real purchase is **one engine on all three OSes**: one WebRTC implementation, one set of
  echo-cancellation and codec behaviours, pinned and updated on your schedule. For a realtime voice
  product that is worth a great deal, and it makes the Linux blocker vanish entirely.
- Its real cost is ~235 MB of bundle, ~2.4× memory, and carrying the Chromium security treadmill
  yourself.

**The tiebreaker is that this is a wrapper around a *remote* app.** Almost all shipping happens
server-side; the shell should be near-static and rarely updated. That weakens "Electron updates are
heavy" *and* "Tauri is small" symmetrically, and leaves correctness and maintenance burden as the
deciding axes. Tauri wins on maintenance burden (no Chromium to patch) and loses on correctness
guarantees (three engines).

**Decision, with its alternative recorded:** Tauri, targeting macOS first. **If the three-engine
matrix produces two or more distinct WebRTC defects during D5's measurement phase, switch to
Electron and eat the 235 MB** — that is the pre-committed trigger, written down now so it is not
re-litigated under sunk cost later. A platform-native webview host (WKWebView on macOS + WebView2 on
Windows, written directly) is a third option that buys nothing Tauri does not already give and costs
two codebases; rejected.

---

# D3 — What the wrapper must not do

**Verdict: ANSWERED.**

## The boundary

> **The wrapper renders muxterm and grants capability. It does not implement, duplicate, or extend
> anything the web app does.**

Three operational tests, in order of how quickly they catch drift:

1. **The deletion test.** Delete the wrapper and every muxterm user must still have a complete
   product in a browser tab. If deleting the wrapper removes a feature, that feature was built in the
   wrong place.
2. **The pixel test.** The wrapper draws no pixels except OS chrome: a window frame, a tray icon, a
   tray menu, and the OS permission dialogs it cannot suppress. No preferences window, no about box,
   no error screen. If a designer needs to be consulted, the boundary has been crossed.
3. **The bridge test.** Every capability the wrapper adds is visible as a line in
   `bridge.d.ts`. That file is small enough to read in a minute. If it stops being small enough to
   read in a minute, the wrapper has become a product.

## The temptations, named

Desktop's temptations are different from mobile's: mobile pulls you toward a second UI, desktop pulls
you toward a hundred small native affordances that each look free.

| # | Temptation | Why it is tempting | The rule |
|---|---|---|---|
| 1 | **Native menu bar** | macOS gives you one whether you want it or not, and an empty one looks broken. | Ship the **minimum system menu only** — About, Hide, Quit, and the edit menu that makes ⌘C/⌘V work in the webview. No File, no View, no Window, no muxterm-specific items ever. Any menu item that would do something muxterm-specific belongs in the web app's own UI. |
| 2 | **Preferences window** | "Just one setting: which server to connect to." | **No preferences window.** The server URL is compiled in for the first slice. If it must be configurable, it is a config file the wrapper reads at launch, with no UI. Settings that are about *muxterm* live in muxterm. |
| 3 | **Native notifications** | The OS has them; the web app's notifications are weaker. | **Not in the wrapper.** The web app uses the Notification API, which works in all three engines. If it needs to be better, improve it in the web app where every user gets it, browser tab included. |
| 4 | **Tray menu accretion** | Every feature "just needs one more menu item". | The tray menu is **capped at four items**: Show muxterm, Start/Stop voice, About, Quit. Adding a fifth requires editing this document first. |
| 5 | **Deep links / URL scheme** (`muxterm://`) | Obvious, cheap, feels native. | **Out of the first slice.** A deep link is an input channel, and every input channel is a security surface on a wrapper that hosts a remote origin. Revisit only with a concrete named use case. |
| 6 | **File associations** | "Open this log in muxterm." | **No.** muxterm is not a file viewer. This is the clearest case of the wrapper inventing a product. |
| 7 | **Native window layout / splits** | The repo already contains a prior design for exactly this. | **The web app owns all layout.** A wrapper has one window and one webview. There is no window layout to architect. If a second window ever seems necessary, that is a signal the model is being abandoned, and it should be argued explicitly rather than arrived at. |
| 8 | **Caching, offline mode, a local proxy** | "It's a native app, it could be resilient." | **No local state at all** beyond the webview's own cookie jar and the OS keychain the webview already uses. The wrapper stores nothing, caches nothing, proxies nothing. |
| 9 | **Auto-launch at login, dock badges, jump lists, Touch Bar** | Each is ten lines. | **Auto-launch: yes eventually, it is pure lifecycle and draws nothing.** Badges, jump lists, Touch Bar: no — they are UI, and they are UI that only some users get. |

## The structural defence

Rules decay. Two of these are enforced by the artefacts rather than by discipline:

- **The capability file grants exactly one permission.** Adding a wrapper feature that the page can
  reach requires editing `capabilities/muxterm-remote-bridge.json`, which is a reviewable one-line
  diff with the rule written in its own `description` field.
- **`withGlobalTauri: false`.** The remote origin never sees `window.__TAURI__`. A well-meaning
  change cannot casually reach for `fs`, `shell` or `process` from page code, because they are not
  there.

---

# D4 — The bridge

**Verdict: ANSWERED. Contract written, type-checked, and behaviourally tested.**

## Shape

Two globals, one per direction. Each side installs its own; neither installs the other's. That is
what makes presence detection honest — the page cannot fake being wrapped, and the host cannot fake a
page that is ready.

```
  window.__muxtermHost      installed by NATIVE, before page load, main frame only,
                            via WebviewBuilder::initialization_script.
                            One method: declareVoiceState().

  window.__muxtermDesktop   installed by the WEB APP, once, only when __muxtermHost exists.
                            One method: command(verb).
```

**Native → web: two verbs, no payload.**

```ts
type DesktopCommand = 'voice.toggle' | 'voice.stop';
```

No payload is the design, not an omission. Native says *"the user asked to toggle voice"*; the page
decides what that means using state native does not have and must not be given. Delivery is
`Webview::eval` of a literal string built from a closed Rust enum, so nothing attacker-controlled ever
reaches the page — and, importantly, **this direction needs no permission at all.**

**Web → native: one state declaration.**

```ts
interface VoiceStateDeclaration { active: boolean; detail?: string }
```

A *declaration*, not a request. The page is not asking native to do anything; native decides for
itself what to do with the fact — take or drop the OS wake assertion, change the tray icon, keep the
process alive. It is **edge-triggered**: the voice controller emits a snapshot on every level-meter
tick, and forwarding those would put a ~30 Hz IPC stream on the bridge carrying information native
does not use.

## What must never cross, in either direction

- Terminal bytes, PTY output, command text, session content of any kind.
- Credentials, cookies, bearer tokens, the realtime ephemeral key.
- Audio samples, encoded frames, VAD decisions, transcripts.
- Realtime tool calls or any realtime protocol frame. A server-side bridge already keeps these away
  from the browser; the desktop bridge must not become a second place they surface.
- UI state: layout, focus, which pane or workspace is open.
- Filesystem paths, or anything native could turn into an arbitrary read.

**One line: the bridge carries intent and lifecycle, never content.**

## Failure semantics

The wrapper's job is to *add* capability, so losing the bridge must subtract nothing. Verified
behaviourally (run log below): with no host, `installDesktopBridge` is a no-op returning a callable
teardown; on a version mismatch it warns and disables itself; a `declareVoiceState` rejection is
swallowed, because its worst consequence is that the machine idle-sleeps mid-call — which is what a
browser tab does anyway.

## COORDINATION — the seam with the Android lane

Marked as required, so reconciliation is a merge and not a rewrite. **No attempt is made here to
design a cross-platform bridge.**

**UNIVERSAL — any wrapper on any platform will need these:**

1. **A host-presence handshake carrying a contract version.** Both directions, so neither side
   guesses.
2. **Inbound verbs `voice.toggle` and `voice.stop`, payload-free.** Every platform has some
   out-of-page affordance — tray, notification action, widget, headset button, lock screen — that
   must be able to start and stop a call without knowing anything about voice state.
3. **An outbound `voiceState` declaration, edge-triggered.** Every platform needs to know a call is
   live so it can hold whatever that OS's keep-alive primitive is.
4. **The content prohibition**, verbatim as listed above. Identical on every platform.
5. **Degrade-to-browser semantics.** No host ⇒ the web app behaves exactly as it does in a tab.

**DESKTOP-SPECIFIC — do not expect these to generalise:**

1. Tray icon and tray menu as the surface that emits the verbs. (No Android analogue.)
2. OS-wide global hotkey registration as a second emitter of the same verbs.
3. "Last window closed, app still alive" — `prevent_exit` plus macOS `ActivationPolicy::Accessory`.
   A desktop-only lifecycle concept.
4. The three different OS wake-assertion primitives taken on `voiceState.active`
   (`NSProcessInfo.beginActivity` / `SetThreadExecutionState` / logind `Inhibit`).
5. Window show/hide/focus in response to a tray click.
6. Three webview engines behind one bridge.

**Explicitly NOT reconciled, and left to the merge:** the wire encoding (Tauri `eval` + `invoke` here;
Android will have its own), the global names, whether the state declaration is push or pull, and the
version-negotiation policy. Universal items 1–5 are the seam. Everything else is local.

---

# D5 — The first slice

**Verdict: ANSWERED.**

## First, the uncomfortable part

D1 found that a browser tab already keeps a WebRTC call alive when the window is hidden, minimised or
occluded, on all three desktop OSes, in both engine families, by documented design. And Chromium
already takes a system wake lock during audio playback. muxterm already runs as a local service with
a browser UI on this machine, so a desktop user has a complete working path today.

**So "audio while hidden" is not a differentiator on desktop, and this design should not pretend
otherwise.** What the wrapper actually adds, ranked honestly:

1. **A tray presence and a global hotkey** — start or stop a conversation without finding the tab.
   Real, small, and the thing most likely to be used daily.
2. **An app that outlives its window** — closing the window does not end the session; there is no tab
   to accidentally lose.
3. **A sleep assertion across the *whole* session**, including capture-only silences the browser's
   playback-triggered wake lock does not cover. Real, narrow.
4. **Insurance against WebKit process suspension** on macOS via one config line. Possibly zero value;
   costs one line.

That is the case. It is a decent case for a menu-bar app. It is not a case for "the browser can't do
this". **Anyone deciding whether to fund this should be shown this list, not the premise.**

Which changes what the first slice should prove. Not "can audio survive being hidden" — measure that
in a browser tab in an afternoon and you may find there is nothing to prove. The slice should prove:

> **A tray-resident app that holds a voice conversation with the user having never seen a window.**

That is the model working end to end, and it is genuinely impossible in a browser tab.

## Build order

| # | Component | Proves | Depends on |
|---|---|---|---|
| 0 | **Measurement harness in a plain browser tab.** A page that polls `getStats()` every 5 s and logs `packetsSent`/`packetsReceived`/`visibilityState`, run hidden for 30 min on each OS. | Whether the wrapper has a job at all. **Half a day. Do this before writing any Rust.** | Nothing |
| 1 | Tauri skeleton: one window, `visible: false`, pointed at `https://muxterm.ampbox.io`, `withGlobalTauri: false`. | The remote origin loads and voice works unchanged in a WKWebView. | Toolchain |
| 2 | `Info.plist` + entitlements + `minimumSystemVersion: 14.0`; run signed. | `getUserMedia` succeeds; one prompt, not two, not none. | 1 |
| 3 | Tray icon, four-item menu, `prevent_exit`, `ActivationPolicy::Accessory`. | The app lives with no window and no Dock icon. | 1 |
| 4 | `initialization_script` + the `declare_voice_state` command + the capability file. | The bridge closes, in the direction that needs a permission. | 1, 3 |
| 5 | The web-side shim wired into `web/src/app.ts` (one call). | Tray "Start voice" begins a real conversation. **This is the slice's success criterion.** | 4 |
| 6 | Global shortcut registered from Rust, firing the same verb. | A hotkey works with the window never shown. | 4 |
| 7 | `NSProcessInfo.beginActivity` on `active: true`, ended on `active: false`; verified with `pmset -g assertions`. | The one power capability the browser does not fully cover. | 4 |
| 8 | `backgroundThrottling: "disabled"`; 30-minute hidden-call soak; compare against step 0. | Whether the wrapper measurably beats a tab. | 1 |

Steps 0 and 8 bracket the whole thing with the same measurement. That is deliberate: the project
should be able to fail honestly.

## A specific trap the slice will hit, found while writing the config

**A voice session started from the tray or a global shortcut has no user gesture in the page.**

That matters because the assistant is heard through a real `<audio>` element
(`voice-session-controller.ts:509-528`), and the call site is
`el.play().catch(() => { /* autoplay policy; the user gesture that started the session covers it */ })`.
That comment is true in a browser tab, where the orb was clicked. It is **not** true when native
eval'd `voice.toggle` because you pressed a hotkey with the window hidden — and the failure is
silent, because the rejection is deliberately swallowed. Symptom: the conversation connects, the
microphone works, the assistant answers, and you hear nothing.

Verified in wry 0.55.1's source: `WebViewAttributes::autoplay` defaults to `true`
(`src/lib.rs:843`) and Tauri never overrides it — `grep autoplay` in `tauri-runtime-wry/src/lib.rs`
and in the whole config schema both return zero. Each backend honours it differently:

- **macOS** — `config.setMediaTypesRequiringUserActionForPlayback(WKAudiovisualMediaTypes::None)`
  (`wkwebview/mod.rs:361-365`). Free, and unaffected by anything in this design.
- **Linux** — `WebsitePolicies` with `AutoplayPolicy::Allow` (`webkitgtk/mod.rs:397-403`). Free.
- **Windows** — only by appending `--autoplay-policy=no-user-gesture-required` to the browser args
  (`webview2/mod.rs:300-302`), and that append lives inside the `unwrap_or_else` closure that
  supplies the *default* `additionalBrowserArgs`. **Setting `additionalBrowserArgs` in
  `tauri.conf.json` skips the whole closure and silently drops it**, along with wry's
  `--disable-features=msWebOOUI,...` defaults.

The committed `tauri.conf.json` therefore passes all of it explicitly. This is the kind of thing that
costs a day of debugging if it is discovered during step 5 rather than now.

*Inference, flagged:* that Chromium's autoplay policy would actually block this specific
`srcObject`-fed element is not verified — WebRTC-sourced media has historically been treated
differently from file media. It is cheap insurance either way.

## The single biggest technical risk

**Windows: a user who clicks "Block" on WebView2's microphone prompt has permanently broken voice,
and there is no API to re-prompt.** ([tauri#5042](https://github.com/tauri-apps/tauri/issues/5042);
[tauri#8606](https://github.com/tauri-apps/tauri/issues/8606), open since 2024-01-15.) It is worse
than Linux's total absence of mic support, because Linux fails visibly and is fixed by waiting for
Tauri 2.12, whereas this fails once, silently, per user, forever.

*Possible mitigation, unverified:* wry 0.56.0 added `WebViewBuilderExtWindows::with_profile_name`
(PR #1738), which gives isolated WebView2 profiles — a resettable profile would be an escape hatch.
It is not documented as such. **Inference. Needs a Windows build to confirm.**

*Runner-up, non-technical but larger:* step 0 shows the browser already does everything, and the
remaining delta does not justify a shipping artefact per OS.

## Effort, honestly

| Scope | Estimate | Assumes |
|---|---|---|
| Step 0 alone | **half a day** | Any desktop |
| Steps 1–8, macOS only | **3–5 days** | Someone who has shipped a Tauri app before. Double it otherwise — the remote-origin capability path has no worked desktop example in Tauri's docs. |
| Windows to parity | **+3–5 days** | Dominated by the permission one-way door and Modern Standby testing |
| Linux to parity | **blocked** on Tauri 2.12, then **+3–5 days** and an unknown for GStreamer packaging |
| All three, soaked | **3–4 weeks elapsed** | Code signing and notarisation not included — out of scope here, but a hard gate on actually shipping macOS, and the one place it changes this design is that `getUserMedia` has behaved differently in notarised builds than in dev builds before ([tauri#8314](https://github.com/tauri-apps/tauri/issues/8314)), so macOS mic testing must be done on a signed build. |

## Which OS first: macOS

Three reasons, in order:

1. **It is the only platform where the risk is real *and* the mitigation exists.** WebKit genuinely
   suspends inactive web views, and `backgroundThrottling: "disabled"` (macOS 14+) is the documented
   answer. A pass on macOS is informative; a pass on Windows mostly confirms that nothing was ever
   wrong.
2. **Microphone access works with zero code.** wry auto-grants at the WebKit layer; only bundle
   metadata is needed. Windows has the one-way door, Linux does not work at all.
3. **A menu-bar app with no window is the most native, most-used idiom on macOS**, which is exactly
   the affordance the slice is meant to prove.

Linux last, because stable Tauri cannot grant the microphone at all.

## Camera and file attachment through the same bridge — short answer

**Camera:** structurally identical to the microphone, and **the bridge does not change.** The page
calls `getUserMedia({ video: true })`; the wrapper's only job is bundle metadata —
`NSCameraUsageDescription` and `com.apple.security.device.camera` on macOS (both already written into
the artefacts so enabling it later is a code change, not another notarisation round), WebView2's
prompt with the same one-way door on Windows, the same zero-handler problem on Linux. No new verb, no
new permission.

**File attachment:** two shapes, and only one of them is a wrapper feature.

- **`<input type="file">` inside the page** works in all three engines and needs no bridge at all.
  **This is the conservative choice and the recommendation:** file attachment is a web-app feature,
  every muxterm user gets it including browser-tab users, and the wrapper stays out of it.
- **A native picker** — drag-and-drop onto the tray, an "Attach…" menu item, Finder "Open With" —
  would need a new inbound verb, and the rule then is: **the bridge passes a reference the page can
  turn into an upload, never bytes and never a path.** Concretely, native reads the file and POSTs it
  to muxterm's existing upload endpoint, then tells the page which upload id appeared; or hands the
  page a single-use `asset://` URL scoped to that one file. A raw path must never cross, because a
  path the page can name is a path the page can ask native to read.

Deferred until a concrete need appears. Recorded here so that when it does, the rule already exists.

---

# Artefacts built in this session

No Rust toolchain, no Node modules, and no `webkit2gtk-4.1` are present on this machine
(`cargo: command not found`; `pkg-config --modversion webkit2gtk-4.1` fails), so **nothing here was
compiled as a Tauri app and no Rust was written to be pretended-verified.** What could be built and
checked, was.

All files live in [`docs/design/webview-wrapper-desktop/`](webview-wrapper-desktop/).

| File | What it is | How it was verified |
|---|---|---|
| `tauri.conf.json` | The wrapper's whole configuration: hidden window on the remote origin, `withGlobalTauri: false`, `backgroundThrottling: "disabled"`, macOS 14 floor + entitlements, WebView2 bootstrapper, and the Chromium background switches passed through `additionalBrowserArgs` — **restating wry's own defaults, including `--autoplay-policy=no-user-gesture-required`, which setting this field would otherwise silently drop** (see D5). | **Schema-validated against Tauri 2.11.5's published schema** (`https://schema.tauri.app/config/2`, `$id` 2.11.5) with ajv → `VALID`. |
| `capabilities/muxterm-remote-bridge.json` | The only capability granted to the remote origin. Scoped to `https://muxterm.ampbox.io`, one permission. | Shape matches the documented `remote.urls` form. **The exact permission identifier for an app-local command is the one thing needing a build to confirm** — Tauri's docs establish that app-level permissions are unprefixed ("When referencing permissions of the application itself it is not necessary"), but the generated identifier is emitted by `tauri-build`. Documented fallback if it differs: `core:event:default`, which is broader and therefore the worse option. |
| `macos/Info.plist` | `NSMicrophoneUsageDescription` (mandatory — AVFoundation raises without it), `NSCameraUsageDescription` (pre-declared), `LSUIElement=false`. | XML well-formedness only. |
| `macos/entitlements.plist` | `audio-input`, `camera`, `network.client`. Every deliberate *absence* is annotated with the D3 rule that keeps it absent. | XML well-formedness only. |
| `bridge.d.ts` | **The bridge contract.** Both interfaces, the closed verb set, and the never-crosses list as enforced documentation. | `tsc 5.9.3 --strict --noUnusedLocals --noUnusedParameters` → clean. |
| `desktop-bridge.ts` | **The web-side half.** Not wired into `web/src` — changing the web app is out of scope — so this is the artefact, plus the one call site it would need. | Type-checked, then compiled and **behaviourally tested** (run log below). |
| `initialization-script.js` | **The native-side half**: the exact JS Rust injects, main frame only, one frozen object with one method. | `node --check` after token substitution, plus a behavioural smoke test. |

### Behavioural test run

```
1. installed, __muxtermDesktop present: true
2. initial declaration: [{"active":false,"detail":"initial"}]
3. after toggle: [{"active":false,...},{"active":true,"detail":"listening"}]
4. after 30 same-state snapshots (edge-trigger check): 2 declarations total
5. after stop: [...,{"active":false,"detail":"idle"}]
6. unknown verb survived, calls unchanged: 3
7. after teardown, __muxtermDesktop present: false
8. unwrapped: __muxtermDesktop present: false | teardown callable: true
9. version mismatch: __muxtermDesktop present: false
```

Line 4 is the one worth noting: thirty snapshots at the same state produced zero extra IPC calls, so
the level-meter tick cannot leak onto the bridge. Lines 8 and 9 are the degrade-to-browser guarantee.

### What is NOT built

The Rust side — `main.rs`, the tray builder, the `declare_voice_state` command, the platform
assertion module. It cannot be compiled here, and shipping unverified Rust in a design document
invites someone to trust it. The design above specifies it precisely enough to write; writing it is
step 1 of D5.

---

# Sources

Fetched 2026-09-08 unless noted.

**Platform behaviour**
- [Windows application lifecycle](https://learn.microsoft.com/en-us/windows/uwp/launch-resume/app-lifecycle)
- [Quality of Service (Windows)](https://learn.microsoft.com/en-us/windows/win32/procthread/quality-of-service)
- [SetThreadExecutionState](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate)
- [Prepare software for modern standby](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/prepare-software-for-modern-standby)
- [App Nap](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/AppNap.html) · [Work when visible](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/WorkWhenVisible.html) · [Prioritize work at the app level](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/PrioritizeWorkAtTheAppLevel.html)
- [IOPMLib.h](https://github.com/opensource-apple/IOKitUser/blob/master/pwr_mgt.subproj/IOPMLib.h) · [AVCaptureDevice.requestAccess](https://developer.apple.com/documentation/avfoundation/avcapturedevice/requestaccess(for:completionhandler:))
- [systemd inhibitor locks](https://systemd.io/INHIBITOR_LOCKS/) · [logind.conf](https://www.freedesktop.org/software/systemd/man/latest/logind.conf.html)
- [Windows camera, microphone and privacy](https://support.microsoft.com/en-us/windows/windows-camera-microphone-and-privacy-a83257bc-e990-d54a-d212-b5e41beba857)

**Engines**
- [Heavy throttling of chained JS timers beginning in Chrome 88](https://developer.chrome.com/blog/timer-throttling-in-chrome-88) (2021-01-18)
- Chromium `main`: [media_stream_track_impl.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/mediastream/media_stream_track_impl.cc) · [child_process_launcher.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/child_process_launcher.cc) · [media_web_contents_observer.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/media/media_web_contents_observer.cc) · [content_switches.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/public/common/content_switches.cc) · [visibility.h](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/public/browser/visibility.h)
- WebKit `main`: [Page.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/Page.cpp) · [WebPageProxy.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/WebPageProxy.cpp) · [WebViewImpl.mm](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/mac/WebViewImpl.mm)
- [WKPreferences.InactiveSchedulingPolicy](https://developer.apple.com/documentation/webkit/wkpreferences/inactiveschedulingpolicy-swift.enum) (macOS 14.0+, iOS 17.0+) · [WKUIDelegate requestMediaCapturePermissionFor](https://developer.apple.com/documentation/webkit/wkuidelegate/webview(_:requestmediacapturepermissionfor:initiatedbyframe:type:decisionhandler:)) (macOS 12.0+)
- [CoreWebView2.TrySuspendAsync](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.trysuspendasync) · [CoreWebView2Controller.IsVisible](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2controller.isvisible) · [WebView2 distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)
- [WebView2Feedback#1172](https://github.com/MicrosoftEdge/WebView2Feedback/issues/1172) — background throttling, **open since 2021-04-10**, no fix as of 2025-02-15

**Tauri / wry**
- [Config schema 2.11.5](https://schema.tauri.app/config/2) · [Prerequisites](https://tauri.app/start/prerequisites/) · [Capabilities](https://v2.tauri.app/security/capabilities/) · [Permissions](https://v2.tauri.app/security/permissions/) · [System tray](https://tauri.app/learn/system-tray/) · [Global shortcut plugin](https://tauri.app/plugin/global-shortcut/)
- Source read at tag: [`wry-v0.55.1` wkwebview UI delegate](https://github.com/tauri-apps/wry/blob/wry-v0.55.1/src/wkwebview/class/wry_web_view_ui_delegate.rs) · [`wry-v0.55.1` webkitgtk](https://github.com/tauri-apps/wry/blob/wry-v0.55.1/src/webkitgtk/mod.rs) · [`wry-v0.55.1` webview2](https://github.com/tauri-apps/wry/blob/wry-v0.55.1/src/webview2/mod.rs) · [`tauri-v2.11.5` tauri-runtime-wry](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri-runtime-wry/src/lib.rs)
- Issues: [wry#85](https://github.com/tauri-apps/wry/issues/85) (open, 2020) · [wry#1195](https://github.com/tauri-apps/wry/issues/1195) (open) · [wry#1654](https://github.com/tauri-apps/wry/pull/1654) (merged 2026-06-11) · [tauri#5042](https://github.com/tauri-apps/tauri/issues/5042) · [tauri#8314](https://github.com/tauri-apps/tauri/issues/8314) · [tauri#8606](https://github.com/tauri-apps/tauri/issues/8606) (open) · [tauri#5250 comment](https://github.com/tauri-apps/tauri/issues/5250#issuecomment-2569380578)
- [Tauri vs Electron measurements](https://www.gethopp.app/blog/tauri-vs-electron) (2025-04-09, N=1, author-disclaimed)

**In-repo**
- `web/src/lib/voice-session-controller.ts:509-528` — the unmuted `<audio>` sink and its crbug 40094084 comment
- `web/src/lib/voice-session-controller.ts:688-696` — `voiceSessionController`'s exported surface, which satisfies the bridge's `VoiceControl` structurally
