package moe.nakode.portal.update

import android.app.Activity
import android.app.AlertDialog
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.provider.Settings
import android.util.Log
import android.webkit.CookieManager
import androidx.core.net.toUri
import moe.nakode.portal.shell.ServerOrigin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Updates the shell from the signed-in Hermes Portal, reusing the WebView's
 * session cookie. Android 12+ installs without a prompt once this app is its
 * own installer of record; otherwise the system confirmation appears.
 */
class AppUpdater(private val context: Context) {
    private val packageInfo get() = context.packageManager.getPackageInfo(context.packageName, 0)
    private var lastCheck = 0L
    private var askedForPermission = false

    val installedVersionName: String get() = packageInfo.versionName.orEmpty()

    // Debug builds use a separate application id and never update themselves.
    private val enabled get() = context.packageName == RELEASE_PACKAGE

    suspend fun checkAndInstall(origin: ServerOrigin, activity: Activity) {
        val now = System.currentTimeMillis()
        if (!enabled || now - lastCheck < CHECK_INTERVAL_MS) {
            return
        }
        lastCheck = now
        val cookie = CookieManager.getInstance().getCookie(origin.url)
        val release = withContext(Dispatchers.IO) { runCatching { fetchRelease(origin.value, cookie) }.getOrNull() }
        if (release == null || !isUpgrade(packageInfo.longVersionCode, release)) {
            return
        }
        if (!context.packageManager.canRequestPackageInstalls()) {
            askForInstallPermission(activity, release)
            return
        }
        runCatching {
            val apk = withContext(Dispatchers.IO) {
                val directory = File(context.cacheDir, "updates").apply { mkdirs() }
                directory.listFiles()?.forEach { it.delete() }
                downloadRelease(origin.value, cookie, release, File(directory, "hermes-${release.versionCode}.apk"))
            }
            withContext(Dispatchers.IO) { install(apk) }
        }.onFailure { Log.w(TAG, "Update to ${release.versionName} failed", it) }
    }

    private fun askForInstallPermission(activity: Activity, release: AndroidRelease) {
        if (askedForPermission) {
            return
        }
        askedForPermission = true
        AlertDialog.Builder(activity)
            .setTitle("Nako ${release.versionName} is available")
            .setMessage("Allow Nako to install its own updates.")
            .setPositiveButton("Allow") { _, _ ->
                lastCheck = 0
                activity.startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:${context.packageName}".toUri()),
                )
            }
            .setNegativeButton("Not now", null)
            .show()
    }

    private fun install(apk: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(apk.length())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
        }
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            session.openWrite("hermes.apk", 0, apk.length()).use { output ->
                apk.inputStream().use { it.copyTo(output) }
                session.fsync(output)
            }
            val callback = PendingIntent.getBroadcast(
                context,
                sessionId,
                Intent(context, InstallResultReceiver::class.java).setPackage(context.packageName),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
            )
            session.commit(callback.intentSender)
        }
    }

    companion object {
        const val RELEASE_PACKAGE = "moe.nakode.portal"
        private const val TAG = "HermesUpdate"
        private const val CHECK_INTERVAL_MS = 30 * 60 * 1000L
    }
}
