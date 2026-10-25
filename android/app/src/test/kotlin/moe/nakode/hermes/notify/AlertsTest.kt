package moe.nakode.hermes.notify

import moe.nakode.hermes.shell.ServerOrigin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AlertsTest {
    @Test
    fun alertFramesBecomeNotificationsAndEverythingElseIsIgnored() {
        assertEquals(
            Alert("Fix the build", "done", "20261024_020202_bbbbbb"),
            parseAlert("""{"kind":"alert","title":"Fix the build","body":"done","session":"20261024_020202_bbbbbb"}"""),
        )
        assertEquals(Alert("Hermes", "daily digest", null), parseAlert("""{"kind":"alert","title":"Hermes","body":"daily digest","session":null}"""))
        assertNull(parseAlert("""{"kind":"status","session":"x","status":"done"}"""))
        assertNull(parseAlert("""{"kind":"event","type":"message.delta","payload":{"text":"secret"}}"""))
        assertNull(parseAlert("""{"kind":"alert"}"""))
        assertNull(parseAlert("not json"))
    }

    @Test
    fun reconnectsBackOffToFiveMinutes() {
        assertEquals(listOf(2L, 4L, 8L, 16L), (0..3).map(::backoffSeconds))
        assertEquals(300L, backoffSeconds(20))
    }

    @Test
    fun notificationsOpenOnlyRealChatsOnThePortal() {
        val origin = ServerOrigin.parse("portal.example.com/")!!
        assertEquals("https://portal.example.com", origin.value)
        assertEquals("wss://portal.example.com/ws", origin.socketUrl)
        assertEquals("https://portal.example.com/#/c/20261024_020202_bbbbbb", origin.chatPage("20261024_020202_bbbbbb"))
        assertNull(origin.chatPage("../../evil"))
        assertNull(origin.chatPage("javascript:alert(1)"))
        assertNull(origin.chatPage(null))
        assertEquals(true, origin.opensInApp("https://portal.example.com/#/settings"))
        assertEquals(false, origin.opensInApp("https://evil.example.com/"))
        assertNull(ServerOrigin.parse("https://portal.example.com/path"))
        assertNull(ServerOrigin.parse("ftp://portal.example.com"))
    }
}
