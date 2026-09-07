# Native apps and ambient voice for muxterm

**Question:** should muxterm build native Android and/or Tauri desktop apps in order to
support an always-listening voice mode that keeps working with the screen off — and what
about camera and file attachments as inputs?

**Answer, in one paragraph.** No, and the three asks should be separated because they are
three different problems. *Ambient always-listening* is killed twice over: once by cost
arithmetic that nobody had done (continuous streaming is **$553/month per user** at 16 h/day
on the full model), and once by an Android platform that is actively tightening against
background microphone access — two independent moves against it in the last month alone.
*Tauri on the desktop* solves nothing: its background-throttling control is documented
**Unsupported on Windows and Linux**, so it does not deliver the one thing it would be built
for, while adding WebKitGTK's six-year-old WebRTC gap to a problem the browser already
handles. *Camera and attachments* have nothing to do with native apps at all — they are
plain web-platform features blocked by a missing muxterm **backend**, and building an app to
get them would be solving the wrong problem entirely.

Everything below is dated **2026-09-07**. Chrome and Android behaviour is Finch- and
release-controlled; re-check before acting on this six months from now.

**Claim labels used throughout:** **[REPO]** this repository, cited to file and line ·
**[TRANSCRIPT]** an Amplifier session, cited to session id · **[DOC]** vendor documentation,
cited to URL and date checked · **[SOURCE]** read from Chromium or AOSP source ·
**[ARITHMETIC]** computed here from stated inputs · **[INFERENCE]** my reasoning, not stated
by any source · **[NOT SETTLED]** documentation does not answer it.

---

## Verdict summary

| Item | Verdict |
| --- | --- |
| **A1** The repo's own record | **ANSWERED** — six docs, ~275 KB, zero lines of native code, and **zero mentions of voice** |
| **A2** Session transcripts | **ANSWERED**, with one hard limit: no transcript predates 2026-08-31, so the July reasoning is unrecoverable |
| **A3** Today's PWA finding | **ANSWERED** — NO-GO, and it already named the native app *and recommended against building it* |
| **A4** What muxterm has today | **ANSWERED** — WebRTC voice ships; camera and attachments are wholly absent |
| **P1** What each platform permits | **ANSWERED** — Android: yes, expensively, and tightening. Tauri desktop: **no**, on Windows and Linux |
| **P2** The honest shape of always-listening | **ANSWERED** — the arithmetic decides it, exactly as predicted |
| **P3** The recommendation | **ANSWERED** — **do not build either**; ship three cheap things instead |

---

# PHASE ONE — ARCHAEOLOGY

## The finding that reframes the question

**The session being remembered does not exist.** There is no prior session in which anyone
reasoned about native apps *for voice*. What exists is two unrelated bodies of work that
memory has fused:

1. **2026-06-30 → 07-02** — a real, detailed native companion apps design (Swift + Kotlin,
   ~275 KB). Its purpose was **replacing the server-side CDP browser pane**. It mentions
   voice, microphone, audio and camera exactly **zero** times.
2. **2026-09-07 (today)** — the always-listening / screen-off reasoning, which is real and
   deep, and is entirely about a **PWA**. It concluded NO-GO and explicitly recommended
   **not** building the native app it named as the alternative.

**Tauri appears nowhere.** Not in the repository, not in any of 378 transcripts, except
inside today's own request. There is no prior Tauri decision to recover. It is a new idea,
and this document is the first place it has been evaluated.

```
2026-06-30 → 07-02   Native companion apps design (Swift + Kotlin)
                     Purpose: kill the server-side CDP browser; native webview; embedded SSH
                     Voice / camera / attachments: NEVER MENTIONED
                     Shipped: NOTHING (documents only)
                     Transcripts: DO NOT EXIST on this machine
                            │
                            │   ← no link. Different problem entirely.
                            │
2026-09-07 01:39     Realtime voice research → cost math established
2026-09-07 ~14:00    v0.23.0 ships WebRTC realtime voice in the browser
2026-09-07 17:36     end_voice_session lane — "wake words ... NOT in scope"
2026-09-07 17:51     THE PWA INVESTIGATION → NO-GO; "do not build it"
2026-09-07 21:17     This document
```

---

## A1 — The repository's own record → **ANSWERED**

Six documents, committed in three commits:

| Commit | Contents |
| --- | --- |
| `e86a6de` | `docs/designs/2026-06-30-native-companion-apps-design.md` (21 KB) |
| `9713a0b` | resolves 3 review ambiguities in the above |
| `97daf7a` | phase 0/1/2 plans (65 / 60 / 115 KB) + UX wireframes (16 KB) |

Plus `docs/designs/2026-07-02-macos-window-layout-architecture-design.md` (22 KB).

### What was designed

`docs/designs/2026-06-30-native-companion-apps-design.md:5` **[REPO]**:

> "Build a pair of native companion client apps — Swift for Apple platforms (macOS/iOS) and
> native Kotlin/Android — that connect to muxterm's existing sessiond/WebSocket contract,
> **replace the server-side CDP/Chromium browser pane** with a client-rendered-but-server-drivable
> native webview, and use **embedded SSH** to make remote dev boxes feel local."

Three approaches were weighed; **Approach 1** was chosen — "native shells over a written
protocol spec," each app implementing `docs/muxterm-client-protocol.md` natively, with **no
shared client binary**. gomobile/UniFFI was rejected as "over-engineered for only 2
platforms." One surgical exception: `libghostty-vt` shared for the VT engine only. Five
bricks per platform (Connection Manager, Protocol Client, Terminal Pane, Browser Pane,
Layout UI). The auth model is elegant and worth preserving if this is ever revived: a single
SSH `-L` forward makes every client a loopback client, so **SSH keys become the auth** and no
new pairing scheme is needed.

### The load-bearing negative finding

Term counts across all six documents **[REPO]**:

```
phase0-cdp-removal            voice=0  microphone=0  audio=0  camera=0  "foreground service"=0  tauri=0
phase1-swift-app              voice=0  microphone=0  audio=0  camera=0  "foreground service"=0  tauri=0
phase2-android-app            voice=0  microphone=0  audio=0  camera=0  "foreground service"=0  tauri=0
native-companion-apps-design  voice=0  microphone=0  audio=0  camera=0  "foreground service"=0  tauri=0
native-companion-apps-ux      voice=0  microphone=0  audio=0  camera=0  "foreground service"=0  tauri=0
macos-window-layout           voice=0  microphone=0  audio=0  camera=0  "foreground service"=0  tauri=0
```

**The premise of the request is false.** The July native-app work was never motivated by
voice, never considered it, and would not have delivered it. Its "attach" hits are all
WebSocket session-attach; its "browser pane" is a CDP replacement, not a camera.

### How far it got

**Nowhere.** **[REPO]**

```
$ git log --all --diff-filter=A -- '*.swift' '*.kt' '*.kts' '*.gradle' '*AndroidManifest.xml' 'src-tauri/*'
(empty)

$ git grep -il -e tauri -e capacitor -e react-native
(empty)
```

No native source file has ever existed on any branch. Nothing shipped. The documents are the
whole artifact.

---

## A2 — The session transcripts → **ANSWERED**, with one named limit

### The limit, stated plainly

