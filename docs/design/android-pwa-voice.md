# Android PWA voice with the screen off

**Question:** can muxterm, installed as a PWA on Android, hold a two-way realtime voice
conversation while the phone's screen is off?

**Answer: no. NO-GO on the pure-PWA approach.** Not because of one missing API but because
of four independent blocks, any one of which is sufficient on its own. The smallest thing
that would work is a native Android app that hosts the web UI *in its own process* and runs
a `microphone`-typed foreground service — and the obvious candidate for that, a Trusted Web
Activity, **does not work either**, for a reason worth reading before anyone budgets for it.

What *is* achievable on the web today is a voice session that survives the phone being idle
with the **screen on**, held there by a screen wake lock. That is a different product than
the one the question asks about, and it should be named as such rather than shipped as if it
were the same thing.

Everything below is dated **2026-09-07**. Chrome feature defaults are Finch-controlled and
Chromium source is a moving target; re-check before acting on this six months from now.
Each claim is tagged **[SPEC]**, **[CHROME-ANDROID]** (Chromium source or Google
documentation), **[ANDROID]** (Android platform documentation), **[MEASURED]** (observed in
this work), or **[INFERENCE]**.

Companion deliverable: [`android-voice-probe/`](./android-voice-probe/index.html) — an
installable, instrumented page that measures on a real phone the handful of things
documentation genuinely cannot settle. See [What the probe settles](#what-the-probe-settles).

---

## The short version

```
service worker cannot host audio  ─┐
screen wake lock dies when hidden ─┤
Android silences a background mic ─┼──> pure PWA: NO-GO
  and never tells the page         │
WebAPK cannot run a foreground svc ┘
```

The load-bearing one is the third. The others are merely also fatal.

---

## What muxterm does today

muxterm's realtime voice (`web/src/lib/voice-session-controller.ts`, shipped in v0.23.0) is
WebRTC. `getUserMedia` opens a microphone, `RTCPeerConnection` carries it to the vendor, and
the inbound assistant audio arrives as a remote `MediaStreamTrack` that is attached to an
`<audio>` element via `srcObject` and played. Turn detection is server VAD with
`interrupt_response: true`.

So the screen-off case is **two simultaneous things** — an open microphone capture and
continuous inbound audio playback — and they turn out to be governed by entirely different
rules. The playback half is in reasonable shape. The capture half is what kills it.

---

## R1 — Service workers and audio

**VERDICT: ANSWERED. A service worker cannot hold a peer connection, cannot call
`getUserMedia`, and cannot use Web Audio. Any plan built on service-worker audio is built on
nothing.**

This needs saying first and unambiguously, because it is the design people reach for.

| Capability | In a service worker | Evidence |
| --- | --- | --- |
| `navigator.mediaDevices` | **absent** | A worker's `navigator` is a `WorkerNavigator`, which has no `mediaDevices` member. [SPEC] |
| `getUserMedia()` | **unreachable** | Defined on `MediaDevices`, which is `[Exposed=Window, SecureContext]`. [SPEC] |
| `RTCPeerConnection` | **unreachable** | `[Exposed=Window]`. The only worker-exposed WebRTC type is `RTCDataChannel`, and that is `DedicatedWorker` only. [SPEC] |
| `AudioContext` / `OfflineAudioContext` | **unreachable** | All `[Exposed=Window]`; both constructors additionally require a fully active `Document`, which a service worker categorically lacks. [SPEC] |
| `AudioWorklet` | **not an escape hatch** | `[Exposed=Window]` and reachable only via `BaseAudioContext.audioWorklet`. [SPEC] + [INFERENCE from the IDL graph] |

- Media Capture and Streams, §9.2 and the `Navigator` extensions:
  <https://www.w3.org/TR/mediacapture-streams/#mediadevices> (checked 2026-09-07)
- `WorkerNavigator` IDL, HTML Standard §10.3.2:
  <https://html.spec.whatwg.org/multipage/workers.html#the-workernavigator-object> (checked 2026-09-07)
- WebRTC 1.0 (W3C Recommendation, 2025-03-13), §4.4.2:
  <https://www.w3.org/TR/webrtc/#interface-definition> (checked 2026-09-07)
- Web Audio API IDL: <https://webaudio.github.io/web-audio-api/#BaseAudioContext> (checked 2026-09-07)
- Blink matches the spec on all of the above — e.g. `[Exposed=Window]` in
  `third_party/blink/renderer/modules/mediastream/media_devices.idl` and
  `.../peerconnection/rtc_peer_connection.idl`. [CHROME-ANDROID]

This is not an oversight awaiting a fix. The Web Audio WG **formally resolved not to pursue
it** at TPAC 2023, closing w3c/WebAudio#2383 with: *"The WG will not pursue this.
ServiceWorker has nothing to do with audio playback and processing"* and *"the lifetime of
ServiceWorker and how it interacts with BaseAudioContext needs to be clearly defined … this
line of work is outside the scope of the current charter."*
(<https://github.com/WebAudio/web-audio-api/issues/2383>, checked 2026-09-07). The parallel
request to expose `RTCPeerConnection` to workers (w3c/webrtc-pc#3131, opened 2026-07-29) is
open, unresolved, and **explicitly excludes service workers on lifetime grounds**.

Lifetime is the deeper reason. Chrome terminates a service worker after **30 seconds idle**
(`kServiceWorkerDefaultIdleDelayInSeconds = 30`) and caps any single event at **5 minutes**
(`kRequestTimeout` / `kEventTimeout`), 90 seconds for `push`. [CHROME-ANDROID] A service
worker is an event-scoped host; a conversation is not an event.

Nor can a service worker keep a *page* alive. Its entire client-facing surface is `Clients`
(`get` / `matchAll` / `openWindow` / `claim`) plus `WindowClient.focus()` / `.navigate()`,
and `openWindow()` itself requires transient activation. There is no unfreeze, no keep-alive,
no resume. [SPEC] What exists instead — Background Sync, Periodic Background Sync, Web Push —
delivers *events to the worker*, and none of them touches a page's audio. Periodic Background
Sync is additionally installed-PWA-only, site-engagement-gated, and fires on a schedule Chrome
picks. [CHROME-ANDROID]

> **Measured on this device, not asserted:** the probe asks its own service worker which audio
> APIs exist in `ServiceWorkerGlobalScope` and prints the answer in the report. In the
> verification run: `getUserMedia=false, RTCPeerConnection=false, AudioContext=false,
> mediaDevices=false` — against `fetch=true, indexedDB=true, push=true`. [MEASURED]

muxterm already ships a service worker (see R7). It is the right service worker for what a
service worker is for. It is not, and cannot become, part of a voice session.

---

## R2 — Wake locks

**VERDICT: ANSWERED. The web platform exposes exactly one wake lock type, `"screen"`. It is
released the instant the document becomes hidden, cannot be acquired while hidden, and is
explicitly not applicable once the user switches the screen off. No web API reaches an Android
partial (CPU) wake lock.**

**One type, and only one.**
`enum WakeLockType { "screen" };` — Screen Wake Lock API §10,
<https://www.w3.org/TR/screen-wake-lock/#the-wakelocktype-enum> (checked 2026-09-07). [SPEC]
The interface is `[SecureContext, Exposed=(Window)]` — not workers, not service workers.

There *was* a second type. `"system"` was removed on **2020-03-25** in commit "Convert to
purely screen wake lock (#255)", whose message says *"We will move system lock to a new
spec."* That spec was never produced, and **there is no Chrome Platform Status entry for a
system wake lock** — the registry contains only Screen Wake Lock (Chrome 84, desktop and
Android), `WakeLockSentinel.released` (87), and the optional-`type` change (88).
(<https://github.com/w3c/screen-wake-lock/commit/59d8d392af34bf3ac6b1e9ae971ecc28e43c858a>,
<https://chromestatus.com/feature/4636879949398016>, checked 2026-09-07)

Chromium still carries residual `"system"` plumbing, but it is behind the `experimental`
`SystemWakeLock` runtime flag and exposed only to `DedicatedWorker`; in shipping Chrome
`navigator.wakeLock.request("system")` throws `TypeError`. Do not describe it as a
capability. [CHROME-ANDROID]

**It dies when the page hides.** The spec's own algorithm, §11.3:

> Run these page visibility change steps: 1. If *state* is not `"hidden"`, abort these steps.
> 2. For each *lock* in `document.[[ActiveLocks]]["screen"]`: run **release a wake lock**.

And §"Managing wake locks", normatively:

> **The screen wake lock MUST NOT be applicable after the screen is manually switched off by
> the user until it is switched on again.**

Blink implements exactly this (`WakeLock::PageVisibilityChanged()` clears the locks).
Chrome's own documentation says the same in plain terms: *"the screen wake lock is
automatically released when you minimize a tab or window, or switch away…"*
(<https://developer.chrome.com/docs/capabilities/web-apis/wake-lock>, checked 2026-09-07)

**It cannot be re-acquired while hidden.** `request()` checks visibility twice — once
synchronously, once after the permission check resolves — and rejects with `NotAllowedError`
both times. [SPEC]

> **Measured:** in headless Chrome (which reports `visibilityState: "hidden"`), the probe's
> wake lock request is refused with exactly
> `NotAllowedError — Failed to execute 'request' on 'WakeLock': The requesting page is not visible`.
> The spec text and the shipped behaviour agree. [MEASURED]

**Android's native locks are out of reach.** Android's only non-deprecated CPU-holding level
is `PARTIAL_WAKE_LOCK`; the deprecated screen levels all defer to `FLAG_KEEP_SCREEN_ON`.
[ANDROID] No web API reaches any of them. Worth knowing precisely *why*: Chromium's wake-lock
taxonomy has a `kPreventAppSuspension` type used for audio playback
(`MediaWebContentsObserver::GetAudioWakeLock()`, reason `kAudioPlayback`, description
`"Playing audio"`) — but the **Android implementation of that type is an empty constructor**:

```cpp
PowerSaveBlocker::PowerSaveBlocker(...) : delegate_(ui_task_runner) {
  // Don't support PreventAppSuspension.
}
```
— `services/device/wake_lock/power_save_blocker/power_save_blocker_android.cc` [CHROME-ANDROID]

On Android the only functional path is `kPreventDisplaySleep`, implemented as
`View.setKeepScreenOn(true)`. So **Chrome on Android does not take a native CPU wake lock on
behalf of a page playing audio.** Whatever keeps a backgrounded Chrome tab's audio alive on
Android, it is not that.

**Consequence for muxterm:** the screen wake lock is genuinely useful for keeping a session
alive while the user is *looking* at the phone. It contributes exactly nothing once the screen
is off, by design and by normative text.

---

## R3 — Background and screen-off lifecycle on Android Chrome

**VERDICT: ANSWERED. A hidden page on an Android phone is frozen by default. The one
exemption that matters is being *audible* — and an open microphone does **not** confer it.
Screen-off is materially different from tab-backgrounding, and Chrome has just started
wiring an explicit screen-off → suspend-WebRTC path.**

### The states and the thresholds

Page Lifecycle defines FROZEN and DISCARDED on top of Page Visibility, with `freeze` /
`resume` events and `document.wasDiscarded`
(<https://wicg.github.io/page-lifecycle/>, Draft Community Group Report, 2022-06-09 — note
the weak status). Frozen means *"any tasks associated with the document will not run"*;
freezing also **pauses every media element on the page**. Discarded means *"no tasks, event
callbacks, or JavaScript of any kind can run."* [SPEC]

Timer throttling has three tiers — minimal, 1/second, and intensive 1/minute after 5 minutes
hidden with chain count ≥ 5 and 30 seconds of silence
(<https://developer.chrome.com/blog/timer-throttling-in-chrome-88>, checked 2026-09-07;
constants confirmed in `page_scheduler_impl.{h,cc}`). [CHROME-ANDROID]

But on Android the throttling tiers are mostly moot, and Chromium says so itself:

```cpp
// The base::Feature is enabled by default on all platforms. However, on
// Android, it has no effect because page freezing kicks in at the same time.
BASE_FEATURE(kIntensiveWakeUpThrottling, base::FEATURE_ENABLED_BY_DEFAULT);
```
— `third_party/blink/common/features.cc` [CHROME-ANDROID]

Freezing is the operative mechanism, and it is **on by default on Android phones**:

```cpp
BASE_FEATURE(kStopInBackground, "stop-in-background",
#if BUILDFLAG(IS_ANDROID) && !BUILDFLAG(IS_CAST_ANDROID) && !BUILDFLAG(IS_DESKTOP_ANDROID)
             base::FEATURE_ENABLED_BY_DEFAULT
#else
             base::FEATURE_DISABLED_BY_DEFAULT
#endif
);
```
— same file. Note the Cast carve-out and its reason: *"Disable this for Chromecast on Android
builds to prevent apps that play audio in the background from stopping."* That is Chromium
stating, in a comment, that this feature stops background audio. [CHROME-ANDROID]

The freeze deadline is `kDefaultDelayForBackgroundTabFreezing = base::Minutes(1)` in source,
while a neighbouring comment and the WICG spec both say 5 minutes, and the real value ships
via the Finch parameter `DelayForBackgroundTabFreezingMills`. **Treat the freeze deadline as
somewhere between 1 and 5 minutes, server-controlled, not knowable from source.**

### The exemption that matters — and the one that does not

This is the crux, so here it is exactly:

```cpp
bool PageSchedulerImpl::IsBackgrounded() const {
  return !IsPageVisible() && !IsAudioPlaying() && !main_thread_scheduler_->IsVirtualTimeEnabled();
}
bool PageSchedulerImpl::IsAudioPlaying() const {
  return audio_state_ == AudioState::kAudible || audio_state_ == AudioState::kRecentlyAudible;
}
```
— `page_scheduler_impl.cc`; freezing only happens inside `if (IsBackgrounded())`.
`kRecentlyAudible` persists for `kRecentAudioDelay = base::Seconds(30)` after sound stops.
[CHROME-ANDROID]

So the freeze exemption is **audibility, and nothing else**. Meanwhile, a live
`MediaStreamTrack` registers `SchedulingPolicy::DisableAggressiveThrottling` — which exempts
it from *intensive throttling* and from nothing else:

| Page condition (hidden, Android phone, defaults) | 1 s throttle | intensive 1/min | **freeze** | discard |
| --- | --- | --- | --- | --- |
| audible (playing sound out) | exempt | exempt | **exempt** | protected (`kAudible`) |
| live `getUserMedia` mic track, silent | applies | exempt | **NOT exempt** | protected (`kCapturingAudio`) |
| open `RTCDataChannel` | applies | exempt | **NOT exempt** | — |
| bare `RTCPeerConnection` | applies | **NOT exempt** | NOT exempt | — |
| `WebSocket` only | applies | **NOT exempt** | NOT exempt | — |

Sources: `media_stream_track_impl.cc`, `rtc_data_channel.cc`, `rtc_peer_connection.cc`,
`websocket_channel_impl.cc`, `page_scheduler_impl.cc`, `cannot_discard_reason.h`,
`discard_eligibility_policy.cc`. [CHROME-ANDROID]

Two corrections to widespread belief fall out of that table. **A WebSocket buys no throttling
exemption at all** — it registers only `DisableBackForwardCache`. And **a bare
`RTCPeerConnection` buys none either**; web.dev's "WebRTC is in use" is accurate in effect but
imprecise in mechanism — it is the live *track* or open *data channel* that registers the
opt-out.

For muxterm the good news is real: continuously playing inbound assistant audio should make
the page audible and therefore exempt from freezing. That is **[INFERENCE]** — Chrome's
`AudioStreamMonitor` monitors *"the audible state of audio output streams"* generically and
carves out nothing for MediaStream, but no source states it for WebRTC specifically. The probe
measures it directly, via the audio clock.

### Screen-off is not the same as backgrounding

Two mechanisms distinguish them, both Android-specific:

1. **App-state teardown.** `VideoCaptureManager::OnApplicationStateChange` releases capture
   devices on `APPLICATION_STATE_HAS_STOPPED_ACTIVITIES`, with the comment: *"the device is
   only stopped when Chrome is sent to background and not when, e.g., a tab is hidden."*
   Critically, `ReleaseDevices()` filters to `DEVICE_VIDEO_CAPTURE` — **it is camera-only, and
   there is no microphone equivalent anywhere in the audio input path.** (I looked:
   `audio_input_device_manager.cc` and `audio_manager_android.cc` contain no
   `ApplicationState` references at all.) [CHROME-ANDROID]

2. **An explicit screen-off hook, landed 2026-08-21** — three weeks before this was written,
   and covered by no blog post or MDN page:

   ```cpp
   // Android does not provide an API for apps to be notified of system suspend...
   // As a workaround, we use the SCREEN_OFF event as a proxy to trigger
   // WebRTC suspend, ensuring hardware resources are released.
   void PeerConnectionTrackerHost::OnScreenOff() { OnSuspend(); }
   ```
   Gated on `kAndroidSuspendWebRtcOnScreenOff`, `FEATURE_DISABLED_BY_DEFAULT`, force-enabled
   under `BUILDFLAG(IS_DESKTOP_ANDROID)`. The CL message: *"This ensures that WebRTC properly
   closes its peer connections before the device goes to sleep."*
   (<https://chromium-review.googlesource.com/c/chromium/src/+/8260535>, checked 2026-09-07)
   [CHROME-ANDROID]

   It is off on phones **today**. It is a Finch flag, and it names the direction of travel:
   Chrome is building toward *closing* WebRTC connections on screen-off, not preserving them.
   Any plan that depends on today's default is depending on a server-side switch someone else
   owns.

> **Measured, on desktop Chrome 152:** across a deliberate 5-second `Page.setWebLifecycleState:
> frozen`, the probe recorded `audioOverWall: 0.204` — the AudioContext clock advanced only
> 20.8% of wall clock. **A frozen page's audio graph stops rendering**, and the media element
> was paused (`audio.pause` on `streamEl` immediately after `resume`), consistent with the
> Page Lifecycle freeze steps' "execute media pause on element". Freezing is not merely a
> pause in JavaScript; it silences the page. [MEASURED]

Discarding is the one place the microphone earns real protection: `kCapturingAudio` is an
explicit `CannotDiscardReason`, and on Android that maps a protected page to
`ChildProcessImportance::NOT_PERCEPTIBLE` rather than `NORMAL`, ranking it above ordinary
background tabs for the low-memory killer. That is a ranking, not a guarantee.
[CHROME-ANDROID]

---

## R4 — Microphone capture while hidden

**VERDICT: ANSWERED, and this is the block that decides the question. The spec permits an
already-running capture to continue while hidden. Android's platform policy then silences it,
because Chrome on a phone does not run a microphone foreground service — and the page is
never told, because Chrome's `mute` event on Android is wired to the OS mic-mute toggle, not
to Android's "capture silenced" signal.**

### The spec permits it. That is not the constraint.

Media Capture and Streams does **not** mandate muting on hidden. For camera and microphone
sources *"the reasons to mute are implementation-defined."* [SPEC]

There is an asymmetry worth internalising: *continuing* a capture while hidden is permitted;
*starting* one is not. The `getUserMedia()` algorithm performs an **"is in view"** check and
normatively *waits* — it does not reject — until the document becomes visible.
(<https://w3c.github.io/mediacapture-main/>, checked 2026-09-07) Chrome's user-facing
documentation states the consequence: *"If you're using a different Chrome tab or a different
app, a site can't start recording."*
(<https://support.google.com/chrome/answer/2693767>, checked 2026-09-07)

The spec even sanctions stopping on screen-off, non-normatively: best practice is to mute a
capture on *"an OS-level event for which the User Agent already suspends media playback
globally, but JavaScript is not suspended."*

### What Chrome shows, and what it does not run

While a page captures, Chrome on Android posts an **ongoing** notification — *"A site is
using your microphone"* / *"Tap to return to \<url\>"*, on the "Camera and microphone use"
channel, `setOngoing(true)`, `setAutoCancel(false)`, and — for microphone-only — with **no
Stop button** (`isCapture()` deliberately excludes `AUDIO_ONLY`). [CHROME-ANDROID]

Chrome fully declares the machinery for a real foreground service:

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
<uses-permission android:name="android.permission.RECORD_AUDIO"/>
<service android:name="...MediaCaptureNotificationService"
    android:foregroundServiceType="camera|microphone|mediaProjection|mediaPlayback"
    android:exported="false"/>
```

**And then gates it off on phones:**

```java
if (isBackgroundMediaCapturingEnabled()) {
    startOrUpdateForegroundService(notificationId, notification);
} else {
    mNotificationManager.notify(notification);   // <- a plain notification. No FGS.
}
```
— `MediaCaptureNotificationServiceImpl.java`, where `isBackgroundMediaCapturingEnabled()` reads
`ANDROID_ENABLE_BACKGROUND_MEDIA_CAPTURING`. That feature is
`FEATURE_DISABLED_BY_DEFAULT` and force-enabled only here:

```cpp
#if BUILDFLAG(IS_DESKTOP_ANDROID)
  // TODO(crbug.com/426461170): Remove once we enable this feature for all form
  // factors. Currently we have no conclusion whether to enable this on mobile
  // phones yet.
  feature_overrides.EnableFeature(media::kAndroidEnableBackgroundMediaCapturing);
```
— `chrome/browser/chrome_browser_field_trials.cc` [CHROME-ANDROID]

**"Currently we have no conclusion whether to enable this on mobile phones yet."** Written by
the Chromium team, current in `main` today. Background media capturing on Android phones is an
explicitly unresolved product question, defaulted off.

### What Android does to a background app holding a microphone

> *"Android 9: only apps running in the foreground (or a foreground service) could capture the
> audio input. When an app without a foreground service or foreground UI component started to
> capture, **the app continued running but received silence**, even if it was the only app
> capturing audio at the time."*
> — <https://developer.android.com/media/platform/sharing-audio-input> (checked 2026-09-07) [ANDROID]

> *"Apps with visible foreground UIs have higher priority than background apps… When two apps
> are capturing concurrently, only one app receives audio and the other gets silence."*
> — same page. And note that microphone input is **not** governed by audio focus at all; it is a
> separate automatic prioritisation policy. [ANDROID]

Chain it: screen off → Chrome has no visible activity → Chrome is a background app → Chrome
holds a microphone with **no microphone foreground service** → Android's documented behaviour
is *keeps running, receives silence*. **[INFERENCE]**, but every link is documented.

### And the page is never told

Chrome's `MediaStreamTrack.muted` on Android is wired to the OS microphone-mute flag:

```cpp
bool OpenSLESInputStream::IsMuted() { return audio_manager_->IsMicrophoneMuted(); }
```

Android's own notification channel for "capture silenced" is
`AudioManager.AudioRecordingCallback`. A Gerrit search for `AudioRecordingCallback` returns
**zero CLs**. Nothing wires it to `MediaStreamTrack.muted`. [CHROME-ANDROID]

**Predicted state during the failure: `readyState: "live"`, `muted: false`, `enabled: true` —
and all-zero samples.** No `mute` event. No `ended` event. No error. The page believes it is
listening. Server VAD, receiving digital silence, never detects a turn. The conversation does
not fail; it simply stops being a conversation, silently, with the orb still lit.

That is the single most important sentence in this document, and it is the reason the probe
counts *frames* and *non-silent frames* separately rather than trusting `muted`.

### Tab versus installed PWA

**UNANSWERABLE from documentation as a documented distinction — but the source strongly
indicates there is none on phones.** No documented statement exists either way; the Chromium
issue tracker is not anonymously searchable (HTTP 401 on search, `IamPermissionDeniedException`
on the referenced bug IDs), so a bug thread cannot be ruled out. See R6 for why the structural
evidence points to "no difference", and note that this is precisely the sort of thing the
probe exists to settle empirically.

### Audio focus loss

There is **no web-exposed audio-focus event**. Chrome maps `AUDIOFOCUS_LOSS` and
`AUDIOFOCUS_LOSS_TRANSIENT` alike to `MediaSession::Suspend(SuspendType::kSystem)`, and the
`pause` action handler is routed **only** for `SuspendType::kUI`:

```cpp
void MediaSessionImpl::Suspend(SuspendType suspend_type) {
  if (suspend_type == SuspendType::kUI) {
    if (ShouldRouteAction(MediaSessionAction::kPause)) { DidReceiveAction(kPause); return; }
  }
  OnSuspendInternal(suspend_type, State::SUSPENDED);
}
```

The only signal a page gets is a plain `pause` event on the media element. Ducking is applied
below the element as a volume multiplier and is entirely invisible to JavaScript. [CHROME-ANDROID]
The Media Session spec acknowledges the gap and defers to an "AudioFocus API" that never
shipped. [SPEC] And per R5, muxterm's `srcObject` element does not even get the `pause`.

---

## R5 — Media Session and audio focus

**VERDICT: ANSWERED. For a `MediaStream` played via `srcObject` — which is exactly what
muxterm does — the Media Session API gives you nothing. Chrome classifies it
`MediaContentType::kOneShot`: it takes Android audio focus, gets no media notification, no
lock-screen controls, no `mediaPlayback` foreground service, and never responds to focus loss.**

The spec surface is broad — `metadata`, `playbackState`, 17 actions, `setPositionState()`,
`setMicrophoneActive()` / `setCameraActive()`. Chrome on Android renders **seven** of those
actions in its notification (`play`, `pause`, `stop`, `previoustrack`, `nexttrack`,
`seekforward`, `seekbackward`); the conferencing actions — `togglemicrophone`, `togglecamera`,
`hangup` — reach no Android surface at all. [CHROME-ANDROID]

But none of that matters, because a media notification requires the session to be
**controllable**, and a `MediaStream` never is:

```cpp
// TODO(perkj, magjed): We use OneShot focus type here so that it takes
// audio focus once it starts, and then will not respond to further audio
// focus changes. See https://crbug.com/596516 for more details.
client_->DidMediaMetadataChange(..., media::MediaContentType::kOneShot, ...);
```
— `third_party/blink/renderer/modules/mediastream/web_media_player_ms.cc`. Every code path in
that file emits `kOneShot`; there is no other. [CHROME-ANDROID]

```cpp
bool MediaSessionImpl::IsControllable() const {
  if (audio_focus_state_ == State::INACTIVE || HasOnlyOneShotPlayers()) return false;
  ...
}
void MediaSessionImpl::OnSuspendInternal(...) {
  if (HasOnlyOneShotPlayers()) return;   // <- ignores audio focus loss entirely
  ...
}
```

And on Android, `MediaSessionHelper.mediaSessionStateChanged(isControllable, …)` hides the
notification whenever `!isControllable`. Note also that the desktop escape hatch — where
setting `navigator.mediaSession.playbackState` can make a session controllable — is
`#if !BUILDFLAG(IS_ANDROID)`, i.e. compiled out on Android. [CHROME-ANDROID]

Net behaviour for `audioEl.srcObject = remoteStream`:

| | |
| --- | --- |
| Takes Android audio focus (`AUDIOFOCUS_GAIN`)? | **yes** — so it stomps other apps' audio |
| Media notification / lock-screen controls? | **no** |
| `setActionHandler` handlers ever fire? | **no** (no platform UI exists for it) |
| Paused when another app takes focus? | **no** — so not even the `pause` event |
| `mediaPlayback` foreground service? | **no** |

That last row is the consequential one. When a page has a *controllable* media session, Chrome
runs `ChromeMediaNotificationControllerServices$PlaybackListenerService` with
`foregroundServiceType="mediaPlayback"`, and **that foreground service is what keeps the Chrome
process alive for background audio.** [CHROME-ANDROID] The chain "audible → persistent →
Gain focus → media notification → `mediaPlayback` FGS → process kept alive" is the real reason
background audio works on Android — and a `srcObject` stream gets none of it. **[INFERENCE]**
for the chain as a causal story; each link is source-verified.

There is an undocumented workaround implied by the source: adding a *second*, normal
`<audio src>` player to the same tab makes `normal_players_` non-empty, `HasOnlyOneShotPlayers()`
false, and the session controllable. **I do not recommend it** — see the open decisions. The
probe can test it (the "Run 2" checkbox) so the decision can be made on evidence rather than
on my reading of Chromium.

---

## R6 — The installed-PWA boundary

**VERDICT: ANSWERED. Installing as a WebAPK changes the icon, the task, the intent filters and
the chrome — and changes nothing about throttling, freezing, discarding, microphone lifetime,
or wake locks. An installed PWA categorically cannot run an Android foreground service. The
smallest wrapper that could is NOT a Trusted Web Activity.**

A WebAPK ships **no engine and no web code**. Its generated manifest declares launcher, splash
and share activities, plus exactly two bound IPC services, and exactly two permissions:

```xml
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.REORDER_TASKS" />
```

No `FOREGROUND_SERVICE`. No `FOREGROUND_SERVICE_MICROPHONE`. No `RECORD_AUDIO`. Neither
declared service has a `foregroundServiceType`. The manifest is a Chrome-controlled mustache
template in which a site can substitute only *values* (`start_url`, `scope`, `display_mode`,
orientation, colours, icons, share-target) — there is no field that injects a `<service>`, a
`foregroundServiceType`, or a `<uses-permission>`.
(`chrome/android/webapk/shell_apk/AndroidManifest.xml`, checked 2026-09-07) [CHROME-ANDROID]
And no web API starts an Android service. **[INFERENCE]** from absence across spec/MDN/BCD.

Under Android 14+, calling `startForeground()` without the matching permission throws
`SecurityException`, and creating a `microphone`-typed service requires `RECORD_AUDIO` held
*while in use* — meaning it **cannot be started from the background at all**. [ANDROID]

Why the installed/tab distinction changes nothing: the page runs in the same Chrome renderer
(`WebappActivity` / `SameTaskWebApkActivity` are declared in *Chrome's* manifest), on the same
profile, under the same `PageScheduler`. The scheduling and freezing code takes no input
describing installedness or display mode — `page_scheduler_impl.cc` has zero references to
display mode, standalone, or WebAPK, and `CannotFreezeReason` has no such value. This is
**[INFERENCE]** from absence, with one strong corroborating signal: the one place Chromium
*did* build a PWA-specific protection, it deliberately excluded Android —

```cpp
#if !BUILDFLAG(IS_ANDROID)
  // Do not discard Desktop PWA windows. Preserve native-app experience.
  ... CannotDiscardReason::kWebApp ...
#endif  // !BUILDFLAG(IS_ANDROID)
```
— `discard_eligibility_policy.cc` [CHROME-ANDROID]

### The smallest thing that would work — and the trap

The obvious candidate is a **Trusted Web Activity**. It is the wrong answer, and it is worth
understanding why before anyone spends a sprint on it.

A TWA's web content is rendered **by the user's Chrome, in Chrome's process**. Your host APK
is a separate app with its own process. So your foreground service cannot cover the web page's
`getUserMedia` — the capture happens in Chrome, and Chrome's own
`MediaCaptureNotificationService` (gated off on phones, per R4) is what governs it. Chrome's
TWA documentation is explicit that *"the host app doesn't have direct access to web content in
a Trusted Web Activity or any other kind of web state"*, and that coordination happens only
through URLs and intents. **[INFERENCE]**, clearly labelled: no source states "a TWA's FGS
cannot cover the page's capture" in those words, but it follows directly from process
separation plus the documented lack of host↔content access. Treat "TWA + foreground service =
background microphone for my PWA" as **not demonstrated, and probably wrong.**

The smallest thing that *would* work is a **native app that hosts the UI in its own process** —
a `WebView` wrapper at minimum, or a native client. Then the capture is yours and your
`microphone` foreground service genuinely covers it.

**Honest cost:**

- It is no longer a PWA. It is an Android app: an APK/AAB, a signing key you must not lose,
  `targetSdk` bumps on Play's schedule, and either a Play listing (with foreground-service and
  `RECORD_AUDIO` declarations and prominent disclosure) or sideloading.
- Native Kotlin/Java: a `Service` with `foregroundServiceType="microphone"`, the
  `FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_MICROPHONE` / `RECORD_AUDIO` manifest entries, the
  runtime permission flow, a notification channel, and start-from-a-visible-activity sequencing
  (Android 12+ forbids starting a while-in-use FGS from the background; Android 15+ forbids
  requesting audio focus unless you are the top app or running an FGS).
- **WebView loses the Media Session API entirely** (`webview_android: false`,
  <https://crbug.com/40611412>), and is a different engine surface from Chrome for WebRTC,
  permissions and origin trials. You would own every gap.
- You must handle `WebChromeClient.onPermissionRequest` yourself, plus navigation, downloads,
  file upload.

**Recommendation: do not build it.** The cost is a native Android product; the benefit is one
feature that Chromium itself has an open, unresolved plan to enable
(`crbug.com/426461170`). Revisit if `kAndroidEnableBackgroundMediaCapturing` ships on phones —
at which point the pure PWA may simply start working.

---

## R7 — What muxterm already has, and already excludes

**VERDICT: ANSWERED.**

### The Android exclusion is about dictation, not about WebRTC

`web/src/lib/voice-input-controller.ts:79-86`:

```ts
/**
 * ...
 * Android is deliberately excluded because native keyboard dictation makes
 * the custom button redundant; this is a product decision, not a workaround.
 */
const _isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
const _ctor: SpeechRecognitionCtor | null = _isAndroid ? null : _resolveCtor();
```

It excludes exactly one thing: the **Web Speech API** `SpeechRecognition` constructor backing
the `<mux-mic-button>` dictation button in the mobile title bar. Setting `_ctor` to `null`
makes the button report itself unsupported and render nothing.

**That reasoning does not transfer to the realtime session.** They are different mechanisms
with different answers:

| | dictation (`voice-input-controller.ts`) | realtime (`voice-session-controller.ts`) |
| --- | --- | --- |
| Mechanism | Web Speech API `SpeechRecognition` | `getUserMedia` + `RTCPeerConnection` |
| Availability | not Baseline; MDN "Limited availability"; Edge/Opera unsupported, Firefox disabled by default | WebRTC is a W3C Recommendation, universally shipped |
| Why excluded on Android | the platform keyboard already does it better | **not excluded** — it runs on Android today |
| Relevant to screen-off | no | yes |

Anyone reading that comment and concluding "Android voice is handled" would be wrong. The
realtime session has no Android exclusion and needs none — it works. It just does not survive
the screen going off.

One incidental observation, recorded and **not acted on** (that file belongs to another lane):
the level meter in `voice-session-controller.ts` drives itself with `requestAnimationFrame`,
which does not fire on a hidden page. The meter therefore freezes when the page hides,
independently of everything above.

### muxterm already ships a manifest and a service worker

Both come from `vite-plugin-pwa` in `web/vite.config.ts`. There is no `manifest.webmanifest`
or `sw.js` in the tree; they are build outputs.

**Manifest** (`VitePWA({ manifest: … })`): `name`/`short_name` `muxterm`, `id`/`start_url`/`scope`
`/`, `display: standalone`, `orientation: any`, `background_color` and `theme_color` `#1a1b26`,
and three icons — 192, 512, and a 512 `maskable`. It meets Chrome's installability criteria.
`internal/server/server.go:27-30` adds the `.webmanifest` → `application/manifest+json` MIME
mapping that Go's `mime` package lacks.

**Service worker** (`VitePWA({ workbox: … })`): `registerType: 'autoUpdate'`,
`globPatterns: []` (**precaches nothing**), `navigateFallback: null` (deliberately kept out of
navigations so a deploy is never masked by a cached `index.html`), `cleanupOutdatedCaches: true`.
Registration is hand-rolled in `web/src/lib/sw.ts` rather than injected, and is **skipped
unless the app is mounted at the origin root** — so a `/t/<id>/` tunnel never leaves behind a
per-tunnel registration. Its own comment says the worker exists "for PWA installability … and
will be used for browser-tab notification features."

That is a correct, minimal service worker. Per R1, nothing about voice can or should change it.

Finally: **muxterm sets no `Permissions-Policy`, `Feature-Policy`, or CSP headers** (verified
by grep across `internal/`). The default allowlist for both `microphone` and `screen-wake-lock`
is `'self'`, which is what a same-origin page needs. Nothing is being blocked at the header
level, and nothing needs adding. [MEASURED]

---

## Why this is a NO-GO, in one chain

1. The audio must live in the page; a service worker cannot host any part of it. **[R1, SPEC]**
2. A hidden page on an Android phone is frozen by default, ~1–5 minutes in, Finch-controlled.
   Freezing pauses media elements and — measured here — stops the audio graph. **[R3]**
3. Continuous inbound audio *probably* exempts the page from freezing, because the exemption is
   audibility. **[R3, INFERENCE — the probe measures it]**
4. But the microphone half fails regardless. With the screen off Chrome is a background app
   holding a capture with no microphone foreground service — because
   `kAndroidEnableBackgroundMediaCapturing` is off on phones by explicit, unresolved Chromium
   decision — and Android's documented response is to let it run and feed it **silence**. **[R4]**
5. The page is not told. `muted` tracks the OS mic-mute toggle, not Android's capture-silenced
   signal. `readyState` stays `"live"`. Server VAD hears digital silence and never fires. **[R4]**
6. Nothing available can prevent this. The only wake lock is `"screen"`, released the moment the
   page hides and un-acquirable while hidden. **[R2]** The Media Session API is inert for a
   `srcObject` stream, so no `mediaPlayback` foreground service is created. **[R5]**
7. Installing as a WebAPK changes none of it, and a WebAPK cannot run a foreground service.
   **[R6]**
8. And Chrome has begun wiring `ACTION_SCREEN_OFF` → close peer connections. Off on phones
   today; a Finch flag away. **[R3]**

**GO / NO-GO: NO-GO for screen-off two-way voice as a pure PWA.**

**GO, and worth doing, for screen-on voice held awake by a screen wake lock.** That is a real
capability, uses only shipped APIs, and is honest about what it is.

---

## What the probe settles

Four things above are inference or genuinely unanswerable from documentation. The probe
(`docs/design/android-voice-probe/`) measures each on a real phone:

| Open question | How the probe answers it |
| --- | --- |
| Does continuous playback actually exempt the page from freezing? **[R3]** | Heartbeat gaps plus the `freeze` event; and the AudioContext-clock-versus-wall-clock ratio across each gap, which shows whether audio kept rendering while JavaScript did not. |
| Does the microphone go silent, stop, or keep working? **[R4]** | An AudioWorklet on the audio thread counting total frames and non-silent frames separately — the only instrument that tells "capture stopped" from "capture delivered zeros". Plus a `mic.silenced` event that records `readyState` and `muted` at the moment silence begins, which is what proves the page was not told. |
| Does an installed PWA behave differently from a tab? **[R4, R6]** | The page is installable and records `display-mode` in every heartbeat; run it once from a tab and once from the home-screen icon and compare. |
| Does a normal `<audio src>` element change the outcome? **[R5]** | The "Run 2" checkbox adds one alongside the MediaStream element, so the `kOneShot` finding can be tested rather than trusted. |

It also demonstrates R1 and R2 on the user's own device: it asks its service worker which audio
APIs exist and prints the answer, and it logs every wake-lock acquire, release and refusal with
the visibility state at the time.

Everything is written synchronously to `localStorage` — `IndexedDB` was rejected because an
async write queued immediately before a freeze may never run, and the observations that matter
most are exactly the ones just before the page stops. The last heartbeat is rewritten every
second, so even a page that is killed outright still reports the wall-clock moment JavaScript
stopped.

**Verified before hand-off:** driven under headless Chrome 152 over CDP by
`android-voice-probe/verify.mjs`, **25/25 checks pass** — microphone opened, tone generated and
played, AudioWorklet counters advancing, wake lock path exercised, service worker capabilities
measured, MediaSession registered, event trail persisted, and a real `freeze`/`resume` cycle
captured with its audio-clock ratio. The instrument works. It cannot test screen-off; nothing
here can.

**The probe needs a secure context.** `getUserMedia`, the Screen Wake Lock API, service workers
and `AudioWorklet` all require one, so a plain `http://<lan-ip>:8478/` origin cannot test any of
this — the page refuses with a banner rather than producing a misleading run.

---

## Open decisions

Each has a recommendation. Where a choice was contested I took the conservative option and
recorded the alternative.

**1. Ship a screen wake lock in the realtime voice session?**
**Recommend: yes** — acquire `"screen"` on session start, re-acquire on `visibilitychange` back
to visible, and drop it on stop. It is the only lever that exists, it makes the screen-on case
genuinely reliable, and it costs about fifteen lines. *Not implemented here:*
`voice-session-controller.ts` belongs to another lane. Recorded as a recommendation.

**2. Add a MediaSession to the realtime session?**
**Recommend: no.** For a `srcObject` stream it is provably inert (R5): no notification, no
controls, no handler ever fires. Adding it would be ceremony that reads like a capability.
*Alternative considered:* add it anyway for the day Chromium changes `kOneShot`. Rejected —
speculative, and the day it changes is the day to add it.

**3. Add a silent-ish `<audio src>` "keep-alive" element to force a controllable media session
and a `mediaPlayback` foreground service?**
**Recommend: no.** This is the most tempting idea in the document and the most dangerous. It is
undocumented, it depends on a Chromium implementation detail, it would make the session respond
to *every* audio-focus loss by pausing the conversation (a notification chime would stop the
call), and it takes `AUDIOFOCUS_GAIN` — stomping the user's music. And it does not fix the
microphone, which is the actual blocker. *Alternative recorded:* the probe's Run 2 mode exists
precisely so this can be re-evaluated on measurement rather than argument.

**4. Change the manifest or the service worker?**
**Recommend: nothing.** See D3 below. Both are already correct for what they do, and no change
to either moves the screen-off outcome by one inch. Shipping a manifest edit here would be
theatre.

**5. Warn the Android user that voice ends when the screen does?**
**Recommend: yes, eventually** — a one-line note when a voice session starts on Android, and
ideally a `visibilitychange` handler that stops the session cleanly rather than leaving a lit
orb attached to a dead microphone. *Not implemented here:* the orb and the session controller
are owned by other lanes. Recorded as a recommendation, and it is the highest-value follow-up
in this document, because the failure mode is silent.

**6. Build a native wrapper?**
**Recommend: no, not now.** See R6 for the cost. Revisit if `kAndroidEnableBackgroundMediaCapturing`
is enabled on phones — Chromium has an open TODO to decide exactly that
(`crbug.com/426461170`), and if it lands the pure PWA may simply start working. Watch that bug,
not this document.

**7. Re-check when?**
**Recommend: on any Chrome-on-Android major that touches media.** Three specific flags decide
this question and all three are Finch-controlled: `kAndroidEnableBackgroundMediaCapturing`
(would help), `kAndroidSuspendWebRtcOnScreenOff` (would hurt), `kStopInBackground` (the freeze).
Source defaults are a lower bound on knowledge, not the shipped behaviour.

---

## D3 — the configuration changes this verdict warrants

**Almost none, and that is the finding rather than an omission.**

| Candidate change | Verdict |
| --- | --- |
| Web app manifest (`web/vite.config.ts`) | **No change.** It is already installable with correct icons, scope, id and display mode. No manifest field influences freezing, throttling, microphone lifetime, foreground services, or wake locks — R6 establishes that the scheduler takes no manifest-derived input at all. |
| Service worker (`web/vite.config.ts` workbox block, `web/src/lib/sw.ts`) | **No change.** It precaches nothing, stays out of navigations, and is scoped to the origin root only. R1 establishes it can never participate in audio. Adding anything here would be ceremony. |
| `Permissions-Policy` / `Feature-Policy` headers | **No change needed — verified.** muxterm sets none, so the defaults apply, and the default allowlist for both `microphone` and `screen-wake-lock` is `'self'`. That is exactly right for a same-origin page. Adding an explicit header would change nothing and create a new way to get it wrong. |
| Voice implementation, composer, orb, realtime bridge | **Out of scope** — owned by other lanes. Recommendations 1 and 5 above are addressed to them. |

The one thing genuinely added to the repository is the instrument, because the honest answer to
several of the questions is "documentation does not settle this; measure it."

---

## Sources

Specifications, all checked 2026-09-07:
Media Capture and Streams <https://www.w3.org/TR/mediacapture-streams/> ·
WebRTC 1.0 (REC 2025-03-13) <https://www.w3.org/TR/webrtc/> ·
Web Audio API <https://webaudio.github.io/web-audio-api/> ·
Service Workers <https://w3c.github.io/ServiceWorker/> ·
Screen Wake Lock <https://www.w3.org/TR/screen-wake-lock/> ·
Media Session <https://w3c.github.io/mediasession/> ·
Page Lifecycle (WICG CG Report, 2022-06-09) <https://wicg.github.io/page-lifecycle/> ·
HTML Standard §10.3.2 <https://html.spec.whatwg.org/multipage/workers.html>

Chrome / Chromium, all checked 2026-09-07:
`page_scheduler_impl.{h,cc}` · `blink/common/features.cc` · `media/base/media_switches.cc` ·
`chrome/browser/chrome_browser_field_trials.cc` · `web_media_player_ms.cc` ·
`media_session_impl.cc` · `media_content_type.cc` · `audio_focus_delegate_android.cc` ·
`MediaCaptureNotificationServiceImpl.java` · `MediaSessionHelper.java` ·
`MediaNotificationController.java` · `video_capture_manager.cc` ·
`peer_connection_tracker_host.cc` · `power_save_blocker_android.cc` · `wake_lock.{idl,cc}` ·
`cannot_discard_reason.h` · `discard_eligibility_policy.cc` ·
`chrome/android/webapk/shell_apk/AndroidManifest.xml` · `chrome/android/java/AndroidManifest.xml` —
all at <https://chromium.googlesource.com/chromium/src/+/main/>.
CL 8260535 (screen-off → WebRTC suspend, submitted 2026-08-21)
<https://chromium-review.googlesource.com/c/chromium/src/+/8260535> ·
Timer throttling <https://developer.chrome.com/blog/timer-throttling-in-chrome-88> ·
Page Lifecycle <https://developer.chrome.com/docs/web-platform/page-lifecycle-api> ·
Wake Lock <https://developer.chrome.com/docs/capabilities/web-apis/wake-lock> ·
Media Session <https://web.dev/articles/media-session> ·
WebAPKs (⚠ dated 2017-05-21) <https://web.dev/articles/webapks> ·
Trusted Web Activity (⚠ dated 2020-02-04) <https://developer.chrome.com/docs/android/trusted-web-activity/>

Android, all checked 2026-09-07:
Sharing audio input <https://developer.android.com/media/platform/sharing-audio-input> ·
Foreground service types <https://developer.android.com/develop/background-work/services/fgs/service-types> ·
Background-start restrictions <https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start> ·
Android 14 FGS types required <https://developer.android.com/about/versions/14/changes/fgs-types-required> ·
Android 15 behaviour changes <https://developer.android.com/about/versions/15/behavior-changes-15> ·
Audio focus <https://developer.android.com/media/optimize/audio-focus> ·
Wake locks <https://developer.android.com/training/scheduling/wakelock> ·
Android 9 changes <https://developer.android.com/about/versions/pie/android-9.0-changes-all>

**Known gap:** `issues.chromium.org` is not usefully citable anonymously — its search endpoint
returns HTTP 401 and the individual-issue endpoint returned `IamPermissionDeniedException` for
every bug ID referenced from the source comments (582295, 426461170, 533876870). Where a bug
thread would have been the natural citation, Chromium source or a Gerrit CL is cited instead.
