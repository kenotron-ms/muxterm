# The webview wrapper

**Premise, not a question.** muxterm's native app is a thin wrapper around a webview pointed
at the existing muxterm web app. The web app is the product. The wrapper exists only to give
that webview the platform capabilities a browser tab cannot have — chiefly audio capture and
playback that survive the screen going off, and later camera and file attachment as inputs.

This document designs that wrapper. It does not evaluate whether a wrapper is the right
architecture, and it does not compare one against a from-scratch native client.

**Status: COMPLETE** — every item W1–W6 carries a terminal verdict. See [Verdicts](#verdicts-one-line-each) and the [Recommendation](#recommendation).

---

## How to read this

Everything below is dated **2026-09-08**. Android platform behaviour is versioned and
documented; Chromium is a moving target whose defaults are Finch-controlled; Tauri and its
webview backends ship on their own cadence. Re-check before acting on this in six months.

Each claim carries a tag:

| Tag | Means |
| --- | --- |
| **[ANDROID]** | Stated by Android platform documentation, with URL and check date. |
| **[CHROMIUM]** | Verified by reading Chromium source at `main`, with file and line. |
| **[WEBVIEW]** | Stated by the Android WebView framework reference or `//android_webview/docs`. |
| **[SPEC]** | Stated by a W3C/WHATWG specification. |
| **[VENDOR]** | Stated by a third-party project's own documentation (Tauri, Picovoice, …). |
| **[INFERENCE]** | My conclusion from the above. Not stated anywhere; the reasoning is shown. |
| **[UNSETTLED]** | Cannot be established without hardware. What would settle it is named. |

Where a choice is contested I take the more conservative option, record the alternative, and
move on. Nothing here waits on a device: I have none, and no step below proposes acquiring one.

## What is already settled, and not re-litigated here

[`docs/design/android-pwa-voice.md`](./android-pwa-voice.md) (branch `design/android-pwa-voice`,
dated 2026-09-07) asked whether muxterm-as-a-PWA can hold a two-way voice conversation with the
screen off. **Its verdict is NO-GO**, on four independent grounds, each sufficient alone:

1. A service worker cannot host any part of an audio session — no `getUserMedia`, no
   `RTCPeerConnection`, no `AudioContext`. The Web Audio WG formally resolved never to change
   this. **[SPEC]**
2. The web platform's only wake lock is `"screen"`, released the instant the document hides and
   un-acquirable while hidden, and normatively "MUST NOT be applicable after the screen is
   manually switched off." **[SPEC]**
3. Android silences a background app's microphone, and the page is never told: `readyState`
   stays `"live"`, `muted` stays `false`, and the samples are zeros. **[ANDROID]** + **[CHROMIUM]**
4. A WebAPK — an installed PWA — cannot run an Android foreground service. Its Chrome-generated
   manifest holds exactly two permissions, `POST_NOTIFICATIONS` and `REORDER_TASKS`, and no
   web API starts a service. **[CHROMIUM]**

It also established, and this document depends on it, that a **Trusted Web Activity is not the
escape hatch**: a TWA's content is rendered by the user's Chrome, in Chrome's process, so a
foreground service in the host APK does not cover the page's capture. W1 revisits that with its
own evidence rather than taking it on trust.

That document recommended *not* building a wrapper, on cost grounds. This document does not
overturn that recommendation; the decision to build has been taken elsewhere. What it does is
make the cost concrete, so the recommendation is now argued from a design rather than an
estimate. Where my findings correct it — and there is one correction of substance, in W1 — it
is flagged.

**Not re-done here:** the PWA investigation, the probe, the four blocks above.

---

## The load-bearing finding: nothing in Chrome kills the microphone

This is the finding the whole wrapper rests on, so it gets settled first and in full.

**VERDICT: ANSWERED. Chromium contains no code that stops or mutes microphone capture when the
app is backgrounded or the screen goes off. The Android audio-input path has no app-lifecycle
hook at all. The silencing is done by the operating system, below Chrome, because the app
holding the capture has neither a foreground UI nor a microphone foreground service. It follows
that no web-side change can fix it, and that a wrapper running a correctly typed foreground
service is the entire remedy.**

### Step 1 — the Android audio-input path has no lifecycle hook

Chromium's Android audio backend was migrated off `AudioRecord`; `media/audio/android/` today
contains **no `audio_record_input.cc`**. The two input implementations are
`media/audio/android/aaudio_input.cc` (AAudio, the modern path) and
`media/audio/android/opensles_input.cc` (OpenSL ES, the legacy path). Verified by listing the
directory at `main` on 2026-09-08. **[CHROMIUM]** *(This corrects the file name the earlier
investigation was working from; the conclusion is unaffected.)*

Searching every file on the Android microphone path for the symbol Chromium uses to observe
Android app lifecycle — `base::android::ApplicationStatusListener` / `ApplicationState`:

| File | `ApplicationStat*` matches |
| --- | --- |
| `media/audio/android/audio_manager_android.cc` (49 KB) | **0** |
| `media/audio/android/aaudio_input.cc` (13 KB) | **0** |
| `media/audio/android/opensles_input.cc` (12 KB) | **0** |
| `content/browser/renderer_host/media/audio_input_device_manager.cc` (8.6 KB) | **0** |
| `content/browser/renderer_host/media/media_stream_manager.cc` (198 KB) | **0** |

All five checked at `main`, 2026-09-08. **[CHROMIUM]**

Searching the same files for `mute`, `background`, `screen`, `silence` and `foreground` returns
exactly one hit each in the two input streams, and it is the same line:

```cpp
bool AAudioInputStream::IsMuted() {
  return audio_manager_->IsMicrophoneMuted();
}
```
— `media/audio/android/aaudio_input.cc:397-399`

```cpp
bool OpenSLESInputStream::IsMuted() {
  return audio_manager_->IsMicrophoneMuted();
}
```
— `media/audio/android/opensles_input.cc:182-184` **[CHROMIUM]**

There is no `Suspend`, no `Pause`, no `OnBackgrounded` anywhere in the Android capture path.
Chrome does not stop the microphone. It cannot: it has not asked to be told when the app is
backgrounded.

### Step 2 — the video path *does* have that hook, which proves the absence is deliberate

The asymmetry is the strongest evidence available, because it shows Chromium knows exactly how
to do this and chose to do it for video only:

```cpp
#if BUILDFLAG(IS_ANDROID)
  // When kAndroidEnableBackgroundMediaCapturing is enabled, video capture
  // is allowed to continue even if the app is in the background.
  // Therefore, we only need to register the ApplicationStatusListener and
  // track foreground/background state if this feature is DISABLED,
  // ensuring that capture is stopped when the app is no longer active.
  if (!base::FeatureList::IsEnabled(
          media::kAndroidEnableBackgroundMediaCapturing)) {
    application_state_has_running_activities_ = true;
    app_status_listener_ =
        base::android::ApplicationStatusListener::New(base::BindRepeating(
            &VideoCaptureManager::OnApplicationStateChange, this));
  }
#endif
```
— `content/browser/renderer_host/media/video_capture_manager.cc:132-145` **[CHROMIUM]**

and the handler it installs:

```cpp
void VideoCaptureManager::OnApplicationStateChange(
    base::android::ApplicationState state) {
  // Only release/resume devices when the Application state changes from
  // RUNNING->STOPPED->RUNNING.
  if (state == base::android::APPLICATION_STATE_HAS_RUNNING_ACTIVITIES &&
      !application_state_has_running_activities_) {
    ResumeDevices();
    ...
  } else if (state == base::android::APPLICATION_STATE_HAS_STOPPED_ACTIVITIES) {
    ReleaseDevices();
    ...
  }
}
```
— same file, `:1047-1061`. `ReleaseDevices()` filters to `DEVICE_VIDEO_CAPTURE` and calls
`DoStopDevice` (`:1064-1075`). **[CHROMIUM]**

So on backgrounding, Chrome **explicitly stops the camera** — and explicitly stops doing so when
`kAndroidEnableBackgroundMediaCapturing` (the flag that makes Chrome run a real foreground
service) is on. There is no audio counterpart, in that file or any other. **[CHROMIUM]**

### Step 3 — `muted` reports the wrong thing, so the page never learns

`IsMicrophoneMuted()` returns a cached flag:

```cpp
bool AudioManagerAndroid::IsMicrophoneMuted() {
  DCHECK(GetTaskRunner()->BelongsToCurrentThread());
  return is_microphone_muted_;
}
```
— `media/audio/android/audio_manager_android.cc:1059-1062`

and that flag has exactly two writers in the file:

```cpp
is_microphone_muted_ = jni_delegate_->InitMicrophoneMuteStateListener();   // :1178
...
void AudioManagerAndroid::OnMicrophoneMuteStateChangedOnAudioThread(bool muted) {
  if (is_microphone_muted_ == muted) return;
  is_microphone_muted_ = muted;                                            // :1305
  microphone_mute_state_change_callbacks_.Notify(muted);
}
```
**[CHROMIUM]**

Both are fed by the OS **microphone-mute toggle** — the global privacy switch. Neither is fed by
Android's "your capture is being silenced because you are in the background" condition, whose
platform notification channel is `AudioManager.AudioRecordingCallback`, which Chromium does not
consume anywhere on this path. **[CHROMIUM]** (Confirming the earlier investigation's finding,
at current line numbers.)

**Consequence, stated plainly:** during the failure the track reports `readyState: "live"`,
`muted: false`, `enabled: true`, and delivers digital silence. No `mute` event, no `ended`
event, no error. Server VAD hears nothing and never fires a turn. The conversation does not
fail — it stops being a conversation, silently, with the orb still lit.

### Step 4 — what is actually doing the silencing

Android, and it is documented:

> "One more change was added in Android 9: only apps running in the foreground (or a foreground
> service) could capture the audio input. When an app without a foreground service or foreground
> UI component started to capture, **the app continued running but received silence**, even if
> it was the only app capturing audio at the time."

> "Apps with visible foreground UIs have higher priority than background apps."

— *Sharing audio input*, <https://developer.android.com/media/platform/sharing-audio-input>
(checked 2026-09-08). **[ANDROID]**

Note the parenthesis in the first sentence: *"in the foreground (or a foreground service)"*. The
foreground service is not a workaround for this policy; it is one of the two states the policy
names as sufficient. Note also that mic input is governed by this automatic prioritisation
policy, **not** by audio focus — the same page is explicit that audio focus is a different,
request-based mechanism for output.

### Step 5 — the remedy the platform names

The foreground service type `microphone` exists for exactly this and says so:

| | |
| --- | --- |
| Manifest `android:foregroundServiceType` | `microphone` |
| Manifest permission | `FOREGROUND_SERVICE_MICROPHONE` |
| Constant for `startForeground()` | `FOREGROUND_SERVICE_TYPE_MICROPHONE` |
| Runtime prerequisite | `RECORD_AUDIO` granted |
| **Description** | **"Continue microphone capture from the background, such as voice recorders or communication apps."** |

— *Foreground service types are required*,
<https://developer.android.com/develop/background-work/services/fgs/service-types>
(checked 2026-09-08). **[ANDROID]**

### The finding, assembled

The chain, with each link's evidence:

1. With the screen off, an app with no visible UI is a background app. **[ANDROID]**
2. A background app capturing audio with no microphone foreground service receives silence,
   while continuing to run. **[ANDROID]**
3. Chrome on a phone runs no microphone foreground service — `MediaCaptureNotificationServiceImpl`
   posts a plain notification instead, because `kAndroidEnableBackgroundMediaCapturing` is
   `FEATURE_DISABLED_BY_DEFAULT` on phones. **[CHROMIUM]**, established by the PWA document.
4. Chrome contains no code that would stop the capture itself — Step 1, Step 2. **[CHROMIUM]**
5. Therefore the capture is silenced by the OS, and the page cannot detect it — Step 3.
   **[INFERENCE]**, every link cited.
6. Therefore **no change to the web app can fix it.** Not a manifest field, not a service
   worker, not a wake lock, not a Media Session, not a different WebRTC configuration. The
   condition the OS is testing is a property of the *process*, and the web app does not have a
   process of its own. **[INFERENCE]**
7. Therefore a wrapper that (a) hosts the page in its own process and (b) runs a
   `microphone`-typed foreground service satisfies the exact condition Android's policy names.
   **[INFERENCE]**

**This is the entire argument for the wrapper, and it is narrow on purpose.** The wrapper is not
justified by "native is better". It is justified by one sentence of Android policy that a web
page structurally cannot satisfy. Everything the wrapper does beyond satisfying that sentence is
scope creep — which is what W3 is for.

