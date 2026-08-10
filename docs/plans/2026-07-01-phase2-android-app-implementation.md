# Phase 2 — muxterm Android Companion App Implementation Plan

> **For execution:** Use `/build-like-ken` mode.

**Goal:** Build a native Android (Kotlin + Jetpack Compose) companion app that connects to muxterm's existing sessiond WebSocket contract, renders terminals via libghostty-vt over JNI, hosts a server-drivable `WebView` browser pane, and reaches remote dev boxes through an embedded SSH session.

**Architecture:** A thin client speaking the frozen `muxterm-client-protocol.md` (see Phase 0). Five bricks (Protocol Client, Terminal Pane, Dashboard/Layout UI, Browser Pane, Connection Manager) live in a **new, separate repo `muxterm-android`** — NOT inside the Go monorepo. The terminal-emulation core is the one shared native dependency: **libghostty-vt**, cross-compiled with Zig for `aarch64-linux-android` (+ `armeabi-v7a`, `x86_64` for emulator) and called over JNI, wrapped behind our own stable Kotlin interface. Everything resolves to `localhost:PORT` on-device: a `-L` SSH forward carries the control WebSocket (loopback-auth dividend → SSH keys are the auth), and a local SOCKS5 listener bridges the `WebView` to the remote box's ports over SSH `direct-tcpip` channels.

**Tech Stack:** Kotlin, Jetpack Compose (Material 3), OkHttp (WebSocket), kotlinx.serialization (JSON), sshj (SSH client), libghostty-vt via Zig+JNI, Android `WebView` + `androidx.webkit` `ProxyController`, Compose Canvas (cell-grid rendering). Min SDK 26, target SDK 34.

**Verification approach:** Android has **no local sessiond** — every milestone verifies against a **live remote muxterm sessiond** (a networked host or dev box reachable over the LAN/tailnet). Static gate first (`./gradlew assembleDebug`, ktlint), then install + run on an emulator or physical device, connect to the live sessiond, and observe real behavior (bootstrap logs, a rendered/typed shell, grouped remotes, a driven browser). The only unit tests are JVM tests for the **protocol framing codec** and the **settle-barrier state machine** — pure library logic. Everything else is verified by running the real app against the real server. This mirrors muxterm's project testing policy: no unit tests for integration behavior; verify in a real client.

**Reference implementation to study (do NOT copy verbatim):** Chuchu — `github.com/jossephus/chuchu` (Kotlin + Compose + JNI + Zig + libghostty-vt). It proves the exact Zig→JNI→Compose-Canvas terminal path this plan depends on. Study its `build.zig`, JNI bridge, and Canvas renderer; adapt patterns to our wrapper interface.

---

## ⚠️ Read before starting: libghostty-vt is pre-1.0 and its API churns

libghostty-vt has **no ABI-frozen release** as of this plan (mid-2026 target, unconfirmed — see design Open Questions). **Do not** hardcode assumptions about its C symbols from memory. The mandatory mitigation, applied in M2:

1. **Pin** an exact commit of ghostty in a git submodule.
2. **Vendor** the pinned `libghostty-vt` C header (`ghostty_vt.h` or equivalent) into the repo at `terminal-core/vendor/` and read the **real** function signatures from it — the JNI C code in this plan uses placeholder symbol names (`ghostty_vt_*`) that **you must reconcile against the vendored header** before it compiles.
3. **Wrap** every libghostty-vt call behind our `GhosttyVt` Kotlin interface (M2 Task 4) so a future API change touches one file, not the whole app.

Where this plan writes libghostty-vt call code, it is marked **`// VERIFY-AGAINST-HEADER`**. Treat those as scaffolding with correct *shape* (parse bytes in, read a cell grid out), not correct *symbol names*. This is honest: the settle-barrier, framing, SSH, and JS-executor code below is exact and copy-pasteable; the libghostty-vt FFI surface is intentionally wrapped and flagged because its upstream is unstable.

---

## Repository layout (target)

```
muxterm-android/
├── settings.gradle.kts
├── build.gradle.kts                      # root
├── gradle/libs.versions.toml             # version catalog
├── app/
│   ├── build.gradle.kts
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── java/com/muxterm/app/
│       │   ├── MuxApplication.kt
│       │   ├── MainActivity.kt
│       │   ├── protocol/                 # M1 — Protocol Client brick
│       │   │   ├── Message.kt
│       │   │   ├── PaneFrame.kt
│       │   │   ├── ProtocolClient.kt
│       │   │   └── CidCorrelator.kt
│       │   ├── terminal/                 # M2 — Terminal Pane brick
│       │   │   ├── GhosttyVt.kt          # stable wrapper interface
│       │   │   ├── GhosttyVtNative.kt    # JNI declarations
│       │   │   ├── TerminalPane.kt       # settle-barrier state machine
│       │   │   ├── TerminalRegistry.kt
│       │   │   ├── Keymap.kt
│       │   │   └── TerminalCanvas.kt     # Compose Canvas renderer
│       │   ├── ui/                       # M3 — Dashboard/Layout UI brick
│       │   │   ├── DashboardScreen.kt
│       │   │   ├── WorkspaceScreen.kt
│       │   │   ├── PaneStrip.kt
│       │   │   ├── KeyAccessoryBar.kt
│       │   │   └── MuxStore.kt           # platform-agnostic state model
│       │   ├── browser/                  # M4 — Browser Pane brick
│       │   │   ├── BrowserPane.kt
│       │   │   ├── BrowserExecutor.kt
│       │   │   └── AuthorityBanner.kt
│       │   └── conn/                     # M5 — Connection Manager brick
│       │       ├── ConnectionManager.kt
│       │       ├── SshSession.kt
│       │       ├── SocksListener.kt
│       │       ├── Identities.kt
│       │       └── AddConnectionSheet.kt
│       └── jniLibs/                      # populated by M2 Zig build
│           ├── arm64-v8a/libghostty_vt_jni.so
│           ├── armeabi-v7a/libghostty_vt_jni.so
│           └── x86_64/libghostty_vt_jni.so
├── terminal-core/                        # M2 — native build
│   ├── build.zig
│   ├── jni_bridge.c
│   ├── vendor/                           # pinned libghostty-vt header(s)
│   └── ghostty/                          # git submodule (pinned commit)
└── src/test/java/com/muxterm/app/        # JVM unit tests (framing + settle only)
    ├── PaneFrameTest.kt
    └── SettleBarrierTest.kt
```

---

## Milestone Overview

| Milestone | Delivers | Live-sessiond verification |
|-----------|----------|----------------------------|
| **M1** | Gradle scaffold + Protocol Client (Message codec, binary frame, cid correlation over OkHttp WS) | JVM framing test + connect to real sessiond, log full bootstrap |
| **M2** | libghostty-vt Zig/JNI brick + settle-barrier + keymap + Canvas render | Run on device, attach a shell, render + type; settle scenarios |
| **M3** | Unified dashboard (remotes-only) + pane-strip nav + key bar + per-breakpoint layout | Cold launch → grouped remotes → open/switch panes |
| **M4** | WebView browser pane + browser-command executor + events + authority banner | Drive the app via muxterm MCP browser tools |
| **M5** | Embedded sshj `-L` control forward + SOCKS5→direct-tcpip + onboarding flow + key mgmt | Connect to a real remote box; terminal + browser over the forward |

Total tasks: 34. Milestones are independently verifiable; do them in order (each builds on the prior brick).

---

# M1 — Project Scaffold + Protocol Client

**Goal:** A Gradle project that builds an installable debug APK and can open `/ws` against a real sessiond, run the bootstrap sequence (`config → workspace-list → attach → composition → replay → live`), correctly encode/decode the `Message` JSON envelope and the `[4-byte LE paneId][payload]` binary frame, and correlate replies by `cid`.

**Live verification target:** a running muxterm sessiond reachable at `ws://<HOST>:<PORT>/ws`. For M1 you may connect **directly** (no SSH yet) to a sessiond on your LAN started with its control port bound to `0.0.0.0` for testing, e.g. on the host: `muxterm --listen 0.0.0.0:8311`. (SSH forwarding arrives in M5; direct connect is a scaffolding shortcut for M1–M4 only.)

### Task 1: Gradle project scaffold

**Files:**
- Create: `settings.gradle.kts`, `build.gradle.kts`, `gradle/libs.versions.toml`, `app/build.gradle.kts`, `app/src/main/AndroidManifest.xml`, `app/src/main/java/com/muxterm/app/MuxApplication.kt`, `app/src/main/java/com/muxterm/app/MainActivity.kt`

**Implementation**

`settings.gradle.kts`:
```kotlin
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
}
rootProject.name = "muxterm-android"
include(":app")
```

`gradle/libs.versions.toml`:
```toml
[versions]
agp = "8.5.2"
kotlin = "2.0.20"
compose-bom = "2024.09.02"
okhttp = "4.12.0"
serialization = "1.7.2"
sshj = "0.38.0"
webkit = "1.11.0"
lifecycle = "2.8.5"
activity-compose = "1.9.2"
junit = "4.13.2"

[libraries]
okhttp = { module = "com.squareup.okhttp3:okhttp", version.ref = "okhttp" }
kotlinx-serialization-json = { module = "org.jetbrains.kotlinx:kotlinx-serialization-json", version.ref = "serialization" }
sshj = { module = "com.hierynomus:sshj", version.ref = "sshj" }
androidx-webkit = { module = "androidx.webkit:webkit", version.ref = "webkit" }
compose-bom = { module = "androidx.compose:compose-bom", version.ref = "compose-bom" }
compose-material3 = { module = "androidx.compose.material3:material3" }
compose-ui = { module = "androidx.compose.ui:ui" }
compose-ui-tooling = { module = "androidx.compose.ui:ui-tooling" }
compose-ui-tooling-preview = { module = "androidx.compose.ui:ui-tooling-preview" }
activity-compose = { module = "androidx.activity:activity-compose", version.ref = "activity-compose" }
lifecycle-runtime = { module = "androidx.lifecycle:lifecycle-runtime-ktx", version.ref = "lifecycle" }
junit = { module = "junit:junit", version.ref = "junit" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
kotlin-serialization = { id = "org.jetbrains.kotlin.plugin.serialization", version.ref = "kotlin" }
compose-compiler = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
```

`build.gradle.kts` (root):
```kotlin
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.compose.compiler) apply false
}
```

`app/build.gradle.kts`:
```kotlin
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.compose.compiler)
}

android {
    namespace = "com.muxterm.app"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.muxterm.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64") }
    }
    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    // jniLibs/ is populated by the M2 Zig build; default sourceSet picks it up.
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.runtime)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.sshj)
    implementation(libs.androidx.webkit)
    testImplementation(libs.junit)
}
```

`app/src/main/AndroidManifest.xml`:
```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application
        android:name=".MuxApplication"
        android:label="muxterm"
        android:usesCleartextTraffic="true"
        android:theme="@style/Theme.Material3.DynamicColors.DayNight">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```
> `usesCleartextTraffic` is needed because the control WS connects to `localhost` (loopback) over `ws://` (the SSH tunnel is the encryption layer). Scope it to a `network_security_config` limited to `127.0.0.1` before any release build — noted in "Deferred to later".

`MuxApplication.kt`:
```kotlin
package com.muxterm.app

import android.app.Application

class MuxApplication : Application()
```

`MainActivity.kt`:
```kotlin
package com.muxterm.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { Text("muxterm — scaffold") }
    }
}
```

**Static Analysis**
```
./gradlew :app:assembleDebug
```
Expected: `BUILD SUCCESSFUL`; `app/build/outputs/apk/debug/app-debug.apk` exists.

**Verification**
```
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.muxterm.app/.MainActivity
```
Expected: app launches, shows "muxterm — scaffold".

**Commit**
```bash
git add settings.gradle.kts build.gradle.kts gradle/ app/
git commit -m "feat: gradle scaffold + installable debug APK"
```

---

### Task 2: Message envelope + JSON codec

**Files:**
- Create: `app/src/main/java/com/muxterm/app/protocol/Message.kt`

The `Message` shape mirrors the frozen Go/TS `SessiondMessage` exactly (field names byte-for-byte). Source of truth: `web/src/types.ts:100-129` and Phase 0's `muxterm-client-protocol.md`.

