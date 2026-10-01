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

    /**
     * No Kacey (no Tailscale, kaceybody asleep). Claude Design "Kacey Android"
     * 2b: a 52px bar with the state dot (as .bleedbar), the error as a .readout,
     * what to check, and one accent action at the bottom, in thumb's reach.
     * The accent is hue 193 baked in: this page has no --h (DESIGN.md §7).
     */
    private fun offlinePage(why: String): String {
        val url = Prefs.url(this)
        val esc = { s: String -> s.replace("&", "&amp;").replace("<", "&lt;").replace("\"", "&quot;").replace("'", "&#39;") }
        val lbl = "font-size:12px;letter-spacing:.08em;color:#9a9a9a"
        val hollow = "width:8px;height:8px;flex:none;border-radius:50%;border:1px solid #9a9a9a"
        return """<!doctype html><html lang="cs"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="margin:0;min-height:100vh;display:flex;flex-direction:column;background:#161616;color:#f4f4f4;font:15px/1.5 Consolas,'SFMono-Regular',Menlo,ui-monospace,monospace;-webkit-font-smoothing:antialiased">
<div style="height:52px;flex:none;display:flex;align-items:center;gap:10px;padding:0 16px;background:#242424;border-bottom:1px solid #414141">
<span style="width:12px;height:12px;background:#5cd4f5"></span><b style="font-size:15px;font-weight:600;letter-spacing:.04em">Kacey</b>
<span style="margin-left:auto;display:flex;align-items:center;gap:6px;font-size:12px;letter-spacing:.08em;color:#fa4d56"><span style="width:8px;height:8px;border-radius:50%;background:#fa4d56"></span>NEDOSTUPNÁ</span>
</div>
<div style="flex:1;display:flex;flex-direction:column;gap:14px;padding:20px 16px">
<p style="margin:0;font-size:17px;font-weight:600">Kacey není k zastižení.</p>
<div style="background:#242424;border:1px solid #414141;font-size:13px">
<div style="display:grid;grid-template-columns:72px 1fr;gap:10px;padding:10px 14px;border-bottom:1px solid #2e2e2e"><span style="$lbl">ADRESA</span><span style="color:#c6c6c6;overflow-wrap:anywhere">${esc(url)}</span></div>
<div style="display:grid;grid-template-columns:72px 1fr;gap:10px;padding:10px 14px"><span style="$lbl">CHYBA</span><span style="color:#c6c6c6;overflow-wrap:anywhere">${esc(why.ifBlank { "—" })}</span></div>
</div>
<div style="display:flex;flex-direction:column;gap:8px">
<span style="$lbl">ZKONTROLUJ</span>
<span style="display:flex;align-items:center;gap:10px;font-size:14px;color:#c6c6c6"><span style="$hollow"></span>Tailscale v telefonu je zapnutý</span>
<span style="display:flex;align-items:center;gap:10px;font-size:14px;color:#c6c6c6"><span style="$hollow"></span>kaceybody běží</span>
</div>
<button onclick="location.href='${esc(url)}/#main'" style="margin-top:auto;height:52px;font:inherit;font-size:15px;font-weight:600;border:0;background:#5cd4f5;color:#161616">Zkusit znovu</button>
</div>
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
