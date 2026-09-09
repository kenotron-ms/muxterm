package io.ampbox.muxterm.notify

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import io.ampbox.muxterm.MainActivity
import io.ampbox.muxterm.R
import io.ampbox.muxterm.UrlResolver
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/**
 * Holds the daemon's `session-state` feed open and turns it into notifications.
 *
 * ## Why a foreground service and not "the app, while it happens to be open"
 *
 * The feature exists for the user who dispatched a dozen lanes and then STOPPED
 * WATCHING. A detector that only runs while the dashboard is on screen notifies
 * them of things they can already see and stays silent for everything else,
 * which is the exact inversion of what was asked for.
 *
 * The alternative - the server pushing to the device - needs a push transport,
 * and on Android without Google Play messaging there is no such transport: the
 * only way to be reachable while backgrounded is to HOLD A SOCKET, and the only
 * way to hold a socket is a foreground service. So this is not a compromise
 * short of "real" push; below the cloud layer, this IS the mechanism, and the
 * server-side design is written up in docs/design/android-notifications.md.
 *
 * The wrapper already proved this shape works: VoiceSessionService keeps a
 * WebRTC conversation alive through a dark screen. This is the same trick with
 * a cheaper payload.
 *
 * ## What it does not cover, stated plainly
 *
 *  - force-stopped by the user, or killed by a vendor battery manager: silent
 *    until the app is opened again
 *  - after a reboot, until the app is opened once (no BOOT_COMPLETED receiver)
 *  - deep Doze can suspend the socket; the reconnect is silent by design, so
 *    transitions that happened while it was down are adopted, not announced
 */