**What is still [UNSETTLED]:** that a `microphone`-typed FGS in the host app in fact keeps a
*WebView's* capture alive. The policy is stated in terms of the app (the process), and a
WebView's capture runs in the embedding app's process (W1 establishes this), so it should
follow. But no Android document says "a foreground service in your app covers your WebView's
`getUserMedia`", and I cannot test it. **What would settle it:** the first slice in W6 — load a
page that captures, put the screen off for five minutes, and count non-silent frames in an
AudioWorklet. The PWA probe already does exactly this measurement and can be pointed at the
wrapper unchanged.

---

## W1 — The Android wrapper, concretely

**VERDICT: ANSWERED.** A plain `WebView` in a normal `Activity`, plus one `Service` with
`foregroundServiceType="microphone|mediaPlayback"`, plus a `WebChromeClient` that bridges
permissions. Roughly 300 lines of Kotlin, four manifest additions and two runtime permissions.
Trusted Web Activity and Custom Tabs are both ruled out, for the same reason, and the reason is
structural rather than a matter of effort.

### W1.1 — Which webview host

The question decides everything else, so it is decided first, on one criterion: **does the
`AudioRecord` that ends up holding the microphone live in a process my foreground service
covers?**

Android's mic policy is applied to the *app* — "apps running in the foreground (or a foreground
service)" **[ANDROID]**. A foreground service raises the process state of *its own app*. It has
no reach into another app's process. So the capture must happen in my process.

| Host | Where the page renders | Can my FGS cover its capture? |
| --- | --- | --- |
| **Plain `WebView`** | **My process** | **Yes** |
| Trusted Web Activity | The user's Chrome | No |
| Custom Tabs | The user's Chrome | No |

**Plain `WebView` — the capture is mine.** WebView's own architecture documentation is explicit:

> "When an Android app embeds WebView, WebView's browser code runs in the app's process (we call
> this the 'browser process'). This means WebView code shares the same address space, and we
> generally consider the app to be trusted just like any other browser process code. WebView's
> browser process code runs in the same context as the embedding application, which means it has
> **all the same permissions and limitations of the embedding app**."

> "WebView runs other services (ex. GPU service, Network Service) **in-process on all OS
> versions**."

— `//android_webview/docs/architecture.md`, <https://chromium.googlesource.com/chromium/src/+/HEAD/android_webview/docs/architecture.md>
(checked 2026-09-08) **[WEBVIEW]**

Audio is one of those services, and Chromium confirms it is in-process on Android:

```cpp
// Runs the audio service in a separate process.
BASE_FEATURE(kAudioServiceOutOfProcess,
#if BUILDFLAG(IS_WIN) || BUILDFLAG(IS_MAC) || BUILDFLAG(IS_LINUX)
             base::FEATURE_ENABLED_BY_DEFAULT
#else
             base::FEATURE_DISABLED_BY_DEFAULT
#endif
);
```
— `content/public/common/content_features.cc:160-167` **[CHROMIUM]**

Android is not in the enabled list, so the audio service — and with it `AAudioInputStream`, and
with it the `AudioRecord`/AAudio handle that Android's policy is applied to — runs in the
browser process, which for WebView is **my app's process**. That is the whole chain, and it is
the reason a plain `WebView` works and the alternatives do not. **[INFERENCE]** from two cited
facts.

**Trusted Web Activity — ruled out.** Chrome's own TWA documentation:

> "The content rendered in a Trusted Web Activity comes from the web: they're **rendered by the
> user's browser**, in exactly the same way as a user would see it in their browser except they
> are run fullscreen."

> "**The host app doesn't have direct access to web content** in a Trusted Web Activity or any
> other kind of web state, like cookies and `localStorage`. Nevertheless, you can coordinate with
> the web content by passing data to and from the page in URLs."

— <https://developer.chrome.com/docs/android/trusted-web-activity/> (checked 2026-09-08; ⚠ page
last updated 2020-02-04) **[VENDOR]**

**Answering the item's specific question: a TWA *can* host a foreground service — and it does
not help.** Nothing stops a TWA host APK declaring a `Service` with
`foregroundServiceType="microphone"` and calling `startForeground()`; it is an ordinary Android
app. What it cannot do is make that service cover a capture that is running **in Chrome's
process**. The FGS would raise the process state of the host APK, which is not the app holding
the microphone. Chrome's own capture governance — `MediaCaptureNotificationServiceImpl`, gated
off on phones — is what applies, and the PWA document already established that it posts a plain
notification rather than starting an FGS.

So: **the FGS requirement does not by itself force a plain WebView. Process identity does.**
This is a real distinction, because "can it host an FGS" is the question people ask and the
answer is yes, which is misleading. **[INFERENCE]**, clearly labelled: no document states "a
TWA's FGS does not cover the page's capture" in those words. It follows from (a) Android
applying the policy per-app, (b) Chrome rendering the content, and (c) the documented absence of
host↔content access. Treat "TWA + foreground service = background microphone" as **not
demonstrated, and structurally unlikely.** *Conservative choice recorded; the alternative — that
some cross-process propagation exists — would be settled by the same screen-off frame count as
everything else in W6.*

**Custom Tabs — ruled out, same reason, more so.** A Custom Tab is the mechanism a TWA is built
on; the same documentation notes Chrome "will fall back to a simple toolbar using a Custom Tab"
when TWA is unsupported. It renders in the browser, adds browser chrome, and gives the host app
strictly less control than a TWA. **[VENDOR]**

**What each costs in capability**, since the item asks:

| | Plain `WebView` | TWA | Custom Tabs |
| --- | --- | --- | --- |
| Background mic via my FGS | **yes** | no | no |
| Engine | System WebView (updatable since Lollipop) | User's Chrome | User's Chrome |
| Media Session API | **absent** — `webview_android: false`, <https://crbug.com/40611412> | present | present |
| Permission prompts | **I must build them** (W1.3) | Chrome's | Chrome's |
| Browser chrome visible | none | none | URL bar |
| Native↔web channel | **`addJavascriptInterface`, direct** | URLs and intents only | URLs and intents only |
| Cookie jar / storage | app-private | shared with Chrome | shared with Chrome |

The Media Session loss is real but, for muxterm, free: the PWA document established that
`MediaSession` is inert for a `srcObject` `MediaStream` on Android anyway
(`MediaContentType::kOneShot`), so there is nothing to lose. The permission-prompt cost is the
one that bites, and it is W1.3.

**Decision: plain `WebView`.** Recorded alternative: TWA, rejected on process identity, revisit
only if Chrome ships a documented mechanism for a host app's FGS to cover TWA content.

### W1.2 — The foreground service

**One service, two types.** `microphone` for the capture; `mediaPlayback` for the inbound
assistant audio and the Android 15 audio-focus rule. Both are needed and they are cheap to
declare together, but note the platform's own guidance — *"Usually, you should declare only the
types required for a particular use case"* **[ANDROID]** — so the service should call
`startForeground()` with only the types the current session actually uses.

**Manifest, complete.** This is the entire delta from an empty app:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

<service
    android:name=".VoiceSessionService"
    android:exported="false"
    android:foregroundServiceType="microphone|mediaPlayback" />
```

Sources for each line: `FOREGROUND_SERVICE_MICROPHONE` and the `microphone` type from
*Foreground service types are required*
(<https://developer.android.com/develop/background-work/services/fgs/service-types>, checked
2026-09-08) **[ANDROID]**; `POST_NOTIFICATIONS` from *Notification runtime permission*
(<https://developer.android.com/develop/ui/views/notifications/notification-permission>, checked
2026-09-08) **[ANDROID]**.

**The version-by-version tightening**, which is what the cached release documentation is for:

| Version | Change | What it forces on this design |
| --- | --- | --- |
| **9** (API 28) | *"only apps running in the foreground (or a foreground service) could capture the audio input… the app continued running but received silence"* | The entire reason the wrapper exists. **[ANDROID]** |
| **12** (API 31) | Apps targeting 12+ **cannot start an FGS from the background**; violation throws `ForegroundServiceStartNotAllowedException`. And: an FGS needing while-in-use permissions (microphone included) *"cannot create the service while the app is in the background, even if the app falls into one of the exemptions"*. | **Start the service from the visible Activity, on the user's tap that starts voice.** Never from a broadcast, alarm, or push. There is no exemption to lean on. **[ANDROID]** |
| **13** (API 33) | `POST_NOTIFICATIONS` becomes a runtime permission. *"Apps don't need to request the POST_NOTIFICATIONS permission in order to launch a foreground service. However, apps must include a notification when they start a foreground service."* | The FGS still runs if the user denies notifications; the notification is simply not shown. Do not gate voice on notification permission. **[ANDROID]** |
| **13** (API 33) | **Task Manager.** *"users can complete a workflow from the notification drawer to stop an app that has an ongoing foreground service, regardless of that app's target SDK version."* Pressing **Stop** removes the app from memory, clears the back stack, stops media playback, removes the notification — and *"the system doesn't send your app any callbacks."* | A user-visible kill switch exists and is silent. On next launch, check `ApplicationExitInfo` for `REASON_USER_REQUESTED` and do not auto-restart a session the user killed. **[ANDROID]** |
| **14** (API 34) | Every FGS **must** declare a type or `startForeground()` throws `MissingForegroundServiceTypeException`; calling it without the type-specific permission throws `SecurityException`. Passing a type not declared in the manifest throws `IllegalArgumentException`. | Use `ServiceCompat.startForeground(...)` from `androidx-core` 1.12+ with an explicit type bitmask. Three separate crash modes if the manifest and the call disagree. **[ANDROID]** |
| **15** (API 35) | *"Apps that target Android 15 (API level 35) must be the top app or running a foreground service in order to request audio focus. If an app attempts to request focus when it does not meet one of these requirements, the call returns `AUDIOFOCUS_REQUEST_FAILED`."* | The **playback** half now needs the FGS too, not just capture. This is why `mediaPlayback` is in the type list. **[ANDROID]** |

**Sequencing, which the above makes non-negotiable:**

1. User taps the orb in the web page. The Activity is visible.
2. Web page calls into the bridge (W4): "voice session starting".
3. Native checks `RECORD_AUDIO`; if not granted, requests it and waits. *(Android 12+: a
   `microphone` FGS cannot be created without it.)*
4. Native calls `startForegroundService()` then `ServiceCompat.startForeground(id, notification,
   FOREGROUND_SERVICE_TYPE_MICROPHONE or FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)` — **while the
   Activity is still visible.**
5. Only then does the page call `getUserMedia()`.
6. On session end (including the existing `end_voice_session` realtime tool), the page tells the
   bridge, and native calls `stopForeground()` + `stopSelf()`.

Step 4 before step 5 matters and step 6 matters more: an FGS that outlives the session is a
persistent notification, a battery complaint, and a Play policy problem.

**What the user sees in the notification shade.** An ongoing notification for as long as voice is
live, with the app icon and whatever title and text the app sets, on a channel the app creates.
It must be at least `PRIORITY_LOW`; below that, *"the system adds a message to the notification
drawer, alerting the user to the app's use of a foreground service"* **[ANDROID]** — i.e. the
platform will narrate it for you, worse. Alongside it: Android's **microphone privacy indicator**
(the green dot in the status bar, tappable to a chip naming the app), which is not optional and
not suppressible. And in the Task Manager list of "Active apps", with a **Stop** button.

Design consequence: the notification is the honest surface for "muxterm is listening", so it
should say that in plain words and carry one action — **Stop voice** — that ends the session
cleanly rather than letting the user reach for the Task Manager's harder kill. That action is a
`PendingIntent` to the service; it is the one piece of native UI this design admits, and W3
explains why it does not count as a breach of the boundary.

### W1.3 — What the WebView needs before `getUserMedia` works at all

This is the step that is genuinely, commonly missed, and it fails closed and silently.

**A `WebView` denies every media permission by default.** Not "prompts and denies" — denies,
with no UI and no log:

> `onPermissionRequest(PermissionRequest request)` — "Notify the host application that web
> content is requesting permission to access the specified resources and the permission currently
> isn't granted or denied. The host application must invoke `PermissionRequest.grant(String[])`
> or `PermissionRequest.deny()`. **If this method isn't overridden, the permission is denied.**"

— `android.webkit.WebChromeClient`, API level 21,
<https://developer.android.com/reference/android/webkit/WebChromeClient> (checked 2026-09-08)
**[WEBVIEW]**

So `navigator.mediaDevices.getUserMedia({audio:true})` inside a stock `WebView` rejects with
`NotAllowedError` forever, on a page that works perfectly in Chrome, with nothing in logcat
explaining why. The resource string to grant is `PermissionRequest.RESOURCE_AUDIO_CAPTURE` =
`"android.webkit.resource.AUDIO_CAPTURE"` (API 21); the camera equivalent is
`RESOURCE_VIDEO_CAPTURE` = `"android.webkit.resource.VIDEO_CAPTURE"`. **[WEBVIEW]**

**There are two permission layers and both must pass.** The Android runtime permission
(`RECORD_AUDIO`, granted by the user to the *app*) and the WebView permission (granted by the
*app* to the *page*). Granting one does not grant the other. The correct bridge is: on
`onPermissionRequest`, verify the origin is muxterm's, verify the app holds `RECORD_AUDIO`,
request it if not, and only then `grant()`. Naively calling `request.grant(request.resources)`
unconditionally is the standard sample-code mistake — it grants any origin any resource, which
matters the moment a page can be navigated somewhere else.

`AwContents` exposes a second path, `preauthorizePermission(Uri origin, long resources)`
(`AwContents.java:3597-3602`, calling through to native
`AwContentsJni.get().preauthorizePermission`) **[CHROMIUM]**, reachable from the app via
`android.webkit.WebView#preauthorizePermission`. It grants an origin a resource ahead of time so
`onPermissionRequest` is never raised. Tempting for a single-origin wrapper. **Not recommended
for the first slice:** it moves the grant away from the moment of use, which is exactly where a
reviewer and a user look for it. Recorded as the alternative if the prompt path proves flaky.

