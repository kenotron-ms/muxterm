package io.ampbox.muxterm

import android.content.Context
import android.util.Log
import android.view.View
import android.webkit.WebView

/**
 * A4, second half - the killer the foreground service does NOT fix.
 *
 * Design doc W1.4b, verbatim on the mechanism:
 *
 *   WebView marks its page hidden when the containing window becomes invisible
 *   (AwContents.onWindowVisibilityChanged -> setWindowVisibilityInternal ->
 *   postUpdateVisibility -> updateWebContentsVisibility), so when the Activity
 *   stops, PageSchedulerImpl::IsPageVisible() becomes false. Blink's
 *   kStopInBackground ("Freeze scheduler task queues in background after
 *   allowed grace time") is FEATURE_ENABLED_BY_DEFAULT for IS_ANDROID &&
 *   !IS_CAST_ANDROID && !IS_DESKTOP_ANDROID - WebView gets the enabled default.
 *   The one exemption is audibility and it expires 30 seconds after sound stops
 *   (kRecentAudioDelay = base::Seconds(30)).
 *
 *   "The foreground service does not help here at all. It solves the OS's
 *    microphone policy. This is Blink's scheduler, one layer up, in the same
 *    process, and entirely indifferent to it. Two independent killers, two
 *    independent fixes."
 *
 * So with the screen off, an unpinned voice session survives only while the
 * assistant is actually speaking plus 30 seconds; a longer conversational pause
 * backgrounds the page and the freeze grace period (1-5 minutes, Finch
 * controlled) ends it.
 *
 * The fix: never let the window look invisible while a session is live, so
 * IsBackgrounded() never becomes true and no freeze timer starts.
 *
 * The design doc labels this [INFERENCE] - derived from three Chromium source
 * paths, not an API contract - and [UNSETTLED] pending an on-device screen-off
 * measurement. It is pinned only while VoiceSessionService is running, never
 * unconditionally, which is the conservative constraint the doc asks for.
 */
class MuxtermWebView(ctx: Context) : WebView(ctx) {

    /** Set true only while VoiceSessionService is running. */
    var pinVisible: Boolean = false
        set(value) {
            if (field == value) return
            field = value
            Log.i(MainActivity.TAG, "window visibility pin = $value")
            if (value) super.onWindowVisibilityChanged(View.VISIBLE)
        }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(if (pinVisible) View.VISIBLE else visibility)
    }
}
