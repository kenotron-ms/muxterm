package io.ampbox.muxterm

import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * The whole native UI: one WebView, full bleed, pointed at muxterm.
 *
 * Design artifact. Written 2026-09-08 against the platform documentation of
 * that date; NOT compiled, because this machine has no Android SDK.
 *
 * Read docs/design/webview-wrapper.md W3 before adding anything to this file.
 * There is no native title bar, no native settings screen, no second WebView.
 * If a feature needs a screen, it is a route in the web app.
 */
class MainActivity : ComponentActivity() {

    companion object {
        /** The one origin. Never a wildcard, never http://, never a *. pattern. */
        const val ORIGIN = "https://muxterm.ampbox.io"

        /** The name of the injected JavaScript object. Matches native-bridge.ts. */
        const val JS_OBJECT = "muxtermNative"
    }

    private lateinit var webView: WebView
    private lateinit var bridge: MuxtermBridge

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            settings.apply {
                // All three are off or restrictive by default.
                javaScriptEnabled = true
                domStorageEnabled = true

                // Default is true. The inbound assistant track is attached to an
                // <audio> element and played programmatically, with no user
                // gesture at that moment — with the default, playback is blocked
                // and the session is one-way with no error.
                mediaPlaybackRequiresUserGesture = false
            }

            // Deliberately NOT touched: setRendererPriorityPolicy. The default is
            // RENDERER_PRIORITY_IMPORTANT "regardless of visibility", which is
            // exactly what a backgrounded voice session needs.
        }

        webView.webChromeClient = MuxtermChromeClient(this)
        webView.webViewClient = MuxtermWebViewClient()

        bridge = MuxtermBridge(this, webView)
        installBridge()

        setContentView(webView)
        webView.loadUrl(ORIGIN)

        onBackPressedDispatcher.addCallback(this) {
            if (webView.canGoBack()) webView.goBack() else finish()
        }
    }

    /**
     * Origin-scoped message channel.
     *
     * addWebMessageListener rather than addJavascriptInterface, for one reason:
     * allowedOriginRules. If the WebView is ever navigated off-origin — a link in
     * terminal output, an OAuth redirect — the injected object is simply not
     * there. That is the correct failure, and it is not achievable with
     * addJavascriptInterface at all.
     */
    private fun installBridge() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            // A WebView too old for the feature. The web app degrades to exactly
            // what a browser tab does — which is a working product, minus
            // screen-off audio. Do not crash, do not nag.
            bridge.markUnavailable()
            return
        }
        WebViewCompat.addWebMessageListener(
            webView,
            JS_OBJECT,
            setOf(ORIGIN),
        ) { _, message, sourceOrigin, isMainFrame, replyProxy ->
            // Belt and braces: the origin rule above already guarantees this, but
            // a bridge is exactly the place to check twice.
            if (!isMainFrame || sourceOrigin.toString().trimEnd('/') != ORIGIN) return@addWebMessageListener
            bridge.onMessage(message.data ?: return@addWebMessageListener, replyProxy)
        }
    }

    override fun onDestroy() {
        bridge.dispose()
        super.onDestroy()
    }

    // ---------------------------------------------------------------------
    // Deliberately NOT overridden: onPause / onStop calling webView.onPause()
    // or webView.pauseTimers().
    //
    // pauseTimers() "Pauses all layout, parsing, and JavaScript timers for ALL
    // WebViews". Calling it in onPause is the idiom every tutorial teaches, and
    // it would stop the exact thing the foreground service exists to keep
    // running. This comment is the guard rail; there is no code to write.
    // ---------------------------------------------------------------------
}