**The rest of the `WebSettings` delta**, each of which is off or restrictive by default:

| Setting | Value | Why |
| --- | --- | --- |
| `javaScriptEnabled` | `true` | Default `false`. Nothing works without it. **[WEBVIEW]** |
| `domStorageEnabled` | `true` | Default `false`. muxterm uses `localStorage`. **[WEBVIEW]** |
| `mediaPlaybackRequiresUserGesture` | `false` | *"The default is `true`."* The inbound assistant track is attached to an `<audio>` element and played programmatically — with the default, playback is blocked. **[WEBVIEW]** |

Two more that need no action, recorded so nobody spends a day on them:

- **Renderer priority.** *"The default policy is to set the priority to
  `RENDERER_PRIORITY_IMPORTANT` regardless of visibility"* — equivalent to `BIND_IMPORTANT`,
  *"the same priority as your app's main process"*. **[WEBVIEW]** So a backgrounded WebView's
  renderer is already protected; `setRendererPriorityPolicy` should be left alone.
- **Secure context.** muxterm is served over HTTPS at `https://muxterm.ampbox.io`, so the page is
  a secure context and `getUserMedia` is reachable. No `cleartextTraffic` exception, no local CA,
  no `setAllowFileAccess` games.

And one that must be actively **not** done: **do not call `WebView.onPause()` or
`WebView.pauseTimers()` from `Activity.onPause()`.** `pauseTimers()` *"Pauses all layout,
parsing, and JavaScript timers for all WebViews"* **[WEBVIEW]** — the wrapper would be stopping
the very thing the foreground service exists to keep running. This is the single most likely way
to build the whole thing correctly and still have it fail, because pausing the WebView in
`onPause` is the idiom every tutorial teaches.

**Known defect to carry, not to fix.** A remote WebRTC audio track feeds an `AnalyserNode`
nothing but zeros unless the stream is *also* attached to an audio element. muxterm already
attaches one, so the level meter works today; the wrapper must not "optimise" that element away
on the theory that native is handling playback. Noted here because inside a WebView it will bite
identically and look like a wrapper bug.

### W1.4 — Screen off: what survives, and what still kills it

**Expected to survive**, given a correctly typed FGS started from a visible Activity:

- **Capture.** The app is "running a foreground service", which is one of the two states
  Android's mic policy names as sufficient. **[ANDROID]** + **[INFERENCE]**; see the
  [UNSETTLED] note at the end of the load-bearing finding.
- **Playback.** Same FGS satisfies Android 15's audio-focus precondition. **[ANDROID]**
- **The renderer.** Bound at `RENDERER_PRIORITY_IMPORTANT` regardless of visibility.
  **[WEBVIEW]**
- **JavaScript, the peer connection, the `<audio>` element.** WebView is not Chrome: it has no
  `PageScheduler` tab-freezing story driven by Chrome's `kStopInBackground`, whose Android
  default was set for browser tabs. **[INFERENCE]** — and see the caveat below, because this is
  the weakest claim in the section.

**What still kills it — the real list:**

1. **Vendor battery managers.** The largest risk, and not a bug I can fix. Huawei, Xiaomi,
   OnePlus, Samsung, Meizu, Asus, Oppo and others kill background apps beyond AOSP policy;
   `dontkillmyapp.com` catalogues per-vendor behaviour and rates several at 5/5 aggression, with
   AOSP/Pixel and Nokia at 0. **[VENDOR]** Mitigation is the standard one — request
   `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, document the per-vendor toggle — and it is partial by
   nature. **Plan for a Pixel-class device first and treat everything else as a support matter.**
2. **The Task Manager Stop button.** Silent, immediate, total. **[ANDROID]** Handled by detecting
   `REASON_USER_REQUESTED` on next start and not resurrecting.
3. **Low-memory kill.** `RENDERER_PRIORITY_IMPORTANT` makes the renderer *"less likely"* to be
   killed, not safe; the FGS raises the app's own process state. `WebViewClient.onRenderProcessGone`
   must be handled or the app crashes when the renderer dies. **[WEBVIEW]**
4. **Another app taking the microphone.** *"Two ordinary apps can never capture audio at the same
   time"*, and *"if two background apps of same priority are capturing audio, the last one started
   has higher priority."* **[ANDROID]** A phone call, or the Assistant, wins. There is no signal
   to the page (Step 3 of the load-bearing finding), so the wrapper should watch
   `AudioManager.AudioRecordingCallback` natively — which Chromium does not — and push a
   `mic-silenced` event over the bridge (W4). **This is the one place the wrapper adds a
   capability the page could never have, rather than merely permitting one.**
5. **Doze.** Deep Doze defers jobs and alarms and restricts network. An app running a foreground
   service is not deep-dozed while the service runs, but the device may still be in a restricted
   state around it; App Standby buckets apply to apps the user is not using. **[ANDROID]** The
   session is user-initiated and short-lived, so this is a second-order concern — but it is the
   reason "always listening" in W5 is a different and much harder problem than "listening during
   a session".
6. **Chrome's direction of travel, inherited.** WebView is Chromium. `kAndroidSuspendWebRtcOnScreenOff`
   maps `ACTION_SCREEN_OFF` to a WebRTC suspend; it is `FEATURE_DISABLED_BY_DEFAULT` today.
   **[CHROMIUM]**, established by the PWA document. WebView does not read Chrome's Finch config,
   but it does inherit source defaults when the WebView provider updates. **If that default
   flips, the wrapper breaks and no manifest entry saves it.** This is the single largest
   long-term risk to the whole design, and it should be a watch item rather than a mitigation.

### W1.4b — The second killer, which the foreground service does not fix

Claim 4 of the survival list above was the weakest, so I went and read it. **It is wrong as
stated, and the correction is the most actionable thing in W1.**

**WebView marks its page hidden when the containing window becomes invisible.** The chain, all in
`AwContents.java` at `main`, checked 2026-09-08:

```java
@Override
public void onWindowVisibilityChanged(int visibility) {
    boolean windowVisible = visibility == View.VISIBLE;
    if (mIsWindowVisible == windowVisible) return;
    setWindowVisibilityInternal(windowVisible);       // :5040-5045
}
```
→ `setWindowVisibilityInternal` → `postUpdateVisibility` → `updateWebContentsVisibility()`:

```java
boolean contentVisible = AwContentsJni.get().isVisible(mNativeAwContents);
if (contentVisible && !mIsContentVisible) {
    mWebContents.updateWebContentsVisibility(Visibility.VISIBLE);
} else if (!contentVisible && mIsContentVisible) {
    mWebContents.updateWebContentsVisibility(Visibility.HIDDEN);   // :3880-3892
}
```
**[CHROMIUM]** So when the Activity stops, `PageSchedulerImpl::IsPageVisible()` becomes false.

**And Blink's background-freezing feature is enabled for WebView builds:**

```cpp
// Freeze scheduler task queues in background after allowed grace time.
BASE_FEATURE(kStopInBackground,
             "stop-in-background",
#if BUILDFLAG(IS_ANDROID) && !BUILDFLAG(IS_CAST_ANDROID) && \
    !BUILDFLAG(IS_DESKTOP_ANDROID)
             base::FEATURE_ENABLED_BY_DEFAULT
```
— `third_party/blink/common/features.cc:2229-2239` **[CHROMIUM]** WebView is `IS_ANDROID`, is not
Cast, is not desktop Android. It gets the enabled default. (Note the Cast carve-out's stated
reason — *"to prevent apps that play audio in the background from stopping"* — which is Chromium
saying in a comment that this feature stops background audio.)

**The one exemption is audibility, and it expires 30 seconds after sound stops:**

```cpp
bool PageSchedulerImpl::IsBackgrounded() const {
  return !IsPageVisible() && !IsAudioPlaying() &&
         !main_thread_scheduler_->IsVirtualTimeEnabled();     // :807-814
}
bool PageSchedulerImpl::IsAudioPlaying() const {
  return audio_state_ == AudioState::kAudible ||
         audio_state_ == AudioState::kRecentlyAudible;        // :453-456
}
```
with `static constexpr base::TimeDelta kRecentAudioDelay = base::Seconds(30);`
(`page_scheduler_impl.h:159`). Freezing only runs inside `if (IsBackgrounded())`. **[CHROMIUM]**

**So, the corrected picture.** With the screen off, a voice session in a WebView is protected from
freezing **only while the assistant is actually speaking, plus 30 seconds.** A conversational gap
longer than that — the user thinking, reading, walking to another room — makes the page
backgrounded, and after the freeze grace period (source constant
`kDefaultDelayForBackgroundTabFreezing` is 1 minute, a neighbouring comment and the WICG spec say
5, and the shipped value is the Finch parameter `DelayForBackgroundTabFreezingMills`, so treat it
as **1–5 minutes, server-controlled**) the page is frozen: media elements paused, audio graph
stopped.

**The foreground service does not help here at all.** It solves the OS's microphone policy. This
is Blink's scheduler, one layer up, in the same process, and entirely indifferent to it. **Two
independent killers, two independent fixes.** Anyone who ships the FGS, tests a session with the
assistant talking continuously, sees it survive, and declares victory will have shipped a
wrapper that dies during the first pause.

**The fix, and it is one the wrapper owns and a web page could never reach.** `mIsWindowVisible`
is set from a value the *embedder* supplies. Subclass `WebView`, override
`onWindowVisibilityChanged(int)`, and pass `View.VISIBLE` to `super` for the duration of a voice
session:

```kotlin
class MuxtermWebView(ctx: Context) : WebView(ctx) {
    /** Set true only while VoiceSessionService is running. */
    var pinVisible = false
    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(if (pinVisible) View.VISIBLE else visibility)
    }
}
```

Then `IsPageVisible()` stays true, `IsBackgrounded()` is false regardless of audio, and no freeze
timer starts. **[INFERENCE]**, from the three cited code paths — no document states "override
`onWindowVisibilityChanged` to prevent Blink freezing", and this is exactly the kind of
implementation-detail dependency W3 would normally be suspicious of. It is admitted because the
alternative is a wrapper that works only while the assistant is talking, and because it is
*seven lines inside the wrapper* rather than a change to the product.

*Conservative choice recorded:* pin visibility **only while a session is live**, never
unconditionally, so a backgrounded muxterm with no voice session behaves like any other app and
freezes normally. *Alternative considered and rejected:* accept the freeze and drive audio from an
`AudioWorklet`, which would be a change to the web app's voice implementation — out of scope, and
it would not save the `<audio>` element that the Page Lifecycle freeze steps explicitly pause.

**Still [UNSETTLED], and now precisely:** that the visibility pin actually prevents the freeze on a
device, and that a `microphone` FGS in the host app in fact keeps a *WebView's* capture alive.
Both are settled by the same five-minute measurement in W6 — and the PWA investigation's probe
already counts total frames and non-silent frames separately, which is exactly the instrument
that tells "capture stopped" from "capture delivered zeros" from "JavaScript stopped running."
Point it at the wrapper unchanged.

### W1.5 — The whole Android app, in one list

Nothing here is speculative; every item traces to a citation above.

1. `AndroidManifest.xml` — six `<uses-permission>`, one `<activity>`, one `<service>`.
2. `MainActivity.kt` — creates the `WebView`, applies the three `WebSettings`, installs the
   `WebChromeClient` and `WebViewClient`, loads `https://muxterm.ampbox.io`. Handles back as
   in-page history. Does **not** pause the WebView.