**Implementation**
```kotlin
package com.muxterm.app.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Frozen sessiond message-type vocabulary (mirrors Go MsgType / TS SessiondType). */
object MsgType {
    const val CreateWorkspace = "create-workspace"
    const val ListWorkspaces = "list-workspaces"
    const val Attach = "attach"
    const val CreatePane = "create-pane"
    const val ClosePane = "close-pane"
    const val Resize = "resize"
    const val SaveLayout = "save-layout"
    const val RenamePane = "rename-pane"
    // Replies
    const val WorkspaceList = "workspace-list"
    const val Composition = "composition"
    const val PaneCreated = "pane-created"
    const val Ok = "ok"
    // Events
    const val PaneAdded = "pane-added"
    const val PaneClosed = "pane-closed"
    const val WorkspaceClosed = "workspace-closed"
    const val Error = "error"
    // Phase 0 browser-control (client-rendered, server-drivable)
    const val BrowserCommand = "browser-command"   // server -> client
    const val BrowserResult = "browser-result"     // client -> server
    const val BrowserUrl = "browser-url"           // client -> server (nav committed)
    const val BrowserLoad = "browser-load"         // client -> server (load complete)
}

@Serializable
data class WorkspaceInfo(
    val workspaceId: String,
    val name: String? = null,
    val clientRef: String? = null,
    val paneCount: Int = 0,
)

@Serializable
data class PaneInfo(
    val paneId: Int,
    val cols: Int = 0,
    val rows: Int = 0,
    val title: String? = null,
    val clientRef: String? = null,
    /** Absolute byte sequence of the first replayed byte. Omitted when 0. */
    val seq: Long? = null,
    /** Total bytes ever written; expectedReplayBytes = totalSeq - seq. */
    val totalSeq: Long? = null,
    val surfaceKind: String? = null, // "terminal" | "driver" | "browser" | "settings"
)

@Serializable
data class PaneOffset(val paneId: Int, val seq: Long)

/**
 * Flat sessiond control envelope. Every field is optional; only the ones
 * relevant to a given `type` are populated. `params` is a raw JSON string for
 * browser-command payloads (opaque here; parsed by BrowserExecutor in M4).
 */
@Serializable
data class Message(
    val type: String,
    val cid: Long? = null,
    val clientRef: String? = null,
    val workspaceId: String? = null,
    val name: String? = null,
    val paneId: Int? = null,
    val cols: Int? = null,
    val rows: Int? = null,
    val cmd: List<String>? = null,
    val title: String? = null,
    val workspaces: List<WorkspaceInfo>? = null,
    val panes: List<PaneInfo>? = null,
    val code: String? = null,
    val error: String? = null,
    val breakpoint: String? = null,
    val layout: String? = null,
    val surfaceKind: String? = null,
    val offsets: List<PaneOffset>? = null,
    val placement: String? = null,
    val referencePaneId: Int? = null,
    // Browser-control fields (Phase 0)
    val action: String? = null,
    @SerialName("params") val paramsJson: kotlinx.serialization.json.JsonElement? = null,
    val result: kotlinx.serialization.json.JsonElement? = null,
    val url: String? = null,
)

/** Shared JSON codec: ignore unknown keys (forward-compat), omit nulls on encode. */
val MuxJson = Json {
    ignoreUnknownKeys = true
    encodeDefaults = false
    explicitNulls = false
}
```

**Static Analysis**
```
./gradlew :app:compileDebugKotlin
```
Expected: `BUILD SUCCESSFUL`.

**Verification** — round-trip a real bootstrap message via a one-off unit test in Task 4's file; nothing to run standalone here. Proceed to Task 3.

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/protocol/Message.kt
git commit -m "feat: sessiond Message envelope + JSON codec"
```

---

### Task 3: Binary pane-frame codec (`[4-byte LE paneId][payload]`)

**Files:**
- Create: `app/src/main/java/com/muxterm/app/protocol/PaneFrame.kt`
- Create: `src/test/java/com/muxterm/app/PaneFrameTest.kt`

This is a **hard brick** — get endianness right or nothing renders. Mirrors `web/src/types.ts:140-154` (`encodePaneFrame`/`decodePaneFrame`).

**Implementation** (`PaneFrame.kt`)
```kotlin
package com.muxterm.app.protocol

import okio.ByteString
import okio.ByteString.Companion.toByteString

/** Binary pane-data frame: [4-byte LITTLE-ENDIAN paneId][raw VT bytes]. */
object PaneFrame {

    /** Encode outbound keystrokes/input: paneId header + payload. */
    fun encode(paneId: Int, data: ByteArray): ByteString {
        val buf = ByteArray(4 + data.size)
        buf[0] = (paneId and 0xFF).toByte()
        buf[1] = ((paneId ushr 8) and 0xFF).toByte()
        buf[2] = ((paneId ushr 16) and 0xFF).toByte()
        buf[3] = ((paneId ushr 24) and 0xFF).toByte()
        System.arraycopy(data, 0, buf, 4, data.size)
        return buf.toByteString()
    }

    data class Frame(val paneId: Int, val data: ByteArray)

    /** Decode an inbound binary frame. Throws if shorter than the 4-byte header. */
    fun decode(bytes: ByteString): Frame {
        require(bytes.size >= 4) { "pane frame too short: ${bytes.size}" }
        val b = bytes.toByteArray()
        val paneId = (b[0].toInt() and 0xFF) or
            ((b[1].toInt() and 0xFF) shl 8) or
            ((b[2].toInt() and 0xFF) shl 16) or
            ((b[3].toInt() and 0xFF) shl 24)
        return Frame(paneId, b.copyOfRange(4, b.size))
    }
}
```
> okio's `ByteString` ships with OkHttp — no extra dependency. OkHttp's WebSocket delivers binary frames as `ByteString`, so decode consumes them directly.

**Implementation** (`PaneFrameTest.kt`) — a legitimate library unit test (pure logic, no I/O):
```kotlin
package com.muxterm.app

import com.muxterm.app.protocol.PaneFrame
import okio.ByteString.Companion.toByteString
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class PaneFrameTest {
    @Test fun roundTrip() {
        val payload = byteArrayOf(0x1b, '['.code.toByte(), '2'.code.toByte(), 'J'.code.toByte())
        val encoded = PaneFrame.encode(258, payload) // 258 = 0x0102
        val bytes = encoded.toByteArray()
        // little-endian: 0x02, 0x01, 0x00, 0x00
        assertEquals(0x02.toByte(), bytes[0])
        assertEquals(0x01.toByte(), bytes[1])
        assertEquals(0x00.toByte(), bytes[2])
        assertEquals(0x00.toByte(), bytes[3])
        val frame = PaneFrame.decode(encoded.toByteArray().toByteString())
        assertEquals(258, frame.paneId)
        assertArrayEquals(payload, frame.data)
    }

    @Test fun highPaneIdEndianness() {
        val encoded = PaneFrame.encode(0x01020304, ByteArray(0))
        val frame = PaneFrame.decode(encoded.toByteArray().toByteString())
        assertEquals(0x01020304, frame.paneId)
    }
}
```

**Static Analysis**
```
./gradlew :app:compileDebugKotlin
```
Expected: `BUILD SUCCESSFUL`.

**Verification** (library code → unit test is the correct level here)
```
./gradlew :app:testDebugUnitTest --tests "com.muxterm.app.PaneFrameTest"
```
Expected: `BUILD SUCCESSFUL`, 2 tests passed.

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/protocol/PaneFrame.kt src/test/java/com/muxterm/app/PaneFrameTest.kt
git commit -m "feat: binary pane-frame codec + framing tests"
```

---

### Task 4: ProtocolClient — OkHttp WebSocket + cid correlation + bootstrap

**Files:**
- Create: `app/src/main/java/com/muxterm/app/protocol/CidCorrelator.kt`
- Create: `app/src/main/java/com/muxterm/app/protocol/ProtocolClient.kt`

**Implementation** (`CidCorrelator.kt`)
```kotlin
package com.muxterm.app.protocol

import kotlinx.coroutines.CompletableDeferred
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * Correlates request `cid`s to reply futures. The client assigns a monotonic
 * cid on each request that expects a reply; the matching reply carries the same
 * cid. Reused for browser-command/browser-result correlation (server assigns
 * that cid; we echo it in the result).
 */
class CidCorrelator {
    private val next = AtomicLong(1)
    private val pending = ConcurrentHashMap<Long, CompletableDeferred<Message>>()

    fun allocate(): Long = next.getAndIncrement()

    fun expect(cid: Long): CompletableDeferred<Message> =
        CompletableDeferred<Message>().also { pending[cid] = it }

    /** Resolve a pending future if the reply's cid matches. Returns true if consumed. */
    fun resolve(msg: Message): Boolean {
        val cid = msg.cid ?: return false
        return pending.remove(cid)?.complete(msg) ?: false
    }
}
```

**Implementation** (`ProtocolClient.kt`)
```kotlin
package com.muxterm.app.protocol

import android.util.Log
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

private const val TAG = "ProtocolClient"

sealed interface Inbound {
    data class Control(val msg: Message) : Inbound
    data class PaneData(val frame: PaneFrame.Frame) : Inbound
    data class Closed(val code: Int, val reason: String) : Inbound
    data class Failed(val t: Throwable) : Inbound
    data object Open : Inbound
}

/**
 * The Protocol Client brick. Encode/decode Message + binary frames, cid
 * correlation, and a hot flow of inbound events. It is transport-only — it does
 * NOT know local vs remote; the Connection Manager (M5) supplies the URL
 * (a device-loopback port for remotes, a LAN host for M1-M4 dev).
 */
class ProtocolClient(
    private val http: OkHttpClient = OkHttpClient(),
) {
    val cids = CidCorrelator()
    private val _inbound = MutableSharedFlow<Inbound>(extraBufferCapacity = 256)
    val inbound: SharedFlow<Inbound> = _inbound
    @Volatile private var ws: WebSocket? = null

    fun connect(wsUrl: String) {
        val req = Request.Builder().url(wsUrl).build()
        ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "ws open $wsUrl")
                _inbound.tryEmit(Inbound.Open)
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = runCatching { MuxJson.decodeFromString(Message.serializer(), text) }
                    .getOrElse { Log.w(TAG, "bad control frame: $text", it); return }
                cids.resolve(msg) // resolve any awaiting future; still emit for stream consumers
                _inbound.tryEmit(Inbound.Control(msg))
            }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                val frame = runCatching { PaneFrame.decode(bytes) }
                    .getOrElse { Log.w(TAG, "bad pane frame", it); return }
                _inbound.tryEmit(Inbound.PaneData(frame))
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                _inbound.tryEmit(Inbound.Closed(code, reason))
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "ws failure", t)
                _inbound.tryEmit(Inbound.Failed(t))
            }
        })
    }

    fun send(msg: Message) {
        ws?.send(MuxJson.encodeToString(Message.serializer(), msg))
    }

    fun sendPaneInput(paneId: Int, data: ByteArray) {
        ws?.send(PaneFrame.encode(paneId, data))
    }

    fun close() { ws?.close(1000, "client close"); ws = null }

    // --- bootstrap senders (mirror web/src/ws.ts) ---
    fun listWorkspaces() = send(Message(type = MsgType.ListWorkspaces))
    fun attach(workspaceId: String, breakpoint: String) =
        send(Message(type = MsgType.Attach, workspaceId = workspaceId, breakpoint = breakpoint))
    fun resize(paneId: Int, cols: Int, rows: Int) =
        send(Message(type = MsgType.Resize, paneId = paneId, cols = cols, rows = rows))
    fun createPane(cmd: List<String>? = null) =
        send(Message(type = MsgType.CreatePane, cmd = cmd?.takeIf { it.isNotEmpty() }))
    fun closePane(paneId: Int) = send(Message(type = MsgType.ClosePane, paneId = paneId))
}
```

**Static Analysis**
```
./gradlew :app:compileDebugKotlin
```
Expected: `BUILD SUCCESSFUL`.

**Verification** — deferred to Task 5 (wire a debug screen and connect to the live sessiond).

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/protocol/CidCorrelator.kt app/src/main/java/com/muxterm/app/protocol/ProtocolClient.kt
git commit -m "feat: ProtocolClient over OkHttp WebSocket + cid correlation"
```

---

### Task 5: Bootstrap smoke screen — connect to a live sessiond and log the sequence

**Files:**
- Modify: `app/src/main/java/com/muxterm/app/MainActivity.kt`

Add a minimal debug Compose screen with a URL field (default `ws://10.0.2.2:8311/ws` — `10.0.2.2` is the emulator's alias for the host machine) and a "Connect" button that runs the bootstrap and logs every inbound event. This is the M1 verification harness, not product UI (M3 replaces it).

**Implementation**
```kotlin
package com.muxterm.app

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.lifecycle.lifecycleScope
import com.muxterm.app.protocol.*
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val client = ProtocolClient()
        setContent {
            MaterialTheme {
                var url by remember { mutableStateOf("ws://10.0.2.2:8311/ws") }
                var log by remember { mutableStateOf("") }
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(url, { url = it }, label = { Text("sessiond /ws URL") })
                    Button(onClick = {
                        lifecycleScope.launch {
                            client.inbound.collect { ev ->
                                val line = when (ev) {
                                    is Inbound.Open -> "OPEN"
                                    is Inbound.Control -> "CTRL ${ev.msg.type} " +
                                        "ws=${ev.msg.workspaces?.size} panes=${ev.msg.panes?.size}"
                                    is Inbound.PaneData -> "DATA pane=${ev.frame.paneId} n=${ev.frame.data.size}"
                                    is Inbound.Closed -> "CLOSED ${ev.code}"
                                    is Inbound.Failed -> "FAILED ${ev.t.message}"
                                }
                                Log.i("Bootstrap", line)
                                log = "$line\n$log"
                                // Bootstrap: on OPEN -> list; on workspace-list -> attach first.
                                if (ev is Inbound.Open) client.listWorkspaces()
                                if (ev is Inbound.Control && ev.msg.type == MsgType.WorkspaceList) {
                                    ev.msg.workspaces?.firstOrNull()?.let {
                                        client.attach(it.workspaceId, "desktop")
                                    }
                                }
                            }
                        }
                        client.connect(url)
                    }) { Text("Connect") }
                    Text(log, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}
```

**Static Analysis**
```
./gradlew :app:assembleDebug
```
Expected: `BUILD SUCCESSFUL`.

**Verification** (real server — this is the M1 gate)

