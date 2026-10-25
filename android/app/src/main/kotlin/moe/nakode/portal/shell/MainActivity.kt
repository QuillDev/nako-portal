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
import android.view.inputmethod.EditorInfo
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
import androidx.core.content.edit
import androidx.core.graphics.toColorInt
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.launch
import moe.nakode.portal.R
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
        root = FrameLayout(this).apply { setBackgroundColor(BACKGROUND) }
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

    override fun onDestroy() {
        webView?.destroy()
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
        if (granted) AlertService.start(this)
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
        root.removeAllViews()
        val web = WebView(this).apply {
            setBackgroundColor(BACKGROUND)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.userAgentString = "${settings.userAgentString} NakoAndroid/${updater.installedVersionName}"
            // Passkeys inside the WebView, bound to this app by the portal's assetlinks.json.
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
                WebSettingsCompat.setWebAuthenticationSupport(settings, WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP)
            }
            webViewClient = ShellWebViewClient(server)
            webChromeClient = ShellChromeClient()
        }
        CookieManager.getInstance().setAcceptCookie(true)
        webView = web
        root.addView(web, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        if (startUrl != null) {
            web.loadUrl(startUrl)
        } else if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl(server.url)
        }
    }

    private inner class ShellWebViewClient(private val server: ServerOrigin) : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (server.opensInApp(request.url.toString())) {
                return false
            }
            openExternally(request.url)
            return true
        }

        // Signing in sets the cookie the alert service needs; start it as soon as the page has one.
        override fun onPageFinished(view: WebView, url: String) {
            startListening()
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view === webView) {
                root.removeView(view)
                webView = null
                view.destroy()
                showWebApp(server, null)
            }
            return true
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) {
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

    private fun openExternally(uri: Uri) {
        runCatching { CustomTabsIntent.Builder().build().launchUrl(this, uri) }
            .recoverCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
            .onFailure { Toast.makeText(this, "No app here can open ${uri.host}", Toast.LENGTH_LONG).show() }
    }

    private fun showServerPrompt(error: String?) {
        webView?.destroy()
        webView = null
        root.removeAllViews()
        val input = EditText(this).apply {
            hint = "portal.example.com"
            setText(origin?.value.orEmpty())
            setTextColor(Color.WHITE)
            setHintTextColor(MUTED)
            isSingleLine = true
            inputType = android.text.InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
        }
        val message = label(error ?: "Portal address", if (error == null) MUTED else ERROR)
        val connect = Button(this).apply { text = "Connect" }
        val submit = {
            val parsed = ServerOrigin.parse(input.text.toString())
            if (parsed == null) {
                message.text = "Enter an address like https://portal.example.com"
                message.setTextColor(ERROR)
            } else {
                origin = parsed
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
        val retry = Button(this).apply {
            text = "Retry"
            setOnClickListener { showWebApp(server, null) }
        }
        val change = Button(this).apply {
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

    private fun label(text: String, color: Int, size: Float = 15f) = TextView(this).apply {
        this.text = text
        setTextColor(color)
        textSize = size
        gravity = Gravity.CENTER
    }

    private fun column(vararg views: View) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        val pad = (24 * resources.displayMetrics.density).toInt()
        setPadding(pad, pad, pad, pad)
        views.forEach { addView(it, it.layoutParams as? LinearLayout.LayoutParams ?: LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)) }
        layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    }

    companion object {
        const val EXTRA_SESSION = "session"
        private val BACKGROUND = "#0D0A11".toColorInt()
        private val MUTED = "#B6A4B1".toColorInt()
        private val ERROR = "#F87171".toColorInt()
    }
}
