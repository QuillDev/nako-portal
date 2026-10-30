package moe.nakode.portal.bubble

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.hypot
import kotlin.math.roundToInt

/** Where the floating sticker rests and how it reacts to a drag. All sizes in pixels. */
object BubbleLayout {
    /** Where a released bubble settles: the nearer side edge, kept on screen vertically. */
    fun settle(x: Int, y: Int, size: Int, screenWidth: Int, screenHeight: Int): Rest {
        val left = x + size / 2 < screenWidth / 2
        return Rest(left, clampY(y, size, screenHeight))
    }

    fun clampY(y: Int, size: Int, screenHeight: Int): Int = y.coerceIn(0, maxOf(0, screenHeight - size))

    /** The bubble's x for a resting side. */
    fun edgeX(left: Boolean, size: Int, screenWidth: Int): Int = if (left) 0 else screenWidth - size

    /** Whether a bubble centred at ([x], [y]) is over the dismiss target centred at ([targetX], [targetY]). */
    fun overTarget(x: Float, y: Float, targetX: Float, targetY: Float, radius: Float): Boolean =
        hypot(x - targetX, y - targetY) <= radius

    /** A remembered height as a share of the screen, so the bubble keeps its place across fold and rotation. */
    fun share(y: Int, screenHeight: Int): Float = if (screenHeight <= 0) 0f else y.toFloat() / screenHeight

    fun fromShare(share: Float, size: Int, screenHeight: Int): Int = clampY((share * screenHeight).roundToInt(), size, screenHeight)

    /**
     * Where the open panel goes for a bubble resting at [y]: below her when she's in the top half,
     * above her in the bottom half, [gap] clear of her and the screen edge, at most [maxHeight] tall.
     */
    fun panel(y: Int, size: Int, screenHeight: Int, gap: Int, maxHeight: Int): Spot {
        val below = y + size / 2 < screenHeight / 2
        return if (below) {
            val top = y + size + gap
            Spot(top, minOf(maxHeight, screenHeight - top - gap))
        } else {
            val height = minOf(maxHeight, y - gap * 2)
            Spot(y - gap - height, height)
        }
    }

    /** The panel while the keyboard is up: its bottom edge on the keyboard, shorter if it must be. */
    fun aboveKeyboard(spot: Spot, keyboardTop: Int, gap: Int): Spot {
        val bottom = keyboardTop - gap
        if (spot.y + spot.height <= bottom) return spot
        val top = maxOf(gap, bottom - spot.height)
        return Spot(top, bottom - top)
    }

    data class Rest(val left: Boolean, val y: Int)

    data class Spot(val y: Int, val height: Int)
}

/** What the sticker shows: Nako working on something, waiting on you, or idle. */
enum class Mood { IDLE, WORKING, NEEDS_YOU }

/** Turn statuses per chat, from the portal's `{"kind":"status"}` frames. */
class Statuses {
    private val byChat = mutableMapOf<String, String>()

    /** Applies a socket frame; true when it was a status frame. */
    fun apply(frame: String): Boolean {
        val obj = runCatching { json.parseToJsonElement(frame) as? JsonObject }.getOrNull() ?: return false
        if (obj["kind"]?.jsonPrimitive?.contentOrNull != "status") return false
        val chat = obj["session"]?.jsonPrimitive?.contentOrNull ?: return false
        val status = obj["status"]?.jsonPrimitive?.contentOrNull ?: return false
        byChat[chat] = status
        return true
    }

    val mood: Mood
        get() = when {
            byChat.values.any { it == "needs you" } -> Mood.NEEDS_YOU
            byChat.values.any { it == "working" } -> Mood.WORKING
            else -> Mood.IDLE
        }

    private companion object {
        val json = Json { ignoreUnknownKeys = true }
    }
}