On the host, start a sessiond with at least one workspace/pane and bind the control port for LAN access:
```
muxterm --listen 0.0.0.0:8311    # exact flag per Phase 0; adjust if named differently
```
Then, with an emulator running:
```
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.muxterm.app/.MainActivity
adb logcat -s Bootstrap:I ProtocolClient:I
```
In the app, tap **Connect**. Expected logcat lines (order may interleave; the sequence must appear):
```
Bootstrap: OPEN
Bootstrap: CTRL workspace-list ws=<N> panes=null
Bootstrap: CTRL composition ws=null panes=<M>
Bootstrap: DATA pane=<id> n=<bytes>        # replay frames
```
Success = you see `workspace-list`, then `composition` with a non-null `panes`, then binary `DATA` frames. That proves the JSON codec, the binary decoder, and the bootstrap round-trip all work against a real sessiond.

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/MainActivity.kt
git commit -m "feat: M1 bootstrap smoke screen (verified against live sessiond)"
```

---

# M2 — libghostty-vt via JNI (the hard brick)

**Goal:** Cross-compile libghostty-vt with Zig for Android ABIs, bridge it to Kotlin over JNI behind a stable `GhosttyVt` wrapper, render its cell grid with Compose Canvas, port the web client's **settle-barrier state machine faithfully** (totalSeq gating, 3s RC-1 escape, reattach-without-dispose, generation counter), and own the keystroke keymap. End state: attach a real shell on a device and type into it.

> **Honesty flag:** the Zig build invocation and the JNI C function bodies below have the correct **structure** (feed VT bytes → parse → expose a cell grid) but use **placeholder libghostty-vt symbol names**. Because libghostty-vt is pre-1.0 (see the top-of-doc warning), you MUST open the vendored header after Task 1 and replace every `// VERIFY-AGAINST-HEADER` call with the real symbols. Study Chuchu's `jni_bridge` for the concrete, currently-working call sequence.

### Task 1: Vendor + pin ghostty; establish the Zig toolchain

**Files:**
- Create: `terminal-core/ghostty/` (git submodule, pinned commit)
- Create: `terminal-core/vendor/README.md`
- Create: `.tool-versions` (record the exact Zig version)

