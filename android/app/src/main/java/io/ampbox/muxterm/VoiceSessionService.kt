package io.ampbox.muxterm

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * The reason the wrapper exists.
 *
 * Adapted from docs/design/webview-wrapper.md (branch design/webview-wrapper),
 * section W1.2 and the reference VoiceSessionService.kt in
 * docs/design/webview-wrapper/. Android silences a background app's microphone:
 *
 *   "only apps running in the foreground (or a foreground service) could
 *    capture the audio input. When an app without a foreground service or
 *    foreground UI component started to capture, the app continued running but
 *    received silence"
 *      - developer.android.com/media/platform/sharing-audio-input
 *
 * This service satisfies the parenthesis. It holds no audio, opens no stream and
 * never touches the conversation - the WebView's getUserMedia owns all of that,
 * in this same process, which is the whole point (design doc W1.1: a Trusted Web
 * Activity would run the capture in Chrome's process, where our foreground
 * service has no reach).
 *
 * Two types are declared:
 *   microphone    - the capture, per the policy above
 *   mediaPlayback - Android 15+: "Apps that target Android 15 (API level 35)
 *                   must be the top app or running a foreground service in
 *                   order to request audio focus."
 */
class VoiceSessionService : Service() {

    companion object {
        const val CHANNEL_ID = "voice"
        const val NOTIF_ID = 1

        const val ACTION_STOP = "io.ampbox.muxterm.VOICE_STOP"
        const val ACTION_USER_STOP = "io.ampbox.muxterm.VOICE_USER_STOP"
        const val EXTRA_STATE = "state"

        /** Grace period before an idle microphone tears the session down. */
        private const val IDLE_STOP_MS = 8_000L

        /**
         * If capture never starts at all - getUserMedia rejected, no microphone
         * on the device - give up rather than leave an ongoing notification
         * attached to a session that never happened.
         */
        private const val NEVER_STARTED_MS = 25_000L

        /**
         * Set by the service, read by the Activity. One voice session at a time,
         * one process; simpler and more honest than binding for a boolean.
         */
        @Volatile
        var running: Boolean = false
            private set

        /**
         * Notified when [running] changes so MainActivity can pin the WebView's
         * window visibility for the life of the session. Without that pin Blink
         * freezes the page 1-5 minutes after the assistant stops talking and the
         * foreground service is powerless to prevent it - design doc W1.4b.
         */
        @Volatile
        var onRunningChanged: ((Boolean) -> Unit)? = null

        private fun setRunning(value: Boolean) {
            if (running == value) return
            running = value
            onRunningChanged?.invoke(value)
        }

        /** Native -> page events (mic.silenced / mic.resumed). Null when no page attached. */
        @Volatile
        var events: ((String) -> Unit)? = null

        fun start(ctx: Context, state: String = "connecting") {
            val intent = Intent(ctx, VoiceSessionService::class.java).putExtra(EXTRA_STATE, state)
            // Must be called while the Activity is visible. Apps targeting
            // Android 12+ cannot start a while-in-use FGS from the background;
            // there is no exemption for the microphone type (design doc W1.2).
            ctx.startForegroundService(intent)
        }

        fun stop(ctx: Context) {
            ctx.startService(
                Intent(ctx, VoiceSessionService::class.java).setAction(ACTION_STOP),
            )
        }
    }

    private var recordingCallback: AudioManager.AudioRecordingCallback? = null
    private var lastSilenced = false
    private var sawRecording = false
    private val handler = Handler(Looper.getMainLooper())
    private val idleStop = Runnable {
        Log.i(MainActivity.TAG, "no active capture for ${IDLE_STOP_MS}ms, ending voice session")
        stop()
    }
    private val neverStarted = Runnable {
        if (sawRecording) return@Runnable
        Log.w(MainActivity.TAG, "capture never started within ${NEVER_STARTED_MS}ms, ending voice session")
        stop()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP, ACTION_USER_STOP -> {
                stop()
                return START_NOT_STICKY
            }
        }

        val state = intent?.getStringExtra(EXTRA_STATE) ?: "connecting"