**The July reasoning is unrecoverable.** The oldest transcript on this machine is
**2026-08-31**; there are 378 in total, distributed 08-31:4, 09-01:28, 09-02:15, 09-03:15,
09-04:35, 09-05:61, 09-06:118, 09-07:100. Nothing survives from the June 30 – July 2 window.
The 275 KB of documents **are** the record. There is no transcript to cross-check them
against, and no way to recover why Approach 1 beat Approach 2 beyond what `:24-30` of the
design says.

This is a specific, named reason — not a failure to search. Searching harder cannot produce
files that are not there.

### Sessions carrying the material

All under `/home/ken/.amplifier/projects/-home-ken/sessions/`, verified first-hand
**[TRANSCRIPT]**:

| Session id | Size | mtime | Why it matters |
| --- | --- | --- | --- |
| `muxterm-cos` | 2.23 MB | 2026-09-07 21:18:54 | The orchestrator. Holds the user's own words, both lane dispatches, and the only "tauri" mentions anywhere |
| `a09f8c7d-0bcb-483a-9fe8-f5235cd2cc9e` | 920 KB | 2026-09-07 18:35:19 | **The PWA investigation.** The load-bearing session |
| `da041723-601d-43d7-a01e-36db20fec4cd` | 1.19 MB | 2026-09-07 07:13:18 | Realtime-voice research; source of the cost math |
| `a5b3d55a-81b5-4d26-9541-f2e2a28e6d06` | 789 KB | 2026-09-07 18:02:25 | `end_voice_session`; records that wake words were scoped **out** |
| `…-756afde7449445e2_anchors-researcher` | 1.02 MB | 2026-09-07 01:54:04 | Fetched the raw $32/$64 realtime rate card |
| `…-5c52c9371e15442a_anchors-researcher` | — | 2026-09-07 18:10:33 | MediaSession / audio focus / WebAPK boundary |
| `…-80e29677d05d4637_anchors-researcher` | — | 2026-09-07 18:09:08 | Android Chrome page lifecycle + microphone |
| `…-f6a4e1a43e9346d5_anchors-researcher` | — | 2026-09-07 18:07:15 | Service workers, audio, wake locks |

### The substantive quotes

**Wake words were explicitly ruled out — today, hours before being asked for.**
`a5b3d55a`, 2026-09-07T17:36 **[TRANSCRIPT]**:

> "Wake words, always-listening behaviour, and any hotword detection are NOT in scope."

**The prediction that called the answer before the work started.** `muxterm-cos`,
2026-09-07T17:51 **[TRANSCRIPT]**:

> "The core blocker is that PWAs can't access Android's foreground service API, and the Wake
> Lock API only offers a screen-type lock that releases the moment the page is hidden —
> there's no system-level wake lock in the web platform. … Service workers can't help here
> since they have zero access to Web Audio, `getUserMedia`, or WebRTC … So the realistic path
> is exploiting the audio-playing exemption directly on the page, though that's inherently
> fragile, with a Trusted Web Activity being the more robust alternative…"

and, in the same session:

> "If it doesn't, the answer is a Trusted Web Activity with a native foreground service — no
> longer a pure PWA, needs native code and sideloading or a Play listing. **I told it to
> recommend that honestly rather than build it.**"

**The pricing, as originally derived.** `da041723` **[TRANSCRIPT]**:

> "**Derived (my arithmetic, not vendor-published — flagged as such):** at the documented
> token densities, ≈ **$0.019/min of user speech in** and ≈ **$0.077/min of assistant speech
> out** for `gpt-realtime-2.1` … **Audio input costs 8× per token** vs text input ($32 vs $4),
> audio output ~2.7× ($64 vs $24) — *and* audio consumes far more tokens per unit of conveyed
> information."

### Terms with nothing behind them

Absence is a finding, so it is reported rather than glossed **[TRANSCRIPT]**:

| Term | Result |
| --- | --- |
| **tauri** | One transcript (`muxterm-cos`), and only inside *today's own* lane brief. **Zero prior reasoning.** Absent from the repo. |
| **capacitor / electron / react-native / flutter / expo** | Nothing relevant. |
| **porcupine / openWakeWord / snowboy** | Zero hits. One incidental `@picovoice/web-voice-processor@4.0.10` line in an npm search dump — never evaluated, never discussed. |
| **"hey muxterm" / hotword** | No wake word has ever been chosen or debated. |
| **camera / image attachment / file attachment** | **No prior reasoning on either**, across all 378 transcripts. Every hit is a false positive or today's own brief. |
| **swift / xcode / SwiftUI / AVAudioEngine** | No muxterm-side reasoning. The only Swift-adjacent activity is an unrelated repo probe whose submodules came back empty. |
| **app store / Play Store / TestFlight** | Only as a scope-out and a cost bullet. Distribution was never planned. |
| **push-to-talk** | Only as a *contrast* ("Not dictation. Not push-to-talk transcription."). Never designed. |

---

## A3 — Today's PWA finding, the direct predecessor → **ANSWERED**

Branch `design/android-pwa-voice`; commits `5188d50` (instrumented probe) and `6397798`
(verdict). Deliverables: `docs/design/android-pwa-voice.md` (864 lines) and
`docs/design/android-voice-probe/` (a 1,239-line installable probe page, 25/25 checks passing
under headless Chrome 152 over CDP).

### The verdict

`docs/design/android-pwa-voice.md:5` **[REPO]**:

> "**Answer: no. NO-GO on the pure-PWA approach.** Not because of one missing API but because
> of four independent blocks, any one of which is sufficient on its own. The smallest thing
> that would work is a native Android app that hosts the web UI *in its own process* and runs
> a `microphone`-typed foreground service — and the obvious candidate for that, a Trusted Web
> Activity, **does not work either**, for a reason worth reading before anyone budgets for it."

```
service worker cannot host audio  ─┐
screen wake lock dies when hidden ─┤
Android silences a background mic ─┼──> pure PWA: NO-GO
  and never tells the page         │
WebAPK cannot run a foreground svc ┘
```

### Why the third block is the fatal one

`:689-706` **[REPO]**, and this is the sentence that should govern the whole product
decision:

> "With the screen off Chrome is a background app holding a capture with no microphone
> foreground service — because `kAndroidEnableBackgroundMediaCapturing` is off on phones by
> explicit, unresolved Chromium decision — and Android's documented response is to let it run
> and feed it **silence**. … The page is not told. `muted` tracks the OS mic-mute toggle, not
> Android's capture-silenced signal. `readyState` stays `"live"`. Server VAD hears digital
> silence and never fires."

> "**The conversation doesn't fail. It silently stops being a conversation.**"

The Chromium comment it rests on, verbatim from source **[SOURCE]**:

```
// TODO(crbug.com/426461170): ... Currently we have no conclusion whether to
// enable this on mobile phones yet.
```

### Why a Trusted Web Activity is a trap

`:577` **[REPO]** — this is the single most expensive mistake the document prevents:

> "A TWA's web content is rendered **by the user's Chrome, in Chrome's process**. Your host
> APK is a separate app with its own process. So your foreground service cannot cover the web
> page's `getUserMedia` … Treat 'TWA + foreground service = background microphone for my PWA'
> as **not demonstrated, and probably wrong.**"

And a WebAPK is not a way out: its Chrome-generated manifest declares exactly two
permissions — `POST_NOTIFICATIONS` and `REORDER_TASKS`. No `FOREGROUND_SERVICE`, no
`RECORD_AUDIO`, and no template field that could inject one.

### It already reached this document's conclusion

`:614` **[REPO]**:

