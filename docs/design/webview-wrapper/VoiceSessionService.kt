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
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * The reason the wrapper exists.
 *
 * Design artifact. Written 2026-09-08; NOT compiled — no Android SDK here.
 *
 * Android silences a background app's microphone. From the platform docs:
 *
 *   "only apps running in the foreground (or a foreground service) could
 *    capture the audio input. When an app without a foreground service or
 *    foreground UI component started to capture, the app continued running but
 *    received silence"
 *      — developer.android.com/media/platform/sharing-audio-input
 *
 * This service satisfies the parenthesis. It does nothing else. It holds no
 * audio, opens no stream, and never touches the conversation — the WebView's
 * getUserMedia owns all of that, in this same process, which is the whole
 * point (see W1.1).
 *
 * The two types:
 *   microphone    — the capture, per the policy above
 *   mediaPlayback — Android 15+: "Apps that target Android 15 (API level 35)
 *                   must be the top app or running a foreground service in
 *                   order to request audio focus." The inbound assistant audio
 *                   needs focus, so playback needs the service too.
 */
class VoiceSessionService : Service() {

    companion object {
        const val CHANNEL_ID = "voice"
        const val NOTIF_ID = 1

        const val ACTION_START = "io.ampbox.muxterm.VOICE_START"
        const val ACTION_STOP = "io.ampbox.muxterm.VOICE_STOP"
        const val ACTION_USER_STOP = "io.ampbox.muxterm.VOICE_USER_STOP"
        const val EXTRA_STATE = "state"

        /**
         * Set by the service, read by the bridge. A voice session is one at a
         * time; the process is shared; this is simpler and more honest than
         * binding for a boolean.
         */
        @Volatile var running: Boolean = false
            private set

        /**
         * Notified when `running` changes, so MainActivity can pin the WebView's
         * window visibility for the life of the session. Without that pin, Blink
         * freezes the page ~1-5 minutes after the assistant stops talking, and
         * the foreground service is powerless to prevent it — see W1.4b.
         */
        @Volatile var onRunningChanged: ((Boolean) -> Unit)? = null

        private fun setRunning(value: Boolean) {
            if (running == value) return
            running = value
            onRunningChanged?.invoke(value)
        }

        /** The bridge installs this to receive events. Null when no page is attached. */
        @Volatile var events: ((String) -> Unit)? = null
    }

    private var recordingCallback: AudioManager.AudioRecordingCallback? = null
    private var lastSilenced = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP, ACTION_USER_STOP -> {
                if (intent.action == ACTION_USER_STOP) events?.invoke("voice.stopRequested")
                stop()
                return START_NOT_STICKY
            }
        }

        val state = intent?.getStringExtra(EXTRA_STATE) ?: "connecting"

        // Android 14+ throws three different exceptions if the manifest and this
        // call disagree:
        //   MissingForegroundServiceTypeException  — no type in the manifest
        //   IllegalArgumentException               — type not declared in manifest
        //   SecurityException                      — type permission not declared
        // ServiceCompat handles the pre-34 shape difference.
        ServiceCompat.startForeground(
            this,
            NOTIF_ID,
            buildNotification(state),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
        )
        setRunning(true)
        watchRecording()

        // NOT sticky. If the system kills us, the peer connection is gone too;
        // a service that restarts itself into an empty session is a persistent
        // notification attached to nothing.
        return START_NOT_STICKY
    }

    private fun stop() {
        unwatchRecording()
        setRunning(false)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        unwatchRecording()
        setRunning(false)
        super.onDestroy()
    }

    // -----------------------------------------------------------------------
    // The signal Chromium wires to nothing
    // -----------------------------------------------------------------------

    /**
     * AudioManager.AudioRecordingCallback is Android's channel for "your capture
     * is being silenced". A Gerrit search for AudioRecordingCallback in Chromium
     * returns zero CLs — MediaStreamTrack.muted on Android is wired to the OS
     * mic-MUTE TOGGLE instead (AAudioInputStream::IsMuted -> IsMicrophoneMuted
     * -> is_microphone_muted_, fed only by the mute-state listener).
     *
     * So the page cannot detect this. Native can. This callback is the single
     * most valuable thing on the bridge: it turns "lit orb, dead microphone,
     * silent, forever" into an event the web app can render honestly.
     *
     * isClientSilenced() is API 29+. Below that the wrapper is blind, and says
     * so by not announcing the capability.
     */
    private fun watchRecording() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val cb = object : AudioManager.AudioRecordingCallback() {
            override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>?) {
                val silenced = configs.orEmpty().any { it.isClientSilenced }
                if (silenced == lastSilenced) return
                lastSilenced = silenced
                events?.invoke(if (silenced) "mic.silenced" else "mic.resumed")
                updateNotification(if (silenced) "error" else "listening")
            }
        }
        am.registerAudioRecordingCallback(cb, null)
        recordingCallback = cb
    }

    private fun unwatchRecording() {
        val cb = recordingCallback ?: return
        recordingCallback = null
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        (getSystemService(Context.AUDIO_SERVICE) as AudioManager).unregisterAudioRecordingCallback(cb)
    }

    // -----------------------------------------------------------------------
    // The one piece of native UI this design admits (W3)
    // -----------------------------------------------------------------------

    private fun ensureChannel() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // IMPORTANCE_LOW, not MIN. Below PRIORITY_LOW the platform adds its own
        // message to the drawer about the app's use of a foreground service,
        // in worse words than ours.
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
        "connecting" -> "Connecting…"
        "listening" -> "Listening"
        "thinking" -> "Thinking…"
        "speaking" -> "Speaking"
        "error" -> "Voice is not hearing you"
        else -> "Voice session"
    }
}
