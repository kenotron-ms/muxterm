package io.ampbox.muxterm

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.util.Log
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import io.ampbox.muxterm.notify.FleetWatchService

/**
 * A plain WebView that hosts muxterm and grants it capabilities.
 *
 * It implements no muxterm feature: the chief of staff, voice over WebRTC and
 * remote sessions all already work in the web app. This class exists to give
 * that page a microphone that keeps working - see docs/design/webview-wrapper.md
 * on branch design/webview-wrapper.
 */
class MainActivity : android.app.Activity() {

    companion object {
        const val TAG = "muxterm"
        private const val REQ_STARTUP_PERMS = 4002

        /** Origin the wrapper is currently pointed at, e.g. "https://muxterm.ampbox.io". */
        @JvmStatic
        @Volatile
        var origin: String = ""
            private set
    }

    private lateinit var root: FrameLayout
    private lateinit var webView: MuxtermWebView
    private lateinit var chromeClient: MuxtermChromeClient
    private var currentUrl: String = ""

    /** Origin of the page actually committed in the WebView. Read by NativeBridge
     *  from the JS thread, so it is written on the UI thread and kept volatile. */
    @Volatile
    private var liveOrigin: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Allow `adb shell am start -n io.ampbox.muxterm/.MainActivity -e url https://host`
        // to repoint the wrapper without a rebuild.
        intent?.getStringExtra("url")?.let { UrlResolver.saveUrl(this, it) }

        currentUrl = UrlResolver.resolveUrl(this)
        origin = UrlResolver.originOf(currentUrl)

        root = FrameLayout(this)
        setContentView(
            root,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )

        // Keep the web app out from under the status/navigation bars.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        configureCookies()
        attachWebView()