class FleetWatchService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private val detector = TransitionDetector()
    private val buffer = AlertBuffer()
    private lateinit var notifier: LaneNotifier

    private var client: OkHttpClient? = null
    private var socket: WebSocket? = null
    private var backoffMs = INITIAL_BACKOFF_MS
    private var reconnect: Runnable? = null
    private var stopping = false

    /** Latest snapshot, by sessionId, so a flush can ask "is that still true?". */
    private var latest: Map<String, String> = emptyMap()

    private val flush = Runnable { flushNow() }

    override fun onCreate() {
        super.onCreate()
        notifier = LaneNotifier(this)
        notifier.ensureChannels()
        running = true
        ServiceCompat.startForeground(
            this,
            LaneNotifier.ID_WATCH,
            ongoingNotification(),
            // DATA_SYNC is the honest type: this holds a network sync open. It
            // requires FOREGROUND_SERVICE_DATA_SYNC in the manifest on API 34+;
            // an undeclared type is an IllegalArgumentException, and no type at
            // all is MissingForegroundServiceTypeException.
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
        connect()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            setEnabled(this, false)
            shutdown()
            return START_NOT_STICKY
        }
        // Restarted by the platform after a kill: a fresh detector means the
        // first snapshot is adopted, not diffed against a stale set.
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        shutdown()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun shutdown() {
        if (stopping) return
        stopping = true
        handler.removeCallbacksAndMessages(null)
        reconnect = null
        runCatching { socket?.close(1000, "watch stopped") }
        socket = null
        client = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // -----------------------------------------------------------------------
    // The feed
    // -----------------------------------------------------------------------

    private fun connect() {
        if (stopping) return
        val url = UrlResolver.wsUrl(this)
        if (url == null) {
            Log.w(TAG, "no usable server URL; not watching")
            return
        }
        val c = client ?: OkHttpClient.Builder()
            .pingInterval(PING_SECONDS, TimeUnit.SECONDS)
            .build()
            .also { client = it }

        // EVERY connection starts without a baseline. This is the reconnect
        // guard: the first snapshot of a connection is adopted silently, so
        // coming back from a dead network never replays the fleet as news.
        detector.reset()

        val builder = Request.Builder().url(url)
        // muxterm's /ws is behind AuthMiddleware (internal/server/server.go:
        // `protect(...)`), which accepts the `muxterm_session` cookie. The
        // WebView already holds that cookie - login persists across a force
        // stop - so borrow it rather than inventing a second auth path. A
        // loopback dev server bypasses auth entirely, where this is empty.
        val cookie = cookieHeader()
        if (cookie != null) builder.header("Cookie", cookie)
        Log.i(TAG, "dialing $url (cookie=${cookie != null})")

        socket = c.newWebSocket(
            builder.build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    backoffMs = INITIAL_BACKOFF_MS
                    // `ok` IS NOT OPTIONAL. session-state-subscribe is a
                    // two-way switch, not an event: internal/server/ws.go
                    // does `c.setSessionStateWanted(msg.OK)`, so a frame that
                    // omits the field unmarshals to OK=false and turns the
                    // feed OFF. The daemon still replies
                    // session-state-subscribe-result with OK=true - it
                    // understood the message - and then never sends a single
                    // session-state. Verified on a device against a live
                    // daemon: subscribe acknowledged, zero snapshots.
                    webSocket.send("""{"type":"session-state-subscribe","ok":true}""")
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    handler.post { onFrame(text) }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    Log.w(TAG, "ws failure: ${response?.code ?: ""} ${t.message}")
                    handler.post { scheduleReconnect() }
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    handler.post { scheduleReconnect() }
                }
            },
        )
    }

    /**
     * The cookie the WebView holds for this origin, as a request header, or
     * null if there is none (not logged in yet, or a loopback dev server).
     */
    private fun cookieHeader(): String? {
        // Keyed on the http(s) origin, not the ws:// one: that is where the
        // WebView stored it.
        val httpOrigin = UrlResolver.originOf(UrlResolver.resolveUrl(this))
        if (httpOrigin.isEmpty()) return null
        return runCatching { CookieManager.getInstance().getCookie(httpOrigin) }
            .getOrNull()
            ?.takeIf { it.isNotBlank() }
    }

    private fun scheduleReconnect() {
        if (stopping || reconnect != null || client == null) return
        val delay = backoffMs
        backoffMs = (backoffMs * 2).coerceAtMost(MAX_BACKOFF_MS)
        val r = Runnable {
            reconnect = null
            connect()
        }
        reconnect = r
        handler.postDelayed(r, delay)
    }

    private fun onFrame(text: String) {
        val obj = runCatching { JSONObject(text) }.getOrNull() ?: return
        if (obj.optString("type") != "session-state") return

        val rows = LaneRow.parseAll(obj)
        latest = rows.associate { it.sessionId to it.state }

        val baseline = !detector.hasBaseline
        val transitions = detector.observe(rows)
        if (baseline) {
            Log.i(TAG, "baseline adopted: ${rows.size} lane(s), 0 notifications")
            return
        }
        if (transitions.isEmpty()) return

        for (t in transitions) {
            Log.i(TAG, "transition ${t.row.sessionId} ${t.from} -> ${t.to} (${t.row.displayName})")
        }
        buffer.add(transitions)
        if (!buffer.flushArmed) {
            buffer.flushArmed = true
            handler.postDelayed(flush, AlertBuffer.COALESCE_WINDOW_MS)
        }
    }

    private fun flushNow() {
        val plan = buffer.drain(
            currentState = { latest[it] },
            appForeground = appInForeground,
        )
        if (plan.isEmpty) {
            Log.i(TAG, "flush: nothing to post (foreground=$appInForeground)")
            return
        }
        notifier.post(plan)
    }

    // -----------------------------------------------------------------------
    // The service's own ongoing row
    // -----------------------------------------------------------------------

    private fun ongoingNotification() =
        NotificationCompat.Builder(this, LaneNotifier.CHANNEL_WATCH)
            .setSmallIcon(R.drawable.ic_stat_lanes)
            .setContentTitle("muxterm")
            .setContentText("Watching lanes for status changes")
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(
                PendingIntent.getActivity(
                    this, 0, Intent(this, MainActivity::class.java),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
            .addAction(
                0, "Stop watching",
                PendingIntent.getService(
                    this, 1,
                    Intent(this, FleetWatchService::class.java).setAction(ACTION_STOP),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
            .build()

    companion object {
        private const val TAG = "muxterm-notify"
        private const val ACTION_STOP = "io.ampbox.muxterm.WATCH_STOP"
        private const val PREF_ENABLED = "lane_alerts"

        private const val INITIAL_BACKOFF_MS = 1_000L
        private const val MAX_BACKOFF_MS = 30_000L
        private const val PING_SECONDS = 20L

        @Volatile
        var running: Boolean = false
            private set

        /**
         * True while MainActivity is resumed. Set from the Activity, read at
         * flush time: a change the user is watching happen is not news.
         */
        @Volatile
        var appInForeground: Boolean = false

        fun isEnabled(ctx: Context): Boolean =
            UrlResolver.prefs(ctx).getBoolean(PREF_ENABLED, true)

        fun setEnabled(ctx: Context, on: Boolean) {
            UrlResolver.prefs(ctx).edit().putBoolean(PREF_ENABLED, on).apply()
        }

        /**
         * Must be called while the Activity is visible: apps targeting Android
         * 12+ cannot start a foreground service from the background.
         */
        fun start(ctx: Context) {
            if (running) return
            ctx.startForegroundService(Intent(ctx, FleetWatchService::class.java))
        }

        fun stop(ctx: Context) {
            if (!running) return
            ctx.startService(
                Intent(ctx, FleetWatchService::class.java).setAction(ACTION_STOP),
            )
        }
    }
}