> "**Recommendation: do not build it.** The cost is a native Android product; the benefit is
> one feature that Chromium itself has an open, unresolved plan to enable
> (`crbug.com/426461170`). Revisit if `kAndroidEnableBackgroundMediaCapturing` ships on
> phones — at which point the pure PWA may simply start working."

**This document builds on that rather than re-deriving it.** What follows adds three things
the PWA work did not have: the cost arithmetic, the Tauri evaluation, and the direction of
travel of the platform.

### And one direction-of-travel signal, landed three weeks ago

`:284` **[REPO]**, quoting Chromium source **[SOURCE]**:

```cpp
// Android does not provide an API for apps to be notified of system suspend...
// As a workaround, we use the SCREEN_OFF event as a proxy to trigger
// WebRTC suspend, ensuring hardware resources are released.
void PeerConnectionTrackerHost::OnScreenOff() { OnSuspend(); }
```

Off on phones today. A Finch flag away. Chrome is building toward *closing* WebRTC
connections on screen-off, not preserving them.

---

## A4 — What muxterm has today → **ANSWERED**

### Present

**Realtime voice over WebRTC**, shipped v0.23.0, live at `https://muxterm.ampbox.io`.
`web/src/lib/voice-session-controller.ts:199` **[REPO]**:

```ts
_mic = await navigator.mediaDevices.getUserMedia({
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
});
```

Note what is **not** in that constraints object: there is no `video` key anywhere in the
codebase. `RTCPeerConnection` carries the mic to an Azure OpenAI realtime endpoint; inbound
assistant audio arrives as a remote track attached to an `<audio>` element via `srcObject`.
Server VAD with `interrupt_response: true`, so barge-in is free. A server-side sideband
(`internal/voice/`) means the browser never sees tool calls. Five tools, including
`end_voice_session` with a two-step confirmation (`internal/voice/tools.go:26`, merged as
PR #88). Configuration in a `[voice]` section with `auth_mode` entra
(`internal/config/config.go:67`).

**Dictation**, separately and unrelatedly: `<mux-mic-button>` in the mobile title bar, backed
by the Web Speech API, **deliberately disabled on Android** —
`web/src/lib/voice-input-controller.ts:79-86` **[REPO]**:

```ts
/**
 * Android is deliberately excluded because native keyboard dictation makes
 * the custom button redundant; this is a product decision, not a workaround.
 */
```

That exclusion is about `SpeechRecognition` only. It has no bearing on WebRTC realtime audio,
and the two must not be conflated.

### Absent — confirmed, as the request specifically asked

| Gap | Evidence **[REPO]** |
| --- | --- |
| **Camera input** | The only `getUserMedia` in `web/src/` is the audio-only call above. Zero occurrences of `video:`, `ImageCapture`, `captureStream`, or `camera`. |
| **File / image attachment** | `grep -rn 'type="file"' web/src/` → **0 results**. No `drop`, `dragover` or `paste` file handlers. No `FormData`, no `DataTransfer`, no multipart anywhere. |

A turn carries `text: string` and nothing else. There is no binary transport, no storage
layer, and no per-turn attachment model at any layer of the stack. **This matters for P3:**
the blocker is not the browser and never was.

---

# PHASE TWO — THE PLAN

## P1 — What each platform actually permits → **ANSWERED**

### P1a — Android

**Yes, it is permitted. It requires a foreground service, and the rules are tightening.**

#### The requirement

A `microphone`-typed foreground service is required, via two independent gates.

**Gate A — the capture policy, since Android 9 / API 28** **[DOC]**,
<https://developer.android.com/media/platform/sharing-audio-input>, checked 2026-09-07
(page last updated 2026-09-03):

> "only apps running in the foreground (or a foreground service) could capture the audio
> input. When an app without a foreground service or foreground UI component started to
> capture, **the app continued running but received silence**, even if it was the only app
> capturing audio at the time."

*Honest caveat:* that sentence sits under a heading titled "Pre-Android 10 behavior" and is
written in the past tense. The doc never restates the rule for Android 10+. It is **not** a
statement of repeal — AOSP still enforces it (below) — but a reviewer who challenges the
citation is reading fairly. The load-bearing citation for current behaviour is Gate B plus
source.

**Gate B — FGS types are mandatory, since Android 14 / API 34** **[DOC]**,
<https://developer.android.com/develop/background-work/services/fg-service-types>, checked
2026-09-07. The `microphone` type requires manifest permission
`FOREGROUND_SERVICE_MICROPHONE`, constant `FOREGROUND_SERVICE_TYPE_MICROPHONE`, and the
`RECORD_AUDIO` runtime grant. Google's own listed use case is "Continue microphone capture
from the background, such as voice recorders or communication apps."

**The enforcement is state-based, not screen-based** — AOSP
`AudioPolicyService::apmStatFromAmState()` **[SOURCE]**,
<https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/services/audiopolicy/service/AudioPolicyService.cpp>:

```cpp
if (amState == ActivityManager::PROCESS_STATE_UNKNOWN) {
    return APP_STATE_IDLE;          // -> silenced
} else if (amState <= ActivityManager::PROCESS_STATE_TOP) {
    return APP_STATE_TOP;
}
return APP_STATE_FOREGROUND;        // -> not silenced
```

Screen state is not an input. A running FGS holds the UID at
`PROCESS_STATE_FOREGROUND_SERVICE` → not silenced. So for the *audio path*, screen-off and
merely-backgrounded are the same. **[INFERENCE]** The practical difference is one-way: only
the screen-on case gives you a visible activity from which to (re)start the service.

#### Manifest and permissions — the complete list

**[DOC]** <https://developer.android.com/reference/android/Manifest.permission>, checked
2026-09-07:

```xml
<uses-permission android:name="android.permission.INTERNET" />                      <!-- API 1,  normal    -->
<uses-permission android:name="android.permission.RECORD_AUDIO" />                  <!-- API 1,  dangerous -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />            <!-- API 28, normal    -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" /> <!-- API 34, normal    -->
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />            <!-- API 33, dangerous -->
<uses-permission android:name="android.permission.WAKE_LOCK" />                     <!-- API 1,  normal    -->
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />         <!-- API 1,  normal    -->

<service
    android:name=".VoiceSessionService"
    android:foregroundServiceType="microphone"
    android:exported="false" />
```

The FGS-type permissions are `normal` and **cannot be revoked by the user** **[DOC]**.
`MODIFY_AUDIO_SETTINGS` is **[INFERENCE]** — needed only if you set
`AudioManager.MODE_IN_COMMUNICATION`, which a VoIP-style session conventionally does.

#### The constraint that shapes the architecture

**Android 14 / API 34, while-in-use rule** **[DOC]**,
<https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start>,
checked 2026-09-07 (page last updated 2026-08-14):

> "if an app wants to launch a foreground service that needs while-in-use permissions (for
> example, body sensor, camera, **microphone**, or location permissions), **it cannot create
> the service while the app is in the background, even if the app falls into one of the
> exemptions from background start restrictions.**"

> "**you must call `Context.startForegroundService()` or `Context.bindService()` while your
> app has a visible activity**"

Getting it wrong throws `SecurityException`. And a trap the docs call out explicitly:
`checkSelfPermission()` "returns `PERMISSION_GRANTED` even if the app is in the background,"
so it cannot be used to guard the call.

