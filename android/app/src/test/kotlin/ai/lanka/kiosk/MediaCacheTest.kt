package ai.lanka.kiosk

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.ServerSocket
import java.nio.file.Files

class MediaCacheTest {

    private lateinit var tempDir: java.io.File
    private lateinit var cache: MediaCache

    @Before fun setup() {
        tempDir = Files.createTempDirectory("media-cache-test").toFile()
        cache = MediaCache.forTesting(tempDir)
    }

    @After fun teardown() {
        tempDir.deleteRecursively()
    }

    // --- exists / fileUrl ---

    @Test fun `exists returns false for missing file`() {
        assertFalse(cache.exists("a".repeat(64)))
    }

    @Test fun `exists returns false for empty file`() {
        java.io.File(tempDir, "a".repeat(64)).createNewFile()
        assertFalse(cache.exists("a".repeat(64)))
    }

    @Test fun `exists returns true for non-empty file`() {
        java.io.File(tempDir, "a".repeat(64)).writeBytes(byteArrayOf(1))
        assertTrue(cache.exists("a".repeat(64)))
    }

    @Test fun `fileUrl returns file URI ending in sha`() {
        val sha = "b".repeat(64)
        assertTrue(cache.fileUrl(sha).startsWith("file://"))
        assertTrue(cache.fileUrl(sha).endsWith(sha))
    }

    // --- downloadSync ---

    @Test fun `downloadSync is no-op when already cached`() {
        val sha = "c".repeat(64)
        java.io.File(tempDir, sha).writeBytes(byteArrayOf(9, 8, 7))
        // Bogus URL — would fail if actually attempted, but should be skipped
        cache.downloadSync(sha, "http://127.0.0.1:1/no-such")
        assertEquals(3L, java.io.File(tempDir, sha).length())
    }

    @Test fun `downloadSync cleans up tmp on connection failure`() {
        val sha = "d".repeat(64)
        try {
            cache.downloadSync(sha, "http://127.0.0.1:1/no-such")  // connection refused
        } catch (_: Exception) { }
        val tmpFiles = tempDir.listFiles { f -> f.name.endsWith(".tmp") } ?: emptyArray()
        assertEquals("no .tmp files should remain after failure", 0, tmpFiles.size)
        assertFalse(cache.exists(sha))
    }

    @Test fun `downloadSync downloads file successfully`() {
        val content = "hello media content".toByteArray()
        val sha = "e".repeat(64)
        val port = serveOnce(200, "video/mp4", content)
        cache.downloadSync(sha, "http://127.0.0.1:$port/media")
        assertTrue(cache.exists(sha))
        assertArrayEquals(content, java.io.File(tempDir, sha).readBytes())
    }

    @Test fun `downloadSync throws and leaves no tmp on non-2xx response`() {
        val sha = "f".repeat(64)
        val port = serveOnce(404, "text/plain", ByteArray(0))
        var threw = false
        try {
            cache.downloadSync(sha, "http://127.0.0.1:$port/missing")
        } catch (_: Exception) {
            threw = true
        }
        assertTrue("should throw on 404", threw)
        assertFalse(cache.exists(sha))
        val tmpFiles = tempDir.listFiles { f -> f.name.endsWith(".tmp") } ?: emptyArray()
        assertEquals(0, tmpFiles.size)
    }

    // --- mimeFor (served Content-Type for the interceptor) ---

    @Test fun `mimeFor sniffs mp4 when stored type is octet-stream`() {
        val sha = "a".repeat(64)
        val mp4 = ByteArray(12).apply {
            this[4] = 0x66; this[5] = 0x74; this[6] = 0x79; this[7] = 0x70  // 'ftyp'
        }
        java.io.File(tempDir, sha).writeBytes(mp4)
        java.io.File(tempDir, "$sha.type").writeText("application/octet-stream")
        assertEquals("video/mp4", cache.mimeForTesting(sha))
    }

    @Test fun `mimeFor honors a real stored type without sniffing`() {
        val sha = "b".repeat(64)
        java.io.File(tempDir, sha).writeBytes(ByteArray(12))  // would sniff to octet-stream
        java.io.File(tempDir, "$sha.type").writeText("video/webm")
        assertEquals("video/webm", cache.mimeForTesting(sha))
    }

    @Test fun `mimeFor sniffs when no type sidecar exists`() {
        val sha = "c".repeat(64)
        val png = ByteArray(12).apply {
            this[0] = 0x89.toByte(); this[1] = 0x50; this[2] = 0x4E; this[3] = 0x47  // PNG
        }
        java.io.File(tempDir, sha).writeBytes(png)
        assertEquals("image/png", cache.mimeForTesting(sha))
    }

    // --- evictExcept ---

    @Test fun `evictExcept removes files not in keep set`() {
        val keep = "a".repeat(64)
        val evict = "b".repeat(64)
        java.io.File(tempDir, keep).writeBytes(byteArrayOf(1))
        java.io.File(tempDir, evict).writeBytes(byteArrayOf(2))
        cache.evictExcept(setOf(keep))
        assertTrue(java.io.File(tempDir, keep).exists())
        assertFalse(java.io.File(tempDir, evict).exists())
    }

    @Test fun `evictExcept also removes type sidecar files`() {
        val evict = "c".repeat(64)
        java.io.File(tempDir, evict).writeBytes(byteArrayOf(1))
        java.io.File(tempDir, "$evict.type").writeText("video/mp4")
        cache.evictExcept(emptySet())
        assertFalse(java.io.File(tempDir, evict).exists())
        assertFalse(java.io.File(tempDir, "$evict.type").exists())
    }

    @Test fun `evictExcept is safe on empty cache`() {
        cache.evictExcept(emptySet())  // must not throw
    }

    // --- storage guard ---

    @Test fun `downloadSync proceeds when StatFs is unavailable (free returns 0)`() {
        // In JVM tests StatFs is unavailable so free() returns 0L. The storage
        // guard must NOT block the download in that case — only block when
        // available is known positive but still less than contentLength.
        val content = "guard test content".toByteArray()
        val sha = "g".repeat(64)
        val port = serveOnce(200, "video/mp4", content)
        cache.downloadSync(sha, "http://127.0.0.1:$port/media")
        assertTrue(cache.exists(sha))
    }

    // --- free ---

    @Test fun `free does not throw`() {
        // StatFs is an Android-only API; in JVM tests the catch block returns 0L.
        assertTrue(cache.free() >= 0L)
    }

    // --- helpers ---

    /**
     * Starts a single-request HTTP server on an ephemeral port, serves one
     * response, then shuts down. Returns the port. Uses only standard Java —
     * no external dependencies.
     */
    private fun serveOnce(status: Int, contentType: String, body: ByteArray): Int {
        val ss = ServerSocket(0)
        val port = ss.localPort
        Thread {
            runCatching {
                val client = ss.accept()
                // Drain the request headers
                val reader = client.getInputStream().bufferedReader()
                while (reader.readLine()?.isNotEmpty() == true) { }
                // Send response
                val statusLine = when (status) {
                    200 -> "HTTP/1.1 200 OK"
                    404 -> "HTTP/1.1 404 Not Found"
                    else -> "HTTP/1.1 $status"
                }
                val headers = "$statusLine\r\nContent-Type: $contentType\r\nContent-Length: ${body.size}\r\n\r\n"
                client.getOutputStream().apply {
                    write(headers.toByteArray())
                    write(body)
                    flush()
                }
                client.close()
            }
            ss.close()
        }.also { it.isDaemon = true }.start()
        return port
    }
}
