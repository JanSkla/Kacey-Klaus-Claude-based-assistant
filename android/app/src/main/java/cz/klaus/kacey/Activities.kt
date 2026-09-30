package cz.klaus.kacey

import android.app.Activity
import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.widget.Toast
import cz.klaus.kacey.Prefs.bubbleWanted
import kotlin.concurrent.thread

class KaceyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Bubble.createChannel(this)
    }
}

/** Kacey inside the floating bubble. */
class BubbleActivity : WebHostActivity() {
    override val inBubble = true

    /* Expanding the bubble resumes this. A share that ShareActivity parked
       while the bubble was collapsed is picked up here. */
    override fun onResume() {
        super.onResume()
        ShareStore.bubbleResumedAt = System.currentTimeMillis()
        if (ShareStore.hasPending()) offerShare()
    }
}

/** Kacey full screen — also where a share goes when bubbles are off. */
class KaceyActivity : WebHostActivity() {
    override val inBubble = false

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (ShareStore.hasPending()) offerShare()
    }

    override fun onResume() {
        super.onResume()
        if (ShareStore.hasPending()) offerShare()
    }
}

/**
 * "Share → Kacey". Reads the screenshot, parks it in ShareStore and opens the
 * bubble on it (auto-expand works because this activity is in front). It
 * waits, invisible, until the bubble window has opened (its page takes the
 * share once loaded); if the bubble never opens — bubbles switched off, or
 * the system declined to expand it — it opens Kacey full screen instead,
 * which takes the share on load.
 */
class ShareActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val intent = intent
        thread(name = "kacey-share") {
            val json = ShareStore.fromIntent(applicationContext, intent)
            main.post {
                if (json == null) {
                    Toast.makeText(this, "Tohle Kacey neumí přečíst.", Toast.LENGTH_SHORT).show()
                    finish()
                    return@post
                }
                ShareStore.put(json)
                if (Bubble.canBubble(this)) {
                    Bubble.show(this, expand = true)
                    waitForBubble(System.currentTimeMillis())
                } else {
                    fullScreen()
                }
            }
        }
    }

    private fun waitForBubble(since: Long) {
        if (!ShareStore.hasPending() || ShareStore.bubbleResumedAt >= since) { finish(); return }
        if (System.currentTimeMillis() - since > BUBBLE_WAIT_MS) { fullScreen(); return }
        main.postDelayed({ waitForBubble(since) }, 200)
    }

    private fun fullScreen() {
        startActivity(Intent(this, KaceyActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
    }

    companion object {
        /* Only the bubble window has to appear in time, not the page: a
           bubble opening cold can take a few seconds on a busy phone. */
        private const val BUBBLE_WAIT_MS = 8000L
    }
}

/** Quick Settings tile: the bubble back, after it was dragged away. */
class BubbleTileService : TileService() {
    override fun onStartListening() {
        qsTile?.apply {
            state = if (Bubble.isShowing(this@BubbleTileService)) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
            updateTile()
        }
    }

    override fun onClick() {
        if (Bubble.isShowing(this)) Bubble.hide(this) else Bubble.show(this)
        onStartListening()
    }
}

/** The bubble does not survive a reboot or an app update; bring it back if it was wanted. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (ctx.bubbleWanted) Bubble.show(ctx)
    }
}
