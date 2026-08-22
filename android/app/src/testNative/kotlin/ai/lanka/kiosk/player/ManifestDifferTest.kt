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

    // --- seed(): boot-time replay of a persisted manifest ---------------------

    @Test fun `seeded key makes the same manifest a no-op`() {
        // The offline replay already put this playlist on screen; the first live
        // fetch must not tear the PlaybackView down and rebuild it.
        val d = ManifestDiffer()
        d.seed(ManifestKey(1, 1))
        assertEquals(ManifestDecision.Ignore, d.onFetched(m(1, 1)))
    }

    @Test fun `seeded differ still emits a newer version`() {
        val d = ManifestDiffer()
        d.seed(ManifestKey(1, 1))
        assertTrue(d.onFetched(m(1, 2)) is ManifestDecision.Emit)
    }

    @Test fun `seeded differ still emits a different playlist`() {
        val d = ManifestDiffer()
        d.seed(ManifestKey(1, 1))
        assertTrue(d.onFetched(m(2, 1)) is ManifestDecision.Emit)
    }

    @Test fun `seeded differ emits null when the playlist is unassigned`() {
        // Replayed from disk, then the server says 204 — the screen must clear.
        val d = ManifestDiffer()
        d.seed(ManifestKey(1, 1))
        assertEquals(ManifestDecision.EmitNull, d.onFetched(null))
    }

    @Test fun `unseeded differ emits the same manifest`() {
        // A degraded replay leaves the differ unseeded on purpose, so the
        // server's complete manifest still gets through.
        val d = ManifestDiffer()
        assertTrue(d.onFetched(m(1, 1)) is ManifestDecision.Emit)
    }
}
