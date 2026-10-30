package moe.nakode.portal.bubble

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.ImageDecoder
import android.graphics.PixelFormat
import android.graphics.drawable.AnimatedImageDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import androidx.core.content.edit
import androidx.core.graphics.toColorInt
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import moe.nakode.portal.R
import moe.nakode.portal.shell.MainActivity
import moe.nakode.portal.shell.ServerOrigin
import kotlin.math.abs

/**
 * Nako's sticker floating over other apps. Drag it anywhere (it settles on the nearest side), drop it on
 * the x to put it away, tap it to open the portal in a panel over whatever you're doing: switch chats or
 * answer one without leaving the app you're in. It shows only while the Nako app itself is out of sight.
 */
class Bubble(private val context: Context, private val origin: ServerOrigin) {
    private val windows = context.getSystemService(WindowManager::class.java)
    private val prefs = context.getSharedPreferences("shell", Context.MODE_PRIVATE)
    private val density = context.resources.displayMetrics.density
    private val size = dp(64)
    private val sticker = ImageView(context).apply { contentDescription = "Nako" }
    private val dot = View(context).apply {
        background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(PINK)
            setStroke(dp(2), BACKGROUND)
        }
        visibility = View.GONE
    }
    private val head = FrameLayout(context).apply {
        addView(sticker, FrameLayout.LayoutParams(size, size))
        addView(dot, FrameLayout.LayoutParams(dp(14), dp(14), Gravity.TOP or Gravity.END).apply { setMargins(0, dp(4), dp(4), 0) })
    }
    private val headParams = overlay(size, size, focusable = false)
    private val target = ImageView(context).apply {
        setImageResource(R.drawable.pane_close)
        scaleType = ImageView.ScaleType.CENTER
        background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(BACKGROUND)
            setStroke(dp(1), BORDER)
        }
        contentDescription = "Put Nako away"
    }
    private val targetParams = overlay(dp(56), dp(56), focusable = false).apply {
        gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
        y = dp(48)
    }
    private var panel: Panel? = null
    private var shown = false
    private var targetShown = false
    private var mood = Mood.IDLE
    private var unreadChat: String? = null
    private var animator: ValueAnimator? = null

    init {
        head.setOnTouchListener(Drag())
        showMood(Mood.IDLE)
    }

    val isShown get() = shown

    fun show() {
        if (shown || !canDraw(context)) return
        val screen = screen()
        val left = prefs.getBoolean(KEY_LEFT, false)
        headParams.x = BubbleLayout.edgeX(left, size, screen.first)
        headParams.y = BubbleLayout.fromShare(prefs.getFloat(KEY_Y, 0.3f), size, screen.second)
        runCatching { windows.addView(head, headParams) }.onSuccess { shown = true }
    }

    fun hide() {
        collapse()
        hideTarget()
        if (shown) runCatching { windows.removeView(head) }
        shown = false
    }

    fun destroy() {
        hide()
        panel?.destroy()
        panel = null
    }

    /** A new alert: a dot on the sticker, and the panel opens on that chat next time. */
    fun alert(chat: String?) {
        unreadChat = chat ?: unreadChat
        dot.visibility = View.VISIBLE
    }

    fun mood(next: Mood) {
        if (next != mood) showMood(next)
    }

    /** The screen changed (fold, rotation): keep the bubble on its side at the same height share. */
    fun screenChanged() {
        if (!shown) return
        val screen = screen()
        headParams.x = BubbleLayout.edgeX(prefs.getBoolean(KEY_LEFT, false), size, screen.first)
        headParams.y = BubbleLayout.fromShare(prefs.getFloat(KEY_Y, 0.3f), size, screen.second)
        panel?.let { if (it.open) it.place(screen) }
        update()
    }

    private fun showMood(next: Mood) {
        mood = next
        val drawable = when (next) {
            Mood.WORKING -> animated(R.raw.nako_thinking)
            else -> null
        }
        if (drawable != null) {
            sticker.setImageDrawable(drawable)
            drawable.start()
        } else {
            sticker.setImageResource(R.drawable.nako)
        }
        if (next == Mood.NEEDS_YOU) dot.visibility = View.VISIBLE
    }

    private fun animated(id: Int): AnimatedImageDrawable? =
        runCatching { ImageDecoder.decodeDrawable(ImageDecoder.createSource(context.resources, id)) as? AnimatedImageDrawable }.getOrNull()

    private fun toggle() {
        if (panel?.open == true) collapse() else expand()
    }

    private fun expand() {
        val open = panel ?: Panel().also { panel = it }
        dot.visibility = View.GONE
        // She stays where you left her; the panel opens toward the roomier side of her.
        open.show(screen(), unreadChat)
        unreadChat = null
        // Re-adding puts the sticker above the panel window.
        runCatching { windows.removeView(head); windows.addView(head, headParams) }
    }

    private fun collapse() {
        val open = panel?.takeIf { it.open } ?: return
        open.hide()
    }

    /** Usable width and height for the bubble: the screen less the status and navigation bars. */
    private fun screen(): Pair<Int, Int> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            val metrics = context.resources.displayMetrics
            return metrics.widthPixels to metrics.heightPixels
        }
        val metrics = windows.currentWindowMetrics
        val insets = metrics.windowInsets.getInsetsIgnoringVisibility(
            android.view.WindowInsets.Type.systemBars() or android.view.WindowInsets.Type.displayCutout(),
        )
        return metrics.bounds.width() to (metrics.bounds.height() - insets.top - insets.bottom)
    }

    private fun update() {
        if (shown) runCatching { windows.updateViewLayout(head, headParams) }
    }

    private fun animateTo(x: Int, y: Int) {
        animator?.cancel()
        val fromX = headParams.x
        val fromY = headParams.y
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 220
            interpolator = DecelerateInterpolator()
            addUpdateListener {
                val t = it.animatedValue as Float
                headParams.x = (fromX + (x - fromX) * t).toInt()
                headParams.y = (fromY + (y - fromY) * t).toInt()
                update()
            }
            start()
        }
    }

    private fun showTarget() {
        if (targetShown) return
        runCatching { windows.addView(target, targetParams) }.onSuccess { targetShown = true }
    }

    private fun hideTarget() {
        if (targetShown) runCatching { windows.removeView(target) }
        targetShown = false
    }

    private fun overTarget(): Boolean {
        if (!targetShown) return false
        val spot = IntArray(2).also(target::getLocationOnScreen)
        val here = IntArray(2).also(head::getLocationOnScreen)
        return BubbleLayout.overTarget(
            here[0] + size / 2f, here[1] + size / 2f,
            spot[0] + target.width / 2f, spot[1] + target.height / 2f,
            dp(72).toFloat(),
        )
    }

    /** Drag to move, tap to open or close the panel, drop on the x to put it away. */
    private inner class Drag : View.OnTouchListener {
        private val slop = ViewConfiguration.get(context).scaledTouchSlop
        private var downX = 0f
        private var downY = 0f
        private var startX = 0
        private var startY = 0
        private var dragging = false

        @SuppressLint("ClickableViewAccessibility")
        override fun onTouch(view: View, event: MotionEvent): Boolean {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    animator?.cancel()
                    downX = event.rawX
                    downY = event.rawY
                    startX = headParams.x
                    startY = headParams.y
                    dragging = false
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - downX
                    val dy = event.rawY - downY
                    if (!dragging && (abs(dx) > slop || abs(dy) > slop)) {
                        dragging = true
                        if (panel?.open == true) panel?.hide()
                        showTarget()
                    }
                    if (dragging) {
                        headParams.x = startX + dx.toInt()
                        headParams.y = startY + dy.toInt()
                        update()
                        target.alpha = if (overTarget()) 1f else 0.7f
                        target.scaleX = if (overTarget()) 1.2f else 1f
                        target.scaleY = target.scaleX
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (!dragging) {
                        if (event.actionMasked == MotionEvent.ACTION_UP) toggle()
                        return true
                    }
                    val dismiss = overTarget()
                    hideTarget()
                    if (dismiss) {
                        prefs.edit { putBoolean(KEY_ON, false) }
                        hide()
                        return true
                    }
                    val screen = screen()
                    val rest = BubbleLayout.settle(headParams.x, headParams.y, size, screen.first, screen.second)
                    prefs.edit {
                        putBoolean(KEY_LEFT, rest.left)
                        putFloat(KEY_Y, BubbleLayout.share(rest.y, screen.second))
                    }
                    animateTo(BubbleLayout.edgeX(rest.left, size, screen.first), rest.y)
                }
            }
            return true
        }
    }

    /** The portal in a window under the sticker: the phone layout, so its drawer switches chats. */
    private inner class Panel {
        var open = false
            private set
        private val web = WebView(context).apply {
            setBackgroundColor(BACKGROUND)
            @SuppressLint("SetJavaScriptEnabled")
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.userAgentString = "${settings.userAgentString} NakoAndroid/bubble NakoBubble/1"
            addJavascriptInterface(PanelBridge(), "NakoBubble")
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: android.webkit.WebResourceRequest): Boolean {
                    val link = request.url.toString()
                    if (origin.opensInApp(link)) return false
                    collapse()
                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, request.url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    return true
                }

                override fun onPageFinished(view: WebView, url: String) = matchPortal()
            }
        }
        private val frame = object : LinearLayout(context) {
            // Back closes the panel instead of reaching the app underneath.
            override fun dispatchKeyEvent(event: KeyEvent): Boolean {
                if (event.keyCode == KeyEvent.KEYCODE_BACK) {
                    // With the keyboard up, back only puts the keyboard away.
                    if (event.action == KeyEvent.ACTION_UP) {
                        if (keyboardTop != null) {
                            context.getSystemService(android.view.inputmethod.InputMethodManager::class.java)
                                ?.hideSoftInputFromWindow(windowToken, 0)
                        } else {
                            collapse()
                        }
                    }
                    return true
                }
                return super.dispatchKeyEvent(event)
            }

            // A tap outside the panel puts it away, like a dialog.
            override fun onTouchEvent(event: MotionEvent): Boolean {
                if (event.actionMasked == MotionEvent.ACTION_OUTSIDE) {
                    collapse()
                    return true
                }
                return super.onTouchEvent(event)
            }
        }.apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(BACKGROUND)
                cornerRadius = dp(16).toFloat()
                setStroke(dp(1), BORDER)
            }
            clipToOutline = true
            outlineProvider = android.view.ViewOutlineProvider.BACKGROUND
            addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
            // The keyboard covers the bottom of the panel: lift the page above it so the composer stays in view.
            // The keyboard: lift the panel to sit on it (shrinking when it must), and let her step aside
            // so she doesn't cover keys. Both go back when it closes.
            ViewCompat.setOnApplyWindowInsetsListener(this) { _, insets ->
                // Insets count only the part over this window, so turn the first reading into the
                // keyboard's top edge; once lifted clear of it, the panel reads 0 but it's still up.
                val up = insets.isVisible(WindowInsetsCompat.Type.ime())
                val over = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
                when {
                    !up -> keyboard(null)
                    over > 0 -> keyboard(params.y + params.height - over)
                }
                insets
            }
        }
        private val params = overlay(0, 0, focusable = true).apply {
            flags = flags or WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH or WindowManager.LayoutParams.FLAG_DIM_BEHIND
            dimAmount = 0.35f
            // An overlay of fixed size can't be resized for the keyboard: it pads itself instead (below).
            softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
        }
        private var loaded = false
        /** The keyboard's top edge in overlay coordinates while it's up. */
        private var keyboardTop: Int? = null

        fun show(screen: Pair<Int, Int>, chat: String?) {
            place(screen)
            val page = origin.chatPage(chat)
            when {
                page != null -> web.loadUrl(page)
                !loaded -> web.loadUrl(origin.url)
            }
            loaded = true
            // The app's own stop paused every WebView's timers; this one runs while it's open.
            web.resumeTimers()
            web.onResume()
            matchPortal()
            if (runCatching { windows.addView(frame, params) }.isSuccess) open = true
        }

        /** The frame takes the portal's own background, light or dark. */
        fun matchPortal() {
            web.evaluateJavascript("getComputedStyle(document.body).backgroundColor") { value ->
                val rgb = Regex("\\d+").findAll(value.orEmpty()).take(3).map { it.value.toInt() }.toList()
                if (rgb.size < 3) return@evaluateJavascript
                val color = Color.rgb(rgb[0], rgb[1], rgb[2])
                val light = (rgb[0] + rgb[1] + rgb[2]) / 3 > 128
                (frame.background as GradientDrawable).apply {
                    setColor(color)
                    setStroke(dp(1), if (light) BORDER_LIGHT else BORDER)
                }
            }
        }

        private fun keyboard(top: Int?) {
            if (top == keyboardTop) return
            keyboardTop = top
            head.animate().alpha(if (top != null) 0f else 1f).setDuration(150).start()
            if (open) place(screen())
        }

        fun place(screen: Pair<Int, Int>) {
            val spot = BubbleLayout.panel(headParams.y, size, screen.second, dp(8), dp(620)).let {
                keyboardTop?.let { top -> BubbleLayout.aboveKeyboard(it, top, dp(8)) } ?: it
            }
            params.width = minOf(screen.first - dp(8) * 2, dp(480))
            params.height = spot.height
            params.gravity = Gravity.TOP or (if (prefs.getBoolean(KEY_LEFT, false)) Gravity.START else Gravity.END)
            params.x = dp(8)
            params.y = spot.y
            if (open) runCatching { windows.updateViewLayout(frame, params) }
        }

        fun hide() {
            if (!open) return
            if (keyboardTop != null) keyboard(null)
            runCatching { windows.removeView(frame) }
            open = false
            web.onPause()
            if (!MainActivity.visible) web.pauseTimers()
        }

        fun destroy() {
            hide()
            web.destroy()
        }

        private fun openInApp() {
            val chat = Regex("#/c/([\\w.-]+)").find(web.url.orEmpty())?.groupValues?.get(1)
            collapse()
            val intent = Intent(context, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_SESSION, chat)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            context.startActivity(intent)
        }

        /** The page's own header carries the panel's buttons (see the portal's `lib/bubble.ts`). */
        private inner class PanelBridge {
            @android.webkit.JavascriptInterface
            fun openInApp() {
                web.post { this@Panel.openInApp() }
            }

            @android.webkit.JavascriptInterface
            fun close() {
                web.post { collapse() }
            }
        }
    }

    private fun overlay(width: Int, height: Int, focusable: Boolean) = WindowManager.LayoutParams(
        width,
        height,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        (if (focusable) 0 else WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE),
        PixelFormat.TRANSLUCENT,
    ).apply { gravity = Gravity.TOP or Gravity.START }

    private fun dp(value: Int) = (value * density).toInt()

    companion object {
        const val KEY_ON = "bubble"
        private const val KEY_LEFT = "bubble_left"
        private const val KEY_Y = "bubble_y"
        private val BACKGROUND = "#0D0A11".toColorInt()
        private val BORDER = Color.argb(41, 255, 255, 255)
        private val BORDER_LIGHT = Color.argb(31, 0, 0, 0)
        private val MUTED = "#B6A4B1".toColorInt()
        private val PINK = "#EC4899".toColorInt()

        fun canDraw(context: Context) = Settings.canDrawOverlays(context)

        fun enabled(context: Context) =
            context.getSharedPreferences("shell", Context.MODE_PRIVATE).getBoolean(KEY_ON, false) && canDraw(context)
    }
}