**Steps**
```bash
# From repo root:
git submodule add https://github.com/ghostty-org/ghostty terminal-core/ghostty
cd terminal-core/ghostty && git checkout <PINNED_COMMIT_SHA> && cd ../..
git submodule status  # record the SHA in terminal-core/vendor/README.md
```
Record the Zig version Chuchu/ghostty currently builds with (read ghostty's `build.zig.zon` / CI) into `.tool-versions`:
```
zig <EXACT_VERSION>
```
Copy the libghostty-vt public C header out of the submodule into `terminal-core/vendor/` and read it:
```bash
find terminal-core/ghostty -name "*.h" | grep -i vt   # locate the vt header
cp <that header> terminal-core/vendor/ghostty_vt.h
```

**Verification** (no app build yet — toolchain sanity)
```
zig version                              # matches .tool-versions
test -f terminal-core/vendor/ghostty_vt.h && echo "header vendored"
git submodule status terminal-core/ghostty
```
Expected: Zig version prints, header exists, submodule pinned to the recorded SHA.

**Commit**
```bash
git add .gitmodules terminal-core/ .tool-versions
git commit -m "build: vendor + pin libghostty-vt, record Zig toolchain"
```

---

### Task 2: `build.zig` — cross-compile the JNI `.so` for Android ABIs

**Files:**
- Create: `terminal-core/build.zig`
- Create: `terminal-core/jni_bridge.c`
- Create: `scripts/build-terminal-core.sh`

**Implementation** (`build.zig`) — builds a shared library that links libghostty-vt and our JNI bridge, one per Android target triple.
```zig
const std = @import("std");

pub fn build(b: *std.Build) void {
    const optimize = b.standardOptimizeOption(.{});
    // Caller passes -Dtarget=aarch64-linux-android (etc). Android API 26.
    const target = b.standardTargetOptions(.{});

    const lib = b.addSharedLibrary(.{
        .name = "ghostty_vt_jni",
        .target = target,
        .optimize = optimize,
    });

    // The vendored libghostty-vt module. The exact dependency wiring depends on
    // ghostty's build.zig at the pinned commit — read it. Typically you add the
    // ghostty module and link the vt static lib. VERIFY-AGAINST-SUBMODULE.
    const ghostty = b.dependency("ghostty", .{ .target = target, .optimize = optimize });
    lib.addIncludePath(b.path("vendor"));
    lib.linkLibrary(ghostty.artifact("ghostty-vt")); // VERIFY-AGAINST-SUBMODULE artifact name

    // JNI headers ship with the Android NDK; the include path is passed via
    // -Dndk-jni=... from the build script (points at $NDK/.../include).
    if (b.option([]const u8, "ndk-jni", "NDK JNI include dir")) |jni| {
        lib.addIncludePath(.{ .cwd_relative = jni });
    }

    lib.addCSourceFile(.{ .file = b.path("jni_bridge.c"), .flags = &.{"-std=c11"} });
    lib.linkLibC();

    b.installArtifact(lib);
}
```

**Implementation** (`scripts/build-terminal-core.sh`) — builds all three ABIs and copies to `jniLibs/`:
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../terminal-core"

# JNI headers are architecture-independent; any NDK sysroot include works.
NDK="${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME}"
JNI_INC="$NDK/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/include"

declare -A ABI=(
  [aarch64-linux-android]=arm64-v8a
  [arm-linux-androideabi]=armeabi-v7a
  [x86_64-linux-android]=x86_64
)

for triple in "${!ABI[@]}"; do
  abi="${ABI[$triple]}"
  echo ">>> building $triple -> $abi"
  zig build -Dtarget="$triple" -Dndk-jni="$JNI_INC" -Doptimize=ReleaseSafe
  dest="../app/src/main/jniLibs/$abi"
  mkdir -p "$dest"
  cp "zig-out/lib/libghostty_vt_jni.so" "$dest/"
done
echo "done — jniLibs populated"
```

**Implementation** (`jni_bridge.c`) — see Task 3; created together but shown there.

**Static Analysis / Verification** (native build — deferred until jni_bridge.c exists in Task 3). Just make the script executable now:
```
chmod +x scripts/build-terminal-core.sh
```

**Commit**
```bash
git add terminal-core/build.zig scripts/build-terminal-core.sh
git commit -m "build: Zig cross-compile wiring for Android ABIs"
```

---

### Task 3: JNI bridge C (parse VT bytes → expose cell grid)

**Files:**
- Create: `terminal-core/jni_bridge.c`

The bridge holds an opaque libghostty-vt terminal handle per pane, feeds it bytes, and copies out a snapshot of the visible grid as a packed int array Kotlin can read. **Every libghostty-vt call is `// VERIFY-AGAINST-HEADER`.**

**Implementation**
```c
#include <jni.h>
#include <stdlib.h>
#include <string.h>
#include "ghostty_vt.h"   // vendored; VERIFY the real API

// One opaque VT instance per pane. libghostty-vt owns parsing + screen state;
// we only pull a cell-grid snapshot for rendering.
// The exact type/functions come from ghostty_vt.h — names below are PLACEHOLDERS.

// nativeNew(cols, rows) -> handle
JNIEXPORT jlong JNICALL
Java_com_muxterm_app_terminal_GhosttyVtNative_nativeNew(
        JNIEnv *env, jobject thiz, jint cols, jint rows) {
    // VERIFY-AGAINST-HEADER: allocate a terminal of size cols x rows.
    GhosttyVt *vt = ghostty_vt_new((uint16_t) cols, (uint16_t) rows);
    return (jlong) (intptr_t) vt;
}

// nativeFree(handle)
JNIEXPORT void JNICALL
Java_com_muxterm_app_terminal_GhosttyVtNative_nativeFree(
        JNIEnv *env, jobject thiz, jlong handle) {
    GhosttyVt *vt = (GhosttyVt *) (intptr_t) handle;
    ghostty_vt_free(vt); // VERIFY-AGAINST-HEADER
}

// nativeWrite(handle, bytes) — feed raw VT bytes to the parser.
JNIEXPORT void JNICALL
Java_com_muxterm_app_terminal_GhosttyVtNative_nativeWrite(
        JNIEnv *env, jobject thiz, jlong handle, jbyteArray data) {
    GhosttyVt *vt = (GhosttyVt *) (intptr_t) handle;
    jsize n = (*env)->GetArrayLength(env, data);
    jbyte *buf = (*env)->GetByteArrayElements(env, data, NULL);
    ghostty_vt_write(vt, (const uint8_t *) buf, (size_t) n); // VERIFY-AGAINST-HEADER
    (*env)->ReleaseByteArrayElements(env, data, buf, JNI_ABORT);
}

// nativeResize(handle, cols, rows)
JNIEXPORT void JNICALL
Java_com_muxterm_app_terminal_GhosttyVtNative_nativeResize(
        JNIEnv *env, jobject thiz, jlong handle, jint cols, jint rows) {
    GhosttyVt *vt = (GhosttyVt *) (intptr_t) handle;
    ghostty_vt_resize(vt, (uint16_t) cols, (uint16_t) rows); // VERIFY-AGAINST-HEADER
}

// nativeSnapshot(handle) -> int[] packed cell grid.
// Packing (our convention, decoded in Kotlin GhosttyVt.snapshot):
//   [0] = cols, [1] = rows, [2] = cursorCol, [3] = cursorRow,
//   then cols*rows cells, each 3 ints: codepoint, fgArgb, bgArgb.
JNIEXPORT jintArray JNICALL
Java_com_muxterm_app_terminal_GhosttyVtNative_nativeSnapshot(
        JNIEnv *env, jobject thiz, jlong handle) {
    GhosttyVt *vt = (GhosttyVt *) (intptr_t) handle;
    uint16_t cols = ghostty_vt_cols(vt); // VERIFY-AGAINST-HEADER
    uint16_t rows = ghostty_vt_rows(vt); // VERIFY-AGAINST-HEADER
    int header = 4;
    int cells = (int) cols * (int) rows * 3;
    jintArray out = (*env)->NewIntArray(env, header + cells);
    jint *packed = malloc(sizeof(jint) * (header + cells));
    packed[0] = cols; packed[1] = rows;
    packed[2] = ghostty_vt_cursor_col(vt); // VERIFY-AGAINST-HEADER
    packed[3] = ghostty_vt_cursor_row(vt); // VERIFY-AGAINST-HEADER
    int i = header;
    for (uint16_t y = 0; y < rows; y++) {
        for (uint16_t x = 0; x < cols; x++) {
            GhosttyCell c = ghostty_vt_cell(vt, x, y); // VERIFY-AGAINST-HEADER
            packed[i++] = (jint) c.codepoint;
            packed[i++] = (jint) c.fg_argb;
            packed[i++] = (jint) c.bg_argb;
        }
    }
    (*env)->SetIntArrayRegion(env, out, 0, header + cells, packed);
    free(packed);
    return out;
}
```
> **Design-doc gap acknowledged:** the packed-grid contract above is *our* invention (the design says "we render; libghostty-vt parses only" but does not specify the snapshot ABI). The real libghostty-vt likely exposes a richer cell struct (styles, wide chars, hyperlinks). Start with codepoint+fg+bg to get pixels on screen, then extend the packing as the header reveals what's available. Wide-glyph and combining-char handling is explicitly deferred (see "Deferred to later").

**Static Analysis / Verification** (native build now runnable)
```
ANDROID_NDK_HOME=<ndk-path> scripts/build-terminal-core.sh
ls -la app/src/main/jniLibs/arm64-v8a/libghostty_vt_jni.so
```
Expected: build succeeds for all three ABIs; three `.so` files exist. **If libghostty-vt symbols don't resolve, this is where you reconcile against the vendored header** — expect to iterate here.

**Commit**
```bash
git add terminal-core/jni_bridge.c app/src/main/jniLibs/
git commit -m "build: JNI bridge parsing VT bytes to a packed cell grid"
```

---

### Task 4: Kotlin JNI declarations + stable `GhosttyVt` wrapper

**Files:**
- Create: `app/src/main/java/com/muxterm/app/terminal/GhosttyVtNative.kt`
- Create: `app/src/main/java/com/muxterm/app/terminal/GhosttyVt.kt`

**Implementation** (`GhosttyVtNative.kt`) — raw JNI surface (never used directly by app code):
```kotlin
package com.muxterm.app.terminal

/** Raw JNI declarations. Do NOT call directly — go through GhosttyVt. */
internal object GhosttyVtNative {
    init { System.loadLibrary("ghostty_vt_jni") }
    external fun nativeNew(cols: Int, rows: Int): Long
    external fun nativeFree(handle: Long)
    external fun nativeWrite(handle: Long, data: ByteArray)
    external fun nativeResize(handle: Long, cols: Int, rows: Int)
    external fun nativeSnapshot(handle: Long): IntArray
}
```

**Implementation** (`GhosttyVt.kt`) — the STABLE wrapper. This is the single seam that absorbs libghostty-vt API churn.
```kotlin
package com.muxterm.app.terminal

/** One rendered cell: a codepoint and packed ARGB fg/bg. */
data class Cell(val codepoint: Int, val fgArgb: Int, val bgArgb: Int)

/** An immutable snapshot of the visible grid, produced for each render frame. */
data class Grid(
    val cols: Int,
    val rows: Int,
    val cursorCol: Int,
    val cursorRow: Int,
    val cells: List<Cell>, // row-major, size cols*rows
)

/**
 * Stable Kotlin interface over libghostty-vt. libghostty-vt is pre-1.0 and its
 * API churns; ALL native-detail changes are absorbed here so the rest of the
 * app (TerminalPane, TerminalCanvas) never touches JNI. This is the design's
 * "wrap it behind our own stable interface" mitigation.
 */
class GhosttyVt(cols: Int, rows: Int) : AutoCloseable {
    private var handle: Long = GhosttyVtNative.nativeNew(cols, rows)

    fun write(data: ByteArray) {
        if (handle != 0L) GhosttyVtNative.nativeWrite(handle, data)
    }

    fun resize(cols: Int, rows: Int) {
        if (handle != 0L) GhosttyVtNative.nativeResize(handle, cols, rows)
    }

    fun snapshot(): Grid {
        val p = GhosttyVtNative.nativeSnapshot(handle)
        val cols = p[0]; val rows = p[1]
        val cells = ArrayList<Cell>(cols * rows)
        var i = 4
        repeat(cols * rows) {
            cells.add(Cell(p[i], p[i + 1], p[i + 2])); i += 3
        }
        return Grid(cols, rows, p[2], p[3], cells)
    }

    override fun close() {
        if (handle != 0L) { GhosttyVtNative.nativeFree(handle); handle = 0L }
    }
}
```

**Static Analysis**
```
./gradlew :app:compileDebugKotlin
```
Expected: `BUILD SUCCESSFUL`.

**Verification** — combined with Task 6 (needs a Canvas to see output).

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/terminal/GhosttyVtNative.kt app/src/main/java/com/muxterm/app/terminal/GhosttyVt.kt
git commit -m "feat: stable GhosttyVt wrapper over JNI"
```

---

### Task 5: TerminalPane — port the settle-barrier state machine faithfully

**Files:**
- Create: `app/src/main/java/com/muxterm/app/terminal/TerminalPane.kt`
- Create: `app/src/main/java/com/muxterm/app/terminal/TerminalRegistry.kt`
- Create: `src/test/java/com/muxterm/app/SettleBarrierTest.kt`

This is a **faithful port** of `web/src/lib/terminal-registry.ts` (the RC-* barrier). The web version is scar tissue from real race fixes — port the behavior, do not rediscover the races. Key invariants preserved:
- `expectedReplayBytes` = `totalSeq - seq` (from composition); gate `ready` until `seqBytes >= expectedReplayBytes`.
- **3s RC-1 timeout escape** drains partial replay so a byte-count mismatch can't lock the pane.
- **reattach without dispose:** `resetForReattach` clears settle state only, preserves the VT instance (scrollback), bumps `generation`.
- **generation counter** cancels stale drain completions after reset/close (RC-3/RC-6).
- keystrokes suppressed and incoming bytes queued in `pendingData` while `!ready`.

> **Threading note (Android-specific divergence from web):** the web version leans on rAF + ResizeObserver + xterm's async write callbacks. On Android there is no rAF; we drive the barrier from (a) each inbound frame and (b) a single `Handler`-posted 3s timeout. Because Compose recomposition reads a snapshot each frame, the "drain to renderer" step is: once `ready`, every subsequent `write` bumps a `StateFlow<Long> revision` that triggers a Canvas redraw. This preserves the *semantics* (gate render + input until replay complete) on Android's model.

**Implementation** (`TerminalPane.kt`)
```kotlin
package com.muxterm.app.terminal

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

private const val TAG = "TerminalPane"
private const val RC1_TIMEOUT_MS = 3000L

/**
 * Per-pane terminal state: owns a GhosttyVt instance and the settle barrier.
 * Faithful port of web/src/lib/terminal-registry.ts PaneEntry + _settleAndDrain
 * + resetForReattach. The VT instance survives reattach (scrollback preserved);
 * only settle state resets.
 *
 * onInput: encoded VT input bytes -> ProtocolClient.sendPaneInput
 * onResize: idempotent cols/rows -> ProtocolClient.resize
 */
class TerminalPane(
    initialCols: Int,
    initialRows: Int,
    private val onInput: (ByteArray) -> Unit,
    private val onResize: (cols: Int, rows: Int) -> Unit,
) {
    private val vt = GhosttyVt(initialCols, initialRows)
    private val main = Handler(Looper.getMainLooper())

    // Barrier state (mirrors PaneEntry fields).
    @Volatile private var ready = false
    private var seqBytes = 0L
    private var expectedReplayBytes = 0L
    private var generation = 0
    private var settleWaitStart = 0L
    private val pendingData = ArrayDeque<ByteArray>()
    private var lastCols = -1
    private var lastRows = -1
    private var timeoutPosted = false

    /** Bumped on every applied write; Canvas observes to redraw. */
    private val _revision = MutableStateFlow(0L)
    val revision: StateFlow<Long> = _revision

    fun grid(): Grid = vt.snapshot()

    /** composition -> set expected replay length BEFORE replay frames arrive. */
    fun setExpectedReplayBytes(expected: Long) {
        // Do NOT reset seqBytes: replay frames may have arrived before composition
        // (concurrent server writes). Mirrors web setExpectedReplayBytes.
        expectedReplayBytes = expected
        Log.i(TAG, "expectedReplayBytes=$expected seqBytes=$seqBytes")
        maybeSettle()
    }

    /** Inbound VT bytes (replay + live). */
    fun write(data: ByteArray) {
        seqBytes += data.size
        if (ready) {
            vt.write(data)
            _revision.value = _revision.value + 1
            return
        }
        pendingData.addLast(data)
        // RC-7: once all expected replay bytes arrived, try to settle.
        if (expectedReplayBytes > 0 && seqBytes >= expectedReplayBytes) maybeSettle()
        armTimeout()
    }

    /** Drain the barrier if replay is complete (or the 3s escape fired). */
    private fun maybeSettle() {
        if (ready) return
        val replayComplete = seqBytes >= expectedReplayBytes
        if (!replayComplete) {
            val now = SystemClock.uptimeMillis()
            if (settleWaitStart == 0L) settleWaitStart = now
            if (now - settleWaitStart < RC1_TIMEOUT_MS) { armTimeout(); return }
            Log.w(TAG, "RC-1 TIMEOUT: draining partial replay seq=$seqBytes exp=$expectedReplayBytes")
        }
        val myGen = generation
        while (pendingData.isNotEmpty()) {
            if (generation != myGen) return // reset mid-drain: abandon (RC-3/RC-6)
            vt.write(pendingData.removeFirst())
        }
        ready = true
        _revision.value = _revision.value + 1
        Log.i(TAG, "READY seqBytes=$seqBytes")
    }

    private fun armTimeout() {
        if (timeoutPosted || ready) return
        timeoutPosted = true
        main.postDelayed({ timeoutPosted = false; maybeSettle() }, RC1_TIMEOUT_MS)
    }

    /** Reconnect: reset settle state only; preserve the VT instance + scrollback. */
    fun resetForReattach() {
        Log.i(TAG, "resetForReattach (was ready=$ready)")
        ready = false
        pendingData.clear()
        generation++           // cancel in-flight drain
        seqBytes = 0
        expectedReplayBytes = 0
        settleWaitStart = 0
    }

    /** User keystroke already encoded to VT bytes; suppressed until ready. */
    fun input(bytes: ByteArray) {
        if (!ready) { Log.d(TAG, "input suppressed (not ready)"); return }
        onInput(bytes)
    }

    /** View measured a new grid size; idempotent resize + VT resize. */
    fun reportSize(cols: Int, rows: Int) {
        if (cols == lastCols && rows == lastRows) return
        if (cols <= 0 || rows <= 0) return
        lastCols = cols; lastRows = rows
        vt.resize(cols, rows)
        onResize(cols, rows)
    }

    fun dispose() { generation++; vt.close() }
}
```

**Implementation** (`TerminalRegistry.kt`) — the module-level owner keyed by `"workspaceId:paneId"` (mirrors web `_map` key convention to avoid cross-workspace bleed):
```kotlin
package com.muxterm.app.terminal

import java.util.concurrent.ConcurrentHashMap

/**
 * Persistent per-pane TerminalPane owner. Panes survive workspace switches
 * (scrollback preserved) and are disposed only on prune(). Keyed by
 * "workspaceId:paneId" to isolate reused paneIds across workspaces.
 */
object TerminalRegistry {
    private val map = ConcurrentHashMap<String, TerminalPane>()
    @Volatile private var currentWorkspaceId = ""

    fun setWorkspace(id: String) { currentWorkspaceId = id }
    private fun key(paneId: Int) = "$currentWorkspaceId:$paneId"

    fun ensure(paneId: Int, cols: Int, rows: Int,
               onInput: (ByteArray) -> Unit, onResize: (Int, Int) -> Unit): TerminalPane =
        map.getOrPut(key(paneId)) { TerminalPane(cols, rows, onInput, onResize) }

    fun get(paneId: Int): TerminalPane? = map[key(paneId)]

    fun write(paneId: Int, data: ByteArray) { map[key(paneId)]?.write(data) }

    /** Reconnect: reset settle state on every live pane of the current workspace. */
    fun resetForReattachAll() {
        val prefix = "$currentWorkspaceId:"
        map.forEach { (k, pane) -> if (k.startsWith(prefix)) pane.resetForReattach() }
    }

    fun prune(liveIds: Set<Int>) {
        val prefix = "$currentWorkspaceId:"
        map.entries.removeAll { (k, pane) ->
            if (!k.startsWith(prefix)) return@removeAll false
            val id = k.removePrefix(prefix).toInt()
            (id !in liveIds).also { if (it) pane.dispose() }
        }
    }
}
```

**Implementation** (`SettleBarrierTest.kt`) — legitimate library unit test (pure state-machine logic, no JNI: inject a fake VT by testing at the barrier boundary). To keep it JNI-free, test the barrier arithmetic by driving a `TerminalPane` subclass seam. Simplest honest approach: extract the barrier decision into a pure function and test that.

Create the pure decision helper first (add to `TerminalPane.kt`, above the class):
```kotlin
/** Pure settle decision — unit-testable without JNI. Mirrors the RC-1 barrier. */
internal fun shouldDrain(seqBytes: Long, expectedReplayBytes: Long,
                         waitedMs: Long): Boolean =
    seqBytes >= expectedReplayBytes || waitedMs >= RC1_TIMEOUT_MS
```
Then the test:
```kotlin
package com.muxterm.app

import com.muxterm.app.terminal.shouldDrain
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SettleBarrierTest {
    @Test fun waitsWhenReplayIncomplete() {
        assertFalse(shouldDrain(seqBytes = 10, expectedReplayBytes = 100, waitedMs = 500))
    }
    @Test fun drainsWhenReplayComplete() {
        assertTrue(shouldDrain(seqBytes = 100, expectedReplayBytes = 100, waitedMs = 0))
        assertTrue(shouldDrain(seqBytes = 120, expectedReplayBytes = 100, waitedMs = 0)) // overshoot
    }
    @Test fun rc1TimeoutEscape() {
        assertTrue(shouldDrain(seqBytes = 10, expectedReplayBytes = 100, waitedMs = 3000))
    }
    @Test fun freshPaneNoReplay() {
        assertTrue(shouldDrain(seqBytes = 0, expectedReplayBytes = 0, waitedMs = 0))
    }
}
```

**Static Analysis**
```
./gradlew :app:compileDebugKotlin
./gradlew :app:testDebugUnitTest --tests "com.muxterm.app.SettleBarrierTest"
```
Expected: compile OK; 4 barrier tests pass.

**Verification** — full pane render/type is verified in Task 7.

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/terminal/TerminalPane.kt app/src/main/java/com/muxterm/app/terminal/TerminalRegistry.kt src/test/java/com/muxterm/app/SettleBarrierTest.kt
git commit -m "feat: settle-barrier state machine port + registry + barrier tests"
```

---

### Task 6: Keymap — encode Android key/IME events to VT input bytes

**Files:**
- Create: `app/src/main/java/com/muxterm/app/terminal/Keymap.kt`

libghostty-vt does NOT encode input — key encoding is ours (design Section 3). Cover printable chars (via IME `commitText`), Enter/Backspace/Tab/Esc, arrows, and Ctrl-modified keys (the key-accessory bar's sticky Ctrl feeds `ctrl=true`).

**Implementation**
```kotlin
package com.muxterm.app.terminal

/** Encodes logical key events to the VT input bytes a PTY expects. */
object Keymap {
    private val ESC = 0x1b.toByte()

    /** A committed text run from the IME (already-resolved Unicode). */
    fun text(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

    fun enter(): ByteArray = byteArrayOf(0x0d)                 // CR
    fun backspace(): ByteArray = byteArrayOf(0x7f)            // DEL
    fun tab(): ByteArray = byteArrayOf(0x09)
    fun esc(): ByteArray = byteArrayOf(ESC)

    fun arrowUp(): ByteArray = byteArrayOf(ESC, '['.code.toByte(), 'A'.code.toByte())
    fun arrowDown(): ByteArray = byteArrayOf(ESC, '['.code.toByte(), 'B'.code.toByte())
    fun arrowRight(): ByteArray = byteArrayOf(ESC, '['.code.toByte(), 'C'.code.toByte())
    fun arrowLeft(): ByteArray = byteArrayOf(ESC, '['.code.toByte(), 'D'.code.toByte())

    /**
     * Ctrl + a printable ASCII letter -> control byte (Ctrl-A=0x01 .. Ctrl-Z=0x1a,
     * plus the standard Ctrl-@/[/\/]/^/_ range). Returns null if not encodable.
     */
    fun ctrl(ch: Char): ByteArray? {
        val u = ch.uppercaseChar()
        return when (u) {
            in '@'..'_' -> byteArrayOf((u.code - 0x40).toByte()) // @=0x00 .. _=0x1f
            in 'a'..'z' -> byteArrayOf((u.uppercaseChar().code - 0x40).toByte())
            else -> null
        }
    }
}
```

**Static Analysis**
```
./gradlew :app:compileDebugKotlin
```
Expected: `BUILD SUCCESSFUL`.

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/terminal/Keymap.kt
git commit -m "feat: keystroke/IME to VT-input keymap"
```

---

### Task 7: TerminalCanvas — Compose Canvas cell-grid renderer + live-sessiond verification

**Files:**
- Create: `app/src/main/java/com/muxterm/app/terminal/TerminalCanvas.kt`
- Modify: `app/src/main/java/com/muxterm/app/MainActivity.kt` (wire one terminal pane end-to-end for verification)

**Implementation** (`TerminalCanvas.kt`)
```kotlin
package com.muxterm.app.terminal

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.onGloballyPositioned
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import android.graphics.Paint
import android.graphics.Typeface
import androidx.compose.runtime.collectAsState

/**
 * Draws a TerminalPane's cell grid. Reads pane.revision so every applied write
 * triggers a redraw (the Android analogue of the web drain-to-renderer step).
 * Measures its pixel box, derives cols/rows from the monospace cell size, and
 * reports size back so the PTY resizes (active-view-wins).
 */
@Composable
fun TerminalCanvas(pane: TerminalPane, fontSizeSp: Float = 13f, modifier: Modifier = Modifier) {
    val revision by pane.revision.collectAsState()
    val density = LocalDensity.current
    val fontPx = with(density) { fontSizeSp.sp.toPx() }

    // Monospace metrics: measure advance width once.
    val paint = remember(fontPx) {
        Paint().apply {
            typeface = Typeface.MONOSPACE
            textSize = fontPx
            isAntiAlias = true
        }
    }
    val cellW = remember(paint) { paint.measureText("M") }
    val cellH = remember(paint) { paint.fontMetrics.let { it.descent - it.ascent } }

    Canvas(modifier = modifier
        .fillMaxSize()
        .onGloballyPositioned { coords ->
            val cols = (coords.size.width / cellW).toInt().coerceAtLeast(1)
            val rows = (coords.size.height / cellH).toInt().coerceAtLeast(1)
            pane.reportSize(cols, rows)
        }
    ) {
        @Suppress("UNUSED_EXPRESSION") revision // read to subscribe to redraws
        val grid = pane.grid()
        val fm = paint.fontMetrics
        drawContext.canvas.nativeCanvas.apply {
            for (y in 0 until grid.rows) {
                for (x in 0 until grid.cols) {
                    val cell = grid.cells[y * grid.cols + x]
                    val px = x * cellW
                    val py = y * cellH
                    // Background
                    if (cell.bgArgb != 0) {
                        val bg = Paint().apply { color = cell.bgArgb }
                        drawRect(px, py, px + cellW, py + cellH, bg)
                    }
                    // Glyph
                    if (cell.codepoint != 0 && cell.codepoint != ' '.code) {
                        paint.color = if (cell.fgArgb != 0) cell.fgArgb else 0xFFCCCCCC.toInt()
                        drawText(
                            String(Character.toChars(cell.codepoint)),
                            px, py - fm.ascent, paint,
                        )
                    }
                }
            }
        }
    }
}
```

**Implementation** (`MainActivity.kt` — extend the M1 smoke screen to render + type into the first terminal pane). Wire: on `composition`, call `TerminalRegistry.ensure` + `setExpectedReplayBytes` for each pane; route `Inbound.PaneData` to `TerminalRegistry.write`; render the active pane with `TerminalCanvas`; add a hidden `BasicTextField` that feeds `Keymap.text` → `pane.input`. (Full glue is UI-level; the hard logic is done. Keep it a single-pane debug harness — M3 builds the real UI.)

Key wiring excerpt to add inside the inbound collector:
```kotlin
is Inbound.Control -> when (ev.msg.type) {
    MsgType.Composition -> {
        TerminalRegistry.setWorkspace(currentWorkspaceId)
        ev.msg.panes?.forEach { p ->
            val pane = TerminalRegistry.ensure(
                p.paneId, p.cols.coerceAtLeast(1), p.rows.coerceAtLeast(1),
                onInput = { client.sendPaneInput(p.paneId, it) },
                onResize = { c, r -> client.resize(p.paneId, c, r) },
            )
            val expected = (p.totalSeq ?: 0) - (p.seq ?: 0)
            pane.setExpectedReplayBytes(expected.coerceAtLeast(0))
        }
        activePaneId = ev.msg.panes?.firstOrNull()?.paneId
    }
    else -> {}
}
is Inbound.PaneData -> TerminalRegistry.write(ev.frame.paneId, ev.frame.data)
```

**Static Analysis**
```
./gradlew :app:assembleDebug
```
Expected: `BUILD SUCCESSFUL`.

**Verification** (real server — this is the M2 gate). Requires the `.so` from Task 3 (build it first if not already):
```
ANDROID_NDK_HOME=<ndk> scripts/build-terminal-core.sh
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.muxterm.app/.MainActivity
adb logcat -s TerminalPane:I
```
With the live sessiond running (host has a workspace with a shell pane):
1. Tap **Connect** → the terminal Canvas renders the shell's replayed screen (prompt visible). Logcat shows `READY seqBytes=<n>`.
2. Type `echo hello<Enter>` via the IME field → `hello` appears in the rendered grid, the shell echoes and runs it.
3. **Settle scenario A (normal):** kill and relaunch the app, reconnect → the replayed screen renders once, no duplicated/garbled prompt.
4. **Settle scenario B (RC-1 escape):** temporarily hardcode `expectedReplayBytes` too high (e.g. `expected + 1_000_000`) in the composition wiring, reconnect → after ~3s logcat shows `RC-1 TIMEOUT: draining partial replay` and the screen still renders (not permanently blank). Revert the hack after verifying.

Expected: real shell rendered and interactive; both settle scenarios behave as logged. **This proves the JNI brick, the settle barrier, and the keymap all work against a real sessiond.**

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/terminal/TerminalCanvas.kt app/src/main/java/com/muxterm/app/MainActivity.kt
git commit -m "feat: Compose Canvas terminal render + type, verified vs live sessiond"
```

---

# M3 — Dashboard + Workspace UI

**Goal:** Replace the debug harness with the real UX: the unified dashboard grouped by source (**remotes only** — Android has no local sessiond, so there is no `Local` group), phone pane-strip navigation between panes, the mobile key-accessory bar, and per-client layout keyed by breakpoint. State lives in a platform-agnostic `MuxStore` (same shape as the web `MuxStore`: `{workspaces[], panes[], activePaneId, layout}`).

### Task 1: MuxStore — platform-agnostic state model

**Files:**
- Create: `app/src/main/java/com/muxterm/app/ui/MuxStore.kt`

**Implementation**
```kotlin
package com.muxterm.app.ui

import com.muxterm.app.protocol.PaneInfo
import com.muxterm.app.protocol.WorkspaceInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** A remembered remote source (the dashboard groups by these). */
data class RemoteSource(
    val id: String,
    val name: String,          // "home dev box"
    val target: String,        // "user@dev.tail…"
    val connected: Boolean = false,
    val lastKnownWorkspaces: List<WorkspaceInfo> = emptyList(),
)

data class UiState(
    val sources: List<RemoteSource> = emptyList(),
    val activeWorkspaceId: String? = null,
    val panes: List<PaneInfo> = emptyList(),
    val activePaneId: Int? = null,
    val layout: String? = null, // opaque per-breakpoint native layout blob
)

/** Single source of truth for the UI. Mirrors the web MuxStore shape. */
object MuxStore {
    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state

    fun setSources(s: List<RemoteSource>) = update { it.copy(sources = s) }
    fun setConnected(sourceId: String, connected: Boolean) = update { st ->
        st.copy(sources = st.sources.map { if (it.id == sourceId) it.copy(connected = connected) else it })
    }
    fun setWorkspaces(sourceId: String, ws: List<WorkspaceInfo>) = update { st ->
        st.copy(sources = st.sources.map {
            if (it.id == sourceId) it.copy(lastKnownWorkspaces = ws) else it
        })
    }
    fun setComposition(workspaceId: String, panes: List<PaneInfo>, layout: String?) = update {
        it.copy(activeWorkspaceId = workspaceId, panes = panes,
            activePaneId = it.activePaneId ?: panes.firstOrNull()?.paneId, layout = layout)
    }
    fun setActivePane(paneId: Int) = update { it.copy(activePaneId = paneId) }

    private inline fun update(f: (UiState) -> UiState) { _state.value = f(_state.value) }
}
```

**Static Analysis**
```
./gradlew :app:compileDebugKotlin
```
Expected: `BUILD SUCCESSFUL`.

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/ui/MuxStore.kt
git commit -m "feat: platform-agnostic MuxStore state model"
```

---

### Task 2: DashboardScreen — unified, grouped-by-source (remotes only)

**Files:**
- Create: `app/src/main/java/com/muxterm/app/ui/DashboardScreen.kt`

Renders the "Phone Home" wireframe (UX doc §1): a list of remote sources, each expandable to its workspaces; a header with settings + `+ Add`. **No `Local` group** (Android has no local sessiond — showing an empty one would be a broken group, explicitly disallowed by the UX doc). Collapsed remotes show `tap to connect`; expanded ones show remembered workspaces even before SSH completes.

**Implementation** (task-granularity — standard Compose list; complete but not a "hard brick"):
```kotlin
package com.muxterm.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun DashboardScreen(
    onAddConnection: () -> Unit,
    onOpenSettings: () -> Unit,
    onExpandSource: (RemoteSource) -> Unit,   // triggers lazy connect (M5)
    onOpenWorkspace: (sourceId: String, workspaceId: String) -> Unit,
) {
    val state by MuxStore.state.collectAsState()
    Scaffold(topBar = {
        TopAppBar(
            title = { Text("muxterm") },
            actions = {
                IconButton(onOpenSettings) { Text("⚙") }
                TextButton(onAddConnection) { Text("+ Add") }
            },
        )
    }) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize()) {
            // Remotes only — no Local group on Android.
            items(state.sources, key = { it.id }) { src ->
                SourceGroup(src, onExpandSource, onOpenWorkspace)
            }
            if (state.sources.isEmpty()) {
                item {
                    Column(Modifier.fillMaxWidth().padding(32.dp)) {
                        Text("No connections yet", style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.height(8.dp))
                        Button(onAddConnection) { Text("Add Connection") }
                    }
                }
            }
        }
    }
}

