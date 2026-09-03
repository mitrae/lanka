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
import java.security.MessageDigest

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

    @Test fun `file returns handle inside cache dir ending in sha`() {
        val sha = "a".repeat(64)
        val f = cache.file(sha)
        assertEquals(sha, f.name)
        assertTrue(f.parentFile!!.absolutePath == tempDir.absolutePath)
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
        val sha = sha256Hex(content)
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

    // --- download verification: the path IS the hash ---

    @Test fun `downloadSync rejects a body shorter than Content-Length`() {
        // The JVM's HttpURLConnection returns a clean EOF on a short body — the
        // exact silent-truncation path the verification exists for. Without it
        // the partial file is renamed into place, exists() blesses it forever,
        // and the clip plays up to the cut on every loop.
        val content = "only part of the file arrives".toByteArray()
        val sha = sha256Hex(content)
        val port = serveOnce(200, "video/mp4", content, declaredLength = content.size + 1000)
        var threw = false
        try { cache.downloadSync(sha, "http://127.0.0.1:$port/media") } catch (_: Exception) { threw = true }
        assertTrue("truncated body must throw", threw)
        assertFalse(cache.exists(sha))
        assertEquals(0, (tempDir.listFiles { f -> f.name.endsWith(".tmp") } ?: emptyArray()).size)
    }

    @Test fun `downloadSync rejects bytes whose hash is not the requested sha`() {
        val content = "these are not the bytes you asked for".toByteArray()
        val sha = "e".repeat(64) // deliberately not sha256(content)
        val port = serveOnce(200, "video/mp4", content)
        var threw = false
        try { cache.downloadSync(sha, "http://127.0.0.1:$port/media") } catch (_: Exception) { threw = true }
        assertTrue("hash mismatch must throw", threw)
        assertFalse(cache.exists(sha))
        assertEquals(0, (tempDir.listFiles { f -> f.name.endsWith(".tmp") } ?: emptyArray()).size)
    }

    // --- Range planning (RFC 7233) ---

    @Test fun `no Range header is a full response`() {
        assertEquals(MediaCache.RangePlan.Full, cache.planRangeForTesting(null, 100))
    }

    @Test fun `a malformed Range header is ignored, not rejected`() {
        assertEquals(MediaCache.RangePlan.Full, cache.planRangeForTesting("bytes=abc", 100))
        assertEquals(MediaCache.RangePlan.Full, cache.planRangeForTesting("bytes=-", 100))
        assertEquals(MediaCache.RangePlan.Full, cache.planRangeForTesting("items=0-1", 100))
    }

    @Test fun `well-formed ranges are honoured and clamped`() {
        assertEquals(MediaCache.RangePlan.Partial(0, 9), cache.planRangeForTesting("bytes=0-9", 100))
        assertEquals(MediaCache.RangePlan.Partial(50, 99), cache.planRangeForTesting("bytes=50-", 100))
        assertEquals(MediaCache.RangePlan.Partial(50, 99), cache.planRangeForTesting("bytes=50-500", 100))
        assertEquals(MediaCache.RangePlan.Partial(90, 99), cache.planRangeForTesting("bytes=-10", 100))
        assertEquals(MediaCache.RangePlan.Partial(0, 99), cache.planRangeForTesting("bytes=-1000", 100))
    }

    @Test fun `a range past the end is unsatisfiable, not a silent full body`() {
        // A full 200 here tells Chromium the server ignores ranges, and it
        // re-reads the whole object from 0.
        assertEquals(MediaCache.RangePlan.Unsatisfiable, cache.planRangeForTesting("bytes=100-", 100))
        assertEquals(MediaCache.RangePlan.Unsatisfiable, cache.planRangeForTesting("bytes=500-600", 100))
        assertEquals(MediaCache.RangePlan.Unsatisfiable, cache.planRangeForTesting("bytes=60-50", 100))
        assertEquals(MediaCache.RangePlan.Unsatisfiable, cache.planRangeForTesting("bytes=-0", 100))
    }

    @Test fun `a partial stream serves exactly the requested bytes from the requested offset`() {
        val sha = "a".repeat(64)
        val bytes = ByteArray(1000) { (it % 251).toByte() }
        java.io.File(tempDir, sha).writeBytes(bytes)
        val out = cache.openRangeForTesting(sha, 300, 449).use { it.readBytes() }
        assertEquals(150, out.size)
        assertArrayEquals(bytes.copyOfRange(300, 450), out)
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
        val sha = sha256Hex(content)
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
    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** [declaredLength] lets a test advertise more bytes than it sends. */
    private fun serveOnce(status: Int, contentType: String, body: ByteArray, declaredLength: Int = body.size): Int {
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
                val headers = "$statusLine\r\nContent-Type: $contentType\r\nContent-Length: $declaredLength\r\n\r\n"
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
