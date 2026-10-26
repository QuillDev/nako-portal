package moe.nakode.portal.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowserTabsTest {
    @Test
    fun eachChatHasItsOwnBrowser() {
        val tabs = BrowserTabs()
        tabs.switch("a")
        val a = tabs.openLink("https://one.example/")
        tabs.switch("b")
        assertNull("b has opened nothing", tabs.shown())
        val b = tabs.openLink("https://two.example/")
        assertNotEquals(a, b)
        tabs.switch("a")
        assertEquals("a gets its own tab back, not b's", a, tabs.shown()?.id)
        assertEquals(1, tabs.strip().size)
    }

    @Test
    fun linksOpenNewTabsAndReuseOneAlreadyShowingThePage() {
        val tabs = BrowserTabs()
        tabs.switch("a")
        val one = tabs.openLink("https://one.example/")
        val two = tabs.openLink("https://two.example/")
        assertEquals(2, tabs.strip().size)
        assertEquals(two, tabs.shown()?.id)
        assertEquals(one, tabs.openLink("https://one.example/"))
        assertEquals("no duplicate tab", 2, tabs.strip().size)
        assertEquals(one, tabs.shown()?.id)
    }

    @Test
    fun closingTabsMovesToANeighbourAndTheLastOneClosesTheBrowser() {
        val tabs = BrowserTabs()
        tabs.switch("a")
        val one = tabs.openLink("https://one.example/")
        val two = tabs.newTab()
        val three = tabs.newTab()
        tabs.select(two)
        assertTrue(tabs.closeTab(two))
        assertEquals(three, tabs.shown()?.id)
        assertTrue(tabs.closeTab(three))
        assertEquals(one, tabs.shown()?.id)
        assertTrue(tabs.closeTab(one))
        assertNull(tabs.shown())
    }

    @Test
    fun theBrowserButtonHidesAndBringsBackTheSameTabs() {
        val tabs = BrowserTabs()
        tabs.switch("a")
        tabs.toggle()
        val blank = tabs.shown()!!
        assertNull(blank.url)
        assertEquals("New tab", blank.name)
        tabs.toggle()
        assertNull(tabs.shown())
        tabs.toggle()
        assertEquals("same tab, no second blank one", blank.id, tabs.shown()?.id)
        assertEquals(1, tabs.strip().size)
    }

    @Test
    fun aChatLeftWithItsBrowserClosedStaysClosed() {
        val tabs = BrowserTabs()
        tabs.switch("a")
        tabs.openLink("https://one.example/")
        tabs.hide()
        tabs.switch("b")
        tabs.switch("a")
        assertNull(tabs.shown())
        assertEquals("tabs kept", 1, tabs.strip().size)
    }

    @Test
    fun onlyRecentChatsKeepTheirPagesLoaded() {
        val tabs = BrowserTabs()
        val ids = listOf("a", "b", "c", "d").map { name ->
            tabs.switch(name)
            tabs.openLink("https://$name.example/").also { tabs.tab(it)!!.live = true }
        }
        assertEquals("a is the oldest", listOf(ids[0]), tabs.discard())
        assertEquals("already unloaded", emptyList<Long>(), tabs.discard())
        tabs.switch("a")
        val back = tabs.shown()!!
        assertFalse("a's page loads again", back.live)
        assertEquals("https://a.example/", back.url)
    }

    @Test
    fun theChatOnScreenIsNeverUnloaded() {
        val tabs = BrowserTabs()
        tabs.switch("a")
        tabs.tab(tabs.openLink("https://a.example/"))!!.live = true
        assertTrue(tabs.discard(0).isEmpty())
    }

    @Test
    fun tabsAreNamedByTitleThenHost() {
        val tab = BrowserTabs.Tab(1, "https://docs.example/a", "  ")
        assertEquals("docs.example", tab.name)
        tab.title = "Docs"
        assertEquals("Docs", tab.name)
    }

    @Test
    fun theAddressBarTakesAddressesWithOrWithoutAScheme() {
        assertEquals("https://github.com/QuillDev", Address.resolve("https://github.com/QuillDev", null))
        assertEquals("https://example.com/a?b=1", Address.resolve("  example.com/a?b=1 ", null))
        assertEquals("https://localhost:3000", Address.resolve("localhost:3000", null))
        assertNull(Address.resolve("  ", null))
    }

    @Test
    fun anythingElseIsASearchWithThePickedEngine() {
        assertEquals("https://www.google.com/search?q=nako+app", Address.resolve("nako app", null))
        assertEquals("https://duckduckgo.com/?q=tauri", Address.resolve("tauri", "duckduckgo"))
        assertEquals("https://www.google.com/search?q=javascript%3Aalert%281%29", Address.resolve("javascript:alert(1)", "https://evil.example/?q="))
    }
}
