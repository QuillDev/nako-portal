package moe.nakode.portal.shell

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.provider.Settings
import android.view.inputmethod.EditorInfo
import android.webkit.JavascriptInterface
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.ContextCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.edit
import androidx.core.graphics.toColorInt
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.launch
import moe.nakode.portal.R
import moe.nakode.portal.bubble.Bubble
import moe.nakode.portal.notify.AlertService
import moe.nakode.portal.update.AppUpdater

/**
 * Hosts the portal's web app in a WebView: every web deploy updates the app, and
 * only this shell ships as an APK (see [AppUpdater]). Notifications come from
 * [AlertService], which listens to the portal directly once you're signed in.
 */
class MainActivity : ComponentActivity() {
    private val preferences by lazy { getSharedPreferences("shell", Context.MODE_PRIVATE) }
    private val updater by lazy { AppUpdater(this) }
    private lateinit var root: FrameLayout
    private var webView: WebView? = null
    private var pendingFiles: ValueCallback<Array<Uri>>? = null

    private val pickFiles = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        pendingFiles?.onReceiveValue(uris.toTypedArray())
        pendingFiles = null
    }

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        startListening()
    }

    private var origin: ServerOrigin?
        get() = preferences.getString("origin", null)?.let(ServerOrigin::parse)
        set(value) = preferences.edit { putString("origin", value?.value) }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        root = FrameLayout(this).apply { setBackgroundColor(getColor(R.color.background)) }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
            )
            view.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)
        onBackPressedDispatcher.addCallback(this, backCallback)

        val server = origin
        if (server == null) {
            showServerPrompt(null)
        } else {
            showWebApp(server, savedInstanceState, server.chatPage(intent?.getStringExtra(EXTRA_SESSION)))
        }
    }

    // A tapped notification opens its chat.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val server = origin ?: return
        val page = server.chatPage(intent.getStringExtra(EXTRA_SESSION)) ?: return
        val web = webView
        if (web == null) showWebApp(server, null, page) else web.loadUrl(page)
    }

    override fun onResume() {
        super.onResume()
        val server = origin ?: return
        startListening()
        lifecycleScope.launch { updater.checkAndInstall(server, this@MainActivity) }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView?.saveState(outState)
    }

    override fun onPause() {
        CookieManager.getInstance().flush()
        super.onPause()
    }

    // Out of sight, the pages stop: scripts, timers and rendering pause until the app is back, so a
    // reply streaming into the open chat isn't parsed and laid out in the background. Alerts keep
    // coming through AlertService's own socket, and the page catches up when it's shown again.
    override fun onStop() {
        visible = false
        AlertService.running?.refreshBubble()
        webView?.onPause()
        // Instance method, but it stops timers in every WebView of the app.
        webView?.pauseTimers()
        super.onStop()
    }

    override fun onStart() {
        super.onStart()
        visible = true
        AlertService.running?.refreshBubble()
        webView?.resumeTimers()
        webView?.onResume()
    }

    override fun onDestroy() {
        destroyWebApp()
        super.onDestroy()
    }

    /** Listen for alerts once signed in; ask for notification permission the first time. */
    private fun startListening() {
        val server = origin ?: return
        if (CookieManager.getInstance().getCookie(server.value).isNullOrEmpty()) return
        val granted = Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (!granted && !preferences.getBoolean("asked_notifications", false)) {
            preferences.edit { putBoolean("asked_notifications", true) }
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
            return
        }
        // The bubble lives in the same service, so it keeps it running even with alerts off.
        if (granted || Bubble.enabled(this)) AlertService.start(this)
    }

    /** What the web app's Settings can ask the shell: the app's own alerts, which web push can't do here. */
    private inner class AppBridge {
        @JavascriptInterface
        fun notifications(): String = if (NotificationManagerCompat.from(this@MainActivity).areNotificationsEnabled()) "on" else "off"

        /** Nako's floating sticker over other apps: "on" only when switched on and allowed to draw over apps. */
        @JavascriptInterface
        fun bubble(): String = if (Bubble.enabled(this@MainActivity)) "on" else "off"

        /** Switches the bubble; turning it on the first time sends you to Android's "display over other apps" page. */
        @JavascriptInterface
        fun setBubble(on: Boolean) {
            runOnUiThread {
                preferences.edit { putBoolean(Bubble.KEY_ON, on) }
                if (on && !Bubble.canDraw(this@MainActivity)) {
                    startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
                    return@runOnUiThread
                }
                if (on) startListening()
                AlertService.running?.refreshBubble()
            }
        }

        /** The portal switched between light and dark: the bar strips and system bar icons follow it. */
        @JavascriptInterface
        fun look(light: Boolean) {
            runOnUiThread { showLook(light) }
        }

        @JavascriptInterface
        fun openNotificationSettings() {
            runOnUiThread {
                val settings = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                startActivity(settings)
            }
        }
    }

    private val backCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            val web = webView
            if (web != null && web.canGoBack()) {
                web.goBack()
            } else {
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
                isEnabled = true
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showWebApp(server: ServerOrigin, savedInstanceState: Bundle?, startUrl: String? = null) {
        destroyWebApp()
        root.removeAllViews()
        val web = WebView(this).apply {
            setBackgroundColor(getColor(R.color.background))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.userAgentString = "${settings.userAgentString} NakoAndroid/${updater.installedVersionName}"
            // Passkeys inside the WebView, bound to this app by the portal's assetlinks.json.
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
                WebSettingsCompat.setWebAuthenticationSupport(settings, WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP)
            }
            addJavascriptInterface(AppBridge(), "NakoApp")
            webViewClient = ShellWebViewClient(server)
            webChromeClient = ShellChromeClient()
            FileDownloads.attach(this, server, ::openExternally)
        }
        CookieManager.getInstance().setAcceptCookie(true)
        webView = web
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        if (startUrl != null) {
            web.loadUrl(startUrl)
        } else if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl(server.url)
        }
    }

    private inner class ShellWebViewClient(private val server: ServerOrigin) : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val link = request.url.toString()
            if (server.opensInApp(link)) {
                return false
            }
            openExternally(request.url)
            return true
        }

        // Signing in sets the cookie the alert service needs; start it as soon as the page has one.
        override fun onPageFinished(view: WebView, url: String) {
            if (view !== webView) return
            startListening()
            if (server.opensInApp(url)) {
                view.evaluateJavascript(THEME_WATCH, null)
            }
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view === webView) {
                root.removeAllViews()
                webView = null
                view.destroy()
                showWebApp(server, null)
            }
            return true
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (view === webView && request.isForMainFrame) {
                showUnreachable(server, error.description?.toString())
            }
        }
    }

    private inner class ShellChromeClient : WebChromeClient() {
        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams,
        ): Boolean {
            pendingFiles?.onReceiveValue(null)
            pendingFiles = callback
            val types = params.acceptTypes.filter { it.contains('/') }.ifEmpty { listOf("*/*") }
            pickFiles.launch(types.toTypedArray())
            return true
        }
    }

    private fun destroyWebApp() {
        val old = webView
        webView = null
        old?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.stopLoading()
            it.destroy()
        }
    }

    private fun openExternally(uri: Uri) {
        runCatching { CustomTabsIntent.Builder().build().launchUrl(this, uri) }
            .recoverCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
            .onFailure { Toast.makeText(this, "No app here can open ${uri.host}", Toast.LENGTH_LONG).show() }
    }

    private fun showLook(light: Boolean) {
        val color = if (light) PAGE_LIGHT else BACKGROUND
        root.setBackgroundColor(color)
        webView?.setBackgroundColor(color)
        WindowCompat.getInsetsController(window, root).apply {
            isAppearanceLightStatusBars = light
            isAppearanceLightNavigationBars = light
        }
    }

    /** The connect and offline screens stay dark, whatever the system theme. */
    private val dark by lazy { android.view.ContextThemeWrapper(this, android.R.style.Theme_Material_NoActionBar) }

    private fun showServerPrompt(error: String?) {
        destroyWebApp()
        root.removeAllViews()
        showLook(false)
        val input = EditText(dark).apply {
            hint = "portal.example.com"
            setText(origin?.value.orEmpty())
            setTextColor(Color.WHITE)
            setHintTextColor(MUTED)
            isSingleLine = true
            inputType = android.text.InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
        }
        val message = label(error ?: "Portal address", if (error == null) MUTED else ERROR)
        val connect = Button(dark).apply { text = "Connect" }
        val submit = {
            val parsed = ServerOrigin.parse(input.text.toString())
            if (parsed == null) {
                message.text = "Enter an address like https://portal.example.com"
                message.setTextColor(ERROR)
            } else {
                val changed = origin?.value != parsed.value
                origin = parsed
                if (changed) AlertService.running?.serverChanged()
                showWebApp(parsed, null)
            }
        }
        connect.setOnClickListener { submit() }
        input.setOnEditorActionListener { _, _, _ ->
            submit()
            true
        }
        root.addView(column(portrait(), label("Nako", Color.WHITE, 30f), message, input, connect))
        input.requestFocus()
    }

    private fun showUnreachable(server: ServerOrigin, detail: String?) {
        root.removeAllViews()
        webView?.stopLoading()
        showLook(false)
        val retry = Button(dark).apply {
            text = "Retry"
            setOnClickListener { showWebApp(server, null) }
        }
        val change = Button(dark).apply {
            text = "Change address"
            setOnClickListener { showServerPrompt(null) }
        }
        root.addView(column(label("Can't reach ${server.value}", Color.WHITE, 18f), label(detail.orEmpty(), MUTED), retry, change))
    }

    private fun portrait() = ImageView(this).apply {
        val size = (88 * resources.displayMetrics.density).toInt()
        setImageResource(R.drawable.nako)
        contentDescription = "Nako"
        scaleType = ImageView.ScaleType.CENTER_CROP
        outlineProvider = ViewOutlineProvider.BACKGROUND
        background = GradientDrawable().apply { shape = GradientDrawable.OVAL }
        clipToOutline = true
        layoutParams = LinearLayout.LayoutParams(size, size).apply {
            gravity = Gravity.CENTER_HORIZONTAL
            bottomMargin = size / 5
        }
    }

    private fun label(text: String, color: Int, size: Float = 15f) = TextView(dark).apply {
        this.text = text
        setTextColor(color)
        textSize = size
        gravity = Gravity.CENTER
    }

    private fun column(vararg views: View) = LinearLayout(dark).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundColor(BACKGROUND)
        gravity = Gravity.CENTER
        val pad = (24 * resources.displayMetrics.density).toInt()
        setPadding(pad, pad, pad, pad)
        views.forEach { addView(it, it.layoutParams as? LinearLayout.LayoutParams ?: LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)) }
        layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    }

    companion object {
        const val EXTRA_SESSION = "session"

        /** Whether the app is on screen; the bubble stays away while it is. */
        var visible = false
            private set

        /** Runs in the portal: watches light/dark theme changes so the system bar strips match. */
        private const val THEME_WATCH = """(() => {
  if (window.__portalThemeWatch || !window.NakoApp || !window.NakoApp.look) return
  window.__portalThemeWatch = true
  const look = () => window.NakoApp.look(document.documentElement.classList.contains("light"))
  new MutationObserver(look).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  look()
})()"""
        private val BACKGROUND = "#0D0A11".toColorInt()
        /** The portal's light page colour, for the strips beside it. */
        private val PAGE_LIGHT = "#FBFBFC".toColorInt()
        private val MUTED = "#B6A4B1".toColorInt()
        private val ERROR = "#F87171".toColorInt()
    }
}