@Composable
private fun SourceGroup(
    src: RemoteSource,
    onExpand: (RemoteSource) -> Unit,
    onOpenWorkspace: (String, String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    Column {
        ListItem(
            headlineContent = { Text(src.name) },
            supportingContent = { Text(src.target) },
            leadingContent = { Text(if (src.connected) "●" else "○") },
            trailingContent = {
                Text(if (src.connected) "${src.lastKnownWorkspaces.size} workspaces" else "tap to connect")
            },
            modifier = Modifier.clickable {
                expanded = !expanded
                if (expanded && !src.connected) onExpand(src) // lazy connect
            },
        )
        if (expanded) {
            src.lastKnownWorkspaces.forEach { ws ->
                ListItem(
                    headlineContent = { Text(ws.name ?: ws.workspaceId) },
                    trailingContent = { Text("${ws.paneCount} panes ›") },
                    modifier = Modifier
                        .padding(start = 24.dp)
                        .clickable { onOpenWorkspace(src.id, ws.workspaceId) },
                )
            }
        }
    }
}
```

**Static Analysis**
```
./gradlew :app:compileDebugKotlin
```
Expected: `BUILD SUCCESSFUL`.

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/ui/DashboardScreen.kt
git commit -m "feat: unified dashboard grouped by source (remotes only)"
```

---

### Task 3: PaneStrip + WorkspaceScreen — one pane full-screen, swipe/tab between panes

**Files:**
- Create: `app/src/main/java/com/muxterm/app/ui/PaneStrip.kt`
- Create: `app/src/main/java/com/muxterm/app/ui/WorkspaceScreen.kt`

Phone navigation model (UX doc §1/§2): one pane fills the screen; a pane strip (dots/tabs) selects panes; the *visible* pane is focused = authority. Uses a Compose `HorizontalPager` for swipe.

**Implementation** (`PaneStrip.kt`)
```kotlin
package com.muxterm.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.muxterm.app.protocol.PaneInfo

@Composable
fun PaneStrip(panes: List<PaneInfo>, activePaneId: Int?, onSelect: (Int) -> Unit) {
    LazyRow(Modifier.fillMaxWidth().padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        items(panes, key = { it.paneId }) { p ->
            FilterChip(
                selected = p.paneId == activePaneId,
                onClick = { onSelect(p.paneId) },
                label = { Text(p.title ?: "pane ${p.paneId}") },
            )
        }
    }
}
```

**Implementation** (`WorkspaceScreen.kt`) — task-granularity glue tying MuxStore + TerminalRegistry + PaneStrip + KeyAccessoryBar + (M4) BrowserPane:
```kotlin
package com.muxterm.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import com.muxterm.app.terminal.TerminalCanvas
import com.muxterm.app.terminal.TerminalRegistry

@Composable
fun WorkspaceScreen(
    onInput: (paneId: Int, ByteArray) -> Unit,
    onResize: (paneId: Int, Int, Int) -> Unit,
) {
    val state by MuxStore.state.collectAsState()
    val panes = state.panes
    val pager = rememberPagerState(pageCount = { panes.size })

    // Keep MuxStore.activePane in sync with the visible page (visible = focused).
    LaunchedEffect(pager.currentPage, panes) {
        panes.getOrNull(pager.currentPage)?.let { MuxStore.setActivePane(it.paneId) }
    }

    Column(Modifier.fillMaxSize()) {
        PaneStrip(panes, state.activePaneId) { paneId ->
            panes.indexOfFirst { it.paneId == paneId }.takeIf { it >= 0 }?.let {
                // pager.scrollToPage in a coroutine — omitted for brevity
            }
        }
        HorizontalPager(state = pager, modifier = Modifier.weight(1f)) { page ->
            val p = panes[page]
            when (p.surfaceKind) {
                "browser" -> { /* M4: BrowserPane(p.paneId) */ }
                else -> {
                    val pane = remember(p.paneId) {
                        TerminalRegistry.ensure(
                            p.paneId, p.cols.coerceAtLeast(1), p.rows.coerceAtLeast(1),
                            onInput = { onInput(p.paneId, it) },
                            onResize = { c, r -> onResize(p.paneId, c, r) },
                        )
                    }
                    TerminalCanvas(pane)
                }
            }
        }
        val active = panes.firstOrNull { it.paneId == state.activePaneId }
        if (active != null && active.surfaceKind != "browser") {
            KeyAccessoryBar { bytes -> onInput(active.paneId, bytes) }
        }
    }
}
```

**Static Analysis**
```
./gradlew :app:compileDebugKotlin
```
Expected: `BUILD SUCCESSFUL` (KeyAccessoryBar exists after Task 4 — sequence Task 4 before compiling this, or stub it).

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/ui/PaneStrip.kt app/src/main/java/com/muxterm/app/ui/WorkspaceScreen.kt
git commit -m "feat: phone pane-strip navigation + workspace screen"
```

---

### Task 4: KeyAccessoryBar — above-keyboard terminal keys

**Files:**
- Create: `app/src/main/java/com/muxterm/app/ui/KeyAccessoryBar.kt`

UX doc §5: Esc, Ctrl (sticky modifier), Tab, arrows, and symbols (`|` `/` `~` `-`). Sticky Ctrl composes with the next printable key via `Keymap.ctrl`.

**Implementation**
```kotlin
package com.muxterm.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.muxterm.app.terminal.Keymap

@Composable
fun KeyAccessoryBar(send: (ByteArray) -> Unit) {
    var ctrlSticky by remember { mutableStateOf(false) }
    fun emitChar(c: Char) {
        if (ctrlSticky) { Keymap.ctrl(c)?.let(send); ctrlSticky = false }
        else send(Keymap.text(c.toString()))
    }
    LazyRow(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        item { KeyBtn("Esc") { send(Keymap.esc()) } }
        item { KeyBtn("Ctrl", active = ctrlSticky) { ctrlSticky = !ctrlSticky } }
        item { KeyBtn("Tab") { send(Keymap.tab()) } }
        item { KeyBtn("←") { send(Keymap.arrowLeft()) } }
        item { KeyBtn("↑") { send(Keymap.arrowUp()) } }
        item { KeyBtn("↓") { send(Keymap.arrowDown()) } }
        item { KeyBtn("→") { send(Keymap.arrowRight()) } }
        listOf('|', '/', '~', '-').forEach { c -> item { KeyBtn(c.toString()) { emitChar(c) } } }
    }
}

@Composable
private fun KeyBtn(label: String, active: Boolean = false, onClick: () -> Unit) {
    if (active) Button(onClick) { Text(label) }
    else OutlinedButton(onClick) { Text(label) }
}
```

**Static Analysis**
```
./gradlew :app:compileDebugKotlin
```
Expected: `BUILD SUCCESSFUL`.

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/ui/KeyAccessoryBar.kt
git commit -m "feat: mobile key-accessory bar with sticky Ctrl"
```

---

### Task 5: Per-breakpoint layout + navigation host + M3 verification

**Files:**
- Modify: `app/src/main/java/com/muxterm/app/MainActivity.kt`

Wire a top-level nav host: `Dashboard` ↔ `Workspace`. Choose the `breakpoint` string from the screen width (`compact` phone / `medium` tablet / `expanded` desktop-class) and pass it to `attach` so the daemon returns the matching saved `layout`. Persist the opaque layout blob per breakpoint (round-trip through the `layout` field; the design says layout is opaque and per-client). For M3, phone = `compact`, single-pane pager (layout blob can be a no-op passthrough initially).

**Implementation** (breakpoint helper + nav host excerpt)
```kotlin
// Breakpoint from width (mirrors web breakpoint logic).
fun breakpointFor(widthDp: Int): String = when {
    widthDp < 600 -> "compact"
    widthDp < 840 -> "medium"
    else -> "expanded"
}

// In MainActivity setContent: a simple two-route state machine.
var route by remember { mutableStateOf<Route>(Route.Dashboard) }
when (val r = route) {
    is Route.Dashboard -> DashboardScreen(
        onAddConnection = { /* M5 */ },
        onOpenSettings = { /* settings screen */ },
        onExpandSource = { /* M5 lazy connect */ },
        onOpenWorkspace = { sourceId, wsId ->
            val bp = breakpointFor(screenWidthDp)
            client.attach(wsId, bp)
            route = Route.Workspace(wsId)
        },
    )
    is Route.Workspace -> WorkspaceScreen(
        onInput = { paneId, bytes -> client.sendPaneInput(paneId, bytes) },
        onResize = { paneId, c, r -> client.resize(paneId, c, r) },
    )
}
```
Also update the inbound collector to feed `MuxStore` (`workspace-list` → `setWorkspaces`, `composition` → `setComposition` + `TerminalRegistry.setWorkspace`), replacing the M1/M2 debug logging path.

**Static Analysis**
```
./gradlew :app:assembleDebug
```
Expected: `BUILD SUCCESSFUL`.

**Verification** (real server — M3 gate). With a live sessiond that has ≥2 workspaces, each with ≥2 panes (seed one via the host: open a couple of shells):
```
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.muxterm.app/.MainActivity
```
Manually seed a source pointing at the sessiond (for M3, hardcode one `RemoteSource` with the LAN URL until M5's Add-Connection flow lands — note this shortcut in the commit). Then:
1. **Cold launch** → dashboard shows the remote group (no `Local` group present). ✔ if there is no Local row.
2. Tap the source → it expands, shows its workspaces (count matches the host).
3. Tap a workspace → WorkspaceScreen opens, the pane strip shows all panes, the first pane renders its shell.
4. Swipe / tap another pane chip → the visible pane switches, its shell renders, and the key bar targets it (tap `Esc`/arrows and see the shell react).
5. Relaunch the app → same dashboard shape, same groups (consistency principle).

Expected: grouped remotes-only dashboard, pane switching, and key bar all work against the real sessiond.

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/MainActivity.kt
git commit -m "feat: nav host + per-breakpoint attach; M3 verified vs live sessiond"
```

---

# M4 — Browser Pane + Server-Drive

**Goal:** A first-class `browser`-type pane rendered by Android `WebView`, driven by Phase 0 `browser-command` messages (native nav + `evaluateJavascript` for click/scroll/type/inject, supporting **both** `selector` and `x`/`y` targeting), emitting `browser-result`/`browser-url`/`browser-load`, with the "agent driving / you" authority banner. Verified by driving the running app from muxterm's MCP browser tools.

### Task 1: BrowserExecutor — the JS-injection command executor (hard brick)

**Files:**
- Create: `app/src/main/java/com/muxterm/app/browser/BrowserExecutor.kt`

Every manipulation compiles to a native `WebView` call or an `evaluateJavascript`. Both targeting modes required; an action carries exactly one of `{selector}` or `{x,y}` (design Section 4). A bounded 30s default timeout on JS eval so an agent can't hang the pane.

**Implementation**
```kotlin
package com.muxterm.app.browser

import android.webkit.WebView
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.*

/**
 * Executes a browser-command against a live WebView. Actions:
 *  navigate/back/forward/reload -> native WebView calls
 *  click/scroll/type/inject     -> evaluateJavascript (synthetic events / eval)
 * Targeting: exactly one of {selector} (CSS) or {x,y} (CSS px). Both supported.
 *
 * Returns a JSON result element for browser-result, or throws for browser-result.error.
 */
class BrowserExecutor(private val webView: WebView) {

    private val defaultTimeoutMs = 30_000L

    suspend fun execute(action: String, params: JsonObject?): JsonElement {
        return when (action) {
            "navigate" -> { onMain { webView.loadUrl(params!!["url"]!!.jsonPrimitive.content) }; ok() }
            "back" -> { onMain { if (webView.canGoBack()) webView.goBack() }; ok() }
            "forward" -> { onMain { if (webView.canGoForward()) webView.goForward() }; ok() }
            "reload" -> { onMain { webView.reload() }; ok() }
            "click" -> evalJs(clickScript(params!!), timeoutMs(params))
            "scroll" -> evalJs(scrollScript(params!!), timeoutMs(params))
            "type" -> evalJs(typeScript(params!!), timeoutMs(params))
            "inject" -> evalJs(params!!["script"]!!.jsonPrimitive.content, timeoutMs(params))
            else -> throw IllegalArgumentException("unknown action: $action")
        }
    }

    private fun timeoutMs(p: JsonObject?): Long =
        p?.get("timeoutMs")?.jsonPrimitive?.longOrNull ?: defaultTimeoutMs

    /** evaluateJavascript is callback-based; bridge to a suspend + bounded timeout. */
    private suspend fun evalJs(script: String, timeout: Long): JsonElement {
        val deferred = CompletableDeferred<String?>()
        onMain { webView.evaluateJavascript(script) { deferred.complete(it) } }
        val raw = withTimeoutOrNull(timeout) { deferred.await() }
            ?: throw RuntimeException("evaluateJavascript timed out after ${timeout}ms")
        // evaluateJavascript returns a JSON-encoded string; parse it back.
        return runCatching { Json.parseToJsonElement(raw) }.getOrElse { JsonPrimitive(raw) }
    }

    private fun ok(): JsonElement = buildJsonObject { put("ok", true) }

    // --- JS builders. Element targeting via selector; spatial via x/y. ---

    /** Resolve target element: selector OR elementFromPoint(x,y). */
    private fun targetExpr(p: JsonObject): String {
        p["selector"]?.jsonPrimitive?.contentOrNull?.let {
            return "document.querySelector(${it.jsQuote()})"
        }
        val x = p["x"]!!.jsonPrimitive.double
        val y = p["y"]!!.jsonPrimitive.double
        return "document.elementFromPoint($x, $y)"
    }

    private fun clickScript(p: JsonObject): String = """
        (function(){
          var el = ${targetExpr(p)};
          if(!el) return {error:'no-target'};
          var r = el.getBoundingClientRect();
          var cx = ${p["x"]?.jsonPrimitive?.double ?: "r.left + r.width/2"};
          var cy = ${p["y"]?.jsonPrimitive?.double ?: "r.top + r.height/2"};
          ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){
            el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:cx,clientY:cy}));
          });
          return {ok:true};
        })()
    """.trimIndent()

    private fun scrollScript(p: JsonObject): String {
        val dy = p["deltaY"]?.jsonPrimitive?.double ?: 0.0
        val dx = p["deltaX"]?.jsonPrimitive?.double ?: 0.0
        val hasTarget = p.containsKey("selector") || (p.containsKey("x") && p.containsKey("y"))
        return if (hasTarget) """
            (function(){ var el=${targetExpr(p)}; if(el) el.scrollBy($dx,$dy); return {ok:true}; })()
        """.trimIndent() else "(function(){ window.scrollBy($dx,$dy); return {ok:true}; })()"
    }

    private fun typeScript(p: JsonObject): String {
        val text = p["text"]!!.jsonPrimitive.content
        return """
            (function(){
              var el = ${targetExpr(p)};
              if(!el) return {error:'no-target'};
              el.focus();
              el.value = (el.value||'') + ${text.jsQuote()};
              el.dispatchEvent(new Event('input',{bubbles:true}));
              el.dispatchEvent(new Event('change',{bubbles:true}));
              return {ok:true};
            })()
        """.trimIndent()
    }
}

/** JSON-safe JS string literal. */
private fun String.jsQuote(): String =
    "\"" + replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\""

private suspend fun onMain(block: () -> Unit) =
    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) { block() }
```

**Static Analysis**
```
./gradlew :app:compileDebugKotlin
```
Expected: `BUILD SUCCESSFUL`.

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/browser/BrowserExecutor.kt
git commit -m "feat: JS-injection browser command executor (selector + x/y)"
```

---

### Task 2: BrowserPane composable + events + authority banner

**Files:**
- Create: `app/src/main/java/com/muxterm/app/browser/BrowserPane.kt`
- Create: `app/src/main/java/com/muxterm/app/browser/AuthorityBanner.kt`

`WebView` in Compose via `AndroidView`. A `WebViewClient` fires `browser-url` on `doUpdateVisitedHistory` / URL commit and `browser-load` on `onPageFinished`. Authority banner shows `◉ agent driving` vs `● you`; tapping the page flips to `you` (last-focus-wins).

**Implementation** (`BrowserPane.kt` — task-granularity glue; the executor is the hard part):
```kotlin
package com.muxterm.app.browser

import android.annotation.SuppressLint
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun BrowserPane(
    paneId: Int,
    onUrlCommitted: (String) -> Unit,   // -> browser-url
    onLoadComplete: (String) -> Unit,   // -> browser-load
    onExecutorReady: (BrowserExecutor) -> Unit,
    agentDriving: Boolean,
    onUserTookControl: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        AuthorityBanner(agentDriving)
        AndroidView(factory = { ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                webViewClient = object : WebViewClient() {
                    override fun doUpdateVisitedHistory(v: WebView, url: String, isReload: Boolean) {
                        onUrlCommitted(url)
                    }
                    override fun onPageFinished(v: WebView, url: String) { onLoadComplete(url) }
                }
                setOnTouchListener { _, _ -> onUserTookControl(); false } // last-focus-wins
                onExecutorReady(BrowserExecutor(this))
            }
        }, modifier = Modifier.weight(1f))
    }
}
```

**Implementation** (`AuthorityBanner.kt`):
```kotlin
package com.muxterm.app.browser

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

@Composable
fun AuthorityBanner(agentDriving: Boolean) {
    val (label, bg) = if (agentDriving) "◉ agent driving" to Color(0xFF3A2E00)
                      else "● you" to Color(0xFF10240F)
    Box(Modifier.fillMaxWidth().background(bg).padding(6.dp)) { Text(label, color = Color.White) }
}
```

**Static Analysis**
```
./gradlew :app:compileDebugKotlin
```
Expected: `BUILD SUCCESSFUL`.

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/browser/BrowserPane.kt app/src/main/java/com/muxterm/app/browser/AuthorityBanner.kt
git commit -m "feat: WebView browser pane + url/load events + authority banner"
```

---

### Task 3: Wire browser-command relay into ProtocolClient inbound + M4 verification

**Files:**
- Modify: `app/src/main/java/com/muxterm/app/MainActivity.kt` (route `browser-command` → executor → `browser-result`)
- Modify: `app/src/main/java/com/muxterm/app/ui/WorkspaceScreen.kt` (render `BrowserPane` for `surfaceKind == "browser"`)

Handle `Inbound.Control` where `type == browser-command`: parse `params`, dispatch to the focused pane's `BrowserExecutor`, and reply with a `browser-result` echoing the server's `cid`. Emit `browser-url`/`browser-load` from the `WebViewClient` callbacks. On a command to an unfocused/unattached browser pane, reply `browser-result` with a typed error (`no-client-attached` / `not-authority`) — fail loud, no queuing.

**Implementation** (inbound handler excerpt)
```kotlin
is Inbound.Control -> when (ev.msg.type) {
    MsgType.BrowserCommand -> {
        val cid = ev.msg.cid
        val paneId = ev.msg.paneId
        val exec = browserExecutors[paneId]
        lifecycleScope.launch {
            val result: JsonElement = when {
                exec == null -> buildJsonObject { put("error", "no-client-attached") }
                paneId != MuxStore.state.value.activePaneId ->
                    buildJsonObject { put("error", "not-authority") }
                else -> runCatching {
                    exec.execute(ev.msg.action!!, ev.msg.paramsJson as? JsonObject)
                }.getOrElse { buildJsonObject { put("error", it.message ?: "js-error") } }
            }
            client.send(Message(type = MsgType.BrowserResult, cid = cid, result = result))
        }
    }
    else -> { /* existing composition/workspace-list handling */ }
}
```
where `browserExecutors: MutableMap<Int, BrowserExecutor>` is populated by `BrowserPane`'s `onExecutorReady`. `browser-url`/`browser-load` are sent from the pane callbacks:
```kotlin
onUrlCommitted = { url -> client.send(Message(type = MsgType.BrowserUrl, paneId = paneId, url = url)) },
onLoadComplete = { url -> client.send(Message(type = MsgType.BrowserLoad, paneId = paneId, url = url)) },
```

**Static Analysis**
```
./gradlew :app:assembleDebug
```
Expected: `BUILD SUCCESSFUL`.

**Verification** (real server + MCP — M4 gate). With the app connected to a live sessiond:
1. In the app, create a browser pane (add a temporary "＋ browser" button that sends `create-pane` with `surfaceKind=browser`, or trigger via MCP `create_pane kind=browser`). The `WebView` renders; banner shows `● you`.
2. From an MCP client against the same sessiond, drive the pane using muxterm's browser tools:
   ```
   # navigate
   muxterm MCP: browser navigate  url=https://example.com   (paneId=<id>)
   # click by selector
   muxterm MCP: browser click      selector="a"
   # inject/eval
   muxterm MCP: browser inject      script="document.title"
   ```
   (Use the actual MCP tool invocation surface exposed by Phase 0 — via the `muxterm` MCP tools available in this environment, or the agent's MCP client.)
3. Observe: the `WebView` navigates to example.com (page visibly changes), the banner flips to `◉ agent driving` while commands stream, `browser inject` returns the page title string as the `browser-result`, and `adb logcat` shows `browser-url`/`browser-load` being sent.
4. Tap the page → banner flips back to `● you`; a subsequent MCP command flips it to `◉ agent`.
5. **Negative path:** send a browser command to a non-focused browser pane → the MCP tool call returns a `not-authority` (or `no-client-attached`) error, not a hang.

Expected: the same live browser is driven by the agent and the human, authority flips correctly, results/events round-trip. **This proves the executor, event emission, and authority model against the real MCP relay.**

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/MainActivity.kt app/src/main/java/com/muxterm/app/ui/WorkspaceScreen.kt
git commit -m "feat: browser-command relay wired; MCP-driven browser verified"
```

---

# M5 — Remote Connectivity (embedded SSH + SOCKS)

**Goal:** Replace the LAN-direct shortcut with the real connectivity model: an embedded sshj session per remote connection, a single `-L` control forward (device loopback → remote muxterm control port; preserves the loopback-auth dividend), a local SOCKS5 listener that maps each connection to an SSH `direct-tcpip` channel (wired to the `WebView` via `androidx.webkit` `ProxyController`, process-global), and the full onboarding flow (Add Connection sheet, progress trail, typed failures, SSH key generate/import/export). Verified against a real remote box.

### Task 1: SshSession — sshj connect + `-L` local forward (hard brick)

**Files:**
- Create: `app/src/main/java/com/muxterm/app/conn/SshSession.kt`

**Implementation**
```kotlin
package com.muxterm.app.conn

import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.connection.channel.direct.Parameters
import net.schmizz.sshj.connection.channel.direct.LocalPortForwarder
import net.schmizz.sshj.transport.verification.PromiscuousVerifier
import net.schmizz.sshj.userauth.keyprovider.KeyProvider
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicReference

/** Typed connection failures — surfaced by the onboarding trail (UX §3). */
sealed class SshError(msg: String) : Exception(msg) {
    class Unreachable(host: String) : SshError("can't reach $host")
    class AuthRejected(key: String) : SshError("key rejected (tried $key)")
    class ForwardFailed(msg: String) : SshError(msg)
}

/**
 * One embedded SSH session to a remote box. Owns the -L control forward. The
 * loopback-auth dividend: muxterm sees a localhost client on the remote side,
 * so its "localhost = no token" rule applies and SSH keys ARE the auth. We add
 * NO token/pairing scheme.
 */
class SshSession(
    private val host: String,
    private val port: Int,
    private val user: String,
    private val keyProvider: KeyProvider,
    private val keyName: String,
) {
    private val ssh = SSHClient()
    private val forwarder = AtomicReference<LocalPortForwarder?>(null)
    @Volatile private var forwarderThread: Thread? = null

    /** Connect + authenticate. Throws typed SshError. */
    fun connect() {
        // NOTE: PromiscuousVerifier accepts any host key — acceptable ONLY for
        // the first cut. Replace with a TOFU known-hosts store before release
        // (see "Deferred to later"). Host-key pinning is a real security item.
        ssh.addHostKeyVerifier(PromiscuousVerifier())
        try {
            ssh.connect(host, port)
        } catch (e: Exception) {
            throw SshError.Unreachable(host)
        }
        try {
            ssh.authPublickey(user, keyProvider)
        } catch (e: Exception) {
            throw SshError.AuthRejected(keyName)
        }
    }

    /**
     * Bring up the -L control forward: bind a device loopback port and forward
     * it to the remote's muxterm control port. Returns the local port to which
     * the ProtocolClient should connect (ws://127.0.0.1:<localPort>/ws).
     */
    fun forwardControlPort(remoteControlPort: Int): Int {
        val localSocket = ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"))
        val localPort = localSocket.localPort
        val params = Parameters("127.0.0.1", localPort, "127.0.0.1", remoteControlPort)
        val fwd = ssh.newLocalPortForwarder(params, localSocket)
        forwarder.set(fwd)
        // sshj's LocalPortForwarder.listen() blocks — run it on its own thread.
        forwarderThread = Thread({
            try { fwd.listen() } catch (_: Exception) { /* closed on disconnect */ }
        }, "ssh-L-control").also { it.isDaemon = true; it.start() }
        return localPort
    }

    /** Open a direct-tcpip channel to remoteHost:remotePort (used by SOCKS listener). */
    fun openDirectTcpip(remoteHost: String, remotePort: Int) =
        ssh.newDirectConnection(remoteHost, remotePort)

    fun isConnected(): Boolean = ssh.isConnected

    fun disconnect() {
        forwarder.get()?.close()
        forwarderThread?.interrupt()
        runCatching { ssh.disconnect() }
    }
}
```

**Static Analysis**
```
./gradlew :app:compileDebugKotlin
```
Expected: `BUILD SUCCESSFUL`.

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/conn/SshSession.kt
git commit -m "feat: embedded sshj session + -L control forward"
```

---

### Task 2: SocksListener — local SOCKS5 → SSH direct-tcpip (hard brick)

**Files:**
- Create: `app/src/main/java/com/muxterm/app/conn/SocksListener.kt`

A tiny SOCKS5 server on `127.0.0.1:<port>`. For each CONNECT request it opens an SSH `direct-tcpip` channel to the requested `host:port` on the remote (so the `WebView`'s `localhost:3000` reaches the dev box's `localhost:3000`) and pumps bytes both ways. This is the cmux pattern (design Section 1 revised). Only CONNECT + no-auth needed.

**Implementation**
```kotlin
package com.muxterm.app.conn

import android.util.Log
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

private const val TAG = "SocksListener"

/**
 * Minimal SOCKS5 (no-auth, CONNECT only) listener that tunnels each connection
 * over an SSH direct-tcpip channel. The WebView is pointed here via
 * ProxyController; localhost in the WebView resolves to the remote box.
 */
class SocksListener(private val ssh: SshSession) {
    private var server: ServerSocket? = null
    @Volatile private var running = false

    /** Start on a random loopback port. Returns the port for ProxyController. */
    fun start(): Int {
        val s = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        server = s; running = true
        thread(name = "socks-accept", isDaemon = true) {
            while (running) {
                val client = try { s.accept() } catch (_: Exception) { break }
                thread(isDaemon = true) { runCatching { handle(client) } }
            }
        }
        return s.localPort
    }

    fun stop() { running = false; runCatching { server?.close() } }

    private fun handle(client: Socket) {
        val inp = client.getInputStream()
        val out = client.getOutputStream()
        // --- greeting: VER=5, NMETHODS, METHODS ---
        require(inp.read() == 0x05) { "not socks5" }
        val n = inp.read()
        repeat(n) { inp.read() }             // discard offered methods
        out.write(byteArrayOf(0x05, 0x00))   // choose no-auth
        out.flush()
        // --- request: VER CMD RSV ATYP DST.ADDR DST.PORT ---
        require(inp.read() == 0x05)
        val cmd = inp.read()
        inp.read()                            // RSV
        val atyp = inp.read()
        val host = when (atyp) {
            0x01 -> ByteArray(4).also { inp.readFully(it) }
                .joinToString(".") { (it.toInt() and 0xFF).toString() }
            0x03 -> { val len = inp.read(); ByteArray(len).also { inp.readFully(it) }.decodeToString() }
            0x04 -> ByteArray(16).also { inp.readFully(it) } // IPv6
                .let { InetAddress.getByAddress(it).hostAddress }
            else -> { reply(out, 0x08); client.close(); return }
        }
        val port = (inp.read() shl 8) or inp.read()
        if (cmd != 0x01) { reply(out, 0x07); client.close(); return } // only CONNECT

        val chan = try { ssh.openDirectTcpip(host, port) } catch (e: Exception) {
            Log.w(TAG, "direct-tcpip failed $host:$port", e); reply(out, 0x05); client.close(); return
        }
        reply(out, 0x00) // success
        // Pump both directions.
        val up = thread(isDaemon = true) { runCatching { chan.inputStream.copyTo(out) }; runCatching { client.close() } }
        runCatching { inp.copyTo(chan.outputStream) }
        up.join(1000)
        runCatching { chan.close() }; runCatching { client.close() }
    }

    /** SOCKS5 reply with the given status; BND.ADDR/PORT zeroed. */
    private fun reply(out: OutputStream, status: Int) {
        out.write(byteArrayOf(0x05, status.toByte(), 0x00, 0x01, 0, 0, 0, 0, 0, 0)); out.flush()
    }
}

private fun InputStream.readFully(buf: ByteArray) {
    var off = 0
    while (off < buf.size) {
        val r = read(buf, off, buf.size - off); if (r < 0) throw java.io.EOFException(); off += r
    }
}
```
> `ssh.openDirectTcpip` returns sshj's `DirectConnection` — confirm the exact `inputStream`/`outputStream`/`close` accessors against the pinned sshj version (0.38.0). The shape (byte-pumping a channel) is correct; adjust member names if sshj differs.

**Static Analysis**
```
./gradlew :app:compileDebugKotlin
```
Expected: `BUILD SUCCESSFUL`.

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/conn/SocksListener.kt
git commit -m "feat: local SOCKS5 listener over SSH direct-tcpip"
```

---

### Task 3: Identities — SSH key generate / import / export

**Files:**
- Create: `app/src/main/java/com/muxterm/app/conn/Identities.kt`

Mobile has no `~/.ssh` (UX §3/§5). Generate an ed25519 keypair, store the private key in app-private storage, and export the public key (OpenSSH `authorized_keys` format) to copy into the box.

**Implementation** (task-granularity; uses sshj/BouncyCastle which ships transitively with sshj):
```kotlin
package com.muxterm.app.conn

import android.content.Context
import net.schmizz.sshj.userauth.keyprovider.KeyProvider
import net.schmizz.sshj.userauth.keyprovider.OpenSSHKeyV1KeyFile
import java.io.File

/**
 * SSH identity store for mobile. Keys live in app-private storage. Exposes the
 * public key in authorized_keys format to paste into the remote box.
 *
 * NOTE: ed25519 keygen + OpenSSH-format serialization details depend on the
 * pinned sshj/BouncyCastle version — VERIFY the generate() call against the
 * bundled crypto provider. The store/load/export shape is what matters here.
 */
class Identities(private val ctx: Context) {
    private val dir = File(ctx.filesDir, "identities").apply { mkdirs() }

    fun list(): List<String> = dir.listFiles { f -> f.extension == "" }?.map { it.name } ?: emptyList()

    /** Generate a new named ed25519 key; returns the public-key line. */
    fun generate(name: String): String {
        // VERIFY-AGAINST-LIB: use BouncyCastle Ed25519KeyPairGenerator, then
        // serialize private (OpenSSH v1) + public. Placeholder outline:
        TODO("generate ed25519, write private to dir/$name, return 'ssh-ed25519 <b64> muxterm:$name'")
    }

    /** Import an existing private key blob under a name. */
    fun import(name: String, privateKeyPem: String) {
        File(dir, name).writeText(privateKeyPem, Charsets.UTF_8)
    }

    fun publicKeyLine(name: String): String =
        File(dir, "$name.pub").readText(Charsets.UTF_8).trim()

    fun keyProvider(name: String): KeyProvider =
        OpenSSHKeyV1KeyFile().apply { init(File(dir, name)) }

    fun delete(name: String) { File(dir, name).delete(); File(dir, "$name.pub").delete() }
}
```
> **Honest gap:** `generate()` is left as `TODO` because the exact ed25519 keygen + OpenSSH-v1 private serialization is library-version-specific and must be written against the resolved BouncyCastle/sshj APIs — inventing the byte layout here would be fiction. `import`/`export`/`keyProvider`/`delete` are concrete. The M5 verification below can proceed using an **imported** key while `generate()` is finished.

**Static Analysis**
```
./gradlew :app:compileDebugKotlin
```
Expected: `BUILD SUCCESSFUL` (the `TODO()` compiles; it throws at runtime until implemented).

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/conn/Identities.kt
git commit -m "feat: SSH identity store (import/export/keyProvider; generate TODO)"
```

---

### Task 4: ConnectionManager — orchestrate SSH + forwards + ProxyController

**Files:**
- Create: `app/src/main/java/com/muxterm/app/conn/ConnectionManager.kt`

Ties it together: on open-remote, connect SSH, bring up the `-L` control forward and the SOCKS listener, point the `WebView` proxy at SOCKS via `ProxyController` (process-global — documented limitation, design Section 1 revised), then hand the ProtocolClient the loopback URL. Emits progress-trail steps for the onboarding UI.

**Implementation**
```kotlin
package com.muxterm.app.conn

import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import com.muxterm.app.protocol.ProtocolClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import java.util.concurrent.Executors

/** Progress-trail step for the onboarding UI (UX §3). */
data class TrailStep(val label: String, val state: State) {
    enum class State { PENDING, ACTIVE, DONE, FAILED }
}

/**
 * Orchestrates one remote connection: SSH -> -L control forward -> SOCKS ->
 * ProxyController -> ProtocolClient. Local-target path (not used on Android,
 * which has no local sessiond) would skip SSH/SOCKS entirely.
 */
class ConnectionManager(private val client: ProtocolClient) {
    private val _trail = MutableStateFlow<List<TrailStep>>(emptyList())
    val trail: StateFlow<List<TrailStep>> = _trail
    private var ssh: SshSession? = null
    private var socks: SocksListener? = null

    suspend fun openRemote(
        host: String, port: Int, user: String,
        identities: Identities, keyName: String, remoteControlPort: Int,
    ): Result<Unit> = withContext(Dispatchers.IO) {
        val steps = mutableListOf(
            TrailStep("Reaching $host", TrailStep.State.ACTIVE),
            TrailStep("SSH auth ($keyName)", TrailStep.State.PENDING),
            TrailStep("Forwarding control port", TrailStep.State.PENDING),
            TrailStep("Attaching", TrailStep.State.PENDING),
        )
        _trail.value = steps
        val session = SshSession(host, port, user, identities.keyProvider(keyName), keyName)
        try {
            session.connect()                              // Reaching + auth
            mark(steps, 0, TrailStep.State.DONE); mark(steps, 1, TrailStep.State.DONE)
            mark(steps, 2, TrailStep.State.ACTIVE)
            val localPort = session.forwardControlPort(remoteControlPort)
            mark(steps, 2, TrailStep.State.DONE); mark(steps, 3, TrailStep.State.ACTIVE)
            // Browser plane: SOCKS -> ProxyController (process-global).
            val socksListener = SocksListener(session)
            val socksPort = socksListener.start()
            applyProxy(socksPort)
            ssh = session; socks = socksListener
            client.connect("ws://127.0.0.1:$localPort/ws") // loopback-auth dividend
            mark(steps, 3, TrailStep.State.DONE)
            Result.success(Unit)
        } catch (e: SshError) {
            val idx = when (e) {
                is SshError.Unreachable -> 0
                is SshError.AuthRejected -> 1
                is SshError.ForwardFailed -> 2
            }
            mark(steps, idx, TrailStep.State.FAILED, e.message)
            Result.failure(e)
        }
    }

    private suspend fun applyProxy(socksPort: Int) = withContext(Dispatchers.Main) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) return@withContext
        val cfg = ProxyConfig.Builder()
            .addProxyRule("socks://127.0.0.1:$socksPort")
            .build()
        val done = java.util.concurrent.CountDownLatch(1)
        ProxyController.getInstance().setProxyOverride(cfg, Executors.newSingleThreadExecutor()) { done.countDown() }
        withContext(Dispatchers.IO) { done.await() }
    }

    private fun mark(steps: MutableList<TrailStep>, i: Int, s: TrailStep.State, err: String? = null) {
        steps[i] = steps[i].copy(label = err ?: steps[i].label, state = s)
        _trail.value = steps.toList()
    }

    fun disconnect() {
        socks?.stop(); ssh?.disconnect()
        if (WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            ProxyController.getInstance().clearProxyOverride(Executors.newSingleThreadExecutor()) {}
        }
    }
}
```

**Static Analysis**
```
./gradlew :app:compileDebugKotlin
```
Expected: `BUILD SUCCESSFUL`.

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/conn/ConnectionManager.kt
git commit -m "feat: ConnectionManager orchestrating SSH + SOCKS + ProxyController"
```

