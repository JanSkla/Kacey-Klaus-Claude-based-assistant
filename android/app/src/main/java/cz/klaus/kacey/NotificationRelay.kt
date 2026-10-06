package cz.klaus.kacey

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Copies every notification the phone shows to Kacey (POST /api/notify on
 * kaceybody, notifications.js there).
 *
 * This is the same mechanism a smartwatch uses: the apps receive their own
 * notifications as always, and this only reads the shade. Nothing here talks
 * to Instagram or any other app's servers, so there is nothing for an
 * anti-automation system to see — unlike a bridge that logs into the account
 * from somewhere else.
 *
 * It never dismisses anything: the phone looks exactly as it would without
 * Kacey. An app whose notifications are switched OFF in Android posts nothing,
 * so nothing reaches here either; to get Instagram's DMs without the buzz, set
 * its message channel to Silent instead (README, "Notifications").
 *
 * Android binds and keeps the service itself once the owner grants
 * notification access; there is no foreground service and no notification of
 * its own.
 */
class NotificationRelayService : NotificationListenerService() {

    override fun onListenerConnected() {
        /* Whatever is in the shade now, in case some of it arrived while the
           listener was down. The server drops what it already has. */
        val active = try { activeNotifications } catch (e: SecurityException) { null } ?: return
        Relay.enqueue(this, active.flatMap { Relay.itemsOf(this, it) }, emptyList())
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val items = Relay.itemsOf(this, sbn)
        if (items.isNotEmpty()) Relay.enqueue(this, items, emptyList())
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification, rankingMap: RankingMap, reason: Int) {
        // Only for the kind that was relayed: the server marks those rows "gone
        // from the phone" (read in the app, swiped away).
        if (!Relay.relayable(this, sbn)) return
        val removal = JSONObject().put("key", sbn.key).put("reason", reason).put("at", System.currentTimeMillis())
        Relay.enqueue(this, emptyList(), listOf(removal))
    }
}

/**
 * The queue between the listener and kaceybody. A file, one JSON line per
 * item, so a notification that arrives while the phone is off the tailnet is
 * sent when it is back — and survives the process being killed in between.
 */
object Relay {
    private const val TAG = "KaceyRelay"
    private const val QUEUE = "relay-queue.jsonl"
    private const val MAX_QUEUE = 3000
    private const val BATCH = 200
    /* A messaging notification repeats the recent conversation; the newest
       few are enough, the server already has the rest. */
    private const val MAX_MESSAGES = 25

    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()
    private var backoffMs = 0L
    private var retryPending = false

