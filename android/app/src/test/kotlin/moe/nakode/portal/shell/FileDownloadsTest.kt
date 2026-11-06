package moe.nakode.portal.shell

import org.junit.Assert.assertEquals
import org.junit.Test

class FileDownloadsTest {
    private val url = "https://portal.example.test/api/file?session=s1&path=%2Fhome%2Fme%2Fwhim%20logo%2B640.png&download=1"

    @Test
    fun savesUnderTheNameThePortalSends() {
        val header = "attachment; filename=\"caf_ logo.png\"; filename*=UTF-8''caf%C3%A9%20logo.png"
        assertEquals("café logo.png", FileDownloads.fileName(url, header))
        assertEquals("caf_ logo.png", FileDownloads.fileName(url, "attachment; filename=\"caf_ logo.png\""))
    }

    @Test
    fun fallsBackToTheFilesOwnName() {
        assertEquals("whim logo+640.png", FileDownloads.fileName(url, null))
        assertEquals("download", FileDownloads.fileName("https://portal.example.test/api/file", ""))
    }

    @Test
    fun neverSavesOutsideDownloads() {
        assertEquals("passwd", FileDownloads.fileName(url, "attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd"))
        assertEquals("hidden", FileDownloads.fileName(url, "attachment; filename=\"..hidden\""))
    }
}