3. `MuxtermChromeClient.kt` — `onPermissionRequest` origin check + `RECORD_AUDIO` check + grant;
   `onPermissionRequestCanceled`; later `onShowFileChooser` for attachments.
4. `VoiceSessionService.kt` — notification channel, ongoing notification with a **Stop voice**
   action, `ServiceCompat.startForeground` with the type bitmask, `AudioRecordingCallback`
   watcher, `stopSelf` on stop.
5. `MuxtermBridge.kt` — the `@JavascriptInterface` object. W4 defines its surface.
6. `web/src/lib/native-bridge.ts` — the web-side half. W4 defines it; it is buildable today.

Effort is costed in W6.

---

## W2 — The desktop wrapper, concretely

**VERDICT: ANSWERED, and the answer contains one hard fact that decides the near term.**

**Desktop has no screen-off problem in Android's sense.** No desktop OS feeds silence to a
background app's microphone. The wrapper's job on desktop is therefore completely different: not
*permitting* capture, but *reaching* the machine — tray presence, a global shortcut, a window
that can hide without dying.

**But Tauri's current stable release cannot grant microphone permission to its own webview.**
Not "is awkward" — cannot, on any platform, because the API does not exist in the version it
pins. This is a versioning fact with a date, and it will stop being true; see below.

### W2.1 — The Tauri version fact, stated plainly

| Crate | Version | Published |
| --- | --- | --- |
| `tauri` (latest stable) | **2.11.5** | 2026-07-01 |
| `tauri-runtime-wry` (latest stable) | 2.11.4 | — |
| ↳ its `wry` dependency requirement | **`^0.55.0`** | — |
| `wry` 0.55.1 (newest satisfying `^0.55.0`) | 0.55.1 | 2026-05-04 |
| `wry` **0.56.0** — first release with `WebViewBuilder::with_permission_handler` | 0.56.0 | **2026-07-30** |
| `wry` 0.56.1 | 0.56.1 | 2026-08-13 |

Verified directly against the crates.io API and docs.rs on 2026-09-08:
<https://crates.io/api/v1/crates/tauri>, <https://crates.io/api/v1/crates/wry>,
<https://crates.io/api/v1/crates/tauri-runtime-wry/2.11.4/dependencies>,
<https://docs.rs/wry/0.56.1/wry/struct.WebViewBuilder.html>,
<https://docs.rs/wry/0.56.1/wry/enum.PermissionKind.html> (which lists `Microphone` — *"Microphone
access permission"* — and `Camera` among 16 variants). **[VENDOR]**

Under Cargo's semver rules for `0.x` crates, `^0.55.0` means `>=0.55.0, <0.56.0`. **Stable Tauri
cannot resolve to a `wry` that has the permission handler.** **[INFERENCE]**, from two verified
version facts.

Why that matters: a webview denies media permissions by default on every desktop backend, and
each backend fails closed and quietly, exactly as Android's WebView does.

- **Linux / WebKitGTK:** *"If the last reference is removed on a `WebKitPermissionRequest` and the
  request has not been handled, `webkit_permission_request_deny()` will be the default action."*
  — <https://webkitgtk.org/reference/webkit2gtk/stable/signal.WebView.permission-request.html>
  (checked 2026-09-08) **[VENDOR]**
- **Windows / WebView2:** the host must handle `PermissionRequested`, which *"is raised when
  content in a WebView requests permission to access some privileged resources"*, with
  `CoreWebView2PermissionKind.Microphone = 0x1`, *"Indicates permission to capture audio."*
  — <https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2permissionkind>
  (page dated 2026-08-03) **[VENDOR]**
- **macOS / WKWebView:** the host must implement `requestMediaCapturePermission`. **[VENDOR]**

wry's own issue for this was open for five years: **wry #81, "Support for web APIs that require
permissions"**, opened 2021-02-25 — *"Currently (at least on Linux), doing any action that
requires permission… fails as the permission request is immediately denied"* — **closed
2026-06-11** by **PR #1654**, which *"adds `WebViewBuilder::with_permission_handler`"* and wires
WebView2's `PermissionRequested`, WKWebView's `requestMediaCapturePermission`, and WebKitGTK's
`permission-request`. <https://github.com/tauri-apps/wry/issues/81>,
<https://github.com/tauri-apps/wry/pull/1654> **[VENDOR]**

Also open and worth knowing before building: **wry #1195**, *"Fix `getDisplayMedia()`
`getUserMedia()` permission prompt on macOS"* (opened 2024-03-20, last updated 2025-09-02) —
*"Show permission prompt for camera and microphone **twice** (application level and webview
level)."* **OPEN.** <https://github.com/tauri-apps/wry/issues/1195> **[VENDOR]** A double prompt
is a UX defect, not a blocker, but it is the state of the art on the platform muxterm's author
is most likely to build on first.

**Conclusion on Tauri, conservative as instructed.** Tauri is the right shape and the wrong
version. The gap is one dependency bump wide and closing — the code exists, is merged, and is
published in `wry`. **Do not build the desktop wrapper on Tauri stable today; re-check
`tauri-runtime-wry`'s `wry` requirement before starting.** The moment it reads `^0.56`, Tauri is
the answer.

**If it has not moved when desktop work starts, the alternative is Electron**, recorded and not
selected. Electron's equivalent is `session.setPermissionRequestHandler`, where camera and
microphone arrive as the `media` permission with `details.mediaTypes` naming which; plus, on
macOS, `systemPreferences.askForMediaAccess('microphone')` to trigger the OS TCC prompt, which
*"In order to properly leverage this API, you must set the `NSMicrophoneUsageDescription` …
strings in your app's `Info.plist` file."* <https://www.electronjs.org/docs/latest/api/session>,
<https://www.electronjs.org/docs/latest/api/system-preferences> (checked 2026-09-08) **[VENDOR]**
The cost of Electron is a Chromium per app and ~100 MB; the cost of waiting is time. Given W3's
insistence that the wrapper stay thin, either is survivable — this is a packaging choice, not an
architecture one, and it should be made on the version fact at the moment work starts.

### W2.2 — Can a desktop webview hold the microphone while hidden or minimised?

**Yes, as far as any primary source documents — with one caveat that is about the webview, not
the OS.**

**macOS: documented, from the WebKit engineer who owns WebRTC.** In WebKit bug 226620,
*"Microphone stopped/paused when application goes to background"*, youenn fablet replied on
2022-03-23:

> "**It is not expected that audio tracks be muted in Safari on Mac.**
> <https://webrtc.github.io/samples/src/content/peerconnection/pc1/> continues to play audio for
> me when Safari is in the background. …
> @dharjanto, for WKWebView, **muting is happening on iOS** in case `UIBackgroundModes` … does
> not contain `"audio"`. Can you try that?"

and closed the bug `RESOLVED / CONFIGURATION CHANGED`.
<https://bugs.webkit.org/show_bug.cgi?id=226620> (checked 2026-09-08) **[VENDOR]**

Two things fall out. On **macOS**, backgrounding does not mute WKWebView capture — so a Tauri or
Electron app hidden to the tray keeps its microphone. On **iOS**, it does, and the remedy is one
Info.plist key, `UIBackgroundModes` containing `"audio"`
(<https://developer.apple.com/documentation/BundleResources/Information-Property-List/UIBackgroundModes>).
That is the promised one-or-two-line iOS note, and iOS is otherwise out of scope: the structure —
a wrapper hosting the web app in its own process, declaring a background capability the OS
requires — is the same shape as Android, with a different declaration.

*(A later comment on the same bug, 2024-10-19: "This is broken on Web Apps that use Add to Home
Screen. Safari: Works; Add to Home Screen: Microphone stopped working." That is the iOS analogue
of the Android PWA verdict, and it is consistent with it.)*

**macOS App Nap does not apply to an audible app.** An app is an App Nap candidate only if,
among other conditions, *"It isn't audible"*; the measures listed are priority reduction, timer
throttling and I/O throttling — nothing about capture.
<https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/AppNap.html>
(⚠ Apple archive, last updated 2016-09-13 — old, but the only primary App Nap document)
**[VENDOR]**

**Windows: no documented mute-on-background policy for Win32 apps.** The nearest primary API is
`SetThreadExecutionState`, which exists specifically because *"media-recording and
media-distribution applications … must perform critical background processing on desktop
computers while the computer appears to be sleeping"* (`ES_AWAYMODE_REQUIRED`), with
`ES_SYSTEM_REQUIRED` to *"force the system to be in the working state"*.
<https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate>
(page dated 2021-10-13) **[VENDOR]** Windows' "background apps" privacy setting governs
UWP/Store apps, not Win32. **[UNSETTLED]** as a citable negative — I found no Microsoft page that
states the absence outright, and absence of a policy is hard to cite.

**The real Windows risk is the webview, not the OS**, and it is documented:

> "There are CPU and memory benefits when the page is hidden. For instance Chromium has code that
> **throttles activities on the page like animations and some tasks are run less frequently**."

— `CoreWebView2Controller.IsVisible`,
<https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2controller.isvisible>
(checked 2026-09-08) **[VENDOR]**

Design consequence, and it is the desktop twin of "do not call `WebView.onPause()`": **when
hiding to tray, do not set `IsVisible = false` and do not destroy the webview.** Hide the *window*.
The idiomatic tray implementation does exactly the wrong thing here.

**Linux: [UNSETTLED].** I found no freedesktop, PipeWire or systemd document stating any policy
on capture during DPMS display blanking, and none is likely to exist because there is no such
policy — but I will not assert a negative from failure to find it. **What would settle it:** run
a capture, `xset dpms force off`, and count non-silent frames. Cheap, and doable on the machine
this is being written on, which is a Linux box — but out of scope for this document, which
designs rather than tests.

### W2.3 — Display sleep is not system sleep, and only one of them is a problem

This is the honest answer to "does desktop even have a screen-off problem".

**Display sleep and system sleep are separate, documented, independently controllable states on
both macOS and Windows:**

- macOS: `kIOPMAssertionTypePreventUserIdleDisplaySleep` — *"Prevents the display from dimming
  automatically… While the display is prevented from dimming, the system cannot go into idle
  sleep."*
  <https://developer.apple.com/documentation/iokit/kiopmassertiontypepreventuseridledisplaysleep>
  **[VENDOR]** And `caffeinate(8)` exposes them as separate flags: `-d` display, `-i` idle
  system, `-s` system. **[VENDOR]**
- Windows: `ES_DISPLAY_REQUIRED` *"Forces the display to be on"* versus `ES_SYSTEM_REQUIRED`
  *"Forces the system to be in the working state"* — two independent flags in the same call.
  **[VENDOR]**

So: **the display going dark on a desktop does not stop an audio capture.** No OS documents
doing so, and the APIs that exist treat display and system as orthogonal. **System sleep
(S3 / Modern Standby) does** suspend capture — that is the real boundary, and it is the same
boundary a native app faces. The correct behaviour for the wrapper is the same as any conferencing
app: assert `ES_SYSTEM_REQUIRED` (Windows) or an idle-sleep assertion (macOS) **for the duration
of a voice session only**, and release it the moment the session ends.

**Net: desktop's problem is not "the screen went off". It is "the window is not on screen and the
user needs a way back to it".** Which is tray and shortcut.

### W2.4 — Tray presence and global shortcuts

**Tray** is a core Tauri feature, not a plugin: `tauri = { version = "2.x", features = ["tray-icon"] }`,
built with `tauri::tray::TrayIconBuilder`. The JS API additionally needs the `core:tray:default`
permission set (`allow-new`, `allow-set-icon`, `allow-set-menu`, `allow-set-tooltip`, …).
<https://v2.tauri.app/learn/system-tray/> (page last updated 2026-04-20),
<https://v2.tauri.app/reference/acl/core-permissions/> **[VENDOR]**

Two Linux caveats, both documented:

- Build dependency: `libayatana-appindicator3-dev` (Debian) / `libappindicator-gtk3-devel`
  (Fedora) / `libappindicator-gtk3` (Arch). <https://v2.tauri.app/start/prerequisites/> **[VENDOR]**
- Behaviour: **"Linux: Unsupported.** The event is not emitted even though the icon is shown and
  will still show a context menu on right click." — i.e. left-click-to-toggle does not work; the
  context menu does. <https://v2.tauri.app/learn/system-tray/> **[VENDOR]**

**Global shortcuts** need `tauri-plugin-global-shortcut` (v2.3.2) plus explicit permissions —
**"No features are enabled by default"**, so `global-shortcut:allow-register`,
`:allow-unregister`, `:allow-is-registered` must be listed.
<https://v2.tauri.app/plugin/global-shortcut/> (page last updated 2025-02-22) **[VENDOR]**

The backing crate is `global-hotkey`, whose README states platform support as **"Windows, macOS,
Linux (X11 Only)"** and notes *"On macOS, an event loop must be running on the main thread."*
<https://github.com/tauri-apps/global-hotkey> **[VENDOR]** **Wayland global shortcuts are a real
gap** — the portal-based path (`org.freedesktop.portal.GlobalShortcuts`) is what Electron uses
and Tauri's backing crate does not. On a Wayland desktop, plan for tray-only activation.

Whether macOS global shortcuts require an Accessibility or Input Monitoring grant is
**[UNSETTLED]**: neither the Tauri plugin documentation nor the `global-hotkey` README mentions
one, and Carbon-style hotkey registration historically needs no TCC grant. Do not assume a
prompt; do not assume its absence either. Settled by running it once on a Mac.

### W2.5 — Is desktop materially easier? Yes — but not *first*

**Easier, on the merits:**

- No foreground service, no service type, no `startForeground` sequencing, no three distinct
  crash modes for a manifest/call mismatch.
- No OS policy silencing a hidden app's microphone (macOS documented; Windows and Linux
  undocumented-because-absent).