    /** Has the owner granted notification access? */
    fun granted(ctx: Context): Boolean =
        NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName)

    fun component(ctx: Context) = ComponentName(ctx, NotificationRelayService::class.java)

    /* Ongoing ones are state, not news: music, navigation, downloads, a
       running service. A group summary repeats its children. Kacey's own
       bubble is not worth telling Kacey about. */
    fun relayable(ctx: Context, sbn: StatusBarNotification): Boolean {
        if (sbn.packageName == ctx.packageName) return false
        if (sbn.isOngoing) return false
        if (sbn.notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return false
        return true
    }

    /** One notification as the server's items: one per message for a messaging app. */
    fun itemsOf(ctx: Context, sbn: StatusBarNotification): List<JSONObject> {
        if (!relayable(ctx, sbn)) return emptyList()
        val n = sbn.notification
        fun base() = JSONObject()
            .put("key", sbn.key)
            .put("package", sbn.packageName)
            .put("app", label(ctx, sbn.packageName))
            .put("channel", n.channelId)
            .put("category", n.category)
            .put("secret", n.visibility == Notification.VISIBILITY_SECRET)

        val style = try { NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n) } catch (e: RuntimeException) { null }
        if (style != null && style.messages.isNotEmpty()) {
            val me = style.user.name?.toString() ?: "Já"
            /* A group has a title; a one-to-one chat often has none, and is
               named after the other person — never after "me", or a reply
               from the shade would start a thread of its own. */
            val conversation = style.conversationTitle?.toString()
                ?: style.messages.lastOrNull { it.person != null }?.person?.name?.toString()
                ?: n.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
            return style.messages.takeLast(MAX_MESSAGES).mapNotNull { m ->
                val text = m.text?.toString()?.takeIf { it.isNotBlank() }
                    ?: if (m.dataMimeType?.startsWith("image/") == true) "[obrázek]" else return@mapNotNull null
                // No person = the phone's owner wrote it (a reply from the shade).
                val sender = m.person?.name?.toString() ?: me
                base()
                    .put("posted_at", if (m.timestamp > 0) m.timestamp else sbn.postTime)
                    .put("title", conversation ?: sender)
                    .put("text", text)
                    .put("sender", sender)
                    .put("conversation", conversation)
                    .put("group", style.isGroupConversation)
                    .put("message", true)
            }
        }

        val x = n.extras
        val title = (x.getCharSequence(Notification.EXTRA_TITLE_BIG) ?: x.getCharSequence(Notification.EXTRA_TITLE))?.toString()
        val lines = x.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)?.joinToString("\n")
        val text = (x.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString() ?: lines ?: x.getCharSequence(Notification.EXTRA_TEXT)?.toString())
        if (title.isNullOrBlank() && text.isNullOrBlank()) return emptyList()
        return listOf(
            base()
                .put("posted_at", sbn.postTime)
                .put("title", title)
                .put("text", text)
                .put("sub_text", x.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString()),
        )
    }

    private val labels = HashMap<String, String>()
    private fun label(ctx: Context, pkg: String): String = labels.getOrPut(pkg) {
        try {
            val pm = ctx.packageManager
            pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
        } catch (e: Exception) { pkg }
    }

    /* ---- the queue ------------------------------------------------------- */

    fun enqueue(ctx: Context, items: List<JSONObject>, removed: List<JSONObject>) {
        if (items.isEmpty() && removed.isEmpty()) return
        val app = ctx.applicationContext
        io.execute {
            synchronized(lock) {
                val f = File(app.filesDir, QUEUE)
                f.appendText(buildString {
                    for (i in items) append(JSONObject().put("t", "i").put("v", i)).append('\n')
                    for (r in removed) append(JSONObject().put("t", "r").put("v", r)).append('\n')
                })
                trim(f)
            }
            flushNow(app)
        }
    }

    /** Send what is waiting, now (the launcher's "Odeslat", a new notification). */
    fun flush(ctx: Context) {
        val app = ctx.applicationContext
        io.execute { flushNow(app) }
    }

    fun pending(ctx: Context): Int = synchronized(lock) {
        File(ctx.filesDir, QUEUE).takeIf { it.exists() }?.useLines { it.count() } ?: 0
    }

    /* The oldest go first when the phone has been offline for a long time:
       what matters is what came last. */
    private fun trim(f: File) {
        val lines = f.readLines()
        if (lines.size > MAX_QUEUE) f.writeText(lines.takeLast(MAX_QUEUE).joinToString("\n", postfix = "\n"))
    }

    private fun flushNow(ctx: Context) {
        while (true) {
            val batch = synchronized(lock) {
                val f = File(ctx.filesDir, QUEUE)
                if (!f.exists()) return
                f.useLines { it.take(BATCH).toList() }
            }
            if (batch.isEmpty()) { backoffMs = 0; return }

            val items = JSONArray()
            val removed = JSONArray()
            for (line in batch) {
                val o = try { JSONObject(line) } catch (e: Exception) { continue }
                if (o.optString("t") == "r") removed.put(o.getJSONObject("v")) else items.put(o.getJSONObject("v"))
            }
            val body = JSONObject().put("device", Build.MODEL).put("items", items).put("removed", removed)

            val code = try { post(Prefs.url(ctx) + "/api/notify", body.toString()) } catch (e: Exception) {
                Log.i(TAG, "kaceybody unreachable (${e.message}); ${batch.size}+ waiting")
                Prefs.noteRelay(ctx, ok = false, error = "nedostupná")
                retryLater(ctx)
                return
            }
            /* 404: a kaceybody that has not been restarted onto the relay yet.
               Worth waiting for — the copies are kept until it has the route. */
            if (code in 500..599 || code == 404) {
                Prefs.noteRelay(ctx, ok = false, error = if (code == 404) "server bez /api/notify" else "chyba serveru $code")
                retryLater(ctx)
                return
            }
            /* 2xx is stored; any other 4xx would be refused forever (a
               malformed item), so it is dropped rather than left to block
               the queue. */
            if (code !in 200..299) Log.w(TAG, "server refused ${batch.size} items ($code); dropped")
            Prefs.noteRelay(ctx, ok = code in 200..299, error = if (code in 200..299) null else "odmítnuto $code")
            synchronized(lock) {
                val f = File(ctx.filesDir, QUEUE)
                val rest = f.readLines().drop(batch.size)
                if (rest.isEmpty()) f.delete() else f.writeText(rest.joinToString("\n", postfix = "\n"))
            }
            backoffMs = 0
        }
    }

    /* 30 s, doubling to 15 min. Only while the process lives; a new
       notification or the listener reconnecting tries again anyway. */
    private fun retryLater(ctx: Context) {
        if (retryPending) return
        backoffMs = if (backoffMs == 0L) 30_000 else minOf(backoffMs * 2, 15 * 60_000)
        retryPending = true
        main.postDelayed({ retryPending = false; flush(ctx) }, backoffMs)
    }

    private fun post(url: String, json: String): Int {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = "POST"
            c.connectTimeout = 10_000
            c.readTimeout = 15_000
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            c.outputStream.use { it.write(json.toByteArray(Charsets.UTF_8)) }
            return c.responseCode
        } finally {
            c.disconnect()
        }
    }
}