**This is the single most consequential platform constraint for the design.** It means
ambient voice can never *start itself*. Every session begins with the user opening the app.
An "always-listening assistant that wakes up on its own" is not buildable on modern Android
by any app, native or otherwise. Related: `BOOT_COMPLETED` receivers have been forbidden from
launching `microphone` services since Android 14 **[DOC]**,
<https://developer.android.com/about/versions/15/behavior-changes-15>.

Android 12 / API 31 adds `ForegroundServiceStartNotAllowedException` for background starts
generally; Android 15 / API 35 requires top-app-or-FGS to request audio focus at all
(`AUDIOFOCUS_REQUEST_FAILED` otherwise) **[DOC]**, same URL.

One piece of good news: `microphone` and `mediaPlayback` have **no wall-clock timeout** —
only `dataSync` and `mediaProcessing` do **[DOC]**,
<https://developer.android.com/develop/background-work/services/fgs/timeout>. A continuous
session can, platform-wise, run indefinitely.

#### The direction of travel — Android 17 background audio hardening

This landed after the PWA investigation and is the newest fact in this document. **[DOC]**
<https://developer.android.com/about/versions/17/changes/bg-audio>, checked 2026-09-07 (page
last updated 2026-08-14):

> "Starting in Android 17, the audio framework enforces restrictions on background audio
> interactions including audio playback, audio focus requests, and volume change APIs… **All
> apps running on Android 17** that have these background audio interactions **must have a
> visible activity or must be running a foreground service that is not of type
> SHORT_SERVICE. This applies whether or not the app targets API level 37.**"

> "If the app is running in the background, the app must be running a foreground service that
> has **while-in-use (WIU) capabilities**."

Failure is silent: playback and volume APIs "fail silently without throwing an exception."

**Read the pair together.** Chrome is wiring `ACTION_SCREEN_OFF` → close peer connections
(A3). Android is extending background-audio hardening from capture to *playback*. Two
independent tightenings inside one year, both pointed the same way. **[INFERENCE]** Anything
built here is being built against the current of the platform, and will need re-verification
every Android release, indefinitely.

#### What the user sees while it runs

**A persistent notification, which the user can dismiss.** Since Android 13, "users can
dismiss notifications associated with foreground services **by default**" **[DOC]**,
<https://developer.android.com/about/versions/13/behavior-changes-all>. Dismissal does not
stop the service **[INFERENCE]**. Use `FOREGROUND_SERVICE_IMMEDIATE` or display may be
deferred ~10 s **[DOC]**.

**If `POST_NOTIFICATIONS` is denied, the notification is simply invisible** — the service
still runs, the mic still works **[DOC]**,
<https://developer.android.com/develop/ui/views/notifications/notification-permission>. This
is a genuine honesty problem: the app can be listening with no visible notification at all.

**A microphone privacy indicator, while the screen is on** — a status-bar icon that becomes a
persistent dot **[DOC]**,
<https://developer.android.com/training/permissions/explaining-access> and
<https://source.android.com/docs/core/permissions/privacy-indicators>.

**With the screen off: NOT SETTLED BY DOCUMENTATION.** No Android or AOSP page addresses it.
**[INFERENCE]** The indicator is described exclusively as a status-bar element rendered by
System UI, and the status bar is not composited with the display off — so there is almost
certainly nothing shown, with always-on-display behaviour being OEM-dependent. **This is the
crux of the trust problem in P2:** the one affordance that tells a user they are being
recorded is, by inference, absent exactly when recording is least expected. The Privacy
Dashboard retains a retrospective timeline either way.

**The Quick Settings mic toggle silences you without telling you.** **[DOC]** "When the user
turns off microphone access, your app receives silent audio." Confirmed at source
**[SOURCE]**: `if (mSensorPrivacyPolicy->isSensorPrivacyEnabled()) { silenceAllRecordings_l(); }`.
No exception, no callback, service keeps running, uplink keeps sending silence — **the same
silent-failure mode the PWA verdict identified**, reproduced natively. The mitigation exists
and must be built: `AudioRecord.registerAudioRecordingCallback()` + `isClientSilenced()`.

**Google Play requires a declaration and a demo video.** **[DOC]**
<https://support.google.com/googleplay/android-developer/answer/13392821>: for each FGS type
you must describe the functionality, describe the user impact of deferral and interruption,
choose a use case, and "**Include a link to a video demonstrating each foreground service
feature.**" Google's own listed use case — "Background Audio Access … voice commands for
virtual assistant" — maps cleanly onto this one. The substantive policy bar **[DOC]**
<https://support.google.com/googleplay/android-developer/answer/9888379> requires that the
service "can be terminated or stopped by the user" and "runs only for as long as necessary to
complete the task." Note the tension: the *platform* imposes no timeout on `microphone`, but
*policy* does. A design that holds the mic open indefinitely with no user-visible session
boundary is a policy risk even though it is technically permitted.

Whether a separate in-app prominent disclosure is *mandatory* is **NOT SETTLED** — the Play
prominent-disclosure article names Accessibility, Background Location and Package Visibility,
but not background microphone. **[INFERENCE]** Build the disclosure anyway; the reviewer-facing
video requirement means you will be showing your flow to Google regardless.

#### Battery, Doze, and the OEM problem

**A running FGS is exempt from Doze's network suspension** — the row that matters, from the
power-management limits table **[DOC]**,
<https://developer.android.com/topic/performance/power/power-details>: "App process is running
a foreground service → **Network: No restrictions**." It is *not* exempt from JobScheduler
quotas (tightened in Android 16) or alarm frequency limits. **[INFERENCE]** Keep every
session-critical path — keepalive, reconnect, watchdog — on threads inside the service. Do not
put anything load-bearing on WorkManager.

**Is a separate `PARTIAL_WAKE_LOCK` needed? NOT SETTLED BY DOCUMENTATION.** The Doze page's
flat "Ignores wake locks" actively misleads. Source settles it two ways **[SOURCE]**:

1. `PowerManagerService.setWakeLockDisabledStateLocked()` disables partial wake locks in idle
   only when `state.mProcState > PROCESS_STATE_BOUND_FOREGROUND_SERVICE` (=5). An FGS app sits
   at `PROCESS_STATE_FOREGROUND_SERVICE` (=4). `4 > 5` is false → **not disabled**.
2. `AudioFlinger::ThreadBase::acquireWakeLock_l()` already takes a `POWERMANAGER_PARTIAL_WAKE_LOCK`
   tagged `"AudioIn"` under `AID_AUDIOSERVER` (uid 1041), which is below `FIRST_APPLICATION_UID`
   and therefore can never be disabled by Doze.

**[INFERENCE]** An FGS plus an actively-running `AudioRecord` is *sufficient* to hold the CPU
awake with the screen off; an explicit wake lock is insurance for the gaps (reconnect,
renegotiation, network stall) when the audio thread is in standby. Take it anyway — it is one
`normal` permission — but record that this conclusion is source-derived, not documented, and
must be re-verified when AOSP moves.

**Note the second-order consequence:** the platform holds the CPU awake *because* the mic is
open. The battery cost of always-listening is therefore structural, not tunable.

**OEM battery killers are a real and unmitigable risk** on a large share of devices.
**[DOC — community source]** <https://dontkillmyapp.com/>, checked 2026-09-07, scores Xiaomi,
Samsung, OnePlus and Huawei at 5/5; AOSP, Nokia and HTC at 0. Directly on point for the
mechanism above: "in Android 11 Samsung has introduced a new severe (default ON) restriction.
**Apps can no longer hold wake lock in foreground services.**" Partially retracted in 2024:
"Since One UI 6.0, foreground services of apps targeting Android 14 will be guaranteed to work
as intended so long as they are developed according to Android's new foreground service API
policy." Xiaomi MIUI additionally requires a per-app "Background autostart" grant that
**cannot be requested programmatically**.

