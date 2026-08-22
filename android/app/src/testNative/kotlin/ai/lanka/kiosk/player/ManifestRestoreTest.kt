package ai.lanka.kiosk.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ManifestRestoreTest {
    private fun item(id: Int, sha: String) = ManifestItem(id, "video", sha, 1000)
    private fun m(vararg shas: String) =
        Manifest(1, "p", 7, shas.mapIndexed { i, s -> item(i + 1, s) })

    private val allCached: (String) -> Boolean = { true }
    private val noneCached: (String) -> Boolean = { false }

    @Test fun `null saved manifest restores nothing`() {
        assertEquals(RestoreDecision.Nothing, restorableManifest(null, allCached))
    }

    @Test fun `empty saved manifest restores nothing`() {
        val empty = Manifest(1, "p", 7, emptyList())
        assertEquals(RestoreDecision.Nothing, restorableManifest(empty, allCached))
    }

    @Test fun `nothing cached restores nothing`() {
        assertEquals(RestoreDecision.Nothing, restorableManifest(m("a", "b"), noneCached))
    }

    @Test fun `fully cached manifest replays complete`() {
        val d = restorableManifest(m("a", "b"), allCached)
        assertTrue(d is RestoreDecision.Replay)
        d as RestoreDecision.Replay
        assertTrue(d.complete)
        assertEquals(listOf("a", "b"), d.manifest.items.map { it.sha256 })
    }

    @Test fun `uncached items are dropped and replay is marked incomplete`() {
        val d = restorableManifest(m("a", "b", "c")) { it != "b" }
        assertTrue(d is RestoreDecision.Replay)
        d as RestoreDecision.Replay
        assertEquals(listOf("a", "c"), d.manifest.items.map { it.sha256 })
        // Partial replay must NOT be marked complete: seeding the differ with it
        // would make the live manifest look unchanged and strand the player on
        // the reduced playlist until the next version bump.
        assertTrue(!d.complete)
    }

    @Test fun `replay preserves playlist identity so the differ can dedupe`() {
        val d = restorableManifest(m("a"), allCached) as RestoreDecision.Replay
        assertEquals(1, d.manifest.playlistId)
        assertEquals(7, d.manifest.version)
        assertEquals("p", d.manifest.playlistName)
    }
}
