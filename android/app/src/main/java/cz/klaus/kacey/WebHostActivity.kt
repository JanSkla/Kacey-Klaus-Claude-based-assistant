package cz.klaus.kacey

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.TextUtils
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Kacey's page in a WebView — the same page the desktop and the kiosk run,
 * served by kaceybody. Everything Kacey does, the page does; this only gives
 * it what a browser tab would have had:
 *
 *  - the microphone (getUserMedia → RECORD_AUDIO). A WebView has no
 *    SpeechRecognition, so dictation uses the server's Whisper
 *    (public/js/voice/server-stt.js), which needs just the microphone;
 *  - a file picker for the composer's paperclip;
 *  - window.KaceyNative.takeShare() for a screenshot shared from another app;
 *  - back = the page's own history (its views are #hash routes).
 *
 * Only Kacey's own origin loads here. Any other link opens in the browser, so
 * the bridge is never handed to a page that is not Kacey's.
 */
abstract class WebHostActivity : Activity() {

    protected lateinit var web: WebView
    private var micRequest: PermissionRequest? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var backCallback: OnBackInvokedCallback? = null

    /** Whether this window is the bubble — the page may want to know. */
    protected abstract val inBubble: Boolean

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)

        web = WebView(this)
        web.setBackgroundColor(getColor(R.color.bg))
        val root = FrameLayout(this)
        root.setBackgroundColor(getColor(R.color.bg))
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)

        /* Edge to edge is enforced from targetSdk 35: keep the page clear of
           the status bar, the navigation bar and the keyboard by padding. */
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime() or WindowInsetsCompat.Type.displayCutout(),
            )
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false      // Kacey speaks without a tap first
            allowFileAccess = false
            allowContentAccess = false
            userAgentString = "$userAgentString KaceyAndroid/1.0"
        }
        web.addJavascriptInterface(Bridge(), "KaceyNative")
        web.webViewClient = Client()
        web.webChromeClient = Chrome()

        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        else web.loadUrl(Prefs.url(this) + "/#main")
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    /** Tell an open page a share is waiting; a page still loading takes it on start. */
    protected fun offerShare() {
        web.evaluateJavascript("window.dispatchEvent(new Event('kacey-share'))", null)
    }

    /* ---- back: the page's history first ------------------------------------ */

    private fun syncBack() {
        if (Build.VERSION.SDK_INT < 33) return
        val want = web.canGoBack()
        if (want && backCallback == null) {
            backCallback = OnBackInvokedCallback { if (web.canGoBack()) web.goBack() }.also {
                onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, it)
            }
        } else if (!want && backCallback != null) {
            onBackInvokedDispatcher.unregisterOnBackInvokedCallback(backCallback!!)
            backCallback = null
        }
    }

    @Deprecated("Below API 33 only; 33+ uses OnBackInvokedDispatcher (syncBack).")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    /* ---- the microphone and the file picker -------------------------------- */

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_MIC) return
        val req = micRequest ?: return
        micRequest = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) req.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        else req.deny()
    }

    @Deprecated("The platform Activity has no ActivityResult API without androidx.activity.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION") super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_FILE) return
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
        fileCallback = null
    }

    private fun isKacey(uri: Uri?): Boolean = uri != null && TextUtils.equals(uri.host, Prefs.host(this))

    private inner class Chrome : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) {
            runOnUiThread {
                val mic = PermissionRequest.RESOURCE_AUDIO_CAPTURE
                if (!isKacey(request.origin) || !request.resources.contains(mic)) { request.deny(); return@runOnUiThread }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(arrayOf(mic))
                } else {
                    micRequest?.deny()
                    micRequest = request
                    requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
                }
            }
        }

        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            return try {
                @Suppress("DEPRECATION") startActivityForResult(params.createIntent(), REQ_FILE)
                true
            } catch (_: ActivityNotFoundException) {
                fileCallback = null
                false
            }
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (isKacey(request.url)) return false
            try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (_: ActivityNotFoundException) { }
            return true
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            syncBack()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            view.loadDataWithBaseURL(null, offlinePage(error.description?.toString() ?: ""), "text/html", "utf-8", null)
        }
    }

    /** No Kacey (no Tailscale, kaceybody asleep): say so, in Kacey's colours, with a way back. */
    private fun offlinePage(why: String): String {
        val url = Prefs.url(this)
        val esc = { s: String -> s.replace("&", "&amp;").replace("<", "&lt;").replace("\"", "&quot;") }
        return """<!doctype html><html lang="cs"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="margin:0;padding:24px;background:#161616;color:#f4f4f4;font:15px/1.5 monospace">
<p style="font-weight:600;font-size:17px">Kacey není k zastižení.</p>
<p style="color:#c6c6c6">${esc(url)}<br>${esc(why)}</p>
<p style="color:#9a9a9a">Je v telefonu zapnutý Tailscale a běží kaceybody?</p>
<button onclick="location.href='${esc(url)}/#main'" style="font:inherit;font-weight:600;padding:12px 20px;border:0;background:#5cd4f5;color:#161616">Zkusit znovu</button>
</body></html>"""
    }

    /** window.KaceyNative — what public/js/ui/share.js looks for. */
    private inner class Bridge {
        @JavascriptInterface fun takeShare(): String = ShareStore.take() ?: ""
        @JavascriptInterface fun isBubble(): Boolean = inBubble
    }

    companion object {
        private const val REQ_MIC = 7
        private const val REQ_FILE = 8
    }
}