**[INFERENCE]** Risk profile: low on Pixel/AOSP; medium on Samsung One UI 6+ with
`targetSdk ≥ 34`; **high, with no API to detect or prevent it**, on older Samsung, Xiaomi,
Huawei, OnePlus, Oppo, realme and vivo. Detect-and-apologise via `ApplicationExitInfo` is the
only universal answer.

#### WebView specifics

WebRTC and `getUserMedia` are supported in Android WebView (`getUserMedia` since WebView 53;
`RTCPeerConnection` mirrors Chrome) **[DOC]**, MDN browser-compat-data. The host app **must**
override `WebChromeClient.onPermissionRequest` and call `grant(RESOURCE_AUDIO_CAPTURE)` —
"**If this method isn't overridden, the permission is denied**" **[DOC]**,
<https://developer.android.com/reference/android/webkit/WebChromeClient>. The host app must
*also* hold `RECORD_AUDIO` at the OS level, since WebView runs in the host's UID
**[INFERENCE]**.

**The Media Session API is entirely unsupported in WebView**, confirmed: every member is
`webview_android: false` with `impl_url: https://crbug.com/40611412` **[DOC]**, MDN BCD. In a
native-host design this is a non-issue — use native `android.media.session.MediaSession` and
bridge over a `JavascriptInterface`.

**The unknown that gates the whole design: NOT SETTLED BY DOCUMENTATION.** Whether Chromium's
renderer-visibility throttling applies to a WebView whose window is not visible because the
screen is off, and whether it degrades the WebRTC path. No Android or Chromium documentation
addresses WebView here. WebView's own `onPause()`/`pauseTimers()` are app-controlled and can
simply not be called, but the internal renderer policy is undocumented. **[INFERENCE]** WebRTC
audio runs off the renderer main thread, which argues it survives; JS-driven signalling and
reconnect logic are exposed. **This can only be settled on a physical device, and it decides
whether the cheap version of the Android app works at all.**

### P1b — Tauri desktop

**No. Tauri does not deliver background audio on Windows or Linux, and it is documented as
not delivering it.**

#### Version and engines

Current stable is **Tauri 2.11.5**, published 2026-07-01 **[DOC]**,
<https://crates.io/api/v1/crates/tauri> and <https://tauri.app/release/tauri/>, checked
2026-09-07. **No v3 exists or is announced** — the blog's most recent posts are board
elections (Jun 2026) and the Verso experiment (Mar 2025).

Engines **[DOC]**, <https://tauri.app/reference/webview-versions/>: WebView2 (Chromium) on
Windows, WKWebView (WebKit) on macOS, **webkit2gtk on Linux**, system WebView on Android.
Confirmed at the dependency level: `tauri-runtime-wry` 2.11.4 depends on `webkit2gtk =2.0`,
`webview2-com`, and `wry ^0.55.0`.

**This is the core structural problem.** Three different WebRTC implementations, one of which
is WebKitGTK's GStreamer-based stack whose completeness varies by distro packaging. muxterm's
voice implementation is currently validated against exactly one engine.

#### The decisive finding

Tauri exposes `app.windows[].backgroundThrottling`. Its documented default behaviour
**[DOC]**, <https://tauri.app/reference/config/>, checked 2026-09-07:

> "By default, browsers use a suspend policy that will throttle timers and **even unload the
> whole tab (view) to free resources after roughly 5 minutes** when a view became minimized or
> hidden."

And its platform support, verbatim:

> "**Linux / Windows / Android: Unsupported.** Workarounds like a pending WebLock transaction
> might suffice. **iOS: Supported since version 17.0+. macOS: Supported since version 14.0+.**"

**The one control that exists for the one problem Tauri would be built to solve is
Unsupported on two of its three desktop targets.** Tracking issue tauri#5250, **open since
2022-09-21**, labelled `status: upstream`, last active 2025-11-15. Maintainer FabianLars,
2022-09-21 **[DOC]**: *"The webviews don't have APIs for this at all… tldr: Don't wait for
this feature :/"*.

A developer in that thread describing precisely the tray-app-with-hidden-window case
**[DOC]**: *"I've tried a lot of hacks like having a local WebRTC ping pong, playing a muted
audio file, creating an audio on demand with an OscillatorNode or using an infinitely pending
WebLock transaction. **Nothing worked on MacOS.**"* — before the fix that became
`backgroundThrottling`, which he then reports leaves timers throttled to ~2 s even when it
works.

**There is also no sleep-inhibition API.** The complete official plugin list contains no
power/sleep/wake-lock plugin **[DOC]**, <https://tauri.app/plugin/>. The community option
`tauri-plugin-nosleep` last shipped **2024-02-25**, has no registered repository, and its
`max_stable_version` is 0.1.0 **[DOC]**, crates.io. (`tauri-plugin-prevent-default` is
unrelated — it disables browser shortcuts.) Building it yourself means `IOPMAssertion` on
macOS, `SetThreadExecutionState` on Windows, and a `org.freedesktop.login1` inhibitor on
Linux. Machine suspend, of course, stops everything regardless.

#### Microphone in Tauri

It works, with per-platform setup, but there is a version gap **[DOC]**, wry issue #1825
(open, last active 2026-08-31): the permission handler is fully implemented across all
backends — but it landed in **wry 0.56** (Aug 2026), and **`tauri-runtime-wry` 2.11.4 pins
`wry ^0.55.0`**, and Tauri does not expose it anyway (tauri#14753, open). **[INFERENCE]** On
today's stable Tauri you cannot programmatically manage microphone permission; you get the
platform default, and **WebKitGTK's default is deny**, whereas macOS's is grant.

macOS needs `NSMicrophoneUsageDescription` — and Tauri's own docs use *"Request microphone
access for WebRTC"* as the literal example string **[DOC]**,
<https://tauri.app/distribute/macos-application-bundle/>. `hardenedRuntime` defaults to
`true`, but `com.apple.security.device.audio-input` is **not mentioned anywhere in Tauri's
docs** — **NOT SETTLED**; **[INFERENCE]** you will need it, corroborated by tauri#8314 where
mic access worked in dev and failed after notarization.

Open issues worth knowing: **wry#85 "WebRTC support on Linux" — open since 2020-05-30, last
active 2026-07-28** (six years); tauri#6623 `track.stop()` does not clear the capture
indicator; tauri#8041 macOS universal builds re-prompt every launch.

#### Tray and global shortcuts — what Tauri actually buys

Tray is core (`tray-icon` feature) **[DOC]**, <https://tauri.app/learn/system-tray/>, but on
Linux tray *mouse events are unsupported* ("the event is not emitted") and left-click menus
are unsupported — Linux gets context-menu-only. Global shortcuts are a plugin, deny-by-default
**[DOC]**, <https://tauri.app/plugin/global-shortcut/> — but the underlying `global-hotkey`
0.8.0 states **"Linux (X11 Only)"** **[DOC]**, <https://docs.rs/global-hotkey/latest/>, which
tauri.app's plain Linux checkmark does not mention. Ubuntu and Fedora default to Wayland, so
global hotkeys silently fail on most modern Linux desktops. macOS Accessibility/TCC
requirements are **NOT SETTLED** by either doc set; **[INFERENCE]** `global-hotkey` uses
`objc2-app-kit` rather than `CGEventTap`, so a plain hotkey most likely needs no Accessibility
grant — verify on a signed hardened-runtime build.

#### Tauri on Android — the one genuinely interesting finding

**A Tauri Android app *can* declare a microphone foreground service.** The
`AndroidManifest.xml` is a generated template at `gen/android/` that Tauri's own docs instruct
you to edit **[DOC]**, <https://tauri.app/plugin/file-system/>; Android plugins are Kotlin
classes receiving the `Activity`, so `startForegroundService()` is directly available
**[DOC]**, <https://tauri.app/develop/plugins/develop-mobile/>; and Kotlin↔Rust works "**even
when the application WebView is suspended**" (same page). Tauri issue **#15671** (open, filed
2026-07-07) contains a complete working FGS setup against 2.11.5 — manifest entries, a
`KeepAliveService.kt`, a `TauriActivity` override, and `RunEvent::ExitRequested { api } =>
api.prevent_exit()`. Swap `dataSync` for `microphone` and it is the recipe. **[INFERENCE]**

