package moe.nakode.portal.shell

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.Uri
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
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
 * [split] is the horizontal row the chat's WebView sits in; the pane joins it on [open].
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
) {
    private var column: LinearLayout? = null
    private var page: WebView? = null
    private var address: TextView? = null
    private var light = false

    val isOpen: Boolean get() = column != null

    /** The page showing, so a fold can hand it to a Custom Tab. */
    val currentUrl: String? get() = page?.url

    /** Opens [url] in the pane, drawn [light] or dark to match the portal beside it. */
    fun open(url: String, light: Boolean) {
        if (page != null && light != this.light) close()
        this.light = light
        val web = page ?: build()
        web.loadUrl(url)
        show(url)
    }

    fun close() {
        val web = page
        column?.let(split::removeView)
        column = null
        page = null
        address = null
        web?.destroy()
    }

    /** Back inside the pane; false when it has nowhere left to go. */
    fun goBack(): Boolean {
        val web = page ?: return false
        if (!web.canGoBack()) return false
        web.goBack()
        return true
    }

    /** Re-measures the pane after the window changes size (a fold, a rotation, split screen). */
    fun resize(widthDp: Int) {
        val column = column ?: return
        column.layoutParams = LinearLayout.LayoutParams(dp(PaneLayout.paneWidthDp(widthDp, share)), ViewGroup.LayoutParams.MATCH_PARENT)
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
                            column?.layoutParams = LinearLayout.LayoutParams(width, ViewGroup.LayoutParams.MATCH_PARENT)
                        }
                    }
                }
                true
            }
        }
    }

    private fun currentWidth() = column?.width ?: 0

    /** Where the divider would leave the pane for a finger at [rawX]: its share and width in px. */
    private fun drag(rawX: Float): Pair<Float, Int>? {
        if (column == null) return null
        val origin = IntArray(2).also(split::getLocationOnScreen)
        val density = context.resources.displayMetrics.density
        val widthDp = (split.width / density).roundToInt()
        val paneDp = ((origin[0] + split.width - rawX) / density).roundToInt()
        val dragged = PaneLayout.shareFor(widthDp, paneDp)
        return dragged to dp(PaneLayout.paneWidthDp(widthDp, dragged))
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun build(): WebView {
        val palette = Palette.of(light)
        val web = WebView(context).apply {
            setBackgroundColor(palette.background)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webViewClient = PaneClient()
        }
        val text = TextView(context).apply {
            setTextColor(palette.muted)
            textSize = 13f
            isSingleLine = true
            ellipsize = TextUtils.TruncateAt.END
            setPadding(dp(8), 0, dp(8), 0)
        }
        val toolbar = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4), 0, dp(4), 0)
            setBackgroundColor(palette.background)
            addView(button(R.drawable.pane_back, "Back", palette) { page?.takeIf { it.canGoBack() }?.goBack() })
            addView(button(R.drawable.pane_forward, "Forward", palette) { page?.takeIf { it.canGoForward() }?.goForward() })
            addView(button(R.drawable.pane_reload, "Reload", palette) { page?.reload() })
            addView(text, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(button(R.drawable.pane_external, "Open in browser", palette) { page?.url?.let { openExternally(Uri.parse(it)) } })
            addView(button(R.drawable.pane_close, "Close browser", palette) { close() })
        }
        // Toolbar over the page, a hairline under the toolbar and one between the chat and the pane.
        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(palette.background)
            addView(toolbar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)))
            addView(View(context).apply { setBackgroundColor(palette.border) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)))
            addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        val edge = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            // The divider slides past the pane's edge while it's dragged.
            clipChildren = false
            addView(divider(palette), LinearLayout.LayoutParams(dp(16), ViewGroup.LayoutParams.MATCH_PARENT))
            addView(column, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        }
        split.clipChildren = false
        split.addView(edge, LinearLayout.LayoutParams(dp(PaneLayout.paneWidthDp(widthDp(), share)), ViewGroup.LayoutParams.MATCH_PARENT))
        this.column = edge
        this.page = web
        this.address = text
        return web
    }

    private fun show(url: String) {
        val uri = Uri.parse(url)
        val path = uri.encodedPath?.takeUnless { it == "/" }.orEmpty() + (uri.encodedQuery?.let { "?$it" } ?: "")
        address?.text = (uri.host.orEmpty() + path)
        address?.contentDescription = url
    }

    private fun button(@DrawableRes icon: Int, label: String, palette: Palette, action: () -> Unit) = ImageButton(context).apply {
        setImageResource(icon)
        imageTintList = ColorStateList.valueOf(palette.muted)
        contentDescription = label
        tooltipText = label
        background = RippleDrawable(ColorStateList.valueOf(palette.hover), null, GradientDrawable().apply { cornerRadius = dp(8).toFloat(); setColor(palette.text) })
        setOnClickListener { action() }
        layoutParams = LinearLayout.LayoutParams(dp(44), dp(40))
    }

    private inner class PaneClient : WebViewClient() {
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

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) = show(url)

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) = show(url)

        // A crashed page closes the pane rather than the app.
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view === page) close()
            return true
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
