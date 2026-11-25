package moe.nakode.portal.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeepLinkTest {
    private val origin = ServerOrigin.parse("https://portal.example.com")!!

    @Test
    fun browserHandoffLinksOpenMatchingPortalPages() {
        assertEquals(
            "https://portal.example.com/#/c/20261125_041540_abc123",
            origin.deepLink("nako://open?c=20261125_041540_abc123"),
        )
        assertEquals(
            "https://portal.example.com/#/new",
            origin.deepLink("nako://open?page=new"),
        )
        assertEquals(
            "https://portal.example.com/#/elsewhere",
            origin.deepLink("nako://open?page=elsewhere"),
        )
        assertEquals(
            "https://portal.example.com/#/settings",
            origin.deepLink("nako://open?page=settings"),
        )
        assertEquals(
            "https://portal.example.com/#/settings/mesh",
            origin.deepLink("nako://open?page=settings%2Fmesh"),
        )
    }

    @Test
    fun bareOpenLinkKeepsDefaultAppPage() {
        assertNull(origin.deepLink("nako://open"))
        assertNull(origin.deepLink("nako://open?"))
        assertNull(origin.deepLink(null))
    }

    @Test
    fun untrustedSchemesHostsAndParamsAreIgnored() {
        assertNull(origin.deepLink("https://portal.example.com/#/c/20261125_041540_abc123"))
        assertNull(origin.deepLink("nako://evil?c=20261125_041540_abc123"))
        assertNull(origin.deepLink("nako://open?c=../../evil"))
        assertNull(origin.deepLink("nako://open?c=javascript:alert(1)"))
        assertNull(origin.deepLink("nako://open?page=settings/.."))
        assertNull(origin.deepLink("nako://open?page=desktop?port=1234"))
        assertNull(origin.deepLink("nako://open?c=%ZZ"))
    }
}
