package moe.nakode.portal.shell

import java.net.URI

/**
 * Which tabs the in-app browser holds for each chat, and which one is on screen. No WebViews
 * here: [BrowserPane] builds, shows, pauses and drops them to match. `null` is everything that
 * isn't a chat (the list, settings).
 */
class BrowserTabs {
    class Tab(val id: Long, var url: String?, var title: String? = null) {
        /** Whether a WebView holds this tab right now. */
        var live = false
        internal var used = 0L

        /** What the tab strip calls it: the page's title, else its host. */
        val name: String
            get() = title?.trim()?.takeIf { it.isNotEmpty() }
                ?: url?.let { runCatching { URI(it).host }.getOrNull() }
                ?: "New tab"
    }

    private class Chat {
        val tabs = mutableListOf<Tab>()
        var active = 0
        var open = false
        var used = 0L
    }

    private val chats = HashMap<String?, Chat>()
    private var current: String? = null
    private var next = 0L
    private var clock = 0L

    private fun chat(): Chat = chats.getOrPut(current) { Chat() }.also { it.used = ++clock }

    /** Moves to chat [to]; false when it's already the one on screen. */
    fun switch(to: String?): Boolean {
        if (to == current) return false
        current = to
        chat()
        return true
    }

    private fun push(url: String?): Long {
        val chat = chat()
        val tab = Tab(++next, url)
        tab.used = ++clock
        chat.tabs += tab
        chat.active = chat.tabs.lastIndex
        chat.open = true
        return tab.id
    }

    /** A link clicked in the chat: a new tab in this chat's browser, or the tab already showing it. */
    fun openLink(url: String): Long {
        val chat = chat()
        val i = chat.tabs.indexOfFirst { it.url == url }
        if (i < 0) return push(url)
        chat.active = i
        chat.tabs[i].used = ++clock
        chat.open = true
        return chat.tabs[i].id
    }

    fun newTab(): Long = push(null)

    fun select(id: Long) {
        val chat = chat()
        val i = chat.tabs.indexOfFirst { it.id == id }
        if (i >= 0) {
            chat.active = i
            chat.tabs[i].used = ++clock
        }
    }

    /** Closes tab [id] in the chat on screen; the browser closes with its last tab. */
    fun closeTab(id: Long): Boolean {
        val chat = chat()
        val i = chat.tabs.indexOfFirst { it.id == id }
        if (i < 0) return false
        chat.tabs.removeAt(i)
        if (i < chat.active || chat.active >= chat.tabs.size) chat.active = (chat.active - 1).coerceAtLeast(0)
        if (chat.tabs.isEmpty()) chat.open = false
        return true
    }

    /** The header's browser button: puts this chat's browser away, or brings it back (with a new tab when it has none). */
    fun toggle() {
        val chat = chat()
        if (chat.tabs.isEmpty()) newTab() else chat.open = !chat.open
    }

    /** Puts this chat's browser away, keeping its tabs. */
    fun hide() {
        chat().open = false
    }

    /** The tab on screen, if this chat's browser is open. */
    fun shown(): Tab? = chats[current]?.takeIf { it.open }?.let { it.tabs.getOrNull(it.active) }

    /** This chat's tabs, for the tab strip. */
    fun strip(): List<Tab> = chats[current]?.tabs.orEmpty()

    fun tab(id: Long): Tab? = chats.values.firstNotNullOfOrNull { chat -> chat.tabs.firstOrNull { it.id == id } }

    /**
     * Unloads the pages of every chat but the [keep] most recently used (the one on screen is
     * always kept), and bounds live tabs within those chats. URLs and titles remain available
     * for reloading evicted tabs. Returns the tabs whose WebViews should go.
     */
    fun discard(keep: Int = LIVE_CHATS, keepTabs: Int = LIVE_TABS): List<Long> {
        val loaded = chats.entries.filter { (_, chat) -> chat.tabs.any { it.live } }
            .sortedWith(compareBy<Map.Entry<String?, Chat>> { it.key != current }.thenByDescending { it.value.used })
        return loaded.flatMapIndexed { index, (_, chat) ->
            val live = chat.tabs.filter { it.live }
                .sortedWith(compareBy<Tab> { it.id != chat.tabs.getOrNull(chat.active)?.id }.thenByDescending { it.used })
            val discard = if (index >= keep.coerceAtLeast(1)) live else live.drop(keepTabs.coerceAtLeast(1))
            discard.onEach { it.live = false }.map { it.id }
        }
    }

    companion object {
        /** How many chats keep their pages loaded; older ones reload their tabs when you come back. */
        const val LIVE_CHATS = 3
        const val LIVE_TABS = 3
    }
}
