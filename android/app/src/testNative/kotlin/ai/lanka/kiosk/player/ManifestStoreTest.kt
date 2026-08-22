package ai.lanka.kiosk.player

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class ManifestStoreTest {
    private val json = Json { ignoreUnknownKeys = true }

    private fun tempFile(): File =
        File(Files.createTempDirectory("manifest-store").toFile(), ManifestStore.FILE_NAME)

    private fun m(v: Int = 3) =
        Manifest(2, "Lobby", v, listOf(ManifestItem(1, "video", "sha-a", 5000)))

    @Test fun `load returns null when nothing was ever saved`() {
        assertNull(ManifestStore(tempFile(), json).load())
    }

    @Test fun `saved manifest round-trips`() {
        val f = tempFile()
        ManifestStore(f, json).save(m())
        val loaded = ManifestStore(f, json).load()
        assertEquals(m(), loaded)
    }

    @Test fun `save creates missing parent directories`() {
        val nested = File(
            Files.createTempDirectory("manifest-store").toFile(),
            "a/b/c/${ManifestStore.FILE_NAME}"
        )
        ManifestStore(nested, json).save(m())
        assertTrue(nested.exists())
        assertEquals(m(), ManifestStore(nested, json).load())
    }

    @Test fun `save overwrites a previous manifest`() {
        val f = tempFile()
        val store = ManifestStore(f, json)
        store.save(m(1))
        store.save(m(9))
        assertEquals(9, store.load()?.version)
    }

    @Test fun `clear removes the saved manifest`() {
        val f = tempFile()
        val store = ManifestStore(f, json)
        store.save(m())
        store.clear()
        assertNull(store.load())
        assertFalse(f.exists())
    }

    @Test fun `corrupt file loads as null instead of throwing`() {
        // A power cut mid-write (these boxes die by having the mains pulled) must
        // not poison every subsequent boot.
        val f = tempFile()
        f.parentFile!!.mkdirs()
        f.writeText("{ not json")
        assertNull(ManifestStore(f, json).load())
    }

    @Test fun `save leaves no temp file behind`() {
        val f = tempFile()
        ManifestStore(f, json).save(m())
        val strays = f.parentFile!!.listFiles()?.filter { it.name.endsWith(".tmp") }.orEmpty()
        assertTrue(strays.isEmpty())
    }
}
