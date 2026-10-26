package moe.nakode.portal.shell

import java.net.URI
import java.net.URLEncoder

/** What the in-app browser's address bar does with what you type: go there, or search for it. */
object Address {
    /** The engines the portal's Settings can pick (localStorage `browser:search`); Google until one is. */
    private val ENGINES = mapOf(
        "google" to "https://www.google.com/search",
        "duckduckgo" to "https://duckduckgo.com/",
        "bing" to "https://www.bing.com/search",
        "brave" to "https://search.brave.com/search",
    )

    /** An address (a scheme is optional) or a search with [engine]; null for nothing typed. */
    fun resolve(text: String, engine: String?): String? {
        val typed = text.trim()
        if (typed.isEmpty()) return null
        if (typed.none(Char::isWhitespace)) {
            val scheme = typed.substringBefore(':', "").lowercase()
            if ((scheme == "http" || scheme == "https") && runCatching { URI(typed).host }.getOrNull() != null) return typed
            // example.com, localhost:3000, 10.0.0.2/admin: no scheme, but clearly a place.
            val host = typed.split('/', '?', '#').first()
            val name = host.substringBeforeLast(':').takeIf { host.substringAfterLast(':', "").toIntOrNull() != null } ?: host
            val looksLikeHost = name == "localhost" || (name.contains('.') && !name.startsWith('.') && !name.endsWith('.'))
            if (looksLikeHost && runCatching { URI("https://$typed").host }.getOrNull() != null) return "https://$typed"
        }
        val base = ENGINES[engine] ?: ENGINES.getValue("google")
        return "$base?q=" + URLEncoder.encode(typed, "UTF-8")
    }
}