        // Android 14+ throws three different exceptions if the manifest and this
        // call disagree:
        //   MissingForegroundServiceTypeException - no type in the manifest
        //   IllegalArgumentException              - type not declared in manifest
        //   SecurityException                     - type permission not declared
        // ServiceCompat handles the pre-34 shape difference.
        ServiceCompat.startForeground(
            this,
            NOTIF_ID,
            buildNotification(state),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
        )
        Log.i(MainActivity.TAG, "foreground service started (microphone|mediaPlayback)")
        setRunning(true)
        watchRecording()
        handler.removeCallbacks(neverStarted)
        handler.postDelayed(neverStarted, NEVER_STARTED_MS)

        // NOT sticky. If the system kills us the peer connection is gone too; a
        // service that restarts itself into an empty session is a persistent
        // notification attached to nothing.
        return START_NOT_STICKY
    }

    private fun stop() {
        handler.removeCallbacks(idleStop)
        handler.removeCallbacks(neverStarted)
        unwatchRecording()
        setRunning(false)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        handler.removeCallbacks(idleStop)
        handler.removeCallbacks(neverStarted)
        unwatchRecording()
        setRunning(false)
        super.onDestroy()
    }

    // -----------------------------------------------------------------------
    // The signal Chromium wires to nothing
    // -----------------------------------------------------------------------

    /**
     * AudioManager.AudioRecordingCallback is Android's channel for "your capture
     * is being silenced". Chromium ignores it - MediaStreamTrack.muted on Android
     * is wired to the OS mic MUTE TOGGLE instead - so the page cannot detect
     * this and native can (design doc W1.4).
     *
     * It doubles as the session-end signal for this build: the muxterm web app
     * has no native bridge yet, so nothing tells us the orb was switched off.
     * When the app holds no recording configuration for [IDLE_STOP_MS] the
     * session is over and the notification should go with it.
     */
    private fun watchRecording() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        if (recordingCallback != null) return
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val cb = object : AudioManager.AudioRecordingCallback() {
            override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>?) {
                val list = configs.orEmpty()

                if (list.isEmpty()) {
                    if (sawRecording) handler.postDelayed(idleStop, IDLE_STOP_MS)
                } else {
                    sawRecording = true
                    handler.removeCallbacks(idleStop)
                    handler.removeCallbacks(neverStarted)
                }

                val silenced = list.any { it.isClientSilenced }
                if (silenced == lastSilenced) return
                lastSilenced = silenced
                Log.i(MainActivity.TAG, if (silenced) "mic.silenced" else "mic.resumed")
                events?.invoke(if (silenced) "mic.silenced" else "mic.resumed")
                updateNotification(if (silenced) "error" else "listening")
            }
        }
        am.registerAudioRecordingCallback(cb, handler)
        recordingCallback = cb
    }

    private fun unwatchRecording() {
        val cb = recordingCallback ?: return
        recordingCallback = null
        sawRecording = false
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        (getSystemService(Context.AUDIO_SERVICE) as AudioManager).unregisterAudioRecordingCallback(cb)
    }

    // -----------------------------------------------------------------------
    // The one piece of native UI this wrapper admits
    // -----------------------------------------------------------------------

    private fun ensureChannel() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // IMPORTANCE_LOW, not MIN. Below PRIORITY_LOW the platform adds its own
        // message to the drawer about the app's use of a foreground service, in
        // worse words than ours.
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Voice", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while muxterm is listening"
                setShowBadge(false)
            },
        )
    }

    /** One line of text, one action, no state of its own. */
    private fun buildNotification(state: String) =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_voice)
            .setContentTitle("muxterm")
            .setContentText(textFor(state))
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
                0, "Stop voice",
                PendingIntent.getService(
                    this, 1,
                    Intent(this, VoiceSessionService::class.java).setAction(ACTION_USER_STOP),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
            .build()

    private fun updateNotification(state: String) {
        if (!running) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID, buildNotification(state))
    }

    /** Mirrors VoiceSessionState from the web app. No vocabulary of its own. */
    private fun textFor(state: String) = when (state) {
        "connecting" -> "Connecting\u2026"
        "listening" -> "Listening"
        "thinking" -> "Thinking\u2026"
        "speaking" -> "Speaking"
        "error" -> "Voice is not hearing you"
        else -> "Voice session"
    }
}
