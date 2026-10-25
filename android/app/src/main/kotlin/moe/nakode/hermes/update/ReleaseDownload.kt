package moe.nakode.hermes.update

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** `GET /api/android/release` (server/androidRelease.ts). */
@Serializable
data class AndroidRelease(
    val versionCode: Long,
    val versionName: String,
    val sha256: String,
    val sizeBytes: Long,
    val apkUrl: String,
)

private val json = Json { ignoreUnknownKeys = true }

class ReleaseVerificationException(message: String) : IOException(message)

/** Whether a published release should replace the installed build. */
fun isUpgrade(installedVersionCode: Long, release: AndroidRelease): Boolean =
    release.versionCode > installedVersionCode

private fun open(url: String, cookie: String?): HttpURLConnection =
    (URL(url).openConnection() as HttpURLConnection).apply {
        connectTimeout = 15_000
        readTimeout = 30_000
        instanceFollowRedirects = false
        if (cookie != null) {
            setRequestProperty("Cookie", cookie)
        }
    }

/** The published release, or null when signed out or nothing is published. */
fun fetchRelease(origin: String, cookie: String?): AndroidRelease? {
    val connection = open("$origin/api/android/release", cookie)
    try {
        if (connection.responseCode != 200) {
            return null
        }
        return json.decodeFromString(AndroidRelease.serializer(), connection.inputStream.bufferedReader().readText())
    } finally {
        connection.disconnect()
    }
}

/**
 * Streams the APK to [destination] and keeps it only when its size and SHA-256
 * match the manifest, so a truncated or substituted download is never installed.
 */
fun downloadRelease(origin: String, cookie: String?, release: AndroidRelease, destination: File): File {
    val partial = File(destination.parentFile, "${destination.name}.part")
    val digest = MessageDigest.getInstance("SHA-256")
    var written = 0L
    val connection = open(origin + release.apkUrl, cookie)
    try {
        if (connection.responseCode != 200) {
            throw IOException("Update download failed with HTTP ${connection.responseCode}")
        }
        connection.inputStream.use { input ->
            partial.outputStream().use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) {
                        break
                    }
                    digest.update(buffer, 0, read)
                    output.write(buffer, 0, read)
                    written += read
                }
            }
        }
    } finally {
        connection.disconnect()
    }
    val sha256 = digest.digest().joinToString("") { "%02x".format(it) }
    if (written != release.sizeBytes || sha256 != release.sha256) {
        partial.delete()
        throw ReleaseVerificationException("Downloaded update did not match the published release")
    }
    if (!partial.renameTo(destination)) {
        throw IOException("Could not store the downloaded update")
    }
    return destination
}
