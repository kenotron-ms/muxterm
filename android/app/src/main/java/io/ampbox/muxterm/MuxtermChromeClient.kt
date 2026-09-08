package io.ampbox.muxterm

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.util.Log
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * A3 - the commonly missed half of "the microphone works".
 *
 * There are two independent permission layers and BOTH must pass:
 *   1. Android's runtime RECORD_AUDIO permission, held by this app.
 *   2. The WebView's own grant, from this app to the page, delivered here.
 *
 * Granting one does not grant the other. Omit this override and the page's
 * getUserMedia is denied silently: the orb lights, nothing is heard, and there
 * is no error anywhere to explain it.
 *
 * The standard sample-code mistake is `request.grant(request.resources)`
 * unconditionally. We check the origin first, grant only audio, and never grant
 * optimistically before the app itself holds RECORD_AUDIO.
 */
class MuxtermChromeClient(private val activity: Activity) : WebChromeClient() {

    companion object {
        const val REQ_RECORD_AUDIO = 4001
    }

    private var deferred: PermissionRequest? = null

    /** Invoked after audio capture has actually been granted to the page. */
    var onAudioGranted: (() -> Unit)? = null

    override fun onPermissionRequest(request: PermissionRequest) {
        // 1. Origin check FIRST.
        val origin = request.origin?.toString()?.trimEnd('/')
        if (origin != MainActivity.origin) {
            Log.w(MainActivity.TAG, "denying permission request from unexpected origin: $origin")
            request.deny()
            return
        }

        // 2. Grant only what we understand, and only audio. Camera and file
        //    attachment input are out of scope for this build.
        val wanted = request.resources.filter { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
        if (wanted.isEmpty()) {
            Log.w(MainActivity.TAG, "denying non-audio resources: ${request.resources.joinToString()}")
            request.deny()
            return
        }

        // 3. The app must itself hold RECORD_AUDIO before it can pass it on.
        val granted = ContextCompat.checkSelfPermission(
            activity, Manifest.permission.RECORD_AUDIO,
        ) == PackageManager.PERMISSION_GRANTED

        if (granted) {
            Log.i(MainActivity.TAG, "granting RESOURCE_AUDIO_CAPTURE to $origin")
            request.grant(wanted.toTypedArray())
            onAudioGranted?.invoke()
            return
        }

        // Not held: ask the OS, remember the page's request, answer it in
        // onRequestPermissionsResult. Never grant() optimistically.
        Log.i(MainActivity.TAG, "app lacks RECORD_AUDIO; requesting from user")
        deferred = request
        ActivityCompat.requestPermissions(
            activity, arrayOf(Manifest.permission.RECORD_AUDIO), REQ_RECORD_AUDIO,
        )
    }

    override fun onPermissionRequestCanceled(request: PermissionRequest) {
        if (deferred?.origin == request.origin) deferred = null
    }

    /** Call from Activity.onRequestPermissionsResult. */
    fun onRuntimePermissionResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        if (requestCode != REQ_RECORD_AUDIO) return
        val req = deferred ?: return
        deferred = null
        // Look RECORD_AUDIO up by name: a combined request puts it at an index
        // that depends on what else was asked for at the same time.
        val i = permissions.indexOf(Manifest.permission.RECORD_AUDIO)
        val ok = i >= 0 && i < grantResults.size &&
            grantResults[i] == PackageManager.PERMISSION_GRANTED
        if (ok) {
            Log.i(MainActivity.TAG, "RECORD_AUDIO granted; releasing deferred page request")
            req.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
            onAudioGranted?.invoke()
        } else {
            Log.w(MainActivity.TAG, "RECORD_AUDIO denied; denying page request")
            req.deny()
        }
    }

    override fun onConsoleMessage(message: android.webkit.ConsoleMessage): Boolean {
        Log.d(MainActivity.TAG, "console: ${message.message()} @${message.sourceId()}:${message.lineNumber()}")
        return true
    }
}