**But that same issue is the reason not to.** #15671 exists because with an FGS keeping the
process alive, swiping the app from recents and relaunching yields a **permanent white
screen** — tao binds one Activity to one Window by `hashCode()`, the relaunch gets a fresh id,
and the resume event is silently dropped. The fix PR #15678 is still open. Maintainer
FabianLars on Android background work generally **[DOC]**: *"the only real approach here is
using a **service** … **We do not have a plugin or any helpers for that yet though so you'd be
on your own.**"*

So: Tauri Android is Kotlin-plus-overhead. You still write the Kotlin service by hand, and you
additionally inherit a young mobile runtime with an open lifecycle bug in exactly the
configuration you need.

#### Alternatives, briefly

**Electron** actually solves the desktop problem Tauri does not: `webPreferences.backgroundThrottling: false`
is a boolean that works on all three OSes **[DOC]**,
<https://www.electronjs.org/docs/latest/api/structures/web-preferences>, and
`powerSaveBlocker.start('prevent-app-suspension')` is documented with "**Example use cases:
downloading a file or playing audio**" **[DOC]**,
<https://www.electronjs.org/docs/latest/api/power-save-blocker>. It bundles Chromium, so voice
behaves identically everywhere. The costs are the known ones: ~150 MB, memory, and owning
Chromium patching. It offers no Android path.

**Just using the browser** loses tray presence, global hotkeys, autostart, an installer, and
sleep inhibition — and loses *nothing* on background audio, because desktop browsers do not
freeze a tab that holds an active capture and is playing audio. **[INFERENCE]** On desktop,
the browser is already the working answer.

---

## P2 — The honest shape of always-listening → **ANSWERED**

Always-listening is three different features wearing one name. Costing them separately settles
the design, exactly as predicted.

### The arithmetic

Both given anchors imply the same token density — $32/M at 1.9¢/min and $10/M at 0.6¢/min both
resolve to **≈600 audio tokens per minute** (10 tokens/second) **[ARITHMETIC]**. That is the
figure used throughout.

**Continuous streaming — listening only, before any assistant speech, before context
re-billing** **[ARITHMETIC]**:

| | full ($32/M in) | mini ($10/M in) |
| --- | --- | --- |
| per minute | $0.0192 | $0.0060 |
| **per hour** | **$1.15** | **$0.36** |
| 8 h/day | $9.22/day · **$276/30 days** | $2.88/day · $86/30 days |
| 16 h/day | $18.43/day · **$553/30 days** | $5.76/day · $173/30 days |
| 24 h/day | $27.65/day · **$829/30 days** | $8.64/day · $259/30 days |

**These are floors.** Assistant speech adds $64/M (full) or $20/M (mini) on top, and each
response re-bills accumulated context. Real cost is strictly higher.

**Wake-word-gated, for comparison** — assume 20 exchanges/day averaging 90 s, so 30 min/day
streamed in and 8 min/day of assistant speech **[ARITHMETIC]**:

| | full | mini |
| --- | --- | --- |
| per day | $0.88 | $0.28 |
| per 30 days | **$26** | **$8** |

**Wake-word gating is ~21× cheaper than continuous 16 h/day, on either model.**

**Push-to-talk** costs the same as wake-word gating for the same amount of speech, with no
wake-word engine and no open microphone.

### The other two currencies

**Battery.** The platform holds a `PARTIAL_WAKE_LOCK` under `AID_AUDIOSERVER` for as long as
capture is running (P1, **[SOURCE]**), so the CPU cannot sleep while the mic is open. Add a
continuous radio uplink and this is, energetically, a phone call that never ends.
**[INFERENCE — not documented, and I have no device to measure on]** treat it as equivalent to
continuous VoIP: a device that idles for a day gets roughly a third to a half of one waking
day. Ambient always-on is a "charge at lunch" feature.

**Data.** At a standard 24 kbps Opus voice uplink: **10.8 MB/hour → 173 MB/day at 16 h →
≈5.2 GB per 30 days, uplink alone**, before inbound audio **[ARITHMETIC]**. On a metered plan
that is a second bill the user did not agree to.

**Trust — and this is the one that should decide it.**

| Mode | What the user must trust |
| --- | --- |
| **Continuous streaming** | That every sound within microphone range — their family, their colleagues, their doctor — is acceptable to send to a cloud vendor, continuously, with **no privacy indicator visible while the screen is off** (**[INFERENCE]**, P1). Not a setting they can verify. |
| **Wake-word on device** | That audio stays local until the word fires. The mic is still open 24/7. They are trusting *your code*, not the platform — and the platform gives them no way to check. |
| **Push-to-talk / scheduled window** | Nothing. The mic is open when they opened it. |

### What the arithmetic settles

**Continuous streaming of all audio is not a product.** At $553/month for one user at 16 h/day
it is not shippable at any plausible price, and even if it were free the trust position is
indefensible when the platform's own indicator is (inferred) absent with the screen off. The
prediction in the lane brief was right: the arithmetic decides the design on its own.

**So "always-listening" reduces to wake-word gating.** Which means the API cost collapses to
~$26/month — and the *entire remaining cost* is the native app needed to hold the microphone
open. The expensive part was never the tokens. **It is the Android product.**

**And push-to-talk gets you the same token bill as a wake word, with no engine, no open
microphone, and nothing to trust.** The only thing a wake word buys over push-to-talk is not
having to touch the phone. That is the actual feature under discussion, and it should be
priced as such: *an Android product, permanently maintained, so the user does not have to
touch the phone.*

---

## P3 — The recommendation → **ANSWERED**

### Do not build either app.

**Tauri desktop: no. Clear no, and the reasoning is not close.**

1. It does not solve the stated problem. `backgroundThrottling` is documented **Unsupported on
   Windows and Linux** — the exact control the app would exist to use.
2. There is no problem to solve on desktop. A desktop browser does not freeze a tab holding an
   active capture. The machine's display sleeping does not end a call. Machine suspend ends
   everything, and no app survives that.
3. It makes voice *worse* on one platform. WebKitGTK's WebRTC has an open issue from 2020; the
   permission handler is one wry minor ahead of Tauri stable; WebKitGTK's permission default is
   deny. muxterm's voice is validated against one engine today; Tauri makes it three.
