# The webview wrapper

**Premise, not a question.** muxterm's native app is a thin wrapper around a webview pointed
at the existing muxterm web app. The web app is the product. The wrapper exists only to give
that webview the platform capabilities a browser tab cannot have — chiefly audio capture and
playback that survive the screen going off, and later camera and file attachment as inputs.

This document designs that wrapper. It does not evaluate whether a wrapper is the right
architecture, and it does not compare one against a from-scratch native client.

**Status: DRAFT — in progress.**

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

**Caveat on claim 4 of the survival list, stated honestly:** I have verified that the *capture*
path has no lifecycle hook, and that the *video* path does. I have **not** verified that WebView
disables Blink's page-freezing for a backgrounded embedder — `kStopInBackground` is a Blink
feature, and WebView uses Blink. A WebView whose Activity is stopped may or may not be treated as
a hidden page by `PageSchedulerImpl`. **[UNSETTLED].** What would settle it, in order of cost:
(a) read `//android_webview/` for `PageScheduler`/visibility plumbing — cheap, and worth doing
before writing code; (b) the screen-off frame count in W6. If WebView *does* freeze the page,
the fix is within the wrapper's remit — keep the Activity technically visible, or drive the audio
graph from an `AudioWorklet` — and it does not change the architecture.

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
