# muxterm Android wrapper

A plain WebView that loads muxterm and grants it the capabilities the web app needs.
It implements **no** muxterm feature: the chief of staff, voice and remote sessions all
already work in the web app. This wrapper exists to give that page a microphone that
keeps working when the screen goes off.

Reference: `docs/design/webview-wrapper.md` on branch `design/webview-wrapper`.

## Build

```sh
export JAVA_HOME=/home/ken/android-toolchain/jdk-17.0.20+8
export ANDROID_HOME=/home/ken/android-toolchain/android-sdk
cd android && ./gradlew assembleDebug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk` (debug-signed, sideloadable).

## Pointing it at a different server

Three ways, in precedence order:

1. In-app: press **back** at the root of history -> **Change URL**.
2. Intent: `adb shell am start -n io.ampbox.muxterm/.MainActivity -e url https://host`
3. Build time: `./gradlew assembleDebug -PmuxtermUrl=https://host`

(1) and (2) persist in SharedPreferences; **Reset to default** clears the override.

## Toolchain

Gradle 8.5, AGP 8.2.2, Kotlin 1.9.22, compileSdk 34, minSdk 26, targetSdk 34,
build-tools 34.0.0.

## What was verified, and how

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