---

### Task 5: AddConnectionSheet + progress trail UI

**Files:**
- Create: `app/src/main/java/com/muxterm/app/conn/AddConnectionSheet.kt`
- Modify: `app/src/main/java/com/muxterm/app/MainActivity.kt` (wire Add flow + trail overlay + lazy connect on source expand)

Renders the Add Connection sheet (name, `user@host:port`, identity picker: use existing key / import / copy public key) and the progress trail (per-step `✓/◐/✗` with typed failure actions). On dashboard source-expand or open, call `ConnectionManager.openRemote`; on `workspace-list`, update `MuxStore`.

**Implementation** (task-granularity — standard Compose form + trail; complete but not a hard brick). Trail composable:
```kotlin
package com.muxterm.app.conn

import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun ProgressTrail(steps: List<TrailStep>) {
    Column(Modifier.padding(16.dp)) {
        Text("Connecting…")
        steps.forEach { s ->
            val glyph = when (s.state) {
                TrailStep.State.DONE -> "✓"; TrailStep.State.ACTIVE -> "◐"
                TrailStep.State.FAILED -> "✗"; TrailStep.State.PENDING -> "·"
            }
            Text("$glyph ${s.label}")
        }
    }
}
```
The Add sheet is a `ModalBottomSheet` with `OutlinedTextField`s for name/host and a dropdown for identity; on Save it persists a `RemoteSource` into `MuxStore` and (for remote) stores creds for `ConnectionManager`. (Full form omitted for brevity — it is mechanical Compose; the connectivity bricks above are the substance.)

