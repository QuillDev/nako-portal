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

    /** The pane's width for a window [widthDp] wide: 45%, leaving the chat at least 360dp. */
    fun paneWidthDp(widthDp: Int): Int = (widthDp * 0.45).roundToInt().coerceIn(320, (widthDp - 360).coerceAtLeast(320))

    /** Web pages browse on in the pane; anything else (mailto:, app links) goes to the system. */
    fun browsesInPane(link: String): Boolean {
        val scheme = link.substringBefore(':', "").lowercase()
        return scheme == "http" || scheme == "https"
    }
}
