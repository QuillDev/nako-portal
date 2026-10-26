package moe.nakode.portal.shell

import kotlin.math.roundToInt

/**
 * Where the in-app browser goes. On a wide screen (a foldable's inner screen, a tablet) links
 * open in a pane beside the chat; narrower screens keep using a Custom Tab.
 */
object PaneLayout {
    /** The narrowest window, in dp, that fits the chat and the pane side by side. */
    const val MIN_WIDTH_DP = 720

    fun fits(widthDp: Int): Boolean = widthDp >= MIN_WIDTH_DP

    /** How much of the window the pane takes until the user drags the divider. */
    const val DEFAULT_SHARE = 0.45f

    private const val MIN_PANE_DP = 320
    private const val MIN_CHAT_DP = 360

    /**
     * The pane's width for a window [widthDp] wide when it takes [share] of it, kept between 320dp
     * and whatever leaves the chat 360dp.
     */
    fun paneWidthDp(widthDp: Int, share: Float = DEFAULT_SHARE): Int =
        (widthDp * share.coerceIn(0f, 1f)).roundToInt().coerceIn(MIN_PANE_DP, (widthDp - MIN_CHAT_DP).coerceAtLeast(MIN_PANE_DP))

    /** The share to remember after dragging the divider to leave the pane [paneDp] of [widthDp]. */
    fun shareFor(widthDp: Int, paneDp: Int): Float = paneWidthDp(widthDp, paneDp.toFloat() / widthDp) / widthDp.toFloat()

    /** Web pages browse on in the pane; anything else (mailto:, app links) goes to the system. */
    fun browsesInPane(link: String): Boolean {
        val scheme = link.substringBefore(':', "").lowercase()
        return scheme == "http" || scheme == "https"
    }
}
