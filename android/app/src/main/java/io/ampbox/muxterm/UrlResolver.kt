package io.ampbox.muxterm

import android.content.Context
import android.net.Uri

/**
 * Single source of truth for "what server is the wrapper pointed at".
 *
 * MainActivity's URL-change dialog and the car screen's session feed both
 * need this, and they must never disagree - so this is the one place that
 * reads/writes the override, with BuildConfig.MUXTERM_URL as the fallback.
 * Extracted out of MainActivity (which used to keep this logic to itself)
 * rather than letting the car package grow a second copy of it.
 */
object UrlResolver {
    private const val PREFS = "muxterm_wrapper"
    private const val KEY_URL = "url"

    fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun resolveUrl(context: Context): String =
        prefs(context).getString(KEY_URL, null)?.takeIf { it.isNotBlank() } ?: BuildConfig.MUXTERM_URL

    fun saveUrl(context: Context, url: String) {
        prefs(context).edit().putString(KEY_URL, url.trim()).apply()
    }

    fun resetUrl(context: Context) {
        prefs(context).edit().remove(KEY_URL).apply()
    }

    fun originOf(url: String): String {
        val u = Uri.parse(url)
        val scheme = u.scheme ?: return ""
        val host = u.host ?: return ""
        val port = u.port
        return if (port == -1) "$scheme://$host" else "$scheme://$host:$port"
    }

    /**
     * The muxterm daemon pushes session rows over its WebSocket at `/ws` on
     * the same origin as the page (http -> ws, https -> wss). Returns null
     * only if the configured URL cannot be parsed into an origin at all.
     */
    fun wsUrl(context: Context): String? {
        val origin = originOf(resolveUrl(context))
        if (origin.isEmpty()) return null
        val wsScheme = when {
            origin.startsWith("https://") -> "wss://"
            origin.startsWith("http://") -> "ws://"
            else -> return null
        }
        val rest = origin.substringAfter("://")
        return "$wsScheme$rest/ws"
    }
}
