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
