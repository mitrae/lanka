package ai.lanka.kiosk

import android.content.Context
import android.net.Uri
import android.os.StatFs
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.channels.Channels
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Transparent on-device cache for content-addressed media (`/media/<sha256>`).
 *
 * The web player keeps requesting the normal server URLs; this interceptor:
 *   - serves a local copy when present (NO tailnet traffic), with full HTTP
 *     Range support so `<video>` seeks/loops play straight from disk;
 *   - on a miss, returns null so the WebView loads from the network as usual,
 *     and caches the file in the background for the next loop.
 *
 * Media is content-addressed (the path IS the sha256), so a cached file is
 * always valid — no invalidation needed. Disk use is bounded by a simple LRU
 * size cap (oldest-touched files evicted first).
 */
class MediaCache private constructor(private val dir: File) {

    private val io = Executors.newFixedThreadPool(2)
    private val inFlight = ConcurrentHashMap.newKeySet<String>()

    private constructor(context: Context) : this(File(context.filesDir, "media-cache"))

    init {
        dir.mkdirs()
        // Drop any temp files left behind by a download interrupted in a prior run.
        dir.listFiles { f -> f.name.endsWith(TMP_SUFFIX) }?.forEach { it.delete() }
    }

    fun exists(sha256: String): Boolean = File(dir, sha256).let { it.exists() && it.length() > 0L }

    fun fileUrl(sha256: String): String = "file://${File(dir, sha256).absolutePath}"

    /** The cached file handle for [sha256] (may not exist). For native (ExoPlayer)
     *  playback, which reads local files directly — no http interception needed. */
    fun file(sha256: String): File = File(dir, sha256)

    /**
     * Downloads [url] into the cache under [sha256], blocking until complete.
     * No-op if the file is already cached. Cleans up the partial [TMP_SUFFIX] file
     * immediately on any failure and re-throws so the caller can log/fall-back.
     */
    fun downloadSync(sha256: String, url: String) {
        if (exists(sha256)) return
        val tmp = File(dir, "$sha256$TMP_SUFFIX")
        try {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 15_000
                readTimeout = 60_000
                instanceFollowRedirects = true
            }
            try {
                if (conn.responseCode !in 200..299) throw Exception("HTTP ${conn.responseCode}")
                // Storage guard: skip if we know we don't have enough space.
                // Guard is intentionally skipped when available == 0L (StatFs
                // unavailable in JVM tests / emulator) — let the write fail
                // naturally in that case so tmp cleanup still runs.
                val contentLength = conn.contentLengthLong
                val available = free()
                if (available > 0L && contentLength > 0L && available < contentLength) {
                    Log.w(TAG, "skip $sha256: need ${contentLength}B, have ${available}B")
                    return
                }
                val mime = conn.contentType
                val (written, actualSha) = conn.inputStream.use { copyHashing(it, tmp) }
                verifyDownload(sha256, contentLength, written, actualSha)
                if (tmp.renameTo(File(dir, sha256))) {
                    if (mime != null) File(dir, "$sha256$TYPE_SUFFIX").writeText(mime)
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            tmp.delete()
            throw e
        }
    }

    /**
     * Streams [input] into [tmp], hashing as it goes. Returns bytes written and
     * the sha256 hex. One pass — the 176 MB clips this fleet plays would make a
     * second read for hashing noticeable on an Amlogic box.
     */
    private fun copyHashing(input: InputStream, tmp: File): Pair<Long, String> {
        val md = MessageDigest.getInstance("SHA-256")
        var written = 0L
        tmp.outputStream().use { out ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
                md.update(buf, 0, n)
                written += n
            }
        }
        return written to md.digest().joinToString("") { "%02x".format(it) }
    }

    /**
     * Refuses a download that is not exactly the object asked for. The path IS
     * the content hash, so "close enough" does not exist: a short body would be
     * blessed by [exists] forever and play up to the cut every loop; wrong bytes
     * under the right name would be served to <video> as if genuine. Android's
     * HttpURLConnection does throw on a short body when Content-Length is
     * known, but that is an implementation detail of one stack — the hash is
     * the contract.
     */
    private fun verifyDownload(sha256: String, expectedLength: Long, written: Long, actualSha: String) {
        if (expectedLength > 0L && written != expectedLength) {
            throw IOException("truncated download for $sha256: $written of $expectedLength bytes")
        }
        if (!actualSha.equals(sha256, ignoreCase = true)) {
            throw IOException("hash mismatch for $sha256: body hashes to $actualSha")
        }
    }

    fun evictExcept(keepSha256s: Set<String>) {
        dir.listFiles { f ->
            f.isFile && !f.name.endsWith(TYPE_SUFFIX) && !f.name.endsWith(TMP_SUFFIX)
        }?.filter { it.name !in keepSha256s }?.forEach { f ->
            f.delete()
            File(dir, "${f.name}$TYPE_SUFFIX").delete()
        }
    }