- Display sleep is not a threat; only system sleep is, and one assertion handles it.
- No Play policy, no `targetSdk` treadmill, no signing key you must never lose.
- No vendor battery managers. Nothing on desktop behaves like Xiaomi.

**Harder, or at least not free:**

- Three OS backends instead of one, each with its own permission plumbing.
- The Tauri version fact above blocks the cheap path *today*.
- Tray and global-shortcut behaviour is uneven on Linux specifically (no left-click event,
  X11-only shortcuts).

**And yet: build Android first.** Not because it is easier — it plainly is not — but because
**desktop does not have the problem the wrapper exists to solve.** A desktop browser tab already
holds a microphone while hidden. The wrapper adds convenience there (tray, shortcut, a window
that survives); on Android it adds the *only* path to a capability that is otherwise
unreachable. Building the easy one first would produce a wrapper that proves nothing about the
hard one, and W6's first slice is explicitly about proving the model.

Recorded alternative, since this is a genuine judgement call: build desktop first to shake out
the bridge (W4) on the platform with the fastest edit-run loop, then port. Rejected because the
bridge's hard case — foreground service lifecycle — exists only on Android, so a desktop-first
bridge would be designed against the easy half and would need redesigning. *If the Tauri version
fact resolves and someone wants a two-day morale win, desktop is that. It is not the first
slice.*

---

## W3 — What the wrapper must not do

**VERDICT: ANSWERED.** The boundary is one sentence, four rules, and a test that can be run
against any proposed change in under a minute.

### The boundary

> **The wrapper renders muxterm and grants capability. It does not implement product.**

Everything the user sees, apart from an OS-mandated notification, is the web app. Every
behaviour, every state machine, every string of product copy, every keybinding, every layout
decision lives in `web/`. The wrapper's entire native surface is: a window, a webview, a
permission bridge, a foreground service, and the narrow channel of W4.

The reason to hold this line is not aesthetic. It is that **muxterm already has a shipping voice
implementation, a composer, an orb, a chief of staff, a fleet view and a mobile navigation
model**, all in the web app, all under active development by other lanes. Anything the wrapper
reimplements immediately becomes a second thing to change whenever the first one changes — and
because the wrapper ships through an app store on someone else's schedule, the two will drift
and the native one will be the stale one. A wrapper that has drifted is worse than no wrapper,
because it looks like the product.

### The four rules

**Rule 1 — One URL, one webview.**
The app loads exactly one URL and hosts exactly one webview. No second webview, no native screen
that renders content, no in-app browser for links. If a feature needs a new screen, it is a new
route in the web app.

**Rule 2 — The APK ships no product assets.**
No HTML, no CSS, no JavaScript, no icons other than the launcher icon, no product copy other than
the app name and the foreground-service notification's text. If the binary contains a copy of any
part of the web app, it is no longer a wrapper — it is a hybrid app with a deployment problem.
This rule is mechanically checkable in CI: assert the asset directory is empty.

**Rule 3 — Every bridge method names an OS capability the web platform cannot reach.**
This is the test that keeps W4 narrow. For each method, ask: *could this be implemented in the
page?* If yes, it must be. `startVoiceService()` passes — no web API starts an Android foreground
service. `saveDraft()` fails — `localStorage` exists. `getSessionList()` fails — that is an HTTP
request. The rule has teeth because it is answerable from the web platform's own surface, not
from taste.

**Rule 4 — Native may own a trigger. It may never own a turn.**
The sharpest case, because W5 makes it real. On-device wake-word detection *must* be native: no
web API can listen while the page is frozen. That is legitimate under Rule 3. But the wake word's
only output is an event on the bridge saying "the user said the word." Everything after that —
opening the microphone, connecting to the realtime endpoint, the conversation, the transcript,
the tools, hanging up — happens in the page, exactly as it does today. The moment native holds
audio *for a turn*, native owns voice, and the web app becomes a viewer.

### The specific temptations, and the rule that stops each

| Temptation | Why it will be proposed | Rule | What to do instead |
| --- | --- | --- | --- |
| A native title bar or tab strip | "It'll feel like a real app; `title-bar.ts` and `mux-dock.ts` are just HTML" | 1 | Nothing. The web chrome is the chrome. |
| A native settings screen | "Permissions and notification settings are native concerns" | 1 | Deep-link to the OS settings screen from a web button via the bridge; the button is web. |
| A native terminal renderer | "xterm in a WebView will be slower than native" | 1 | Measure first. If it is genuinely too slow, that is a web-app performance bug, and fixing it helps every user, not just wrapped ones. |
| Rich native notifications for lane completion | "muxterm already has completion records and a chief of staff — the phone should buzz" | 3 | Web Push, which is a web capability and works in a browser tab too. If a native notification is genuinely required, it carries **no content and no actions** beyond focusing the app. |
| Bundling the web assets into the APK | "Offline. Faster cold start. No dependency on the server." | 2 | Nothing. muxterm is a terminal multiplexer front-end; there is no useful offline mode, and the server is the product. |
| Native credential storage | "The Keystore is more secure than `localStorage`" | 3 | The page already authenticates. If token storage needs hardening, harden it in the web app so every user benefits. |
| A native "quick capture" overlay window | "Global shortcut → tiny window → speak → done" | 1 + 4 | The global shortcut is legitimate (Rule 3: no web API registers one). What it does is **focus the window and fire a bridge event**; the page decides what that means. |
| Wrapper-only features | "This one only makes sense on mobile" | 1 | It goes in the web app behind a capability check. The web app already ships mobile-specific navigation. |
| Native handling of the wake word's *response* | "We already have the audio, may as well stream it" | 4 | Fire `wake` over the bridge, hand the page nothing but the fact that it happened. |

### The deletion test

For any proposed wrapper change, ask:

> **If the wrapper were deleted tomorrow, would a user in a normal browser lose this?**

- *They would lose nothing* → the change belongs in the web app. Reject it.
- *They would lose screen-off audio, or a tray icon, or a global shortcut* → capability. Accept.
- *They would lose a feature* → **stop.** The boundary has already been breached; find where.

### The one admitted exception, drawn narrowly

The Android foreground-service notification (W1.2) is native UI with product copy in it, and it
carries a **Stop voice** action. This is a genuine exception and it is admitted because the OS
mandates it: an FGS without a notification is not a thing Android permits, and a notification
below `PRIORITY_LOW` gets narrated by the platform in worse words than ours. The exception is
bounded to: one notification, one line of text, one action, no state of its own — it reads the
session state over the bridge and its Stop action writes one event back. It renders nothing the
page does not already know.

The same exception covers the desktop tray icon and its menu, for the same reason and with the
same bound: it exists because the window can be hidden, and it does nothing but show and hide
the window.

### How this is enforced, rather than merely stated

1. **A line budget.** The Android source in W1.5 is six files. If it grows past roughly 500 lines
   of Kotlin, something has moved that should not have. That is a smell to investigate, not a
   hard gate.
2. **The empty-assets assertion**, in CI, per Rule 2.
3. **The bridge surface is a reviewed interface.** W4 defines it; adding a method is a design
   change, not an implementation detail. Every addition must state which OS capability it reaches
   and why the page cannot.

---

## W4 — The bridge

