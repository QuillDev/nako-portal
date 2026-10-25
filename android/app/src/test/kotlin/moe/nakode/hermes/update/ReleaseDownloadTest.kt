package moe.nakode.hermes.update

import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.security.MessageDigest

class ReleaseDownloadTest {
    @get:Rule
    val folder = TemporaryFolder()
    private val server = MockWebServer()
    private val apk = ByteArray(200_000) { (it % 251).toByte() }
    private val sha256 = MessageDigest.getInstance("SHA-256").digest(apk).joinToString("") { "%02x".format(it) }
    private val origin get() = server.url("/").toString().trimEnd('/')

    @Before
    fun setUp() = server.start()

    @After
    fun tearDown() = server.close()

    private fun release(sha: String = sha256) =
        AndroidRelease(versionCode = 9, versionName = "0.1.9", sha256 = sha, sizeBytes = apk.size.toLong(), apkUrl = "/android/hermes.apk")

    @Test
    fun readsThePublishedReleaseWithTheSessionCookie() {
        server.enqueue(
            MockResponse.Builder()
                .body("""{"versionCode":9,"versionName":"0.1.9","sha256":"$sha256","sizeBytes":200000,"apkUrl":"/android/hermes.apk"}""")
                .build(),
        )

        assertEquals(release(), fetchRelease(origin, "__Host-portal=abc"))
        assertEquals("__Host-portal=abc", server.takeRequest().headers["Cookie"])
    }

    @Test
    fun reportsNoReleaseWhenSignedOutOrUnpublished() {
        server.enqueue(MockResponse.Builder().code(401).build())
        server.enqueue(MockResponse.Builder().code(404).build())

        assertNull(fetchRelease(origin, null))
        assertNull(fetchRelease(origin, "__Host-portal=abc"))
    }

    @Test
    fun keepsADownloadThatMatchesTheManifest() {
        server.enqueue(MockResponse.Builder().body(Buffer().write(apk)).build())
        val destination = folder.root.resolve("hermes.apk")

        downloadRelease(origin, "__Host-portal=abc", release(), destination)

        assertArrayEquals(apk, destination.readBytes())
        assertEquals("/android/hermes.apk", server.takeRequest().url.encodedPath)
    }

    @Test
    fun discardsADownloadThatDoesNotMatch() {
        server.enqueue(MockResponse.Builder().body(Buffer().write(apk)).build())
        val destination = folder.root.resolve("hermes.apk")

        assertThrows(ReleaseVerificationException::class.java) {
            downloadRelease(origin, null, release(sha = "0".repeat(64)), destination)
        }
        assertFalse(destination.exists())
        assertEquals(emptyList<String>(), folder.root.list()!!.toList())
    }

    @Test
    fun upgradesOnlyToNewerBuilds() {
        assertEquals(true, isUpgrade(8, release()))
        assertEquals(false, isUpgrade(9, release()))
    }
}
