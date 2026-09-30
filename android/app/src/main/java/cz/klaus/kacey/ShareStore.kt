package cz.klaus.kacey

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * One share on its way to the page — a screenshot and whatever text came
 * with it. Held in memory until the page takes it (window.KaceyNative
 * .takeShare(), public/js/ui/share.js); taking it empties the slot, so the
 * same image is never attached twice.
 *
 * Images are shrunk here to what the web composer would shrink them to
 * (1568px on the long edge, PNG — text in a screenshot survives PNG, not
 * JPEG), so a 3 MB screenshot does not cross the JavaScript bridge whole.
 */
object ShareStore {
    private const val MAX_EDGE = 1568
    private const val MAX_IMAGES = 4

    @Volatile private var pending: String? = null

    /** When BubbleActivity last came to the front; ShareActivity stops waiting once it has. */
    @Volatile var bubbleResumedAt: Long = 0L

    fun put(json: String) { pending = json }
    fun take(): String? { val p = pending; pending = null; return p }
    fun hasPending(): Boolean = pending != null

    /** Reads a SEND / SEND_MULTIPLE intent into the page's JSON shape. Slow: call off the main thread. */
    fun fromIntent(ctx: Context, intent: Intent): String? {
        val uris = mutableListOf<Uri>()
        when (intent.action) {
            Intent.ACTION_SEND -> intent.streamUri()?.let { uris += it }
            Intent.ACTION_SEND_MULTIPLE -> uris += intent.streamUris()
            else -> return null
        }
        val text = listOfNotNull(
            intent.getStringExtra(Intent.EXTRA_SUBJECT),
            intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString(),
        ).filter { it.isNotBlank() }.distinct().joinToString(" ")

        val images = JSONArray()
        uris.take(MAX_IMAGES).forEachIndexed { i, uri ->
            val data = encode(ctx, uri) ?: return@forEachIndexed
            images.put(JSONObject().put("name", "sdileny-${i + 1}.png").put("media_type", "image/png").put("data", data))
        }
        if (text.isEmpty() && images.length() == 0) return null
        return JSONObject().put("text", text).put("images", images).toString()
    }

    private fun encode(ctx: Context, uri: Uri): String? = try {
        val src = ImageDecoder.createSource(ctx.contentResolver, uri)
        val bmp = ImageDecoder.decodeBitmap(src) { decoder, info, _ ->
            val edge = max(info.size.width, info.size.height)
            if (edge > MAX_EDGE) {
                val s = MAX_EDGE.toFloat() / edge
                decoder.setTargetSize((info.size.width * s).roundToInt(), (info.size.height * s).roundToInt())
            }
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
        Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    } catch (e: Exception) {
        android.util.Log.w("KaceyShare", "decode $uri failed", e)
        // Not an image we can read (or a revoked grant): try the raw bytes as a last resort.
        try {
            ctx.contentResolver.openInputStream(uri)?.use { s ->
                BitmapFactory.decodeStream(s)?.let { b ->
                    val out = ByteArrayOutputStream()
                    b.compress(Bitmap.CompressFormat.PNG, 100, out)
                    Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                }
            }
        } catch (e: Exception) { android.util.Log.w("KaceyShare", "read $uri failed", e); null }
    }

    @Suppress("DEPRECATION")
    private fun Intent.streamUri(): Uri? =
        if (android.os.Build.VERSION.SDK_INT >= 33) getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else getParcelableExtra(Intent.EXTRA_STREAM)

    @Suppress("DEPRECATION")
    private fun Intent.streamUris(): List<Uri> =
        (if (android.os.Build.VERSION.SDK_INT >= 33) getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
         else getParcelableArrayListExtra(Intent.EXTRA_STREAM)) ?: emptyList()
}