4. What it genuinely buys — tray, global hotkeys, autostart, installer — is real but unrelated
   to voice, and even that is degraded on Linux (tray mouse events unsupported; global hotkeys
   X11-only, so broken on Wayland-default distros).

If tray-and-hotkeys is ever wanted **for its own sake**, revisit then, judge it on those
merits, and consider Electron instead — it has the background-audio switch Tauri lacks. But do
not build a desktop app to fix a problem the desktop does not have.

**Android native: not now.** The PWA verdict already said this
(`android-pwa-voice.md:614`), and three months of new evidence strengthens rather than weakens
it:

- The cost math (P2) removes continuous streaming as an option, so the app can only deliver
  *wake-word convenience* — a much smaller prize than "ambient assistant."
- Android 17's background-audio hardening (new since that verdict) extends enforcement from
  capture to playback. Two independent tightenings this year.
- The Android 14 while-in-use rule means the session can never start itself. Every voice
  session begins with the user opening the app — which is a large part of the way to just
  pressing a button.
- On a large share of real devices (Xiaomi, Huawei, older Samsung) the service will be killed
  regardless of correct implementation, with no API to detect or prevent it.
- The cheap version depends on an undocumented WebView throttling behaviour that **cannot be
  settled without a physical device**.

**A well-argued "do not build this" is the honest answer here, and this is it.**

### What to build instead — in order, cheapest first

**1. The screen wake lock. ~1 day.** Already recommended as decision #1 of
`android-pwa-voice.md` and still unimplemented. Acquire `"screen"` on voice-session start,
re-acquire on `visibilitychange`, drop on stop. It makes the screen-on case genuinely reliable
and it is about fifteen lines. This is the largest ratio of value to effort in this entire
document.

