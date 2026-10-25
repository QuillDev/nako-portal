package moe.nakode.hermes.shell

import java.net.URI

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

    /** The live-event socket the notification service listens on. */
    val socketUrl: String get() = value.replaceFirst("http", "ws") + "/ws"

    companion object {
        private val SESSION = Regex("[\\w.-]{1,120}")

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