    fun free(): Long = try { StatFs(dir.path).availableBytes } catch (e: Exception) { 0L }

    /** A cached/range response, or null to let the WebView load the request normally. */
    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        if (!request.method.equals("GET", ignoreCase = true)) return null
        val sha = shaFromPath(request.url) ?: return null
        val file = File(dir, sha)
        if (file.exists() && file.length() > 0L) {
            file.setLastModified(System.currentTimeMillis()) // LRU touch
            return try {
                buildResponse(file, mimeFor(sha), rangeHeader(request))
            } catch (e: Exception) {
                Log.w(TAG, "serve-from-cache failed for $sha: ${e.message}")
                null // fall back to the network
            }
        }
        cacheAsync(sha, request.url.toString())
        return null
    }

    private fun shaFromPath(uri: Uri): String? {
        val path = uri.path ?: return null
        return MEDIA_PATH.matchEntire(path)?.groupValues?.get(1)
    }

    private fun rangeHeader(request: WebResourceRequest): String? =
        request.requestHeaders.entries.firstOrNull { it.key.equals("Range", true) }?.value

    private fun cacheAsync(sha: String, url: String) {
        if (!inFlight.add(sha)) return
        io.submit {
            try {
                download(sha, url)
                evictIfNeeded()
            } catch (e: Exception) {
                Log.w(TAG, "cache download failed for $sha: ${e.message}")
            } finally {
                inFlight.remove(sha)
            }
        }
    }

    private fun download(sha: String, url: String) {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 30_000
            instanceFollowRedirects = true
        }
        try {
            if (conn.responseCode !in 200..299) return
            val mime = conn.contentType
            val tmp = File(dir, "$sha.${System.nanoTime()}$TMP_SUFFIX")
            try {
                val (written, actualSha) = conn.inputStream.use { copyHashing(it, tmp) }
                verifyDownload(sha, conn.contentLengthLong, written, actualSha)
                if (tmp.renameTo(File(dir, sha))) {
                    if (mime != null) File(dir, "$sha$TYPE_SUFFIX").writeText(mime)
                } else {
                    tmp.delete()
                }
            } catch (e: Exception) {
                tmp.delete() // previously leaked until the next process start
                throw e
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun mimeFor(sha: String): String {
        val typeFile = File(dir, "$sha$TYPE_SUFFIX")
        if (typeFile.exists()) {
            val t = typeFile.readText().substringBefore(';').trim()
            // A generic/empty stored type means the origin server never set a real
            // Content-Type (older uploads default to application/octet-stream). Serving
            // that to <video> makes it refuse the source, so sniff the magic bytes
            // for a playable type instead.
            if (t.isNotEmpty() && t != OCTET_STREAM) return t
        }
        return sniff(File(dir, sha))
    }

    /** Test seam: resolve the MIME a cached sha would be served with. */
    internal fun mimeForTesting(sha256: String): String = mimeFor(sha256)

    private fun buildResponse(file: File, mime: String, rangeHeader: String?): WebResourceResponse {
        val total = file.length()
        val headers = linkedMapOf(
            "Accept-Ranges" to "bytes",
            "Cache-Control" to "public, max-age=31536000, immutable"
        )
        return when (val plan = planRange(rangeHeader, total)) {
            RangePlan.Full -> {
                headers["Content-Length"] = total.toString()
                WebResourceResponse(mime, null, 200, "OK", headers, FileInputStream(file))
            }
            RangePlan.Unsatisfiable -> {
                // RFC 7233 §4.4. Answering a full 200 here instead would tell
                // Chromium the server ignores ranges, and it would re-read the
                // whole object from 0 — 176 MB through the interceptor for a
                // request that asked for nothing.
                headers["Content-Range"] = "bytes */$total"
                headers["Content-Length"] = "0"
                WebResourceResponse(mime, null, 416, "Range Not Satisfiable", headers, ByteArrayInputStream(ByteArray(0)))
            }
            is RangePlan.Partial -> {
                headers["Content-Range"] = "bytes ${plan.start}-${plan.end}/$total"
                headers["Content-Length"] = (plan.end - plan.start + 1).toString()
                WebResourceResponse(mime, null, 206, "Partial Content", headers, boundedStream(file, plan.start, plan.end))
            }
        }
    }

    /** Test seam for the Range decision. */
    internal fun planRangeForTesting(header: String?, total: Long): RangePlan = planRange(header, total)

    /** Test seam for the positioned stream. */
    internal fun openRangeForTesting(sha256: String, start: Long, end: Long): InputStream =
        boundedStream(File(dir, sha256), start, end)

    /**
     * A stream positioned at exactly [start], yielding at most (end - start + 1)
     * bytes. Positioned through the FileChannel: `InputStream.skip` is allowed
     * to stop short, and the previous loop then served bytes from the wrong
     * offset under a truthful Content-Range — the one interceptor bug that
     * would corrupt playback at a specific timestamp with no error at all.
     */
    private fun boundedStream(file: File, start: Long, end: Long): InputStream {
        val channel = FileInputStream(file).channel
        channel.position(start)
        val src = Channels.newInputStream(channel)
        return object : InputStream() {
            private var remaining = end - start + 1
            override fun read(): Int {
                if (remaining <= 0L) return -1
                val b = src.read()
                if (b >= 0) remaining--
                return b
            }
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (remaining <= 0L) return -1
                val n = src.read(b, off, minOf(len.toLong(), remaining).toInt())
                if (n > 0) remaining -= n
                return n
            }
            override fun close() = channel.close()
        }
    }

    private fun evictIfNeeded() {
        val files = dir.listFiles { f ->
            f.isFile && !f.name.endsWith(TYPE_SUFFIX) && !f.name.endsWith(TMP_SUFFIX)
        } ?: return
        var total = files.sumOf { it.length() }
        if (total <= MAX_BYTES) return
        for (f in files.sortedBy { it.lastModified() }) { // oldest first
            if (total <= MAX_BYTES) break
            val len = f.length()
            if (f.delete()) {
                total -= len
                File(dir, "${f.name}$TYPE_SUFFIX").delete()
            }
        }
    }

    /** How to answer a request given its Range header (or none). */
    internal sealed class RangePlan {
        /** No header, or a malformed one — RFC 7233 §3.1 says ignore it. */
        object Full : RangePlan()
        data class Partial(val start: Long, val end: Long) : RangePlan()
        /** Well-formed but outside the file: 416. */
        object Unsatisfiable : RangePlan()
    }

    private fun planRange(header: String?, total: Long): RangePlan {
        if (header == null) return RangePlan.Full
        val m = RANGE.matchEntire(header.trim()) ?: return RangePlan.Full
        val (s, e) = m.destructured
        return try {
            when {
                s.isEmpty() && e.isNotEmpty() -> {
                    val n = e.toLong()
                    if (n <= 0L) RangePlan.Unsatisfiable
                    else RangePlan.Partial(maxOf(0L, total - n), total - 1)
                }
                s.isNotEmpty() && e.isEmpty() -> {
                    val start = s.toLong()
                    if (start >= total) RangePlan.Unsatisfiable else RangePlan.Partial(start, total - 1)
                }
                s.isNotEmpty() && e.isNotEmpty() -> {
                    val start = s.toLong()
                    val end = minOf(e.toLong(), total - 1)
                    if (start >= total || start > end) RangePlan.Unsatisfiable else RangePlan.Partial(start, end)
                }
                else -> RangePlan.Full // "bytes=-": malformed
            }
        } catch (e: NumberFormatException) {
            RangePlan.Full
        }
    }

    companion object {
        private const val TAG = "LankaCache"
        private const val TYPE_SUFFIX = ".type"
        private const val TMP_SUFFIX = ".tmp"
        private const val OCTET_STREAM = "application/octet-stream"
        private const val MAX_BYTES = 2L * 1024 * 1024 * 1024 // 2 GB LRU cap
        private val MEDIA_PATH = Regex("""/media/([0-9a-f]{64})""")
        private val RANGE = Regex("""bytes=(\d*)-(\d*)""")

        @Volatile
        private var instance: MediaCache? = null

        /** Process-wide singleton so activity recreations don't spawn extra thread pools. */
        fun get(context: Context): MediaCache =
            instance ?: synchronized(this) {
                instance ?: MediaCache(context.applicationContext).also { instance = it }
            }

        /** For unit tests only — constructs a cache backed by an arbitrary directory. */
        internal fun forTesting(dir: File): MediaCache = MediaCache(dir)

        private fun sniff(file: File): String {
            val b = ByteArray(12)
            val n = try { FileInputStream(file).use { it.read(b) } } catch (e: Exception) { -1 }
            if (n < 12) return "application/octet-stream"
            fun u(i: Int) = b[i].toInt() and 0xFF
            return when {
                u(0) == 0xFF && u(1) == 0xD8 -> "image/jpeg"
                u(0) == 0x89 && u(1) == 0x50 && u(2) == 0x4E && u(3) == 0x47 -> "image/png"
                u(0) == 0x47 && u(1) == 0x49 && u(2) == 0x46 -> "image/gif"
                u(4) == 0x66 && u(5) == 0x74 && u(6) == 0x79 && u(7) == 0x70 -> "video/mp4"
                u(0) == 0x52 && u(1) == 0x49 && u(2) == 0x46 &&
                    u(8) == 0x57 && u(9) == 0x45 && u(10) == 0x42 && u(11) == 0x50 -> "image/webp"
                u(0) == 0x1A && u(1) == 0x45 && u(2) == 0xDF && u(3) == 0xA3 -> "video/webm"
                else -> "application/octet-stream"
            }
        }
    }
}
