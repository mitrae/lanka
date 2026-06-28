package ai.lanka.kiosk.player
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ManifestDifferTest {
    private fun m(pl: Int, v: Int) = Manifest(pl, "p", v, listOf(ManifestItem(1, "video", "sha-1", 1000)))

    @Test fun `first non-null emits`() {
        val d = ManifestDiffer()
        assertTrue(d.onFetched(m(1, 1)) is ManifestDecision.Emit)
    }
    @Test fun `unchanged key is ignored`() {
        val d = ManifestDiffer(); d.onFetched(m(1, 1))
        assertEquals(ManifestDecision.Ignore, d.onFetched(m(1, 1)))
    }
    @Test fun `version bump re-emits`() {
        val d = ManifestDiffer(); d.onFetched(m(1, 1))
        assertTrue(d.onFetched(m(1, 2)) is ManifestDecision.Emit)
    }
    @Test fun `first null emits null once then ignores`() {
        val d = ManifestDiffer()
        assertEquals(ManifestDecision.EmitNull, d.onFetched(null))
        assertEquals(ManifestDecision.Ignore, d.onFetched(null))
    }
    @Test fun `manifest then null emits null`() {
        val d = ManifestDiffer(); d.onFetched(m(1, 1))
        assertEquals(ManifestDecision.EmitNull, d.onFetched(null))
    }
}
