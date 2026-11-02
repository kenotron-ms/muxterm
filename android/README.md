# muxterm Android satellite

The launcher is a native Android client for SDK projects and chats. It connects to
one muxterm server, shows that server's connected SSH nodes and their projects,
creates managed project folders and chats on a selected node, and reads and sends
chat messages through the server's existing API. The native transcript shows
user bubbles, Markdown replies, work progress and outcomes, questions, and
session errors. The composer supports attachments, native speech dictation,
steering, stop, and server-backed permission/model controls. Completed messages
can be copied, edited into a new chat, or forked. The phone does not run muxterm,
sessiond, SSH, or an agent harness. The **Workspace** action opens the original
WebView for sign-in, terminal, voice, and settings features.

Android's text share sheet can send text to the satellite. Shared text stays in a
local draft until the user chooses a chat and presses **Send**. No phone data is
published to other nodes in the background.

The WebView and its live voice service remain in the app. Native dictation uses
Android's speech recognizer to prepare a text draft; it is separate from the
WebView's live voice conversation. The original wrapper design
is documented in `docs/design/webview-wrapper.md`.

Reference: `docs/design/webview-wrapper.md` on branch `design/webview-wrapper`.

## Build

```sh
export JAVA_HOME=/home/ken/android-toolchain/jdk-17.0.20+8
export ANDROID_HOME=/home/ken/android-toolchain/android-sdk
cd android && ./gradlew assemblePhone
```

Output: `android/app/build/outputs/apk/phone/app-phone.apk` (debug-signed, sideloadable).
The `assembleDebug` variant also includes an Android Automotive OS launcher for
emulator verification. Do not install that variant on a phone.

To install alongside an existing GitHub release, build with
`./gradlew assemblePhone -PappIdSuffix=.satellite`. This uses package
`io.ampbox.muxterm.satellite` and has separate app data. The normal debug-signed
APK cannot update a release-signed installation in place.

## GitHub releases

Every `vMAJOR.MINOR.PATCH` tag builds a signed phone APK and attaches
`Muxterm-MAJOR.MINOR.PATCH-android.apk` to the existing GitHub Release. The tag
sets the Android version name and a monotonically increasing version code.
The release job uses repository secrets `ANDROID_RELEASE_KEYSTORE_BASE64` and
`ANDROID_RELEASE_KEYSTORE_PASSWORD`; the key alias is `muxterm-android`.
Release APKs use a different signing key from local debug and phone builds, so
installing the first release over a debug build requires uninstalling the debug
build once. Later release APKs can update each other in place.

## Pointing it at a different server

Three ways, in precedence order:

1. In-app: tap **Change server** under the muxterm title. The Workspace WebView also
   has **Change URL** at the root of its history.
2. Intent: `adb shell am start -n io.ampbox.muxterm/.MainActivity -e url https://host`
3. Build time: `./gradlew assemblePhone -PmuxtermUrl=https://host`

(1) and (2) persist in SharedPreferences; **Reset to default** clears the override.

## Toolchain

Gradle 8.5, AGP 8.2.2, Kotlin 1.9.22, compileSdk 34, minSdk 26, targetSdk 34,
build-tools 34.0.0.

## Native satellite verification

On an Android 14 emulator connected to isolated `make dev-local` on port 8313,
the native app created a fresh project and Codex chat, displayed a tool turn's
work duration and Markdown answer, uploaded and sent a file, opened the saved
attachment, uploaded a PNG that rendered inline, forked and edited completed
messages into new chats, and stopped a running shell turn. A separate running
turn accepted a steering message and displayed it inside the work disclosure;
its 16-second duration matched the browser. Playwright opened the same fresh chat in a real browser and
confirmed the messages, work disclosure, Markdown answer, and composer controls.
Android text sharing populated a draft, and **Discard** cleared it without
sending. The native dictation control launched Android's speech recognizer; the
emulator has no microphone input to verify transcription. The side-by-side APK
installed next to the existing package. A connected SSH node was not available
in this fixture, so remote relay still needs device verification.
The native screens and interaction storyboard are in
`docs/design-system/android-chat-storyboard.md`.

## Earlier WebView verification

Verified on an Android 14 (API 34) Pixel 6 emulator, `google_apis x86_64`.