**2. The Android honesty warning. ~1 day.** Also already recommended (decision #5). Today an
Android user who locks their phone mid-conversation gets a lit orb attached to a dead
microphone, and is never told. A one-line note when a voice session starts on Android, plus a
`visibilitychange` handler that ends the session cleanly. **The failure mode is silent, which
is what makes this urgent** — and it is worth noting that P1 found the *native* path
reproduces the same silent failure via the Quick Settings mic toggle, so this instrumentation
is not wasted even if an app is built later.

**3. Camera and attachments — as a web + backend feature, not an app. 1–2 weeks.** See below.

**4. Nothing else.** Then watch `crbug.com/426461170`.

### The revisit trigger, stated precisely

Re-open the Android question if **and only if**
`kAndroidEnableBackgroundMediaCapturing` is enabled by default on phones — at which point,
per the PWA verdict, the pure PWA may simply start working and the app becomes unnecessary
rather than cheaper. **Watch that bug, not this document.** Checking it costs minutes; the app
costs a quarter and then costs forever.

### If it is built anyway — the build order, and the risk

Named because the decision may go the other way, not because it is recommended.

| # | Component | Note |
| --- | --- | --- |
| 0 | **A throwaway device spike, before anything else** | WebView + mic FGS + a real WebRTC session, screen locked 30+ minutes on a physical phone. Measure audio continuity *and* JS timer intervals. **If this fails, stop.** Do not escalate to a native audio client. |
| 1 | Kotlin `Activity` hosting a `WebView` on `https://muxterm.ampbox.io` | Plus `WebChromeClient.onPermissionRequest` → `grant(RESOURCE_AUDIO_CAPTURE)` |
| 2 | `RECORD_AUDIO` runtime flow, granted **before** step 3 | Order is enforced; `checkSelfPermission()` cannot guard it |
| 3 | `microphone` FGS + notification channel, started **only from the visible activity** | Consider `microphone\|mediaPlayback` for Android 17 |
| 4 | Silence detection: `registerAudioRecordingCallback()` + `isClientSilenced()` | Non-optional. Without it the app reproduces the exact silent failure that made the PWA a NO-GO |
| 5 | `ApplicationExitInfo` on next launch → honest "the system ended your session" | The only defence against OEM kills |
| 6 | Signing key, sideload or Play listing + FGS declaration + demo video | Ongoing, not one-time |
| 7 | Wake-word engine, only if step 0 passed and the rest shipped | Last, and optional |

**The single biggest technical risk is step 0** — whether Chromium's renderer throttling
degrades the WebRTC/JS path in a WebView whose window is not visible because the screen is
off. It is **NOT SETTLED BY DOCUMENTATION** (P1), it is invisible in an emulator, and it is
the difference between a 3–6 week thin shell and a 8–14 week native audio client that would
fork muxterm's voice implementation in two. **I cannot resolve it: this lane has no phone.**
Nobody should budget for the Android app before someone runs that spike.

**Honest effort estimates** (calendar, one experienced developer, **[INFERENCE]**):

| Work | Estimate |
| --- | --- |
| Screen wake lock + Android honesty warning | **2 days** |
| Camera + attachment input (web + backend) | **1–2 weeks** |
| Device spike (step 0) | **2–3 days**, plus a phone |
| Android thin shell + mic FGS, *if the spike passes* | **3–6 weeks**, plus permanent `targetSdk` maintenance |
| Android native-audio client, *if the spike fails* | **8–14 weeks**, and voice forks in two |
| Tauri desktop app that gains nothing on this goal | 2–4 weeks, plus a permanent 3-engine test matrix |

### Should Android and desktop share a codebase? **No.**

1. **They do not share a problem.** Desktop already works in a browser. Android does not.
   Sharing a codebase to solve one platform's problem imports the other's risk for no benefit.
2. **The only shared-codebase candidate makes both worse.** Tauri's desktop background story
   is Unsupported on Windows and Linux, so it does not solve desktop; and its Android path adds
   a young mobile runtime with an open blank-webview bug (#15671) in exactly the FGS
   configuration required, on top of Kotlin you must still write by hand.
3. **The sharing that matters is already free.** muxterm is a web app served over https. Any
   shell — Tauri, Kotlin, Electron, or a browser — loads the same UI. The UI is the shared
   codebase. Adding a cross-platform *framework* on top shares nothing further; it only adds
   engines to test against.

The one honest argument *for* Tauri is that both P1 findings converge on the same
architecture — audio out of the webview, in native code, on every platform. That convergence
is real. It is also an argument for **not putting audio in a webview**, which is an argument
against the thin-shell approach generally, not an argument for Tauri.

---

## Camera and attachments — the short answer

**These are not native-app problems, and bundling them with the voice question is the mistake
to avoid.** **[REPO]** confirms both are absent (A4): zero `type="file"`, zero video
constraints, zero paste/drop handlers, `text: string` as the only payload a turn can carry.

**The browser already does the hard part, today, on Android:**

- **Camera:** `<input type="file" accept="image/*" capture="environment">` opens the camera
  directly. That is the whole client-side feature — one HTML attribute.
- **Attachments:** `<input type="file">`, `DataTransfer` for drag-and-drop, and
  `clipboardData` for paste. All Baseline. All work in Chrome on Android and on every desktop
  browser.

**The blocker is muxterm's backend, and it is entirely muxterm's own.** There is no upload
endpoint, no storage with a lifecycle, no binary transport, and — most importantly — no
convention for how bytes reach an agent. The agent in a pane receives *keystrokes*, not
multipart payloads.

**The design that fits what already exists** **[INFERENCE]**: accept the upload over HTTP,
write it to a per-session temp directory on the machine the pane runs on, and inject its
**path** into the text the agent receives (`[image: /tmp/muxterm/<session>/shot-01.png]`).
The agent already has file tools and can simply read it. No protocol change, no binary
framing, no model-vision plumbing in muxterm at all. Add size limits, auth on the endpoint,
and a cleanup policy. **1–2 weeks.**

**A native app would deliver nothing here that the browser does not already deliver** — and it
would still need every line of that backend work. Do this one on the web, and do it
independently of the voice question.

---

## Open decisions

Each is decision-shaped, with a recommendation. Where a choice was contested I took the
conservative option and recorded the alternative.

**1. Build a Tauri desktop app?** → **No.** It does not solve background audio on Windows or
Linux (documented Unsupported), and the desktop has no background-audio problem to solve.
*Alternative recorded:* if tray + global hotkeys are wanted for their own sake, revisit on
those merits — and evaluate Electron alongside, since it has the switch Tauri lacks.

**2. Build a native Android app?** → **No, not now.** Same conclusion the PWA verdict reached,
now with cost math and Android 17 behind it. *Revisit trigger:* `kAndroidEnableBackgroundMediaCapturing`
enabled on phones (`crbug.com/426461170`), at which point the PWA may simply work.

**3. If Android is built anyway — Tauri or Kotlin?** → **Kotlin.** Tauri's Android path
requires the same hand-written Kotlin service *plus* a young runtime with an open lifecycle bug
(#15671) in precisely the FGS configuration needed. *Alternative recorded:* Tauri, if a
desktop app were also being built from the same tree — but decision 1 says it is not.

**4. If Android is built — WebView-hosted or native audio?** → **WebView-hosted, gated on the
device spike.** If the spike shows the WebView path degrades with the screen off, **stop
rather than escalate**: a native audio client forks muxterm's voice implementation in two and
triples the estimate. *Conservative choice recorded:* not attempting native audio.

**5. Continuous-streaming always-listening?** → **No.** $553/month per user at 16 h/day on the
full model; $173 on mini. Indefensible on cost, and on trust given the (inferred) absent
screen-off privacy indicator.

**6. Wake-word engine?** → **Defer entirely; decide only after decision 2 flips.** Naming
candidates and licensing shape only, as scoped: **openWakeWord** (Apache-2.0, permissive, ONNX
— needs a JVM/native runtime story), **Picovoice Porcupine** (proprietary, per-device
commercial licensing with a free tier behind an AccessKey — the licensing model is the real
cost, not the code), **Vosk** (Apache-2.0, heavier, built for full ASR). Snowboy is abandoned.
*Recommendation if forced:* openWakeWord for licensing freedom, Porcupine for quality.

**7. Ship the screen wake lock now?** → **Yes.** ~15 lines, already decision #1 of the PWA
verdict, still unimplemented, and the best value-to-effort ratio available. Owned by another
lane; this document only concurs.

**8. Warn Android users that voice ends when the screen does?** → **Yes, and soon.** The
failure mode is silent — a lit orb on a dead microphone. Note that P1 found the *native* path
has the same silent failure via the Quick Settings mic toggle, so this work is not wasted even
if an app is later built.

**9. Camera and attachments — native or web?** → **Web, plus a muxterm upload endpoint and a
path-injection convention.** Decouple from the voice question completely; it was only ever
adjacent by coincidence.

**10. Is "notify me and let me reply by voice" the real need?** → **Investigate separately —
explicitly not verified here.** If the underlying want is "keep talking to my fleet without
holding a lit phone," a push notification with a reply affordance may deliver most of it with
no background microphone at all. Whether Chrome on Android supports inline reply input for web
push is **NOT SETTLED** by anything checked in this document, and should not be assumed. It is
the cheapest idea in this file if it holds, so it deserves its own short investigation before
anyone budgets a quarter for an Android app.

---

## Sources

**Repository** — `docs/designs/2026-06-30-native-companion-apps-design.md`,
`docs/designs/2026-07-01-native-companion-apps-ux-design.md`,
`docs/designs/2026-07-02-macos-window-layout-architecture-design.md`,
`docs/plans/2026-07-01-phase{0,1,2}-*.md`, commits `e86a6de` / `9713a0b` / `97daf7a`;
`docs/design/android-pwa-voice.md` and `docs/design/android-voice-probe/` on branch
`design/android-pwa-voice`, commits `5188d50` / `6397798`;
`web/src/lib/voice-session-controller.ts`, `web/src/lib/voice-input-controller.ts`,
`internal/voice/tools.go`, `internal/config/config.go`.

**Transcripts** — `/home/ken/.amplifier/projects/-home-ken/sessions/{muxterm-cos,
a09f8c7d-0bcb-483a-9fe8-f5235cd2cc9e, da041723-601d-43d7-a01e-36db20fec4cd,
a5b3d55a-81b5-4d26-9541-f2e2a28e6d06, 0000000000000000-756afde7449445e2_anchors-researcher,
0000000000000000-5c52c9371e15442a_anchors-researcher,
0000000000000000-80e29677d05d4637_anchors-researcher,
0000000000000000-f6a4e1a43e9346d5_anchors-researcher}/transcript.jsonl`.

**Android documentation**, all checked 2026-09-07 —
media/platform/sharing-audio-input ·
develop/background-work/services/fg-service-types ·
develop/background-work/services/fgs/restrictions-bg-start ·
develop/background-work/services/fgs/timeout ·
develop/background-work/services/fgs/handle-user-stopping ·
about/versions/14/changes/fgs-types-required ·
about/versions/15/behavior-changes-15 ·
about/versions/17/changes/bg-audio ·
about/versions/13/behavior-changes-all ·
training/permissions/explaining-access ·
training/monitoring-device-state/doze-standby ·
topic/performance/power/power-details ·
reference/android/Manifest.permission ·
reference/android/webkit/WebChromeClient ·
develop/ui/views/notifications/notification-permission ·
source.android.com/docs/core/permissions/privacy-indicators ·
support.google.com/googleplay/android-developer/answer/{13392821,9888379,11150561}.

**AOSP / Chromium source**, checked 2026-09-07 —
`frameworks/av/services/audiopolicy/service/AudioPolicyService.cpp` ·
`frameworks/av/services/audioflinger/Threads.cpp` ·
`frameworks/base/services/core/java/com/android/server/power/PowerManagerService.java` ·
`system/core/libcutils/include/private/android_filesystem_config.h` ·
`crbug.com/426461170` · `crbug.com/40611412`.

**Tauri / Electron**, all checked 2026-09-07 —
tauri.app/reference/config/ · tauri.app/reference/webview-versions/ · tauri.app/plugin/ ·
tauri.app/learn/system-tray/ · tauri.app/plugin/global-shortcut/ ·
tauri.app/develop/plugins/develop-mobile/ · tauri.app/distribute/macos-application-bundle/ ·
tauri.app/release/tauri/ · tauri.app/blog/tauri-20/ · crates.io/api/v1/crates/tauri ·
docs.rs/wry/0.55.1 and 0.56.1 · docs.rs/global-hotkey/latest ·
github.com/tauri-apps/tauri/issues/{5250,15671,15678,14753,15277,8314,10846,6623,8041} ·
github.com/tauri-apps/wry/issues/{85,1825,1195} ·
electronjs.org/docs/latest/api/structures/web-preferences ·
electronjs.org/docs/latest/api/power-save-blocker.

**Community** — dontkillmyapp.com (and /samsung, /xiaomi), checked 2026-09-07. Directional,
not vendor-authoritative.