**Static Analysis**
```
./gradlew :app:assembleDebug
```
Expected: `BUILD SUCCESSFUL`.

**Verification** (real remote box — M5 gate, the whole-system proof). Prereqs: a reachable remote host running muxterm sessiond on its `localhost:<CONTROL_PORT>`, plus a dev server on the box (e.g. `python3 -m http.server 3000` in a workspace), and your device's public key in the box's `~/.ssh/authorized_keys` (use an imported key while `Identities.generate` is finished).
```
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.muxterm.app/.MainActivity
adb logcat -s SocksListener:W ProtocolClient:I TerminalPane:I
```
1. **Add Connection** → enter `user@remote-host`, pick the imported key, Save.
2. Tap the source / open → the progress trail shows `✓ Reaching → ✓ SSH auth → ✓ Forwarding control port → ✓ Attaching`.
3. A workspace opens; a **terminal pane renders and is interactive** over the `-L` forward (type `hostname` → the remote box's name prints — proving the tunnel + loopback-auth dividend, no token used).
4. Open a **browser pane**, navigate to `http://localhost:3000` → the box's dev server page renders **through the SOCKS-over-SSH channel** (proving `WebView` + ProxyController + direct-tcpip). Logcat shows no `direct-tcpip failed`.
5. **Failure path:** add a connection with a bad key → the trail shows `✗ SSH auth: key rejected (tried <name>)` with copy-public-key / choose-another-key actions, and does not fall back to any HMAC token.

Expected: end-to-end remote connectivity — terminal over `-L`, browser over SOCKS — against a real box, with a transparent trail and a typed auth failure. **This is the full-system verification.**

**Commit**
```bash
git add app/src/main/java/com/muxterm/app/conn/AddConnectionSheet.kt app/src/main/java/com/muxterm/app/MainActivity.kt
git commit -m "feat: add-connection flow + progress trail; remote connectivity verified end-to-end"
```

---

## Deferred to later

These are explicitly **out of scope** for Phase 2's first cut. Each is a real follow-up, listed so nothing is silently dropped:

| Deferred item | Why deferred / what it needs |
|---------------|------------------------------|
| **`Identities.generate()` ed25519 keygen** | Left as `TODO` — the OpenSSH-v1 private-key serialization is BouncyCastle/sshj-version-specific and must be written against resolved APIs, not invented. Verify against imported keys first, then implement. |
| **SSH host-key verification (TOFU / known-hosts)** | M5 uses `PromiscuousVerifier` (accepts any host key) to get connectivity working. Replace with a trust-on-first-use known-hosts store before any release — this is a genuine security requirement, flagged not skipped. |
| **`network_security_config` scoping cleartext to 127.0.0.1** | M1 enables app-wide `usesCleartextTraffic` for the loopback WS. Tighten to a config permitting cleartext only for `127.0.0.1` before release. |
| **libghostty-vt rich cell attributes** | Snapshot ABI starts at codepoint+fg+bg. Bold/italic/underline, wide (CJK/emoji) glyphs, combining chars, and hyperlinks need the real cell struct from the vendored header — extend the packing once confirmed. |
| **Scrollback rendering + touch scroll** | Canvas renders the visible grid only. Scrollback viewport + touch-drag scrolling (the web client's manual touch-scroll port) is a follow-up once the live grid is solid. |
| **Tablet two-pane split + desktop-class layout** | M3 ships the phone `compact` single-pane pager. `medium`/`expanded` breakpoints (side-by-side panes, collapsible sidebar) are a later layout pass; the `breakpoint` plumbing is already in place. |
| **Reconnect backoff + overlay** | `resetForReattach` exists (M2). The exponential backoff `min(1000·2^n,30000)+jitter` reconnect loop and the dimmed reconnect overlay (UX §3) are a follow-up on top of it. |
| **Live-port suggestions (⚡ port chip)** | The browser pane's port-dropdown from muxterm's listening-port tracking. Manual URL entry works first; port discovery is additive. |
| **Settings screen (font/theme/palette)** | Mirrors `/api/config`. Terminal renders with defaults for now. |
| **Protocol conformance fixture set** | The design's shared cross-platform `muxterm-client-protocol.md` conformance fixtures (recorded byte sequences). Our JVM framing + settle tests cover the local codec; the shared fixtures are a cross-app effort. |
| **Multiple independent browser panes with different proxies** | `ProxyController` is process-global (documented limitation). One remote's SOCKS proxy at a time is fine now; revisit if concurrent multi-remote browser panes are needed. |
| **NDK-only fallback build** | Terminal core builds via Zig. If Zig-in-CI proves painful, a prebuilt-`.so`-artifact path is a fallback — not needed while the Zig build works. |

---

## Cross-cutting verification note

Per muxterm's testing policy and the "verify with reality" principle: the **only** unit tests in this plan are `PaneFrameTest` (framing codec) and `SettleBarrierTest` (barrier decision) — both pure library logic. Every other capability is verified by **running the real app on a device/emulator against a live sessiond** (M1–M4) and a **real remote box** (M5). No mocked SSH, no mocked WebSocket, no simulated terminal. A green build that hasn't rendered a real shell or driven a real browser is **not** a passing milestone.
