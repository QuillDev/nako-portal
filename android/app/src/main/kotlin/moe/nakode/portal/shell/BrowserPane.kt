package moe.nakode.portal.shell

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.Uri
import android.os.Message
import android.text.InputType
import android.text.TextUtils
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.DrawableRes
import androidx.core.content.edit
import androidx.core.graphics.toColorInt
import moe.nakode.portal.R
import kotlin.math.roundToInt

/**
 * The in-app browser on a wide screen: a toolbar over a page, in a column beside the chat.
 * [split] is the horizontal row the chat's WebView sits in; the pane joins it while open.
 *
 * Every chat has a browser of its own with tabs ([BrowserTabs]). Each tab is a WebView; only the
 * one on screen is attached and running, the rest are paused, and chats left a while ago are
 * unloaded down to their addresses.
 */
class BrowserPane(
    private val context: Context,
    private val split: LinearLayout,
    private val server: ServerOrigin,
    /** Where the divider was last dragged to, kept across launches. */
    private val preferences: SharedPreferences,
    /** Portal links clicked in the pane go back to the chat. */
    private val openInPortal: (String) -> Unit,
    /** Links that aren't web pages, and the toolbar's "open in browser". */
    private val openExternally: (Uri) -> Unit,
    /** Told whenever the browser opens or closes, for the portal's browser button. */
    private val changed: () -> Unit,
) {
    private val tabs = BrowserTabs()
    private val pages = HashMap<Long, WebView>()
    /** The tab last put on screen. */
    private var visible: Long? = null
    private var chrome: Chrome? = null

    /** Drawn light or dark to match the portal beside it; the activity asks the portal before each change. */
    var light = false

    /** The search engine picked in the portal's Settings. */
    var engine: String? = null

    val isOpen: Boolean get() = chrome?.edge?.parent != null

    /** The page showing, so a fold can hand it to a Custom Tab. */
    val currentUrl: String? get() = visiblePage()?.url?.takeUnless { it.startsWith("about:") }

    private fun visiblePage(): WebView? = visible?.let(pages::get)

    /** The portal moved to another chat (or off chats): the browser beside it follows. */
    fun chat(id: String?) {
        if (tabs.switch(id)) sync()
    }

    /** A link clicked in the chat: a new tab in this chat's browser, or the tab already showing it. */
    fun open(url: String) {
        tabs.openLink(url)
        sync()
    }

    /** The chat header's browser button. */
    fun toggle() {
        tabs.toggle()
        sync()
        focusAddressIfBlank()
    }

    /** Puts the browser away; its tabs stay for when it comes back. */
    fun close() {
        tabs.hide()
        sync()
    }

    /** Drops every page, for when the activity or the chat's WebView goes. */
    fun destroy() {
        chrome?.edge?.let(split::removeView)
        chrome = null
        pages.values.forEach(WebView::destroy)
        pages.clear()
        visible = null
    }

    fun pause() {
        visiblePage()?.onPause()
    }

    fun resume() {
        visiblePage()?.onResume()
    }

    /** Back inside the pane; false when it has nowhere left to go. */
    fun goBack(): Boolean {
        val web = visiblePage() ?: return false
        if (!web.canGoBack()) return false
        web.goBack()
        return true
    }

    /** Re-measures the pane after the window changes size (a fold, a rotation, split screen). */
    fun resize(widthDp: Int) {
        val edge = chrome?.edge?.takeIf { it.parent != null } ?: return
        edge.layoutParams = LinearLayout.LayoutParams(dp(PaneLayout.paneWidthDp(widthDp, share)), ViewGroup.LayoutParams.MATCH_PARENT)
    }

    /** Builds, shows, pauses and drops WebViews to match the tabs. */
    private fun sync() {
        for (id in tabs.discard()) {
            pages.remove(id)?.let { page ->
                (page.parent as? ViewGroup)?.removeView(page)
                page.destroy()
            }
        }
        val shown = tabs.shown()?.takeIf { PaneLayout.fits(widthDp()) }
        val before = visible
        if (shown == null) {
            chrome?.edge?.let(split::removeView)
        } else {
            val chrome = chromeFor(light)
            if (chrome.edge.parent == null) {
                split.clipChildren = false
                split.addView(chrome.edge, LinearLayout.LayoutParams(dp(PaneLayout.paneWidthDp(widthDp(), share)), ViewGroup.LayoutParams.MATCH_PARENT))
            }
            val page = pages.getOrPut(shown.id) { page(shown) }
            shown.live = true
            if (page.parent !== chrome.holder) {
                chrome.holder.removeAllViews()
                (page.parent as? ViewGroup)?.removeView(page)
                chrome.holder.addView(page, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            }
            page.onResume()
        }
        visible = shown?.id
        // The page going out of sight stops: its videos pause and the WebView pauses.
        if (before != null && before != visible) pages[before]?.let(::suspend)
        report()
        changed()
    }

    private fun suspend(page: WebView) {
        page.evaluateJavascript("document.querySelectorAll('video, audio').forEach(m => m.pause())", null)
        page.onPause()
    }

    private fun focusAddressIfBlank() {
        val address = chrome?.address ?: return
        if (tabs.shown()?.url != null || !isOpen) return
        address.requestFocus()
        context.getSystemService(InputMethodManager::class.java)?.showSoftInput(address, InputMethodManager.SHOW_IMPLICIT)
    }

    /** The toolbar's address bar and the tab strip, for the tab on screen. */
    private fun report() {
        val chrome = chrome ?: return
        val shown = tabs.shown()
        if (!chrome.address.hasFocus()) chrome.address.setText(shown?.url?.let(::shortAddress).orEmpty())
        chrome.address.contentDescription = shown?.url ?: "Address or search"
        val strip = tabs.strip()
        chrome.strip.visibility = if (strip.size > 1) View.VISIBLE else View.GONE
        chrome.tabs.removeAllViews()
        for (tab in strip) chrome.tabs.addView(tabView(tab, tab.id == shown?.id, chrome.palette))
        // Keep the tab on screen in view, e.g. a new one past the right edge.
        val active = strip.indexOfFirst { it.id == shown?.id }
        if (active >= 0) {
            chrome.strip.post {
                val tab = chrome.tabs.getChildAt(active) ?: return@post
                val left = chrome.strip.scrollX
                if (tab.left < left || tab.right > left + chrome.strip.width) chrome.strip.smoothScrollTo(tab.right - chrome.strip.width.coerceAtMost(tab.right), 0)
            }
        }
    }

    private fun shortAddress(url: String): String {
        val uri = Uri.parse(url)
        val path = uri.encodedPath?.takeUnless { it == "/" }.orEmpty() + (uri.encodedQuery?.let { "?$it" } ?: "")
        return uri.host.orEmpty() + path
    }

    private var share: Float
        get() = preferences.getFloat(SHARE, PaneLayout.DEFAULT_SHARE)
        set(value) = preferences.edit { putFloat(SHARE, value) }

    /**
     * The line between the chat and the pane, with a grip to drag it sideways. The touch target is
     * wider than the line so it's easy to catch with a finger.
     */
    @SuppressLint("ClickableViewAccessibility")
    private fun divider(palette: Palette): View {
        val line = View(context).apply { setBackgroundColor(palette.border) }
        val grip = View(context).apply {
            background = GradientDrawable().apply {
                cornerRadius = dp(2).toFloat()
                setColor(palette.muted)
            }
            alpha = 0.6f
        }
        return FrameLayout(context).apply {
            setBackgroundColor(palette.background)
            contentDescription = "Drag to resize"
            addView(line, FrameLayout.LayoutParams(dp(1), ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER_HORIZONTAL))
            addView(grip, FrameLayout.LayoutParams(dp(4), dp(36), Gravity.CENTER))
            // Only the divider follows the finger; the chat and the page resize once, on release.
            // Resizing them on every move queues a reflow per step in each WebView, and those
            // keep playing out after the finger has lifted.
            setOnTouchListener { divider, event ->
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        grip.alpha = 1f
                        // Drawn over the page while it slides across it.
                        divider.translationZ = dp(4).toFloat()
                        parent.requestDisallowInterceptTouchEvent(true)
                    }
                    MotionEvent.ACTION_MOVE -> drag(event.rawX)?.let { (_, width) -> divider.translationX = (currentWidth() - width).toFloat() }
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                        grip.alpha = 0.6f
                        divider.translationX = 0f
                        divider.translationZ = 0f
                        drag(event.rawX)?.let { (dragged, width) ->
                            share = dragged
                            chrome?.edge?.layoutParams = LinearLayout.LayoutParams(width, ViewGroup.LayoutParams.MATCH_PARENT)
                        }
                    }
                }
                true
            }
        }
    }

    private fun currentWidth() = chrome?.edge?.width ?: 0

    /** Where the divider would leave the pane for a finger at [rawX]: its share and width in px. */
    private fun drag(rawX: Float): Pair<Float, Int>? {
        if (!isOpen) return null
        val origin = IntArray(2).also(split::getLocationOnScreen)
        val density = context.resources.displayMetrics.density
        val widthDp = (split.width / density).roundToInt()
        val paneDp = ((origin[0] + split.width - rawX) / density).roundToInt()
        val dragged = PaneLayout.shareFor(widthDp, paneDp)
        return dragged to dp(PaneLayout.paneWidthDp(widthDp, dragged))
    }

    /** The toolbar, tab strip and page holder; built again when the portal changes theme. */
    private class Chrome(val light: Boolean, val palette: Palette, val edge: LinearLayout, val holder: FrameLayout, val address: EditText, val strip: HorizontalScrollView, val tabs: LinearLayout)

    private fun chromeFor(light: Boolean): Chrome {
        chrome?.takeIf { it.light == light }?.let { return it }
        chrome?.let { old ->
            old.holder.removeAllViews()
            split.removeView(old.edge)
        }
        return buildChrome(light).also { chrome = it }
    }

    private fun buildChrome(light: Boolean): Chrome {
        val palette = Palette.of(light)
        val address = EditText(context).apply {
            setTextColor(palette.text)
            setHintTextColor(palette.muted)
            hint = "Search or enter address"
            textSize = 13f
            isSingleLine = true
            ellipsize = TextUtils.TruncateAt.END
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            setSelectAllOnFocus(true)
            background = GradientDrawable().apply { cornerRadius = dp(8).toFloat(); setColor(android.graphics.Color.TRANSPARENT) }
            setPadding(dp(8), 0, dp(8), 0)
            setOnFocusChangeListener { field, focused ->
                (field.background as GradientDrawable).setColor(if (focused) palette.hover else android.graphics.Color.TRANSPARENT)
                if (focused) (field as EditText).setText(tabs.shown()?.url.orEmpty()) else report()
            }
            setOnEditorActionListener { field, action, event ->
                val go = action == EditorInfo.IME_ACTION_GO || (event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN)
                if (go) {
                    Address.resolve(field.text.toString(), engine)?.let { url -> visiblePage()?.loadUrl(url) }
                    field.clearFocus()
                    context.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(field.windowToken, 0)
                }
                go
            }
        }
        val toolbar = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4), 0, dp(4), 0)
            setBackgroundColor(palette.background)
            addView(button(R.drawable.pane_back, "Back", palette) { visiblePage()?.takeIf { it.canGoBack() }?.goBack() })
            addView(button(R.drawable.pane_forward, "Forward", palette) { visiblePage()?.takeIf { it.canGoForward() }?.goForward() })
            addView(button(R.drawable.pane_reload, "Reload", palette) { visiblePage()?.reload() })
            addView(address, LinearLayout.LayoutParams(0, dp(36), 1f))
            addView(button(R.drawable.pane_new, "New tab", palette) {
                tabs.newTab()
                sync()
                focusAddressIfBlank()
            })
            addView(button(R.drawable.pane_external, "Open in browser", palette) { currentUrl?.let { openExternally(Uri.parse(it)) } })
            addView(button(R.drawable.pane_close, "Close browser", palette) { close() })
        }
        val tabRow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4), 0, dp(4), dp(4))
        }
        val strip = HorizontalScrollView(context).apply {
            isHorizontalScrollBarEnabled = false
            setBackgroundColor(palette.background)
            visibility = View.GONE
            addView(tabRow)
        }
        val holder = FrameLayout(context).apply { setBackgroundColor(palette.background) }
        // Toolbar and tabs over the page, a hairline under them and one between the chat and the pane.
        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(palette.background)
            addView(toolbar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)))
            addView(strip, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(40)))
            addView(View(context).apply { setBackgroundColor(palette.border) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)))
            addView(holder, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        val edge = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            // The divider slides past the pane's edge while it's dragged.
            clipChildren = false
            addView(divider(palette), LinearLayout.LayoutParams(dp(16), ViewGroup.LayoutParams.MATCH_PARENT))
            addView(column, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        }
        return Chrome(light, palette, edge, holder, address, strip, tabRow)
    }

    /** One tab in the strip: its name to switch to it, and a cross to close it. */
    private fun tabView(tab: BrowserTabs.Tab, current: Boolean, palette: Palette): View {
        val name = TextView(context).apply {
            text = tab.name
            setTextColor(if (current) palette.text else palette.muted)
            textSize = 13f
            isSingleLine = true
            ellipsize = TextUtils.TruncateAt.END
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), 0, dp(2), 0)
        }
        val shut = ImageButton(context).apply {
            setImageResource(R.drawable.pane_close)
            imageTintList = ColorStateList.valueOf(palette.muted)
            contentDescription = "Close ${tab.name}"
            background = null
            scaleX = 0.7f
            scaleY = 0.7f
            setOnClickListener {
                if (tabs.closeTab(tab.id)) {
                    pages.remove(tab.id)?.let { page ->
                        (page.parent as? ViewGroup)?.removeView(page)
                        page.destroy()
                    }
                    if (visible == tab.id) visible = null
                    sync()
                }
            }
        }
        return LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            contentDescription = tab.name
            background = GradientDrawable().apply {
                cornerRadius = dp(8).toFloat()
                setColor(if (current) palette.hover else android.graphics.Color.TRANSPARENT)
            }
            setOnClickListener {
                tabs.select(tab.id)
                sync()
            }
            addView(name, LinearLayout.LayoutParams(dp(120), ViewGroup.LayoutParams.MATCH_PARENT))
            addView(shut, LinearLayout.LayoutParams(dp(28), dp(28)))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(32)).apply { marginEnd = dp(2) }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun page(tab: BrowserTabs.Tab): WebView = WebView(context).apply {
        setBackgroundColor(Palette.of(light).background)
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        // Pages that open a window (target=_blank, window.open) get a new tab.
        settings.setSupportMultipleWindows(true)
        webViewClient = PaneClient(tab.id)
        webChromeClient = PaneChrome(tab.id)
        loadUrl(tab.url ?: "about:blank")
    }

    /** Keeps a tab's address and title as its page moves on, for the strip and for reloading it after it was unloaded. */
    private fun remember(id: Long, url: String?, title: String?) {
        val tab = tabs.tab(id) ?: return
        // A new tab's blank page has no address worth keeping, and its title is just "about:blank".
        if (url == null || url.startsWith("about:")) return
        if (url != tab.url && title == null) tab.title = null
        tab.url = url
        if (title != null) tab.title = title
        report()
    }

    private fun button(@DrawableRes icon: Int, label: String, palette: Palette, action: () -> Unit) = ImageButton(context).apply {
        setImageResource(icon)
        imageTintList = ColorStateList.valueOf(palette.muted)
        contentDescription = label
        tooltipText = label
        background = RippleDrawable(ColorStateList.valueOf(palette.hover), null, GradientDrawable().apply { cornerRadius = dp(8).toFloat(); setColor(palette.text) })
        setOnClickListener { action() }
        layoutParams = LinearLayout.LayoutParams(dp(38), dp(40))
    }

    private inner class PaneClient(private val id: Long) : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val link = request.url.toString()
            return when {
                server.opensInApp(link) -> {
                    openInPortal(link)
                    true
                }
                PaneLayout.browsesInPane(link) -> false
                else -> {
                    openExternally(request.url)
                    true
                }
            }
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) = remember(id, url, null)

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) = remember(id, url, null)

        // A crashed page closes its tab rather than the app.
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (pages[id] === view) {
                pages.remove(id)
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
                tabs.tab(id)?.live = false
                if (visible == id) visible = null
                sync()
            }
            return true
        }
    }

    private inner class PaneChrome(private val id: Long) : WebChromeClient() {
        override fun onReceivedTitle(view: WebView, title: String?) = remember(id, view.url, title.orEmpty())

        // A page asking for a new window: a throwaway WebView catches where it goes, and that opens as a tab.
        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            if (!isUserGesture) return false
            val catcher = WebView(context)
            catcher.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    caught(view, request.url.toString())
                    return true
                }

                override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) = caught(view, url)
            }
            (resultMsg.obj as WebView.WebViewTransport).webView = catcher
            resultMsg.sendToTarget()
            return true
        }

        private fun caught(catcher: WebView, url: String) {
            catcher.stopLoading()
            catcher.post { catcher.destroy() }
            when {
                server.opensInApp(url) -> openInPortal(url)
                PaneLayout.browsesInPane(url) -> open(url)
                else -> openExternally(Uri.parse(url))
            }
        }
    }

    private fun widthDp() = context.resources.configuration.screenWidthDp

    private companion object {
        const val SHARE = "pane_share"
    }

    private fun dp(value: Int) = (value * context.resources.displayMetrics.density).toInt()

    /** The portal's own colors, light or dark. */
    private class Palette(val background: Int, val text: Int, val muted: Int, val hover: Int, val border: Int) {
        companion object {
            fun of(light: Boolean): Palette {
                return if (!light) {
                    Palette("#09090B".toColorInt(), "#ECECEF".toColorInt(), "#8E8E99".toColorInt(), "#26262C".toColorInt(), "#1A1A1D".toColorInt())
                } else {
                    Palette("#FBFBFC".toColorInt(), "#18181B".toColorInt(), "#6B6B76".toColorInt(), "#DCDCE0".toColorInt(), "#E7E7EA".toColorInt())
                }
            }
        }
    }
}
