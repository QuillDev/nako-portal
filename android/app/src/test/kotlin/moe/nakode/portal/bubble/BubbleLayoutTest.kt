package moe.nakode.portal.bubble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BubbleLayoutTest {
    @Test
    fun aReleasedBubbleSettlesOnTheNearerSide() {
        assertEquals(BubbleLayout.Rest(left = true, y = 400), BubbleLayout.settle(x = 300, y = 400, size = 160, screenWidth = 1080, screenHeight = 2200))
        assertEquals(BubbleLayout.Rest(left = false, y = 400), BubbleLayout.settle(x = 500, y = 400, size = 160, screenWidth = 1080, screenHeight = 2200))
        assertEquals(920, BubbleLayout.edgeX(left = false, size = 160, screenWidth = 1080))
    }

    @Test
    fun aBubbleDraggedOffScreenComesBackOnIt() {
        assertEquals(0, BubbleLayout.settle(x = 10, y = -300, size = 160, screenWidth = 1080, screenHeight = 2200).y)
        assertEquals(2040, BubbleLayout.settle(x = 10, y = 2500, size = 160, screenWidth = 1080, screenHeight = 2200).y)
    }

    @Test
    fun itKeepsItsHeightAcrossAFold() {
        // Half way down the cover screen is half way down the inner one.
        val share = BubbleLayout.share(1000, 2000)
        assertEquals(900, BubbleLayout.fromShare(share, size = 160, screenHeight = 1800))
    }

    @Test
    fun thePanelOpensFromWhereSheIs() {
        // Near the top: it hangs below her.
        assertEquals(BubbleLayout.Spot(y = 380, height = 1600), BubbleLayout.panel(y = 200, size = 160, screenHeight = 2200, gap = 20, maxHeight = 1600))
        // Near the bottom: it rises above her, its bottom edge just over her head.
        val above = BubbleLayout.panel(y = 1900, size = 160, screenHeight = 2200, gap = 20, maxHeight = 1600)
        assertEquals(1880, above.y + above.height)
        assertEquals(1600, above.height)
        // In the middle there's only half a screen either way: it shrinks rather than run off it.
        val middle = BubbleLayout.panel(y = 1100, size = 160, screenHeight = 2200, gap = 20, maxHeight = 1600)
        assertTrue(middle.y >= 20)
        assertEquals(1080, middle.y + middle.height)
    }

    @Test
    fun theKeyboardPushesThePanelUpThenShrinksIt() {
        val panel = BubbleLayout.Spot(y = 300, height = 1500)
        // Clear of the keyboard: unchanged.
        assertEquals(panel, BubbleLayout.aboveKeyboard(panel, keyboardTop = 1900, gap = 20))
        // Overlapping it: moved up so the composer sits on the keyboard.
        assertEquals(BubbleLayout.Spot(y = 80, height = 1500), BubbleLayout.aboveKeyboard(panel, keyboardTop = 1600, gap = 20))
        // No room to move: pinned to the top and shorter.
        assertEquals(BubbleLayout.Spot(y = 20, height = 1180), BubbleLayout.aboveKeyboard(panel, keyboardTop = 1220, gap = 20))
    }

    @Test
    fun droppingNearTheXPutsItAway() {
        assertTrue(BubbleLayout.overTarget(540f, 2000f, 560f, 2040f, radius = 72f))
        assertFalse(BubbleLayout.overTarget(540f, 1700f, 560f, 2040f, radius = 72f))
    }

    @Test
    fun theStickerShowsWhatNakoIsDoingAcrossChats() {
        val statuses = Statuses()
        assertEquals(Mood.IDLE, statuses.mood)
        assertTrue(statuses.apply("""{"kind":"status","session":"a","status":"working"}"""))
        assertEquals(Mood.WORKING, statuses.mood)
        statuses.apply("""{"kind":"status","session":"b","status":"needs you"}""")
        assertEquals(Mood.NEEDS_YOU, statuses.mood)
        statuses.apply("""{"kind":"status","session":"b","status":"working"}""")
        statuses.apply("""{"kind":"status","session":"a","status":"done"}""")
        assertEquals(Mood.WORKING, statuses.mood)
        statuses.apply("""{"kind":"status","session":"b","status":"done"}""")
        assertEquals(Mood.IDLE, statuses.mood)
    }

    @Test
    fun otherFramesLeaveTheMoodAlone() {
        val statuses = Statuses()
        assertFalse(statuses.apply("""{"kind":"alert","title":"t","session":"a"}"""))
        assertFalse(statuses.apply("not json"))
        assertEquals(Mood.IDLE, statuses.mood)
    }
}
