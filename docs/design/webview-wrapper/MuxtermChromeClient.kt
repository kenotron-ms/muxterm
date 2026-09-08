package io.ampbox.muxterm

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * The permission bridge. This file is why getUserMedia works at all.
 *
 * Design artifact. Written 2026-09-08; NOT compiled — no Android SDK here.
 *
 * The framework is explicit and unforgiving:
 *
 *   "The host application must invoke PermissionRequest.grant(String[]) or
 *    PermissionRequest.deny(). If this method isn't overridden, the permission
 *    is denied."
 *      — WebChromeClient.onPermissionRequest, API 21
 *
 * So a stock WebView rejects navigator.mediaDevices.getUserMedia() forever,
 * with NotAllowedError, on a page that works perfectly in Chrome, and nothing
 * in logcat explains it. This class is the entire fix, and it is the step most
 * commonly missed.
 *
 * There are TWO permission layers and both must pass:
 *
 *   1. the Android runtime permission — the user grants RECORD_AUDIO to the APP
 *   2. the WebView permission        — the APP grants AUDIO_CAPTURE to the PAGE
 *
 * Granting one does not grant the other.
 */
class MuxtermChromeClient(private val activity: Activity) : WebChromeClient() {

    companion object {
        const val REQ_RECORD_AUDIO = 4001
    }

    /** Held while the OS runtime-permission dialog is up, so we can answer the page after. */
    private var deferred: PermissionRequest? = null

    override fun onPermissionRequest(request: PermissionRequest) {
        // 1. Origin check FIRST. The naive sample-code version of this method is
        //    `request.grant(request.resources)`, which hands any origin any
        //    resource. addWebMessageListener's origin rule protects the bridge;
        //    nothing protects this except this line.
        val origin = request.origin?.toString()?.trimEnd('/')
        if (origin != MainActivity.ORIGIN) {
            request.deny()
            return
        }

        // 2. Grant only what we understand, and only audio for now. Camera is
        //    added when attachments are built, not before — a resource granted
        //    speculatively is a resource granted.
        val wanted = request.resources.filter { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
        if (wanted.isEmpty()) {
            request.deny()
            return
        }

        // 3. The app must itself hold RECORD_AUDIO before it can pass it on.
        val granted = ContextCompat.checkSelfPermission(
            activity, Manifest.permission.RECORD_AUDIO,
        ) == PackageManager.PERMISSION_GRANTED

        if (granted) {
            request.grant(wanted.toTypedArray())
            return
        }

        // Not held: ask the OS, remember the page's request, answer it in
        // onRequestPermissionsResult. Never grant() optimistically — the page
        // would open a capture that the OS then refuses, which is the silent
        // failure mode this whole document exists to eliminate.
        deferred = request
        ActivityCompat.requestPermissions(
            activity, arrayOf(Manifest.permission.RECORD_AUDIO), REQ_RECORD_AUDIO,
        )
    }

    override fun onPermissionRequestCanceled(request: PermissionRequest) {
        if (deferred?.origin == request.origin) deferred = null
    }

    /** Call from Activity.onRequestPermissionsResult. */
    fun onRuntimePermissionResult(requestCode: Int, grantResults: IntArray) {
        if (requestCode != REQ_RECORD_AUDIO) return
        val req = deferred ?: return
        deferred = null
        val ok = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        if (ok) req.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else req.deny()
    }

    // -------------------------------------------------------------------------
    // Considered and rejected for the first slice: WebView#preauthorizePermission
    // (AwContents.java:3597), which grants an origin a resource ahead of time so
    // onPermissionRequest is never raised. Tempting for a single-origin wrapper.
    // Rejected because it moves the grant away from the moment of use, which is
    // exactly where a reviewer and a user look for it. Recorded as the fallback
    // if the prompt path proves flaky on real devices.
    // -------------------------------------------------------------------------
}
