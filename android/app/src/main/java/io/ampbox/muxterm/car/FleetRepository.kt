package io.ampbox.muxterm.car

import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/**
 * The car screen's only data source: the muxterm daemon's session-state feed
 * over WebSocket. Process-wide singleton on purpose - one screen or twenty,
 * this holds exactly one socket. Started/stopped by MuxtermSession's own
 * lifecycle, not FleetScreen's, so a screen recreation (day/night, rotation)
 * never tears down or re-dials the feed.
 */
object FleetRepository {

    data class SessionRow(
        val sessionId: String,
        val workspaceId: String,
        val harness: String?,
        val name: String,
        val label: String?,
        val mode: String,
        val state: String,
        val waitingFor: String?,
        val doing: String?,
        val updatedAt: Long,
    ) {
        /** What a row shows: the human label if there is one, else the raw name. */
        val displayName: String
            get() = label?.takeIf { it.isNotBlank() } ?: name
    }

    private const val TAG = "muxterm-car"
    private const val INITIAL_BACKOFF_MS = 1_000L
    private const val MAX_BACKOFF_MS = 30_000L

    private val handler = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArrayList<() -> Unit>()

    @Volatile private var sessions: List<SessionRow> = emptyList()

    /** True once a "session-state" push has actually arrived at least once. */
    @Volatile private var hasSnapshot: Boolean = false

    /**
     * True once a connection attempt has actually failed at least once. Used
     * to tell "still dialing for the first time" (show a loading list) apart
     * from "genuinely can't reach the server" (show an explicit message) -
     * the spec's "connected/never-connected" flag, made two-valued so the
     * first few hundred ms of startup don't flash an error.
     */
    @Volatile private var everFailedToConnect: Boolean = false

    private var wsUrl: String? = null
    private var client: OkHttpClient? = null
    private var socket: WebSocket? = null
    private var backoffMs = INITIAL_BACKOFF_MS
    private var reconnectRunnable: Runnable? = null

    fun addListener(listener: () -> Unit) = listeners.add(listener)
    fun removeListener(listener: () -> Unit) = listeners.remove(listener)

    fun currentSessions(): List<SessionRow> = sessions
    fun hasSnapshot(): Boolean = hasSnapshot
    fun everFailedToConnect(): Boolean = everFailedToConnect

    fun start(url: String) {
        wsUrl = url
        if (client != null) return
        client = OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
        connect()
    }

    fun stop() {
        handler.removeCallbacksAndMessages(null)
        reconnectRunnable = null
        socket?.close(1000, "car session ended")
        socket = null
        client = null
        backoffMs = INITIAL_BACKOFF_MS
        hasSnapshot = false
        everFailedToConnect = false
        sessions = emptyList()
    }

    private fun connect() {
        val url = wsUrl ?: return
        val c = client ?: return
        val request = Request.Builder().url(url).build()
        socket = c.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    backoffMs = INITIAL_BACKOFF_MS
                    webSocket.send("""{"type":"session-state-subscribe"}""")
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    handleMessage(text)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    Log.w(TAG, "ws failure: ${t.message}")
                    everFailedToConnect = true
                    notifyListeners()
                    scheduleReconnect()
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    scheduleReconnect()
                }
            },
        )
    }

    private fun scheduleReconnect() {
        if (reconnectRunnable != null || client == null) return
        val delay = backoffMs
        backoffMs = (backoffMs * 2).coerceAtMost(MAX_BACKOFF_MS)
        val runnable = Runnable {
            reconnectRunnable = null
            connect()
        }
        reconnectRunnable = runnable
        handler.postDelayed(runnable, delay)
    }

    private fun handleMessage(text: String) {
        val obj = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (obj.optString("type")) {
            "session-state-subscribe-result" -> {
                // Acknowledges the daemon understood us; no data yet.
            }
            "session-state" -> {
                // ABSENT MEANS EMPTY: `sessions` is an omitempty field on the
                // wire, so a fleet that just went from N sessions to zero
                // arrives as a bare {"type":"session-state"} with no
                // `sessions` key at all - not as `"sessions":[]`. The signal
                // is the ARRIVAL of this message; treat a missing field as
                // the empty list. Gating this on `!= null` instead of always
                // replacing would freeze the car screen showing sessions
                // that have already ended.
                val arr = obj.optJSONArray("sessions")
                val list = if (arr == null) {
                    emptyList()
                } else {
                    (0 until arr.length()).mapNotNull { i -> arr.optJSONObject(i)?.let(::parseRow) }
                }
                sessions = list
                hasSnapshot = true
                notifyListeners()
            }
        }
    }

    private fun parseRow(o: JSONObject): SessionRow = SessionRow(
        sessionId = o.optString("sessionId"),
        workspaceId = o.optString("workspaceId"),
        harness = o.optStringOrNull("harness"),
        name = o.optString("name"),
        label = o.optStringOrNull("label"),
        mode = o.optString("mode"),
        state = o.optString("state"),
        waitingFor = o.optStringOrNull("waitingFor"),
        doing = o.optStringOrNull("doing"),
        updatedAt = o.optLong("updatedAt"),
    )

    private fun JSONObject.optStringOrNull(key: String): String? =
        if (has(key) && !isNull(key)) optString(key) else null

    private fun notifyListeners() {
        handler.post { listeners.forEach { it() } }
    }
}
