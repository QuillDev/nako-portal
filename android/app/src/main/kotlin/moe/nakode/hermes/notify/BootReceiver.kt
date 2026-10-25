package moe.nakode.hermes.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.webkit.CookieManager

/** Starts listening again after a reboot or an app update, if the app was signed in. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val signedIn = AlertService.origin(context)?.let { !CookieManager.getInstance().getCookie(it.value).isNullOrEmpty() } == true
        if (signedIn) AlertService.start(context)
    }
}
