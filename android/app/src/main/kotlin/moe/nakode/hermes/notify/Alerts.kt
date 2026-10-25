package moe.nakode.hermes.notify

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** One "turn finished / needs you / inbox" alert the portal pushes over its live socket. */
@Serializable
data class Alert(val title: String, val body: String, val session: String?)

private val json = Json { ignoreUnknownKeys = true }

/** The alert in a socket frame, or null for every other kind of frame (or junk). */
fun parseAlert(frame: String): Alert? {
    val obj = runCatching { json.parseToJsonElement(frame) as? JsonObject }.getOrNull() ?: return null
    if (obj["kind"]?.jsonPrimitive?.contentOrNull != "alert") {
        return null
    }
    val title = obj["title"]?.jsonPrimitive?.contentOrNull ?: return null
    val body = obj["body"]?.jsonPrimitive?.contentOrNull.orEmpty()
    return Alert(title.take(120), body.take(400), obj["session"]?.jsonPrimitive?.contentOrNull)
}

/** Seconds to wait before reconnect attempt [attempt] (0-based): 2, 4, 8 … capped at 5 minutes. */
fun backoffSeconds(attempt: Int): Long = minOf(300L, 2L shl minOf(attempt, 8))
