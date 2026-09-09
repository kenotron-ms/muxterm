package io.ampbox.muxterm.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import io.ampbox.muxterm.MainActivity
import io.ampbox.muxterm.R

/**
 * Posts what [AlertBuffer] decided. Holds no policy of its own.
 *
 * ## Channels, not an in-app settings screen
 *
 * Three channels, because the three things this app posts have three different
 * costs and the user should be able to price them separately in Android's own
 * settings - which outlives any preferences screen we could write, works from
 * the long-press on the notification itself, and is where people already go to
 * turn things down.
 *
 *   "Lanes needing you"  HIGH  - heads-up + sound. The point of the feature.
 *   "Lane completions"   LOW   - shows in the shade, makes no sound.
 *   "Watching lanes"     LOW   - the foreground service's own ongoing row.
 *
 * IMPORTANCE_LOW rather than MIN for the ongoing one, for the reason already
 * learned in VoiceSessionService: below PRIORITY_LOW the platform writes its
 * own worse sentence about the app's foreground service into the drawer.
 *
 * ## Two notification ids, reused
 *
 * All blocked lanes share one id and all completions share another, so a fresh
 * flush REPLACES the previous row instead of stacking beside it. Stacking is
 * how a notification feature becomes a scroll of identical rows and then gets
 * switched off.
 */
class LaneNotifier(private val context: Context) {

    fun ensureChannels() {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_BLOCKED,
                "Lanes needing you",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "A lane stopped and is waiting for you to answer it"
                enableVibration(true)
                setShowBadge(true)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_FINISHED,
                "Lane completions",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "A lane finished or failed. Worth knowing, not urgent"
                setShowBadge(false)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_WATCH,
                "Watching lanes",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Shown while muxterm is watching for lane status changes"
                setShowBadge(false)
            },
        )
    }

    fun post(plan: AlertBuffer.Plan) {
        if (plan.isEmpty) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        if (plan.blocked.isNotEmpty()) {
            Log.i(TAG, "posting blocked alert for ${plan.blocked.size} lane(s)")
            nm.notify(
                ID_BLOCKED,
                build(
                    channel = CHANNEL_BLOCKED,
                    title = AlertText.blockedTitle(plan.blocked),
                    body = AlertText.blockedBody(plan.blocked),
                    entries = plan.blocked,
                    high = true,
                ),
            )
        }
        if (plan.finished.isNotEmpty()) {
            Log.i(TAG, "posting completion alert for ${plan.finished.size} lane(s)")
            nm.notify(
                ID_FINISHED,
                build(
                    channel = CHANNEL_FINISHED,
                    title = AlertText.finishedTitle(plan.finished),
                    body = AlertText.finishedBody(plan.finished),
                    entries = plan.finished,
                    high = false,
                ),
            )
        }
    }

    private fun build(
        channel: String,
        title: String,
        body: String,
        entries: List<TransitionDetector.Transition>,
        high: Boolean,
    ) = NotificationCompat.Builder(context, channel)
        .setSmallIcon(R.drawable.ic_stat_lanes)
        .setContentTitle(title)
        .setContentText(body)
        .setAutoCancel(true)
        .setCategory(if (high) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_STATUS)
        .setPriority(if (high) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_LOW)
        .apply {
            // More than one lane: list them, so the expanded row answers "which
            // ones?" without opening anything.
            if (entries.size > 1) {
                val style = NotificationCompat.InboxStyle().setBigContentTitle(title)
                for (e in entries.take(MAX_LINES)) style.addLine(AlertText.line(e))
                if (entries.size > MAX_LINES) {
                    style.setSummaryText("+${entries.size - MAX_LINES} more")
                }
                setStyle(style)
            }
        }
        .setContentIntent(openApp())
        .build()

    /**
     * Tapping brings the app forward. That is the whole of it, and it is the
     * best available: the muxterm web app is one page with no per-workspace
     * URL (no routing, no hash, nothing in web/src that reads location), so
     * there is nothing to deep-link TO. Giving the wrapper a fake route would
     * be inventing web-app behaviour from the outside.
     *
     * MainActivity is `launchMode="singleTask"`, so this resumes the existing
     * task rather than stacking a second copy; SINGLE_TOP makes that explicit
     * and routes through onNewIntent.
     */
    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        context,
        REQ_OPEN,
        Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    companion object {
        private const val TAG = "muxterm-notify"

        const val CHANNEL_BLOCKED = "lanes_blocked"
        const val CHANNEL_FINISHED = "lanes_finished"
        const val CHANNEL_WATCH = "lanes_watch"

        // 1 is VoiceSessionService's.
        const val ID_WATCH = 2
        const val ID_BLOCKED = 3
        const val ID_FINISHED = 4

        private const val REQ_OPEN = 20
        private const val MAX_LINES = 6
    }
}
