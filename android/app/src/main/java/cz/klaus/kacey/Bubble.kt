package cz.klaus.kacey

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.LocusIdCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import cz.klaus.kacey.Prefs.bubbleWanted

/**
 * The floating bubble — Android's own Bubbles API, the one Messenger's chat
 * heads use. A bubble is a notification with BubbleMetadata, attached to a
 * long-lived conversation shortcut; tapping it opens BubbleActivity in a
 * floating window over whatever app is showing. Dragging it to the bottom
 * dismisses it; the system does all of that.
 *
 * The owner has to allow it once: Settings → Notifications → Bubbles, and
 * either "All conversations" or this conversation. canBubble() says which.
 */
object Bubble {
    const val CHANNEL = "kacey_bubble"
    const val SHORTCUT = "kacey"
    private const val NOTIFICATION = 1

    fun createChannel(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val ch = NotificationChannel(CHANNEL, ctx.getString(R.string.channel_name), NotificationManager.IMPORTANCE_HIGH).apply {
            description = ctx.getString(R.string.channel_desc)
            setAllowBubbles(true)
            setSound(null, null)
            enableVibration(false)
            setShowBadge(false)
        }
        nm.createNotificationChannel(ch)
    }

    /* An adaptive bitmap, not the vector resource: the bubble crops it to a
       circle edge to edge, where a plain resource icon sits on a white disc. */
    private fun icon(ctx: Context): IconCompat {
        val px = (108 * ctx.resources.displayMetrics.density).toInt()
        val bmp = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        ctx.getDrawable(R.drawable.ic_kacey)!!.apply { setBounds(0, 0, px, px); draw(Canvas(bmp)) }
        return IconCompat.createWithAdaptiveBitmap(bmp)
    }

    private fun kacey(ctx: Context) = Person.Builder()
        // Not setBot(true): Android does not count a bot-only thread as a conversation, and only a conversation may bubble.
        .setName("Kacey").setIcon(icon(ctx)).setImportant(true).setKey("kacey").build()

    /** The conversation the bubble belongs to. Must exist before the notification. */
    private fun pushShortcut(ctx: Context) {
        val shortcut = ShortcutInfoCompat.Builder(ctx, SHORTCUT)
            .setShortLabel("Kacey")
            .setLongLabel("Kacey")
            .setIcon(icon(ctx))
            .setLongLived(true)
            .setPerson(kacey(ctx))
            .setLocusId(LocusIdCompat(SHORTCUT))
            // What the bubble opens: a bubble built from this shortcut launches its intent.
            .setIntent(Intent(ctx, BubbleActivity::class.java).setAction(Intent.ACTION_VIEW))
            .build()
        ShortcutManagerCompat.pushDynamicShortcut(ctx, shortcut)
    }

    /** Whether a bubble would actually show, rather than a plain notification. */
    fun canBubble(ctx: Context): Boolean {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (!nm.areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT >= 31) {
            when (nm.bubblePreference) {
                NotificationManager.BUBBLE_PREFERENCE_ALL -> return true
                NotificationManager.BUBBLE_PREFERENCE_NONE -> return false
            }
        } else {
            @Suppress("DEPRECATION")
            if (!nm.areBubblesAllowed()) return false
        }
        // "Selected conversations": this one has to be switched on.
        val conv = nm.getNotificationChannel(CHANNEL, SHORTCUT) ?: nm.getNotificationChannel(CHANNEL)
        return conv?.canBubble() == true
    }

    /** Is the bubble on screen now (collapsed or expanded)? */
    fun isShowing(ctx: Context): Boolean {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        return nm.activeNotifications.any { it.id == NOTIFICATION }
    }

    /**
     * Post (or refresh) the bubble. `expand` opens it at once — Android only
     * honours that while this app is in the foreground, which is the case from
     * MainActivity and from ShareActivity.
     */
    fun show(ctx: Context, expand: Boolean = false) {
        ctx.bubbleWanted = true
        createChannel(ctx)
        pushShortcut(ctx)

        // Tapping the card (when bubbles are off, the card is all there is) opens Kacey full screen.
        val pi = PendingIntent.getActivity(
            ctx, 0, Intent(ctx, KaceyActivity::class.java).setAction(Intent.ACTION_VIEW),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val bubbles = canBubble(ctx)
        /* Built from the shortcut, not from a PendingIntent: the form Android
           asks for now, and the one that also works on Android 16+, where a
           PendingIntent bubble with a resource icon is refused. */
        val meta = NotificationCompat.BubbleMetadata.Builder(SHORTCUT)
            .setDesiredHeight(640)
            .setAutoExpandBubble(expand)
            // Only the bubble, no card in the shade — unless bubbles are off,
            // when the card (with its bubble button) is the only way in.
            .setSuppressNotification(bubbles)
            .build()

        val me = Person.Builder().setName("Já").setKey("me").build()
        val style = NotificationCompat.MessagingStyle(me)
            .addMessage(ctx.getString(R.string.bubble_text), System.currentTimeMillis(), kacey(ctx))

        val n = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Kacey")
            .setContentText(ctx.getString(R.string.bubble_text))
            .setContentIntent(pi)
            .setShortcutId(SHORTCUT)
            .setLocusId(LocusIdCompat(SHORTCUT))
            .addPerson(kacey(ctx))
            .setStyle(style)
            .setBubbleMetadata(meta)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .build()

        try {
            NotificationManagerCompat.from(ctx).notify(NOTIFICATION, n)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS not granted; MainActivity asks for it.
        }
    }

    fun hide(ctx: Context) {
        ctx.bubbleWanted = false
        NotificationManagerCompat.from(ctx).cancel(NOTIFICATION)
    }
}