        // The service flips this whenever a session starts or ends. Pinning the
        // window visible is the only defence against Blink freezing the page
        // with the screen off - design doc W1.4b, and MuxtermWebView.
        VoiceSessionService.onRunningChanged = { running ->
            runOnUiThread { webView.pinVisible = running }
        }
        VoiceSessionService.events = { event ->
            runOnUiThread {
                webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('muxterm-native',{detail:'$event'}))",
                    null,
                )
            }
        }

        requestStartupPermissions()

        if (savedInstanceState == null) {
            Log.i(TAG, "loading $currentUrl")
            webView.loadUrl(currentUrl)
        } else {
            webView.restoreState(savedInstanceState)
        }
    }

    // -----------------------------------------------------------------------
    // A2 - cookies must survive the app closing, or the demo dies at login
    // -----------------------------------------------------------------------

    /**
     * muxterm's session cookie (`muxterm_session`, internal/server/authclient.go)
     * is set with an explicit MaxAge, so it is a persistent cookie and WebView
     * will write it to disk - but only if the store is actually flushed.
     * WebView flushes lazily; a process death between login and flush loses it.
     */
    private fun configureCookies() {
        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
    }

    private fun flushCookies() {
        CookieManager.getInstance().flush()
    }

    /**
     * Two jobs. The service must be started from a visible Activity (Android
     * 12+ forbids starting a while-in-use foreground service from the
     * background), and the notifier needs to know the user is looking at the
     * app so it can stay quiet about changes happening on screen in front of
     * them.
     */
    override fun onResume() {
        super.onResume()
        FleetWatchService.appInForeground = true
        if (FleetWatchService.isEnabled(this)) FleetWatchService.start(this)
    }

    override fun onPause() {
        super.onPause()
        FleetWatchService.appInForeground = false
        // Deliberately NOT calling webView.onPause() or pauseTimers(): design
        // doc W1.4 calls that "the single most likely way to build the whole
        // thing correctly and still have it fail", because pausing the WebView
        // in onPause is the idiom every tutorial teaches - and it stops exactly
        // what the foreground service exists to keep running.
        flushCookies()
    }

    /**
     * Tapping a lane notification lands here, because MainActivity is
     * `singleTask` and the notification's PendingIntent is SINGLE_TOP: the
     * existing task is resumed rather than a second copy stacked on top. There
     * is nothing to navigate to - the muxterm web app is one page with no
     * per-workspace URL - so bringing the app forward IS the whole action.
     */
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        intent?.getStringExtra("url")?.let {
            UrlResolver.saveUrl(this, it)
            currentUrl = it
            origin = UrlResolver.originOf(it)
            webView.loadUrl(it)
        }
    }

    override fun onStop() {
        super.onStop()
        flushCookies()
    }

    // -----------------------------------------------------------------------
    // WebView
    // -----------------------------------------------------------------------

    private fun attachWebView() {
        webView = MuxtermWebView(this)
        root.addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        configureWebView()
    }

    private fun configureWebView() {
        webView.settings.apply {
            // Defaults are false, false, true respectively; muxterm needs all
            // three changed (design doc W1.3).
            javaScriptEnabled = true
            domStorageEnabled = true
            // The assistant's inbound audio element is played programmatically
            // with no user gesture; leaving this true silently kills voice.
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
        }

        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        chromeClient = MuxtermChromeClient(this).apply {
            onAudioGranted = {
                // The web app has no native bridge yet, so this is the honest
                // signal that a voice session is starting: the page just asked
                // for the microphone. We are in the foreground here (the user
                // pressed the orb), which is what Android 12+ requires for
                // starting a while-in-use foreground service.
                if (!VoiceSessionService.running) VoiceSessionService.start(this@MainActivity)
            }
        }
        webView.webChromeClient = chromeClient

        webView.addJavascriptInterface(NativeBridge(), "muxtermNative")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url
                val scheme = url.scheme?.lowercase()
                // Every http(s) navigation stays in the app. Login is an
                // OAuth 2.1 + PKCE redirect chain; bouncing any hop of it into
                // the system browser would strand the cookie in the wrong jar.
                if (scheme == "http" || scheme == "https") return false
                return runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    true
                }.getOrElse {
                    Log.w(TAG, "no handler for $url")
                    true
                }
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                liveOrigin = UrlResolver.originOf(url)
            }

            override fun onPageFinished(view: WebView, url: String) {
                liveOrigin = UrlResolver.originOf(url)
                // Persist whatever the login flow just set, immediately.
                flushCookies()
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
            // memory pressure (design doc W1.4). Rebuild instead.
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.e(TAG, "renderer gone (crashed=${detail.didCrash()}), rebuilding")
                root.removeView(view)
                view.destroy()
                attachWebView()
                webView.pinVisible = VoiceSessionService.running
                webView.loadUrl(currentUrl)
                return true
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        VoiceSessionService.onRunningChanged = null
        VoiceSessionService.events = null
        if (isFinishing && VoiceSessionService.running) VoiceSessionService.stop(this)
        flushCookies()
        super.onDestroy()
    }

    // -----------------------------------------------------------------------
    // A3 - permissions
    // -----------------------------------------------------------------------

    /**
     * Ask for everything once, in a single call. Android shows one runtime
     * permission dialog at a time and silently drops a second requestPermissions
     * while one is in flight - asking separately means only the first is ever
     * seen, which is exactly how RECORD_AUDIO ends up quietly ungranted.
     *
     * If the user declines here, the page's own getUserMedia will ask again at
     * the moment of use, which is the better prompt anyway.
     *
     * POST_NOTIFICATIONS is Android 13+ and MUST be asked for at runtime; the
     * manifest line grants nothing on its own. Voice is not gated on it - "apps
     * don't need to request the POST_NOTIFICATIONS permission in order to
     * launch a foreground service", only its notification is suppressed - but
     * lane status alerts are exactly a notification, so without this grant the
     * platform drops them and the feature is silently absent. It is asked for
     * here, in the same single call, rather than at the moment of use, because
     * the moment of use is by definition when the user is not looking at the
     * app.
     */
    private fun requestStartupPermissions() {
        val wanted = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            wanted += Manifest.permission.RECORD_AUDIO
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            wanted += Manifest.permission.POST_NOTIFICATIONS
        }
        if (wanted.isEmpty()) return
        ActivityCompat.requestPermissions(this, wanted.toTypedArray(), REQ_STARTUP_PERMS)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        chromeClient.onRuntimePermissionResult(requestCode, permissions, grantResults)
    }

    // -----------------------------------------------------------------------
    // Optional page -> native bridge
    // -----------------------------------------------------------------------

    /**
     * Not required by anything today: the muxterm web app does not know this
     * exists, and changing the web app is out of scope. It is here so a voice
     * session can be pinned explicitly once the page does know, and so the
     * behaviour can be exercised by hand from the console. Every method
     * re-checks the origin, because addJavascriptInterface exposes to whatever
     * page happens to be loaded.
     */
    inner class NativeBridge {
        private fun allowed(): Boolean =
            liveOrigin.isNotEmpty() && liveOrigin == origin

        @JavascriptInterface
        fun startVoice(state: String) {
            if (!allowed()) return
            runOnUiThread { VoiceSessionService.start(this@MainActivity, state) }
        }

        @JavascriptInterface
        fun stopVoice() {
            if (!allowed()) return
            runOnUiThread { VoiceSessionService.stop(this@MainActivity) }
        }

        @JavascriptInterface
        fun isVoiceServiceRunning(): Boolean = VoiceSessionService.running

        @JavascriptInterface
        fun capabilities(): String =
            """{"foregroundService":true,"visibilityPin":true,"micSilencedEvents":true}"""
    }

    // -----------------------------------------------------------------------
    // The wrapper's only settings surface
    // -----------------------------------------------------------------------

    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            showRootDialog()
        }
    }

    private fun showRootDialog() {
        // The only in-app control over lane alerts, and deliberately the only
        // one: everything finer - sound, importance, whether completions show
        // at all - lives in Android's own notification settings, per channel,
        // where the user can reach it by long-pressing the notification itself.
        val alertsOn = FleetWatchService.isEnabled(this)
        val alertsItem = if (alertsOn) "Lane alerts: on" else "Lane alerts: off"
        AlertDialog.Builder(this)
            .setTitle("muxterm")
            .setItems(arrayOf("Reload", "Change URL", alertsItem, "Exit")) { _, which ->
                when (which) {
                    0 -> webView.reload()
                    1 -> showUrlDialog()
                    2 -> toggleLaneAlerts(alertsOn)
                    3 -> finish()
                }
            }
            .show()
    }

    /**
     * The watcher resolves the server URL when it dials, so pointing the
     * wrapper somewhere else has to bounce it - otherwise it keeps watching the
     * old server until that socket happens to drop. The restart also re-adopts
     * a baseline, so switching servers never announces the new fleet as news.
     */
    private fun redialWatch() {
        if (!FleetWatchService.isEnabled(this)) return
        FleetWatchService.stop(this)
        webView.postDelayed({ FleetWatchService.start(this) }, 500)
    }

    private fun toggleLaneAlerts(wasOn: Boolean) {
        FleetWatchService.setEnabled(this, !wasOn)
        if (wasOn) {
            FleetWatchService.stop(this)
            Toast.makeText(this, "Lane alerts off", Toast.LENGTH_SHORT).show()
        } else {
            FleetWatchService.start(this)
            Toast.makeText(this, "Lane alerts on", Toast.LENGTH_SHORT).show()
        }
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
                    UrlResolver.saveUrl(this, url)
                    currentUrl = url
                    origin = UrlResolver.originOf(url)
                    webView.loadUrl(url)
                    redialWatch()
                }
            }
            .setNeutralButton("Reset to default") { _, _ ->
                UrlResolver.resetUrl(this)
                currentUrl = BuildConfig.MUXTERM_URL
                origin = UrlResolver.originOf(currentUrl)
                webView.loadUrl(currentUrl)
                redialWatch()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }
}
