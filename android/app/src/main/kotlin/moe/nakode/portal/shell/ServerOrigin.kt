package moe.nakode.portal.shell

import java.net.URI
import java.net.URLDecoder

/** The one portal this install talks to, normalized to `scheme://host[:port]`. */
@JvmInline
value class ServerOrigin private constructor(val value: String) {
    val url: String get() = "$value/"

    /** Only the portal itself stays in the app; every other link opens in the browser. */
    fun opensInApp(link: String): Boolean {
        val uri = runCatching { URI(link) }.getOrNull() ?: return false
        return originOf(uri) == value
    }

    /** The portal page for a chat a notification points at; null when the id isn't a session id. */
    fun chatPage(session: String?): String? = session?.takeIf { SESSION.matches(it) }?.let { "$value/#/c/$it" }

    /** The portal page a browser-to-app deep link points at; null when the link isn't ours or names no page. */
    fun deepLink(link: String?): String? {
        val uri = link?.let { runCatching { URI(it) }.getOrNull() } ?: return null
        if (!uri.scheme.equals(DEEP_LINK_SCHEME, ignoreCase = true) || !uri.host.equals("open", ignoreCase = true)) {
            return null
        }
        val query = uri.rawQuery ?: return null
        val params = buildMap {
            for (part in query.split('&')) {
                val eq = part.indexOf('=')
                if (eq <= 0) continue
                val key = decodeQuery(part.substring(0, eq)) ?: return null
                val paramValue = decodeQuery(part.substring(eq + 1)) ?: return null
                putIfAbsent(key, paramValue)
            }
        }
        params["c"]?.let { return chatPage(it) }
        params["page"]?.let { page ->
            return page.takeIf { DEEP_LINK_PAGE.matches(it) }?.let { "$value/#/$it" }
        }
        return null
    }

    /** The live-event socket the notification service listens on. */
    val socketUrl: String get() = value.replaceFirst("http", "ws") + "/ws"

    companion object {
        const val DEEP_LINK_SCHEME = "nako"
        private val SESSION = Regex("[\\w.-]{1,120}")
        private val DEEP_LINK_PAGE = Regex("new|elsewhere|settings(?:/[\\w-]{1,64})?")

        private fun decodeQuery(raw: String): String? =
            runCatching { URLDecoder.decode(raw, "UTF-8") }.getOrNull()

        /** Accepts `portal.example.com`, `https://portal.example.com/` or `http://10.0.0.5:8797`; null otherwise. */
        fun parse(input: String): ServerOrigin? {
            val trimmed = input.trim().trimEnd('/')
            if (trimmed.isEmpty()) {
                return null
            }
            val withScheme = if ("://" in trimmed) trimmed else "https://$trimmed"
            val uri = runCatching { URI(withScheme) }.getOrNull() ?: return null
            val bare = uri.rawPath.isNullOrEmpty() && uri.rawQuery == null && uri.rawFragment == null && uri.rawUserInfo == null
            return if (bare) originOf(uri)?.let(::ServerOrigin) else null
        }

        private fun originOf(uri: URI): String? {
            val scheme = uri.scheme?.lowercase()
            val host = uri.host?.lowercase()
            if (scheme !in setOf("http", "https") || host.isNullOrEmpty()) {
                return null
            }
            val defaultPort = if (scheme == "https") 443 else 80
            val port = if (uri.port == -1 || uri.port == defaultPort) "" else ":${uri.port}"
            return "$scheme://$host$port"
        }
    }
}
