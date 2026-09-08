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

Gradle 8.5, AGP 8.2.2, Kotlin 1.9.22, compileSdk 34, build-tools 34.0.0.