| | Result | Evidence |
|---|---|---|
| Installs and launches | pass | `adb install` -> `Success`; app process starts, no crash |
| Loads muxterm over https | pass | muxterm login page renders in the WebView |
| JavaScript + DOM storage | pass | probe page reports `localStorage=v` and renders |
| Secure context | pass | probe page reports `secureContext=true` |
| Cookies survive process death | pass | see below |
| App holds RECORD_AUDIO | pass | both runtime dialogs shown and granted |
| WebView grants page's audio request | pass | `granting RESOURCE_AUDIO_CAPTURE to <origin>` |
| `getUserMedia` returns a track | pass, with a fake device | `GETUSERMEDIA OK tracks=1 label=Fake Default Audio Input` |
| Foreground service starts, correctly typed | pass | `isForeground=true foregroundId=1 types=00000082` |
| Notification appears | pass | shade shows `muxterm` / `Connecting...` |
| Real microphone audio | **not verifiable here** | build host has no `/dev/snd`, no audio hardware at all |
| Capture survives screen off | **physical device only** | it is Android *policy*, and vendor battery managers differ |

`types=00000082` is `FOREGROUND_SERVICE_TYPE_MICROPHONE` (0x80) or
`FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK` (0x02) - exactly what the manifest
declares. On Android 14 a mismatch between manifest and `startForeground()` throws,
so a clean start is itself the proof the declaration is right.

### Reproducing the probe

The probe points the wrapper at a local page over `adb reverse`, which is also a
secure context, so it exercises the same code paths as production:

```sh
adb reverse tcp:8090 tcp:8090        # probe page served on the host
adb shell am start -n io.ampbox.muxterm/.MainActivity -e url http://localhost:8090/
adb logcat -s muxterm:*
```

Cookie persistence was checked against a cookie with the same attributes muxterm
uses for `muxterm_session` (`Path=/; HttpOnly; SameSite=Lax; Max-Age=...`, see
`internal/server/authclient.go`): load the page, `adb shell am force-stop`, relaunch,
and confirm the server sees the cookie on the first request of the new process.

Because the host has no audio hardware, `getUserMedia` was exercised with
Chromium's fake capture device:

```sh
adb shell 'echo "webview --use-fake-device-for-media-stream" > /data/local/tmp/webview-command-line'
```

That proves the permission chain delivers a working `MediaStream` to the page. It
does **not** prove real capture, which needs a device with a microphone.

### The screen-off run, and what it did and did not show

The emulator was put to sleep (`mWakefulness=Asleep`) for six unbroken minutes with a
capture active and the probe page sampling its `AnalyserNode` every five seconds.
JavaScript kept running the whole time - 74 consecutive samples, every interval 5.000s,
no gap:

```
09-08 04:30:32.831  console: rms_sum=0.0000 t=1788841832830
...
09-08 04:36:37.830  console: rms_sum=0.0000 t=1788842197829
```

Read this carefully, because it is not the result it looks like. The foreground service
had already stopped before the window began (the fake capture device registers no
`AudioRecordingConfiguration`, so the "capture never started" guard fired), which means
**the visibility pin was OFF for this entire run**. It is a control, not a test.

What it shows: unpinned, with no foreground service, this WebView did not freeze in six
minutes of screen-off. The emulator therefore does not reproduce the failure W1.4b
describes, and running the pinned case would prove nothing that this run has not already
made unfalsifiable. The pin stays in, unverified, exactly as the design doc leaves it.

What it does show positively: the app was not killed, the WebView kept executing, and
the page kept its `MediaStream` across six minutes of screen-off.

## What a physical device still has to settle

- Whether the microphone actually keeps producing audio with the screen off. The
  foreground service is the documented fix, but the policy is the OS's.
- Whether the visibility pin (`MuxtermWebView`, design doc W1.4b) really prevents
  Blink freezing the page during a long conversational pause. The doc marks the
  mechanism `[INFERENCE]` from Chromium sources and `[UNSETTLED]` pending exactly
  this measurement.
- Vendor battery managers. The doc rates several manufacturers 5/5 for killing
  background apps beyond AOSP policy. Plan for a Pixel-class device first.
