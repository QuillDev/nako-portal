package moe.nakode.portal.shell

import android.app.Activity
import android.content.ComponentName
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsCallback
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsServiceConnection
import androidx.browser.customtabs.CustomTabsSession

/**
 * The in-app browser on a wide screen, as Chrome itself docked on the right (a Partial Custom Tab
 * side sheet). Being the real browser, it has passkeys, the password manager and the user's
 * signed-in sites, which no WebView can offer for other sites.
 *
 * [ready] is false until the browser's Custom Tabs service is bound; [BrowserPane] covers that.
 */
class ChromeSheet(
    private val activity: Activity,
    /** The sheet's width in px while it's showing, 0 once it's gone: the chat makes room. */
    private val onWidth: (Int) -> Unit,
) {
    private var session: CustomTabsSession? = null
    private var connection: CustomTabsServiceConnection? = null
    private val main = Handler(Looper.getMainLooper())

    val ready: Boolean get() = session != null

    fun bind() {
        if (connection != null) return
        val browser = CustomTabsClient.getPackageName(activity, null) ?: return
        val bound = object : CustomTabsServiceConnection() {
            override fun onCustomTabsServiceConnected(name: ComponentName, client: CustomTabsClient) {
                client.warmup(0)
                session = client.newSession(Callback())
            }

            override fun onServiceDisconnected(name: ComponentName) {
                session = null
            }
        }
        if (CustomTabsClient.bindCustomTabsService(activity, browser, bound)) connection = bound
    }

    fun unbind() {
        connection?.let { runCatching { activity.unbindService(it) } }
        connection = null
        session = null
    }

    /** Opens [url] in the sheet, [widthPx] wide, in the portal's [light] or dark colors. */
    fun open(url: String, widthPx: Int, light: Boolean): Boolean {
        val session = session ?: return false
        val toolbar = if (light) LIGHT else DARK
        val tab = CustomTabsIntent.Builder(session)
            .setInitialActivityWidthPx(widthPx)
            .setActivitySideSheetBreakpointDp(PaneLayout.MIN_WIDTH_DP)
            .setActivitySideSheetPosition(CustomTabsIntent.ACTIVITY_SIDE_SHEET_POSITION_END)
            .setActivitySideSheetDecorationType(CustomTabsIntent.ACTIVITY_SIDE_SHEET_DECORATION_TYPE_DIVIDER)
            .setActivitySideSheetRoundedCornersPosition(CustomTabsIntent.ACTIVITY_SIDE_SHEET_ROUNDED_CORNERS_POSITION_NONE)
            .setActivitySideSheetMaximizationEnabled(true)
            .setBackgroundInteractionEnabled(true)
            .setColorScheme(if (light) CustomTabsIntent.COLOR_SCHEME_LIGHT else CustomTabsIntent.COLOR_SCHEME_DARK)
            .setDefaultColorSchemeParams(CustomTabColorSchemeParams.Builder().setToolbarColor(toolbar).setNavigationBarColor(toolbar).build())
            .setShowTitle(true)
            .build()
        return runCatching { tab.launchUrl(activity, Uri.parse(url)) }.isSuccess
    }

    private inner class Callback : CustomTabsCallback() {
        override fun onActivityLayout(left: Int, top: Int, right: Int, bottom: Int, state: Int, extras: Bundle) {
            val width = if (state == ACTIVITY_LAYOUT_STATE_SIDE_SHEET) right - left else 0
            main.post { onWidth(width) }
        }

        override fun onNavigationEvent(navigationEvent: Int, extras: Bundle?) {
            if (navigationEvent == TAB_HIDDEN) main.post { onWidth(0) }
        }
    }

    private companion object {
        val DARK = 0xFF09090B.toInt()
        val LIGHT = 0xFFFBFBFC.toInt()
    }
}
