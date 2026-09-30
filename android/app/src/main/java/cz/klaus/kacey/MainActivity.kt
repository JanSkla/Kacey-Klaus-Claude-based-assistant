package cz.klaus.kacey

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * The launcher screen: switch the bubble on, grant what it needs, say where
 * Kacey lives. Kacey herself is BubbleActivity / KaceyActivity.
 */
class MainActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val root = findViewById<android.view.View>(R.id.root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        val url = findViewById<EditText>(R.id.url)
        url.setText(Prefs.url(this))

        findViewById<Button>(R.id.save).setOnClickListener {
            val saved = Prefs.setUrl(this, url.text.toString())
            if (saved == null) toast("To není adresa (https://…).")
            else { url.setText(saved); toast("Uloženo. Otevřená okna Kacey načti znovu.") }
        }

        findViewById<Button>(R.id.bubble).setOnClickListener {
            if (!hasNotifications()) { askPermissions(); return@setOnClickListener }
            if (Bubble.isShowing(this)) Bubble.hide(this)
            else {
                Bubble.show(this, expand = Bubble.canBubble(this))
                if (!Bubble.canBubble(this)) toast("Bubliny jsou vypnuté — zapni je v Nastavení bublin.")
            }
            refresh()
        }
        findViewById<Button>(R.id.open).setOnClickListener {
            startActivity(Intent(this, KaceyActivity::class.java))
        }
        findViewById<Button>(R.id.perms).setOnClickListener { askPermissions() }
        findViewById<Button>(R.id.bubbleSettings).setOnClickListener {
            startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_BUBBLE_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
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

    private fun hasNotifications() =
        checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun hasMic() =
        checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun askPermissions() {
        val want = listOf(Manifest.permission.POST_NOTIFICATIONS, Manifest.permission.RECORD_AUDIO)
            .filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (want.isEmpty()) toast("Oznámení i mikrofon už povolené jsou.")
        else requestPermissions(want.toTypedArray(), 1)
    }

    private fun refresh() {
        val yes = "✓"; val no = "✗"
        val showing = Bubble.isShowing(this)
        findViewById<TextView>(R.id.status).text = listOf(
            "${if (hasNotifications()) yes else no} oznámení",
            "${if (hasMic()) yes else no} mikrofon",
            "${if (Bubble.canBubble(this)) yes else no} bubliny povolené",
            "${if (showing) yes else "·"} bublina ${if (showing) "je na obrazovce" else "není zobrazená"}",
        ).joinToString("\n")
        findViewById<Button>(R.id.bubble).text = if (showing) "Skrýt bublinu" else "Zobrazit bublinu"
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()
}