**VERDICT: ANSWERED.** One origin-scoped message channel, a versioned JSON envelope, **six
messages web→native and six native→web**, no binary payloads in either direction, and a web-side
half that degrades to a no-op in a browser. Reference implementations of both halves are in
[`webview-wrapper/`](./webview-wrapper/) and the TypeScript half type-checks against muxterm's
own config — see [What was built here](#what-was-built-here).

### W4.1 — Transport

**Android: `WebViewCompat.addWebMessageListener`, not `addJavascriptInterface`.**

```java
@UiThread
@RequiresFeature(name = WebViewFeature.WEB_MESSAGE_LISTENER,
                 enforcement = "androidx.webkit.WebViewFeature#isFeatureSupported")
public static void addWebMessageListener(
    @NonNull WebView webView,
    @NonNull String jsObjectName,
    @NonNull Set<String> allowedOriginRules,
    @NonNull WebViewCompat.WebMessageListener listener)
```
— `androidx.webkit.WebViewCompat`, added in 1.3.0,
<https://developer.android.com/reference/androidx/webkit/WebViewCompat> (checked 2026-09-08)
**[WEBVIEW]**

Chosen over `addJavascriptInterface` for one reason that matters more than any other:
**`allowedOriginRules`**. The documentation is emphatic about why —

> "Note that this is a powerful API, as the JavaScript object will be injected when the frame's
> origin matches any one of the allowed origins. **The HTTPS scheme is strongly recommended for
> security**; allowing HTTP origins exposes the injected object to any potential network-based
> attackers. If a wildcard `"*"` is provided, it will inject the JavaScript object to all frames…
> When using a wildcard, the app must treat received messages as untrustworthy."

muxterm passes exactly one rule: `https://muxterm.ampbox.io`. Never `*`, never `http://`,
never a `*.` pattern. If the webview is ever navigated off-origin — a link in terminal output, an
OAuth redirect — the bridge object simply is not there. That is the correct failure.

Secondary reasons: the injected object arrives *"immediately when the page begins to load"*, so
there is no race between page start and bridge availability; messages are strings on a
`WebMessagePort`, so there is no reflection surface and no `@JavascriptInterface` annotation
hazard; and the API is feature-gated, so `WebViewFeature.isFeatureSupported(WEB_MESSAGE_LISTENER)`
gives a clean "this device's WebView is too old" path instead of a crash. **[WEBVIEW]**

**Desktop: the same envelope over each toolkit's own channel** — Tauri commands and
`emit`/`listen`, or Electron `contextBridge` + `ipcRenderer`. The envelope and the message set
are identical; only the two transport functions differ. The web-side half is written so the
transport is a swappable detail (`_send` / `_receive`), which is the whole reason to define an
envelope rather than call platform APIs directly.

### W4.2 — The envelope

```jsonc
{ "v": 1, "type": "voice.start", "id": "c7", "payload": { /* type-specific */ } }
```

- `v` — envelope version. Native refuses an envelope whose `v` it does not know, and says so.
- `type` — a dotted name from the closed set below. Unknown types are dropped with a warning,
  never guessed at.
- `id` — optional correlation id. Present on commands that want a reply; the reply carries the
  same `id`.
- `payload` — a plain JSON object. **Never a string that needs parsing again.** Never binary.

Versioning rule: the wrapper ships through an app store and the web app deploys continuously, so
**the web app will routinely be newer than the wrapper.** Therefore: the web side must treat every
capability as absent until `ready` says otherwise, and native must ignore message types it does
not recognise rather than failing. Additive changes only; a breaking change bumps `v` and native
supports both for one release.

### W4.3 — The message set (closed)

**Web → native.** Every one names an OS capability the page cannot reach — Rule 3 of W3.

| Type | Payload | Capability it reaches | Rule 3 justification |
| --- | --- | --- | --- |
| `voice.start` | `{sessionId}` | Start the `microphone`+`mediaPlayback` foreground service | No web API starts an Android service |
| `voice.stop` | `{sessionId}` | `stopForeground` + `stopSelf` | ditto |
| `voice.state` | `{state}` — one of muxterm's own `VoiceSessionState` values: `idle`/`connecting`/`listening`/`thinking`/`speaking`/`error` | Update the ongoing notification's text | No web API writes an FGS notification |
| `keepAwake` | `{on: boolean}` | Desktop: `ES_SYSTEM_REQUIRED` / macOS idle-sleep assertion | The web platform's only wake lock is `"screen"`, released on hide |
| `openOsSettings` | `{which: "notifications"\|"microphone"\|"battery"}` | `Intent` to the OS settings screen | No web API opens an OS settings page |
| `log` | `{level, msg}` | Write to logcat / the desktop log file | Diagnostics only; carries no product data |

`voice.state` deliberately mirrors `VoiceSessionState` from
`web/src/lib/voice-session-controller.ts` rather than inventing a parallel vocabulary. The web
app already exposes `subscribe()` over a `VoiceSessionSnapshot`; the bridge's web half subscribes
to that and forwards **only the `state` field** — not `level`, not `heard`, not `spoken`. The orb's
level meter and the transcript never cross.

**Native → web.**

| Type | Payload | Why the page cannot know this itself |
| --- | --- | --- |
| `ready` | `{platform, appVersion, capabilities: string[]}` | Announces the bridge and what this build supports |
| `voice.serviceStarted` | `{ok: true}` \| `{ok: false, reason}` | The FGS either started or threw; the page must not call `getUserMedia` until it knows |
| `voice.stopRequested` | `{}` | The user tapped **Stop voice** in the notification or the tray |
| `mic.silenced` / `mic.resumed` | `{}` | **From `AudioManager.AudioRecordingCallback`.** Chromium wires this to nothing (see the load-bearing finding), so this event is information the page could not obtain by any means |
| `wake` | `{}` | Later. On-device wake word fired. **The fact only** — see W3 Rule 4 |
| `attachment` | `{kind, mime, url}` | Later. A camera or file payload is ready **at a URL**, not inline — see the short answer below |

`mic.silenced` is the single most valuable thing on this list and the clearest justification for
having a bridge at all. It converts muxterm's worst failure mode — a lit orb attached to a dead
microphone, silent and undetectable — into an event the web app can render honestly. Even if
everything else about the wrapper were deleted, this event would be worth the channel.

### W4.4 — What must never cross

Stated as prohibitions, because each has a plausible-sounding reason to violate it:

| Never crosses | The tempting argument | Why not |
| --- | --- | --- |
| **Audio samples, either direction** | "Native already has the mic open for the wake word; forward the PCM and skip a `getUserMedia`" | The moment PCM crosses, native owns audio and W3 Rule 4 is dead. The page opens its own microphone, always. |
| **The realtime ephemeral token** | "Native could hold the connection when the page is frozen" | The token mints a session that executes shell tools. It is minted server-side, used in the page, and never leaves it. Native holding it is a different product with a different threat model. |
| **Terminal output or session content** | "The notification could show what the lane is doing" | The notification is one line and one action (W3). Content in a notification is content outside the web app. |
| **Tool calls or their results** | "Native could handle a tool locally" | muxterm's design already keeps tool calls off the browser entirely, on a server-side bridge. Native must be further away, not nearer. |
| **A URL for native to navigate to** | "The page knows where it wants to go" | A page that can drive native navigation can be driven off-origin by anything that can inject into the page. The page navigates itself; native never navigates on instruction. |
| **A command for native to execute** | "One tiny escape hatch for debugging" | This is a remote shell with extra steps. `log` exists precisely so nobody needs to argue for this. |
| **Binary blobs** | "Camera frames, file bytes" | Attachments cross as a **URL** the page fetches (see below). Payloads stay out of the envelope. |

### W4.5 — Failure model

Three properties, all mandatory:

1. **Absent by default.** `nativeBridge.available` is `false` in a browser, and every method is a
   safe no-op that resolves. The web app's behaviour in a normal tab must be byte-identical with
   the bridge module present. This is the deletion test (W3) made executable.
2. **Capability-gated, not version-gated.** The page checks `capabilities.includes('voice.fgs')`,
   never `appVersion >= x`. An old wrapper simply announces less.
3. **Timeouts, not hangs.** `voice.start` waits for `voice.serviceStarted` with a short timeout
   (2 s is generous — `startForeground` is synchronous-ish). On timeout the page proceeds
   *without* the service and tells the user voice may not survive the screen going off. It never
   blocks the user's tap on a native reply that is not coming.

### W4.6 — Room for camera and attachments, without building them

The `attachment` event is shaped now so that adding it later is not a redesign. Two decisions do
that work:

- **Payloads cross as URLs, not bytes.** Native writes the captured photo or the chosen file
  wherever it likes and hands the page a URL. On Android that is a `content://` URI exposed
  through a `FileProvider`, which the WebView can fetch; on desktop it is a local HTTP URL or a
  custom scheme. The envelope stays small, JSON, and loggable.
- **The page still does the upload.** It `fetch`es the URL and posts to muxterm's existing files
  API exactly as a drag-and-drop would. Native never talks to muxterm's server, never holds a
  credential, and never learns what an attachment is for.

Which means the later work is: one more native→web event, one `FileProvider`, and a web-side
handler that reuses the upload path that already exists. No new concepts.

---

## W5 — Always-listening, costed honestly

**VERDICT: ANSWERED. Continuous streaming costs $259 per user per month at the mini model's rate
and $821 at the full model's, for a feature whose useful duty cycle is around 6%. That number
decides the design on its own. Build push-to-talk; leave a wake-word seam; do not build
continuous.**

### W5.1 — The arithmetic, in full

At the stated rates — **$0.006/minute (mini realtime)** and **$0.019/minute (full realtime)** —
for one user, listening only:

| | per minute | per hour | per 8-hour day | per 24-hour day | per month @8h/day | per month @24h/day |
| --- | --- | --- | --- | --- | --- | --- |
| **mini** | $0.0060 | $0.36 | **$2.88** | **$8.64** | $86.40 | **$259.20** |
| **full** | $0.0190 | $1.14 | **$9.12** | **$27.36** | $273.60 | **$820.80** |

*(30-day months. Per user. Listening only — output tokens, tool calls and the rest of muxterm's
bill are on top.)*

Read the fourth column first. **"Always listening" means always.** A phone on a bedside table at
3 a.m. is listening. $8.64 a day, every day, per person, on the cheap model — for a service whose
whole selling point is that it is the cheap one.

**And the duty cycle is the indictment.** Generously, a heavy user speaks to muxterm for 30
minutes in an 8-hour day. That is **6.2%**. The other 93.8% is billed silence. The realtime
models charge for audio in, not for audio that turned out to contain words.

**The comparison that ends the argument:**

| Option | Audio billed per day | mini/day | mini/month | full/month |
| --- | --- | --- | --- | --- |
| Continuous, 24/7 | 1440 min | $8.64 | $259.20 | $820.80 |
| Continuous, 8h waking | 480 min | $2.88 | $86.40 | $273.60 |
| Wake-word gated (20 triggers × 90 s) | 30 min | $0.18 | $5.40 | $17.10 |
| Push-to-talk (10 sessions × 2 min) | 20 min | $0.12 | $3.60 | $11.40 |

**Wake-word gating is 48× cheaper than 24/7 continuous on the same model.** Choosing the mini
model over the full one saves 3.2×. **The gating decision is fifteen times more consequential
than the model decision**, which is the sort of thing that is obvious once written down and
invisible until it is.

### W5.2 — Option 1: continuous streaming to the realtime API

**What it is.** The existing WebRTC session, opened once and never closed. No new technology
whatsoever — muxterm already does this for the length of a session; continuous just removes the
end.

**Money:** the table above. $259.20–$820.80 per user per month.

**Battery.** The dominant cost is the radio, not the microphone, and Android says so:

> "Using the wireless radio to transfer data is **potentially one of your app's most significant
> sources of battery drain**."

> "…the radio will remain at full power for the duration of your transfer — plus an additional 5
> seconds of tail time — followed by 12 seconds at the low energy state. So for a typical 3G
> device, every data transfer session will cause the radio to draw energy for **at least 18
> seconds**." And: "an app which makes a one second data transfer, three times a minute, **will
> keep the wireless radio perpetually active**."

— <https://developer.android.com/develop/connectivity/network-ops/network-access-optimization>
(page states last updated 2026-09-01) **[ANDROID]** *(the tail-time figures are explicitly 3G;
the page notes they vary by radio technology.)*

A continuous Opus upstream is not "three times a minute" — it is unbroken. The radio never
reaches the low-energy state at all. For scale, RFC 6716 §2.1.1 gives Opus's 20 ms sweet spots as
*"16-20 kbit/s for WB speech"* (<https://www.rfc-editor.org/rfc/rfc6716.txt>, September 2012)
**[SPEC]** — so roughly 2.5 kB/s up, continuously, plus the downstream, plus RTCP, forever.

That the whole Doze and App Standby architecture exists to *"defer background network activity"*
(<https://developer.android.com/training/monitoring-device-state/doze-standby>, last updated
2026-08-18) **[ANDROID]** is the platform telling you, structurally, that this is the expensive
thing.

**No primary source quantifies the mA or the %/hour**, and I will not invent one. The defensible
statement is: Google names the radio as among the most significant battery costs, the mechanism
by which continuous streaming pins the radio at full power is documented, and the entire
background-execution regime is built around avoiding exactly this. **[ANDROID]** + **[INFERENCE]**

**What the user must trust.** Everything. Every word spoken near the phone — theirs and other
people's — is encoded and sent to a third-party vendor, continuously, whenever the app is
running. Not "when I press the button", not "when I say the word": always. There is no technical
control the user can verify; there is only the persistent notification and the green microphone
dot, both of which say "listening" and neither of which says "transmitting to a vendor."

For muxterm specifically this is worse than for a consumer assistant, because muxterm lives on a
developer's desk during work: the audio would include other people's conversations, calls, and
whatever is said in a room the user does not control.

**Verdict on Option 1: do not build.** Not primarily on privacy — on arithmetic. It is a $259/user/month
feature that bills for 94% silence.

### W5.3 — Option 2: on-device wake word, stream only after the word

**Money:** ~$5.40/user/month on mini, ~$17.10 on full, at 20 triggers a day. **48× cheaper than
continuous.** The API cost stops being a design constraint entirely.

**But the battery cost does not go to zero — it changes shape.** And there is a hard platform
finding here that anyone budgeting this needs:

**A third-party Android app cannot use the low-power hotword DSP.** The always-on audio hardware
that "Hey Google" runs on is closed to Play-store apps, at four independent gates:

- `VoiceInteractionService` — public API, but *"the current `VoiceInteractionService` that has
  been selected by the user is kept always running by the system, to allow it to do things like
  listen for hotwords in the background"*, and the service *"must also require the
  `Manifest.permission.BIND_VOICE_INTERACTION` permission"*, which is `protectionLevel="signature"`
  — platform-key only.
  <https://developer.android.com/reference/android/service/voice/VoiceInteractionService> **[ANDROID]**
- `AlwaysOnHotwordDetector` — no longer public SDK. Annotated `@hide` / `@SystemApi` in AOSP, and
  <https://developer.android.com/reference/android/service/voice/AlwaysOnHotwordDetector> returns
  **HTTP 404** as of 2026-09-08. **[ANDROID]**
- `HotwordDetectionService` (Android 12) — `@hide` / `@SystemApi`, bound only by the system, and
  creating a detector needs `MANAGE_HOTWORD_DETECTION`, documented *"@hide This is not a
  third-party API (intended for OEMs and system apps)."* **[ANDROID]**
- `CAPTURE_AUDIO_HOTWORD` — *"Allows an application to capture audio for hotword detection.
  **Not for use by third-party applications.**"* `protectionLevel="signature|privileged|role"`.
  **[ANDROID]**

*(Sources: AOSP `core/res/AndroidManifest.xml`, `core/java/android/service/voice/*.java` at
`main` via Google's `aosp-mirror`, checked 2026-09-08.)*

**Consequence:** muxterm's wake word runs on the **application processor**, using ordinary
`RECORD_AUDIO` and the same `microphone` foreground service from W1 — held open all day rather
than for the length of a session. So Option 2 trades API dollars for battery and for a
permanently-present listening indicator. It is a much better trade than Option 1, and it is not
free, and nobody should present it as "the cheap one" without that sentence attached.

**What the user must trust:** that the wake-word model really is on-device and really does gate
the network. That is a *much* smaller ask than Option 1 — and it is verifiable, by the user, from
outside the app: with no network transmission until the word fires, a packet capture or even a
data-usage screen tells the truth. **A privacy claim a user can check is categorically different
from one they must believe**, and that, more than the money, is why this is the right long-term
answer.

**Candidate engines, named and not selected.** Selecting or integrating one is explicitly out of
scope; this is the licensing shape, so the choice can be made later without redoing the survey.
All checked 2026-09-08.

| Engine | Status | Licence *of the engine* | Commercial use | Android build |
| --- | --- | --- | --- | --- |
| **Picovoice Porcupine** | Active | **Split.** Repo `LICENSE` is Apache-2.0 but covers wrappers only: *"Picovoice models and inference engines are **proprietary**."* | Requires an `AccessKey` from Picovoice Console; *"there are no dedicated free or paid plans for personal or non-commercial use."* | Yes — `ai.picovoice:porcupine-android` |
| **sherpa-onnx** (k2-fsa) | **Very active** (push 2026-09-05) | Apache-2.0, engine and all | Free | **Yes — first-class Android/AArch64**; includes keyword spotting |
| **openWakeWord** | Active (push 2025-12-30) | Apache-2.0, engine *and* models, no key | Free | Linux/Windows/Arm64-Linux documented; **no official Android build — [UNSETTLED]** |
| **Mycroft Precise** | Effectively unmaintained (last commit 2023-11-25) | Apache-2.0 | Free | Historically yes |
| **OVOS `precise-lite` plugin** | **Archived**, topic "deprecated" | — | — | — |
| **Snowboy (KITT.AI)** | **Discontinued.** *"we plan to shut down all KITT.AI products … by Dec. 31st, 2020 … Our github repositories will remain open, but only community support."* | GitHub reports **NOASSERTION** | Do not use | Historically an in-repo demo |
| **Sensory TrulyHandsfree** | Commercial | Proprietary | Sales-led | Yes |

Sources: `github.com/Picovoice/porcupine/blob/master/LICENSE`, `picovoice.ai/docs/faq/general/`,
`github.com/k2-fsa/sherpa-onnx`, `github.com/dscripka/openWakeWord/blob/main/LICENSE`,
`github.com/MycroftAI/mycroft-precise`, `github.com/OpenVoiceOS/ovos-ww-plugin-precise-lite`,
`github.com/Kitt-AI/snowboy/blob/master/README.md`. **[VENDOR]**

**If someone eventually has to pick one**, the shortlist is two: **sherpa-onnx** if the Apache-2.0
end-to-end story and a first-class Android build matter most, **Porcupine** if detection quality
per CPU-cycle matters most and a proprietary engine plus an activation key is acceptable. Note
that Porcupine's `AccessKey` is a runtime dependency on someone else's server for a feature sold
as on-device — worth knowing before it is discovered.

**Verdict on Option 2: the right long-term answer, and explicitly not the first slice.** It needs
a native audio path, a model, a licence decision and a day-long open microphone — every one of
which is a reason it should not be entangled with proving that the wrapper works at all.

### W5.4 — Option 3: push-to-talk, or a scheduled window

**What it is: what muxterm already ships.** The user taps the orb; the session runs; the model
hangs up when asked, via the existing `end_voice_session` realtime tool. The wrapper's *entire*
contribution is that the session now survives the screen going off.

**Money:** ~$3.60/user/month on mini, ~$11.40 on full. **72× cheaper than 24/7 continuous.**

**Battery:** bounded by definition. The radio is pinned only while a session runs, and the user
knows when that is because they started it.

**What the user must trust:** nothing they cannot see. The microphone opens on their tap, the
notification says so, the green dot says so, and it all ends when they end it. This is the only
one of the three options with no privacy argument to have.

*"A scheduled window"* — listen during work hours, say — is the same mechanism with a timer, and
it is worse than push-to-talk on every axis that matters: it costs the whole window, it is
listening when the user has forgotten it is, and it needs an FGS started from the background,
which Android 12+ forbids for while-in-use permissions with no exemption to fall back on (W1.2).
**Rejected.**

**Verdict on Option 3: build this. It is the first slice.**

### W5.5 — The recommendation

1. **Ship push-to-talk with screen-off survival.** It is what the product already does, plus the
   one thing it cannot do. W6 is exactly this.
2. **Leave the wake-word seam and nothing more.** The bridge's `wake` event (W4.3) is defined,
   costs nothing, and carries only the fact that the word was heard — W3 Rule 4. When someone
   builds detection, nothing else changes.
3. **Do not build continuous streaming.** $259.20 per user per month on the cheap model, 94%
   billed silence, and a privacy posture no notification can honestly convey. If it is ever
   revisited, revisit it with these four numbers on the page.

*Conservative choice recorded, per instruction: the contested call here is Option 2 versus Option
3 as the target. I take Option 3 because it is buildable now, provable now, and carries no
licensing or battery unknowns. The alternative — go straight to a wake word — is recorded, and
its cost is a native audio path plus a licence decision plus an all-day open microphone, none of
which help answer the question the first slice exists to answer.*

---

## W6 — The first slice

**VERDICT: ANSWERED.** Seven components, roughly **5–6 focused days** for someone who has shipped
an Android app and **10–14** for someone who has not, plus a hardware-dependent tail nobody can
compress. The biggest technical risk is not the foreground service.

### W6.1 — What the slice is, exactly

> **An APK that loads `https://muxterm.ampbox.io`, lets the user start voice by tapping the orb
> that already exists, and holds the conversation through five minutes of screen-off — including
> a two-minute silence in the middle.**

The silence clause is not padding. It is the difference between a demo and a proof: W1.4b
establishes that a session survives screen-off trivially while the assistant is talking, and dies
1–5 minutes after it stops. **A first slice that does not include a long pause proves nothing.**

Not in the slice: wake word, camera, attachments, tray, desktop, any store listing, any native UI
beyond the notification the OS requires.

### W6.2 — Components, in build order

Each step ends in something observable. That ordering is deliberate: every step after the first
can fail, and you want to know which one did.

| # | Component | Ends when you can see | Est. |
| --- | --- | --- | --- |
| 1 | Gradle module + `AndroidManifest.xml` | It installs and launches to a blank screen | 0.5 d |
| 2 | `MainActivity` + `MuxtermWebView` + the three `WebSettings` | **muxterm loads and is usable on a phone.** Terminal, sidebar, everything | 0.5 d |
| 3 | `MuxtermChromeClient` — the two-layer permission bridge | **The orb works. A voice conversation runs, screen on.** This is the first genuinely load-bearing milestone: it proves WebRTC realtime works inside a WebView at all | 1.0 d |
| 4 | `VoiceSessionService` + notification + `ServiceCompat.startForeground` | An ongoing notification appears when voice starts and goes when it stops; **Stop voice** ends the session | 1.0 d |
| 5 | The bridge — `addWebMessageListener` + wiring `native-bridge.ts` into `voice-session-controller.ts` | The service starts *before* `getUserMedia`, tracks state, and stops on hang-up | 1.0 d |
| 6 | Visibility pin (`pinVisible`, W1.4b) + `AudioRecordingCallback` → `mic.silenced` | The page is told when the OS silences it | 0.5 d |
| 7 | **Measure.** Point the PWA investigation's existing probe at the wrapper: screen off 5 min with a 2 min silence, count total frames vs non-silent frames | **The answer** | 0.5 d |

**Total: 5.0 days.** Then double it for a first Android app, and add whatever step 7 turns up.

Steps 1–6 are all buildable from what is in this repository plus an SDK. Step 7 needs a phone and
nothing else will do.

**Build order note:** step 3 before step 4 is not arbitrary. If WebRTC realtime does not work
inside a WebView at all — a possibility I cannot rule out from here — you find out on day 2 for
the price of two files, instead of on day 5 having built a foreground service for nothing.

### W6.3 — The single biggest technical risk

**Not the foreground service. The freeze.**

The FGS story is well-documented, the platform names the exact type for this exact use case, and
if it fails it fails loudly — `SecurityException`, `IllegalArgumentException`,
`MissingForegroundServiceTypeException`, all at `startForeground()`, all on the first run.

The freeze (W1.4b) is the opposite in every respect:

- **It is silent.** No exception, no callback, no log. Audio simply stops.
- **It is delayed.** 1–5 minutes after the last sound, on a Finch-controlled timer.
- **It only appears in the case people skip testing** — a long pause in a real conversation.
- **The fix depends on an implementation detail.** Pinning window visibility works because of how
  `AwContents` computes `isVisible`, not because any API promises it. It is **[INFERENCE]** from
  three source files, and it is the one place this design leans on Chromium internals.
- **And if the pin does not work, there is no second idea inside the wrapper's remit.** The
  alternatives — restructure the web app's audio around an `AudioWorklet`, or keep a real visible
  Activity alive with the screen off — are respectively out of scope and user-hostile.

**What would settle it, and it is cheap:** step 7. Load the probe, start a session, screen off,
wait five minutes with two minutes of deliberate silence in the middle, read the counters. Total
frames flat ⇒ frozen (or the renderer died). Total frames advancing with non-silent frames at
zero ⇒ the OS silenced the capture, so the FGS is the problem, not the freeze. Both advancing ⇒
it works. **The instrument already exists and needs no changes** — it counts exactly these three
cases apart, which is what it was built for.

**Second-biggest risk, different in kind:** `kAndroidSuspendWebRtcOnScreenOff`. Chromium has
landed a hook mapping `ACTION_SCREEN_OFF` to a WebRTC suspend; it is
`FEATURE_DISABLED_BY_DEFAULT` today. WebView does not read Chrome's Finch config, but it inherits
source defaults when the WebView provider updates. **If that default flips, the wrapper stops
working and nothing in the app can prevent it.** This is not a build risk — it is a standing
watch item, and it belongs in whatever list the team keeps of external things that can break the
product.

### W6.4 — Honest effort estimate

| | |
| --- | --- |
| Someone who has shipped an Android app | **5–6 days** to the end of step 7 |
| Someone who has not | **10–14 days**, most of it in the Gradle/SDK/signing tax rather than in this design |
| If step 7 says the freeze wins | **+3–5 days**, and possibly a scope conversation |
| If step 3 says WebRTC does not work in a WebView | **stop.** That is a different document. |

**What is *not* in that number, and should be said out loud:** a signing key that must never be
lost, `targetSdk` bumps on Play's schedule, a Play listing with foreground-service and
`RECORD_AUDIO` declarations and prominent disclosure, and per-vendor battery-manager support
tickets from every Xiaomi and OnePlus owner. The build is a week. **The app is forever.** The
earlier PWA investigation was right that this is the real cost; this document's contribution is
that the *engineering* is small and well-understood, so the decision is about the ongoing cost
rather than about technical risk.

### W6.5 — What was built here, since the SDK-free parts were buildable

Everything that did not need an Android SDK, an emulator or a device has been written, and where
it could be verified it was. All in [`webview-wrapper/`](./webview-wrapper/).

**Verified:**

- `native-bridge.ts` — the web half of the bridge, 300 lines. **`tsc --noEmit` clean** under the
  web app's own compiler options (ES2021 / DOM / `strict`), TypeScript 5.9, exit 0.
- `native-bridge.test.mjs` — **10/10 checks pass** under Node v24.15.0, driving the module through
  a fake host channel. It demonstrates, rather than asserts: absent-by-default in a browser;
  capability-gating rather than version-checking; an unknown envelope version dropped; an unknown
  message type from a newer wrapper dropped; a command with no reply resolving by timeout instead
  of hanging; a throwing listener not taking out the others; and an attachment crossing as a URL
  with no bytes in the envelope.

**Written, not compiled — no Android SDK on this machine, and the README says so:**

- `AndroidManifest.xml` — the complete delta from an empty app. Six permissions, one activity, one
  service, every line traced to its citation, and every deliberate *absence*
  (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `WAKE_LOCK`, `CAMERA`) recorded as a decision.
- `MainActivity.kt` — the one screen, plus `MuxtermWebView` with the seven-line visibility pin
  from W1.4b.
- `MuxtermChromeClient.kt` — the two-layer permission bridge, with the origin check that the
  standard sample-code version omits.
- `VoiceSessionService.kt` — the foreground service, the notification, and the
  `AudioRecordingCallback` watcher.
- `MuxtermBridge.kt` — the native half of the bridge.

**Not built, deliberately:** anything requiring the web app to change. `native-bridge.ts` lives
under `docs/design/` and is inert; the README describes exactly how to wire it in when that is in
scope for whoever owns `web/`.

---

## Camera and file attachment, briefly

The item asks for a short answer, so this is one.

**Both are the same shape, and both are already accommodated by W4's `attachment` event.**

**File attachment** needs one override: `WebChromeClient.onShowFileChooser`. Without it, an
`<input type="file">` in a WebView does nothing at all — the same fail-closed-and-silent pattern as
`onPermissionRequest`. The override launches `ACTION_OPEN_DOCUMENT` (or the Photo Picker on
Android 13+, which needs no storage permission) and returns the resulting URIs to the callback.
The page then reads the file through the ordinary `File` API and posts it to muxterm's existing
upload path. **No bridge message required at all** — this is the web platform working normally
once the host stops blocking it.

**Camera** has two flavours and they are not the same job:

- *Live camera in the page* (`getUserMedia({video:true})`) — needs `<uses-permission CAMERA>`,
  the runtime grant, and `PermissionRequest.RESOURCE_VIDEO_CAPTURE` added to the same
  `onPermissionRequest` that already handles audio. Perhaps twenty lines. Note the finding from
  the load-bearing section: **Chrome explicitly stops video capture on backgrounding**
  (`VideoCaptureManager::ReleaseDevices`), so a backgrounded camera behaves differently from a
  backgrounded microphone and should not be assumed to follow the same rules.
- *Take a photo and attach it* — cheaper and probably what is actually wanted. `ACTION_IMAGE_CAPTURE`
  to the system camera app, write to a `FileProvider` path, hand the page a `content://` URL via
  the `attachment` event. **No `CAMERA` permission needed**, because the system camera app takes
  the picture.

**The rule that keeps both cheap** (W4.6): **payloads cross as URLs, never as bytes**, and the page
does the upload. Native never talks to muxterm's server and never holds a credential. Which means
the later work is one more event type, one `FileProvider`, one `onShowFileChooser`, and a web-side
handler reusing the upload path that already exists. No new concepts, and no change to the
architecture in this document.

---

## What was built here

| Artifact | Verified |
| --- | --- |
| [`webview-wrapper/native-bridge.ts`](./webview-wrapper/native-bridge.ts) | `tsc --noEmit` clean, web app's own options, TS 5.9 |
| [`webview-wrapper/native-bridge.test.mjs`](./webview-wrapper/native-bridge.test.mjs) | 10/10 pass, Node v24.15.0 |
| [`webview-wrapper/tsconfig.check.json`](./webview-wrapper/tsconfig.check.json) | — |
| [`webview-wrapper/AndroidManifest.xml`](./webview-wrapper/AndroidManifest.xml) | Not compiled — no SDK |
| [`webview-wrapper/MainActivity.kt`](./webview-wrapper/MainActivity.kt) | Not compiled — no SDK |
| [`webview-wrapper/MuxtermChromeClient.kt`](./webview-wrapper/MuxtermChromeClient.kt) | Not compiled — no SDK |
| [`webview-wrapper/VoiceSessionService.kt`](./webview-wrapper/VoiceSessionService.kt) | Not compiled — no SDK |
| [`webview-wrapper/MuxtermBridge.kt`](./webview-wrapper/MuxtermBridge.kt) | Not compiled — no SDK |
| [`webview-wrapper/README.md`](./webview-wrapper/README.md) | States exactly what is and is not checked |

---

## Verdicts, one line each

| Item | Verdict |
| --- | --- |
| **W1** — the Android wrapper | **ANSWERED.** Plain `WebView`, not TWA, on process identity. One service, `microphone\|mediaPlayback`. Two permission layers, both fail closed and silent. And **two independent killers**: the OS mic policy, fixed by the FGS; and Blink's freeze, fixed by pinning window visibility. |
| **W2** — the desktop wrapper | **ANSWERED.** No screen-off problem on desktop. But stable Tauri 2.11.5 pins `wry ^0.55.0` and the permission handler arrived in `wry` 0.56.0 — **today's Tauri cannot grant its own webview a microphone.** Re-check the pin before starting; Electron is the recorded alternative. |
| **W3** — the boundary | **ANSWERED.** One sentence, four rules, one deletion test. The sharpest rule: native may own a trigger, never a turn. |
| **W4** — the bridge | **ANSWERED.** Origin-scoped `WebMessageListener`, versioned JSON envelope, six messages each way, no bytes. Both halves written; the web half is tested. |
| **W5** — always-listening | **ANSWERED.** $259.20/user/month continuous on mini, $820.80 on full, for ~6% duty cycle. Gating beats model choice 15:1. Third-party apps cannot reach the hotword DSP. Build push-to-talk. |
| **W6** — the first slice | **ANSWERED.** Seven components, 5–6 days experienced / 10–14 not. Biggest risk is the freeze, not the service — because the freeze is silent, delayed, and only shows up in the test people skip. |

No item is UNANSWERABLE. Four specific claims are **[UNSETTLED]** and each names the measurement
that settles it: (1) that a `microphone` FGS covers a *WebView's* capture; (2) that the visibility
pin prevents the freeze; (3) whether Linux stops capture on DPMS blanking; (4) whether macOS
global shortcuts need an Accessibility grant. The first two are settled by the same five-minute
screen-off measurement in W6 step 7.

---

## Recommendation

**Build the Android wrapper. Build it as the smallest thing in W6. Do not build the desktop one
yet, and do not build always-listening at all.**

The case rests on one narrow, verified fact rather than on any general preference for native:
**Chromium contains no code that stops or mutes microphone capture when an app is backgrounded or
the screen goes off.** The Android audio-input path has zero app-lifecycle hooks across five
files; the video path has one, gated on the very feature flag that controls Chrome's foreground
service. The silencing is done by the OS, to a *process* that has neither a visible UI nor a
microphone foreground service — and a web page does not have a process of its own to fix. **No
change to muxterm's web app can address this. A wrapper running a correctly typed foreground
service addresses it completely.** That is the entire argument, and everything the wrapper does
beyond it is scope creep.

Three things qualify that, and all three are new to this document:

1. **The foreground service is only half of it.** Blink freezes a hidden WebView's page 1–5
   minutes after audio stops, and `kStopInBackground` is enabled by default in WebView builds. The
   FGS is powerless against it. The fix is seven lines that pin window visibility for the life of
   a session — cheap, but it must be *in the first slice*, because a wrapper without it survives
   screen-off only while the assistant is talking and dies at the first pause. Anyone testing with
   continuous speech will ship a broken thing believing it works.
2. **Desktop is blocked on someone else's version bump.** Stable Tauri cannot resolve to a `wry`
   with a permission handler. That will change; until it does, desktop costs an Electron-sized
   decision for a platform that does not have the problem.
3. **Always-listening is a $259-per-user-per-month feature that bills for 94% silence.** Not a
   privacy judgement — arithmetic. Gate it, or do not build it. And note that a third-party app
   cannot reach the low-power hotword DSP, so even the gated version runs detection on the
   application processor with an all-day open microphone.

**The one thing worth building even if the rest is shelved** is the `mic.silenced` event.
muxterm's worst failure mode today is a lit orb attached to a dead microphone — `readyState:
"live"`, `muted: false`, all-zero samples, no event, no error, a conversation that stops being a
conversation and says nothing about it. Android has a signal for exactly this,
`AudioManager.AudioRecordingCallback`, and Chromium wires it to nothing. **A wrapper can see it.
A web page never can.** That single event converts an invisible failure into a visible one, and it
is worth the channel on its own.

**Recommended next step, for a human to decide on:** build steps 1–3 of W6 — manifest, activity,
permission bridge. Two days, three files, no foreground service. It answers the one question that
would invalidate everything else: *does muxterm's WebRTC realtime voice work inside a WebView at
all?* If yes, the rest of this document is a build plan. If no, it is a different document, and
better to know on day two.

---

## Sources

**Chromium**, all read at `main` and checked 2026-09-08 via
<https://chromium.googlesource.com/chromium/src/+/main/>:
`media/audio/android/audio_manager_android.cc` ·
`media/audio/android/aaudio_input.cc` ·
`media/audio/android/opensles_input.cc` ·
`content/browser/renderer_host/media/audio_input_device_manager.cc` ·
`content/browser/renderer_host/media/media_stream_manager.cc` ·
`content/browser/renderer_host/media/video_capture_manager.cc` ·
`content/public/common/content_features.cc` ·
`third_party/blink/common/features.cc` ·
`third_party/blink/renderer/platform/scheduler/main_thread/page_scheduler_impl.{h,cc}` ·
`android_webview/java/src/org/chromium/android_webview/AwContents.java` ·
`android_webview/browser/aw_contents.cc` ·
`android_webview/lib/aw_main_delegate.cc` ·
`android_webview/docs/architecture.md`

**Android platform**, all checked 2026-09-08:
Sharing audio input <https://developer.android.com/media/platform/sharing-audio-input> ·
Foreground service types <https://developer.android.com/develop/background-work/services/fgs/service-types> ·
Background-start restrictions <https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start> ·
Launching a foreground service <https://developer.android.com/develop/background-work/services/fgs/launch> ·
Android 14 FGS types required <https://developer.android.com/about/versions/14/changes/fgs-types-required> ·
Android 15 behaviour changes <https://developer.android.com/about/versions/15/behavior-changes-15> ·
Notification runtime permission <https://developer.android.com/develop/ui/views/notifications/notification-permission> ·
User-initiated stopping of FGS apps (Task Manager) <https://developer.android.com/develop/background-work/services/fgs/stop-apps> ·
Doze and App Standby <https://developer.android.com/training/monitoring-device-state/doze-standby> ·
Network access optimization <https://developer.android.com/develop/connectivity/network-ops/network-access-optimization> ·
`WebChromeClient` <https://developer.android.com/reference/android/webkit/WebChromeClient> ·
`PermissionRequest` <https://developer.android.com/reference/android/webkit/PermissionRequest> ·
`WebSettings` <https://developer.android.com/reference/android/webkit/WebSettings> ·
`WebView` <https://developer.android.com/reference/android/webkit/WebView> ·
`androidx.webkit.WebViewCompat` <https://developer.android.com/reference/androidx/webkit/WebViewCompat> ·
`VoiceInteractionService` <https://developer.android.com/reference/android/service/voice/VoiceInteractionService> ·
AOSP `core/res/AndroidManifest.xml`, `core/java/android/service/voice/*.java`,
`media/java/android/media/MediaRecorder.java` via <https://github.com/aosp-mirror/platform_frameworks_base>

**Desktop / Tauri / WebKit**, all checked 2026-09-08:
<https://crates.io/api/v1/crates/tauri> · <https://crates.io/api/v1/crates/wry> ·
<https://crates.io/api/v1/crates/tauri-runtime-wry/2.11.4/dependencies> ·
<https://docs.rs/wry/0.56.1/wry/struct.WebViewBuilder.html> ·
<https://docs.rs/wry/0.56.1/wry/enum.PermissionKind.html> ·
<https://github.com/tauri-apps/wry/issues/81> · <https://github.com/tauri-apps/wry/pull/1654> ·
<https://github.com/tauri-apps/wry/issues/1195> ·
<https://v2.tauri.app/learn/system-tray/> · <https://v2.tauri.app/plugin/global-shortcut/> ·
<https://v2.tauri.app/start/prerequisites/> · <https://github.com/tauri-apps/global-hotkey> ·
<https://webkitgtk.org/reference/webkit2gtk/stable/signal.WebView.permission-request.html> ·
<https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2permissionkind> ·
<https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2controller.isvisible> ·
<https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate> ·
<https://bugs.webkit.org/show_bug.cgi?id=226620> ·
<https://developer.apple.com/documentation/iokit/kiopmassertiontypepreventuseridledisplaysleep> ·
<https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/AppNap.html> (⚠ archived 2016) ·
<https://developer.apple.com/documentation/BundleResources/Information-Property-List/UIBackgroundModes> ·
<https://www.electronjs.org/docs/latest/api/session> ·
<https://www.electronjs.org/docs/latest/api/system-preferences> ·
<https://developer.chrome.com/docs/android/trusted-web-activity/> (⚠ page dated 2020-02-04)

**Wake-word engines**, all checked 2026-09-08:
<https://github.com/Picovoice/porcupine> · <https://picovoice.ai/docs/faq/general/> ·
<https://github.com/k2-fsa/sherpa-onnx> · <https://github.com/dscripka/openWakeWord> ·
<https://github.com/MycroftAI/mycroft-precise> ·
<https://github.com/OpenVoiceOS/ovos-ww-plugin-precise-lite> ·
<https://github.com/Kitt-AI/snowboy>

**Specifications:** Opus, RFC 6716 <https://www.rfc-editor.org/rfc/rfc6716.txt> (September 2012).

**Prior work in this repository:** [`android-pwa-voice.md`](./android-pwa-voice.md) — the NO-GO
verdict on the pure-PWA approach, and the probe that measures what documentation cannot.

**Known gap, inherited and unchanged:** `issues.chromium.org` is not usefully citable
anonymously — search returns HTTP 401 and individual issues return `IamPermissionDeniedException`.
Where a bug thread would have been the natural citation, Chromium source or a Gerrit CL is cited
instead.

---

**Status: COMPLETE.** Every item W1–W6 carries a terminal verdict. Written 2026-09-08.
