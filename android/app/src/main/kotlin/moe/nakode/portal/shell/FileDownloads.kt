package moe.nakode.portal.shell

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.webkit.CookieManager
import android.webkit.WebView
import android.widget.Toast
import java.net.URI
import java.net.URLDecoder

/**
 * Saves files the portal hands over (the image viewer's download button, a reply's file link)
 * to the phone's Downloads folder. A WebView with no download listener drops them silently.
 */
object FileDownloads {
    /** Portal files go through the system downloader with the sign-in cookie; anything else opens outside. */
    fun attach(web: WebView, server: ServerOrigin, openOutside: (Uri) -> Unit) {
        web.setDownloadListener { url, userAgent, disposition, mimeType, _ ->
            if (server.opensInApp(url)) save(web.context, url, userAgent, disposition, mimeType) else openOutside(Uri.parse(url))
        }
    }

    private fun save(context: Context, url: String, userAgent: String?, disposition: String?, mimeType: String?) {
        val name = fileName(url, disposition)
        val request = DownloadManager.Request(Uri.parse(url))
            .setTitle(name)
            .setMimeType(mimeType)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
        CookieManager.getInstance().getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
        userAgent?.let { request.addRequestHeader("User-Agent", it) }
        val manager = context.getSystemService(DownloadManager::class.java)
        runCatching { manager.enqueue(request) }
            .onSuccess { Toast.makeText(context, "Saving $name to Downloads", Toast.LENGTH_SHORT).show() }
            .onFailure { Toast.makeText(context, "Couldn't save $name", Toast.LENGTH_LONG).show() }
    }

    /** The name to save under: the server's `filename*`, then `filename`, then the file's own path. */
    fun fileName(url: String, disposition: String?): String {
        val header = disposition.orEmpty()
        val encoded = Regex("filename\\*\\s*=\\s*UTF-8''([^;\\s]+)", RegexOption.IGNORE_CASE).find(header)?.groupValues?.get(1)
        val quoted = Regex("filename\\s*=\\s*\"([^\"]*)\"", RegexOption.IGNORE_CASE).find(header)?.groupValues?.get(1)
        val fromPath = runCatching { URI(url).rawQuery }.getOrNull()
            ?.split('&')
            ?.firstOrNull { it.startsWith("path=") }
            ?.removePrefix("path=")
            ?.let(::decode)
        // Only the last part of any path, so a name can't point outside Downloads.
        val name = (encoded?.let(::decode) ?: quoted ?: fromPath).orEmpty().substringAfterLast('/').substringAfterLast('\\')
        val safe = name.filter { it >= ' ' && it != '/' && it != '\\' }.trim().trimStart('.')
        return safe.ifEmpty { "download" }
    }

    // Percent-decoding only: a literal `+` in a file name stays a plus.
    private fun decode(text: String): String? = runCatching { URLDecoder.decode(text.replace("+", "%2B"), "UTF-8") }.getOrNull()
}
