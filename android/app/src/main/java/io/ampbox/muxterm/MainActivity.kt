package io.ampbox.muxterm

import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.util.Log
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * A1 - the floor: a plain WebView that loads muxterm.
 *
 * Deliberately a *wrapper*, not an app. It hosts the page and grants it capabilities;
 * it implements no muxterm feature. See docs/design/webview-wrapper.md (branch
 * design/webview-wrapper) for why a plain WebView rather than a Trusted Web Activity:
 * capture must run in a process our own foreground service covers.
 */
class MainActivity : android.app.Activity() {

    companion object {
        const val TAG = "muxterm"
        private const val PREFS = "muxterm_wrapper"
        private const val KEY_URL = "url"

        /** Origin the wrapper is currently pointed at, e.g. "https://muxterm.ampbox.io". */
        @JvmStatic
        var origin: String = ""
            private set
    }

    private lateinit var webView: WebView
    private var currentUrl: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Allow `adb shell am start -n io.ampbox.muxterm/.MainActivity -e url https://host`
        // and a plain VIEW intent to repoint the wrapper without a rebuild.
        intent?.getStringExtra("url")?.let { saveUrl(it) }

        currentUrl = resolveUrl()
        origin = originOf(currentUrl)

        val root = FrameLayout(this)
        root.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        webView = WebView(this)
        root.addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        setContentView(root)

        // Keep the web app out from under the status/navigation bars.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        configureWebView()

        if (savedInstanceState == null) {
            Log.i(TAG, "loading $currentUrl")
            webView.loadUrl(currentUrl)
        } else {
            webView.restoreState(savedInstanceState)
        }
    }

    private fun configureWebView() {
        webView.settings.apply {
            // Defaults are false/true respectively; muxterm needs all three.
            javaScriptEnabled = true
            domStorageEnabled = true
            // Default true. The assistant's inbound audio element is played
            // programmatically with no user gesture; leaving this on silently
            // kills voice playback.
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url.toString()
                // Keep our own origin in the app; hand anything else to the system
                // browser (OAuth providers, external links).
                return if (originOf(url) == origin) {
                    false
                } else {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                        .onFailure { Log.w(TAG, "no handler for $url") }
                    true
                }
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                if (!request.isForMainFrame) return
                Log.w(TAG, "load error ${error.errorCode} ${error.description} for ${request.url}")
                Toast.makeText(
                    this@MainActivity,
                    "Could not load $currentUrl - press back to change the URL",
                    Toast.LENGTH_LONG,
                ).show()
            }

            // Without this the whole app dies when the renderer is reaped under
            // memory pressure. Rebuild instead.
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.e(TAG, "renderer gone (crashed=${detail.didCrash()}), rebuilding")
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
                webView = WebView(this@MainActivity)
                (findViewById<ViewGroup>(android.R.id.content).getChildAt(0) as FrameLayout)
                    .addView(
                        webView,
                        FrameLayout.LayoutParams(
                            FrameLayout.LayoutParams.MATCH_PARENT,
                            FrameLayout.LayoutParams.MATCH_PARENT,
                        ),
                    )
                configureWebView()
                webView.loadUrl(currentUrl)
                return true
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    /**
     * NOTE: we deliberately do NOT call webView.onPause() or pauseTimers() here.
     * Pausing the WebView in onPause is the idiom every tutorial teaches and it is
     * exactly what stops the thing a voice session needs kept running.
     */
    override fun onPause() {
        super.onPause()
    }

    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            showRootDialog()
        }
    }

    /** At the root of history, back offers the only settings surface this wrapper has. */
    private fun showRootDialog() {
        AlertDialog.Builder(this)
            .setTitle("muxterm")
            .setItems(arrayOf("Reload", "Change URL", "Exit")) { _, which ->
                when (which) {
                    0 -> webView.reload()
                    1 -> showUrlDialog()
                    2 -> finish()
                }
            }
            .show()
    }

    private fun showUrlDialog() {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setText(currentUrl)
        }
        AlertDialog.Builder(this)
            .setTitle("Server URL")
            .setView(input)
            .setPositiveButton("Load") { _, _ ->
                val url = input.text.toString().trim()
                if (url.isNotEmpty()) {
                    saveUrl(url)
                    currentUrl = url
                    origin = originOf(url)
                    webView.loadUrl(url)
                }
            }
            .setNeutralButton("Reset to default") { _, _ ->
                prefs().edit().remove(KEY_URL).apply()
                currentUrl = BuildConfig.MUXTERM_URL
                origin = originOf(currentUrl)
                webView.loadUrl(currentUrl)
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun saveUrl(url: String) = prefs().edit().putString(KEY_URL, url.trim()).apply()

    private fun resolveUrl(): String =
        prefs().getString(KEY_URL, null)?.takeIf { it.isNotBlank() } ?: BuildConfig.MUXTERM_URL

    private fun originOf(url: String): String {
        val u = Uri.parse(url)
        val scheme = u.scheme ?: return ""
        val host = u.host ?: return ""
        val port = u.port
        return if (port == -1) "$scheme://$host" else "$scheme://$host:$port"
    }
}
