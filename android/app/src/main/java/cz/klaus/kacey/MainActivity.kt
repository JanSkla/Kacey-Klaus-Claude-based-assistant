package cz.klaus.kacey

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.InsetDrawable
import android.graphics.drawable.LayerDrawable
import android.os.Bundle
import android.provider.Settings
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * The launcher screen (Claude Design "Kacey Android" 1a–1c). The state leads:
 * a STAV list of four rows, each with a dot, a state word and — when
 * something is missing — the action that fixes it. One primary action below
 * (show / hide the bubble), then the server address. Kacey herself is
 * BubbleActivity / KaceyActivity.
 */
class MainActivity : Activity() {

    private enum class Dot { OK, ERR, ACC, HOLLOW }

    private lateinit var url: EditText

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.root)) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        url = findViewById(R.id.url)
        url.setText(Prefs.url(this))
        url.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: Editable?) { renderServer() }
        })

        findViewById<Button>(R.id.save).setOnClickListener {
            val saved = Prefs.setUrl(this, url.text.toString())
            if (saved == null) toast("To není adresa (https://…).")
            else { url.setText(saved); url.clearFocus(); toast("Uloženo. Otevřená okna Kacey načti znovu.") }
            renderServer()
        }

        findViewById<Button>(R.id.bubble).setOnClickListener {
            if (Bubble.isShowing(this)) Bubble.hide(this) else Bubble.show(this, expand = true)
            // The notification lands a moment later; draw again once it has.
            it.postDelayed({ refresh() }, 400)
            refresh()
        }
        findViewById<Button>(R.id.open).setOnClickListener {
            startActivity(Intent(this, KaceyActivity::class.java))
        }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refresh()
    }

    private fun granted(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun openBubbleSettings() {
        startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_BUBBLE_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
    }

    /* Straight to Kacey's switch where Android allows it (11+), else the list.
       A sideloaded app may first need "Allow restricted settings" in its App
       info (README, "Notifications"). */
    private fun openRelaySettings() {
        val detail = Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
            .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, Relay.component(this).flattenToString())
        try { startActivity(detail) } catch (e: android.content.ActivityNotFoundException) {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
    }

    private fun refreshSoon() = findViewById<View>(R.id.root).postDelayed({ refresh() }, 1500)

    /* ---- drawing ----------------------------------------------------------- */

    private fun refresh() {
        val notif = granted(Manifest.permission.POST_NOTIFICATIONS)
        val mic = granted(Manifest.permission.RECORD_AUDIO)
        val bubbles = Bubble.canBubble(this)
        val showing = Bubble.isShowing(this)

        row(R.id.rowNotif, "Oznámení", if (notif) Dot.OK else Dot.ERR, if (notif) "povoleno" else "chybí",
            if (notif) null else "Povolit" to { requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1) })
        row(R.id.rowMic, "Mikrofon", if (mic) Dot.OK else Dot.ERR, if (mic) "povolen" else "chybí",
            if (mic) null else "Povolit" to { requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 2) })
        row(R.id.rowBubbles, "Bubliny v systému", if (bubbles) Dot.OK else Dot.ERR, if (bubbles) "zapnuté" else "vypnuté",
            (if (bubbles) "Otevřít" else "Nastavit") to { openBubbleSettings() }, ghost = bubbles)
        row(R.id.rowBubble, "Bublina", if (showing) Dot.ACC else Dot.HOLLOW, if (showing) "na obrazovce" else "skrytá",
            null, current = showing)
        /* The notification relay: access first, then whether the queue is
           getting through to kaceybody. */
        val relay = Relay.granted(this)
        val waiting = if (relay) Relay.pending(this) else 0
        val relayError = Prefs.relayError(this)
        when {
            !relay -> row(R.id.rowRelay, "Čtení oznámení", Dot.ERR, "vypnuté", "Povolit" to { openRelaySettings() })
            waiting > 0 -> row(R.id.rowRelay, "Čtení oznámení", Dot.HOLLOW,
                "čeká $waiting" + (relayError?.let { " · $it" } ?: ""), "Odeslat" to { Relay.flush(this); refreshSoon() })
            else -> row(R.id.rowRelay, "Čtení oznámení", Dot.OK, "posílá do Kacey", "Nastavit" to { openRelaySettings() }, ghost = true)
        }

        val primary = findViewById<Button>(R.id.bubble)
        if (showing) {
            primary.text = "Skrýt bublinu"
            primary.setBackgroundResource(R.drawable.btn_outline_accent)
            primary.setTextColor(getColor(R.color.acc))
        } else {
            primary.text = "Zobrazit bublinu"
            primary.setBackgroundResource(R.drawable.btn_accent)
            primary.setTextColor(getColor(R.color.on_acc))
        }
        // Showing needs bubbles on (and notifications, which they live in); hiding never does.
        val canShow = showing || (bubbles && notif)
        primary.isEnabled = canShow
        primary.alpha = if (canShow) 1f else .45f
        findViewById<TextView>(R.id.bubbleNote).visibility = if (canShow) View.GONE else View.VISIBLE

        renderServer()
    }

    private fun row(
        id: Int, name: String, dot: Dot, state: String,
        action: Pair<String, () -> Unit>?, ghost: Boolean = false, current: Boolean = false,
    ) {
        val r = findViewById<View>(id)
        r.findViewById<TextView>(R.id.name).text = name
        r.findViewById<View>(R.id.dot).background = dotDrawable(dot)
        r.findViewById<TextView>(R.id.state).apply {
            text = state
            setTextColor(getColor(when (dot) { Dot.OK -> R.color.ok; Dot.ERR -> R.color.err; Dot.ACC -> R.color.ink; Dot.HOLLOW -> R.color.ink3 }))
        }
        r.findViewById<Button>(R.id.action).apply {
            if (action == null) { visibility = View.GONE; return@apply }
            visibility = View.VISIBLE
            text = action.first
            setBackgroundResource(if (ghost) R.drawable.btn_ghost else R.drawable.btn)
            setTextColor(getColor(if (ghost) R.color.ink2 else R.color.ink))
            setOnClickListener { action.second() }
        }
        // The current row: l2 with a 4dp accent left edge (DESIGN.md §4, current-item highlight).
        r.background = if (current) currentBackground() else null
    }

    private fun dotDrawable(d: Dot) = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        when (d) {
            Dot.HOLLOW -> { setColor(0); setStroke(dp(1), getColor(R.color.ink3)) }
            Dot.OK -> setColor(getColor(R.color.ok))
            Dot.ERR -> setColor(getColor(R.color.err))
            Dot.ACC -> setColor(getColor(R.color.acc))
        }
    }

    private fun currentBackground(): LayerDrawable {
        val edge = GradientDrawable().apply { setColor(getColor(R.color.acc)) }
        val fill = GradientDrawable().apply { setColor(getColor(R.color.l2)) }
        return LayerDrawable(arrayOf(edge, InsetDrawable(fill, dp(4), 0, 0, 0)))
    }

    /** "Uložit" turns accent only when the field differs from the saved address. */
    private fun renderServer() {
        val changed = url.text.toString().trim().trimEnd('/') != Prefs.url(this)
        findViewById<Button>(R.id.save).apply {
            setBackgroundResource(if (changed) R.drawable.btn_accent else R.drawable.btn)
            setTextColor(getColor(if (changed) R.color.on_acc else R.color.ink))
            typeface = android.graphics.Typeface.create(android.graphics.Typeface.MONOSPACE, if (changed) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
        }
        findViewById<TextView>(R.id.urlNote).apply {
            text = if (changed) "Změněno. Otevřená okna Kacey po uložení načti znovu." else "Adresa kaceybody v tailnetu, https."
            setTextColor(getColor(if (changed) R.color.ink2 else R.color.ink3))
        }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()
}
