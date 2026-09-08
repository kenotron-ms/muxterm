package io.ampbox.muxterm

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import org.json.JSONObject

/**
 * The native half of the bridge. The other half is native-bridge.ts, which is
 * type-checked and unit-tested in this directory.
 *
 * Design artifact. Written 2026-09-08; NOT compiled — no Android SDK here.
 *
 * Twelve messages total, six each way, closed set. Adding one is a design
 * change, not an implementation detail: every method must name an OS capability
 * the page cannot reach (W3, Rule 3), and the reviewer's question is always
 * "could this be done in the page?"
 *
 * Nothing here carries audio samples, credentials, terminal content, tool calls,
 * navigation targets, commands, or binary blobs. See W4.4 for why each of those
 * has a plausible-sounding argument and is refused anyway.
 */
class MuxtermBridge(
    private val activity: Activity,
    private val webView: WebView,
) {
    companion object {
        const val TAG = "MuxtermBridge"
        const val ENVELOPE_VERSION = 1
        const val REPLY_TIMEOUT_HINT_MS = 2000 // the page gives up after this
    }

    private var reply: JavaScriptReplyProxy? = null
    private var unavailable = false

    init {
        VoiceSessionService.events = { type -> post(type, JSONObject()) }
    }

    fun markUnavailable() {
        unavailable = true
    }

    fun dispose() {
        VoiceSessionService.events = null
        reply = null
    }

    // -----------------------------------------------------------------------
    // web -> native
    // -----------------------------------------------------------------------

    fun onMessage(raw: String, replyProxy: JavaScriptReplyProxy) {
        reply = replyProxy
        val env = try {
            JSONObject(raw)
        } catch (e: Exception) {
            Log.w(TAG, "unparseable envelope, dropped")
            return
        }
        if (env.optInt("v", -1) != ENVELOPE_VERSION) {
            Log.w(TAG, "unknown envelope version ${env.optInt("v", -1)}, dropped")
            return
        }
        val type = env.optString("type")
        val id = env.optString("id").ifEmpty { null }
        val payload = env.optJSONObject("payload") ?: JSONObject()

        when (type) {
            "voice.start" -> startVoice(payload, id)
            "voice.stop" -> stopVoice()
            "voice.state" -> updateState(payload)
            "openOsSettings" -> openOsSettings(payload)
            "log" -> Log.i(TAG, "[web] ${payload.optString("level")}: ${payload.optString("msg")}")
            // keepAwake is desktop-only; on Android the foreground service is
            // what holds the process. Accepted and ignored so one web-side
            // implementation works on every platform.
            "keepAwake" -> Unit
            // A newer web app talking to an older wrapper. Drop, never guess.
            else -> Log.w(TAG, "unknown message type '$type', dropped")
        }
    }

    /**
     * Start the foreground service.
     *
     * MUST be reached from a visible Activity. Android 12+ throws
     * ForegroundServiceStartNotAllowedException for a background start, and a
     * while-in-use type (microphone) has NO exemption to fall back on. The page
     * only sends voice.start on the user's tap on the orb, so the Activity is
     * visible; this check is the assertion of that, not a substitute for it.
     */
    private fun startVoice(payload: JSONObject, id: String?) {
        val result = JSONObject()
        try {
            val intent = Intent(activity, VoiceSessionService::class.java)
                .setAction(VoiceSessionService.ACTION_START)
                .putExtra(VoiceSessionService.EXTRA_STATE, "connecting")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(intent)
            } else {
                activity.startService(intent)
            }
            result.put("ok", true)
        } catch (e: Exception) {
            // Do not swallow this. The page must learn that the service did not
            // start, so it can warn the user that voice will not survive the
            // screen going off — rather than discovering it as silence.
            Log.e(TAG, "foreground service refused", e)
            result.put("ok", false).put("reason", e::class.java.simpleName)
        }
        if (id != null) post("voice.serviceStarted", result, id)
    }

    private fun stopVoice() {
        activity.startService(
            Intent(activity, VoiceSessionService::class.java)
                .setAction(VoiceSessionService.ACTION_STOP),
        )
    }

    private fun updateState(payload: JSONObject) {
        if (!VoiceSessionService.running) return
        activity.startService(
            Intent(activity, VoiceSessionService::class.java)
                .setAction(VoiceSessionService.ACTION_START)
                .putExtra(VoiceSessionService.EXTRA_STATE, payload.optString("state")),
        )
    }

    /** Opens an OS settings screen. No web API can do this; that is the whole test. */
    private fun openOsSettings(payload: JSONObject) {
        val pkg = activity.packageName
        val intent = when (payload.optString("which")) {
            "notifications" -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
            "battery" -> Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            else -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.fromParts("package", pkg, null))
        }
        runCatching { activity.startActivity(intent) }
            .onFailure { Log.w(TAG, "no settings activity for that intent") }
    }

    // -----------------------------------------------------------------------
    // native -> web
    // -----------------------------------------------------------------------

    /**
     * Announce the bridge and what this build supports.
     *
     * Capabilities, not a version number: the web app deploys continuously and
     * the wrapper ships through a store, so the page will routinely be newer
     * than this. It must be able to ask what exists rather than infer it.
     */
    fun sendReady() {
        if (unavailable) return
        val caps = mutableListOf("voice.fgs", "osSettings")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) caps.add("mic.silenced")
        post(
            "ready",
            JSONObject()
                .put("platform", "android")
                .put("appVersion", BuildConfig.VERSION_NAME)
                .put("capabilities", caps.joinToString(",").split(",")),
        )
    }

    private fun post(type: String, payload: JSONObject, id: String? = null) {
        val env = JSONObject()
            .put("v", ENVELOPE_VERSION)
            .put("type", type)
            .put("payload", payload)
        if (id != null) env.put("id", id)
        val json = env.toString()
        webView.post {
            // postMessage on the reply proxy keeps the message on the same
            // origin-checked channel the page opened. evaluateJavascript would
            // work and is deliberately not used: it is a second, unchecked path.
            reply?.postMessage(json) ?: run {
                if (!unavailable) Log.d(TAG, "no page attached, dropped '$type'")
            }
        }
    }
}
