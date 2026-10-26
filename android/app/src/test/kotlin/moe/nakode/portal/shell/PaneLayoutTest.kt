package moe.nakode.portal.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PaneLayoutTest {
    @Test
    fun onlyWideScreensGetThePane() {
        assertFalse("a phone", PaneLayout.fits(411))
        assertFalse("a small tablet in portrait", PaneLayout.fits(600))
        assertTrue("a foldable's inner screen", PaneLayout.fits(720))
        assertTrue("a tablet in landscape", PaneLayout.fits(1280))
    }

    @Test
    fun thePaneLeavesTheChatUsable() {
        for (width in listOf(720, 800, 900, 1280, 1920)) {
            val pane = PaneLayout.paneWidthDp(width)
            assertTrue("$width: pane $pane", pane >= 320)
            assertTrue("$width: chat ${width - pane}", width - pane >= 360)
        }
        assertEquals(576, PaneLayout.paneWidthDp(1280))
    }

    @Test
    fun onlyWebPagesBrowseInThePane() {
        assertTrue(PaneLayout.browsesInPane("https://example.com/docs"))
        assertTrue(PaneLayout.browsesInPane("HTTP://example.com"))
        assertFalse(PaneLayout.browsesInPane("mailto:someone@example.com"))
        assertFalse(PaneLayout.browsesInPane("intent://scan/#Intent;scheme=zxing;end"))
        assertFalse(PaneLayout.browsesInPane("javascript:alert(1)"))
    }
}
