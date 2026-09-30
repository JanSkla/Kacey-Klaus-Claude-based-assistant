package cz.klaus.kacey

import android.content.Context
import android.net.Uri

/**
 * The two things the app remembers: where Kacey is, and whether the owner
 * wants the bubble (so it comes back after a reboot or an update).
 *
 * The default is kaceybody on the tailnet, behind `tailscale serve`: a real
 * certificate, which the WebView needs before it will hand the page the
 * microphone (README, "HOST and the microphone").
 */
object Prefs {
    const val DEFAULT_URL = "https://kaceybody.tail87ce53.ts.net"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("kacey", Context.MODE_PRIVATE)

    fun url(ctx: Context): String =
        (prefs(ctx).getString("url", null) ?: DEFAULT_URL).trimEnd('/')

    /** Saves a cleaned URL, or returns null when it is not an http(s) address. */
    fun setUrl(ctx: Context, raw: String): String? {
        var s = raw.trim().trimEnd('/')
        if (s.isEmpty()) s = DEFAULT_URL
        if (!s.contains("://")) s = "https://$s"
        val u = Uri.parse(s)
        if ((u.scheme != "https" && u.scheme != "http") || u.host.isNullOrEmpty()) return null
        prefs(ctx).edit().putString("url", s).apply()
        return s
    }

    fun host(ctx: Context): String? = Uri.parse(url(ctx)).host

    var Context.bubbleWanted: Boolean
        get() = prefs(this).getBoolean("bubble", false)
        set(v) { prefs(this).edit().putBoolean("bubble", v).apply() }
}
