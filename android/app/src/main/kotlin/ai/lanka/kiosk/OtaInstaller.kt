package ai.lanka.kiosk

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import android.util.Log
import android.webkit.WebView
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

class OtaInstaller private constructor(private val baseDir: File) {

    private val apkDir = File(baseDir, "apk-cache").also { it.mkdirs() }

    fun exists(sha256: String): Boolean =
        File(apkDir, "$sha256.apk").let { it.exists() && it.length() > 0L }

    fun apkFile(sha256: String): File = File(apkDir, "$sha256.apk")

    /**
     * Marks the box busy for the whole OTA (download → install → OS result). A
     * surface switch restarts the player Activity, which would orphan a half-done
     * OTA; SurfaceSwitcher refuses while [busy]. Cleared on every failure path
     * here, on the immediate-failure paths of [installSilently], and by
     * OtaInstallReceiver when the OS reports the result. A successful install
     * kills the process anyway. Age-capped at [BUSY_MAX_MS] so a wedged OTA (the
     * WebView died between download and install, the result broadcast never
     * came) can never block the rollback path for good.
     */
    fun downloadApk(sha256: String, url: String): Boolean {
        busySince = System.currentTimeMillis()
        val ok = runCatching { downloadInner(sha256, url) }.getOrDefault(false)
        if (!ok) clearBusy()
        return ok
    }

    private fun downloadInner(sha256: String, url: String): Boolean {
        // Reuse the cache only if its bytes still hash to the sha; otherwise drop a
        // stale/unverified file and re-download good bytes (self-heal).
        if (cachedFileIsValid(sha256)) return true
        val dest = apkFile(sha256)
        dest.delete()
        val tmp = File(apkDir, "$sha256.tmp")
        return try {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 15_000
                readTimeout = 120_000
                instanceFollowRedirects = true
            }
            try {
                if (conn.responseCode !in 200..299) {
                    Log.w(TAG, "download HTTP ${conn.responseCode} for $sha256")
                    tmp.delete()
                    return false
                }
                conn.inputStream.use { input -> tmp.outputStream().use { input.copyTo(it) } }
            } finally {
                conn.disconnect()
            }
            // Never trust the downloaded bytes: promote to the install path only
            // if they hash to the expected sha256 (defeats a spoofed/MITM server).
            verifyAndPromote(tmp, dest, sha256)
        } catch (e: Exception) {
            tmp.delete()
            Log.w(TAG, "downloadApk failed for $sha256: ${e.message}")
            false
        }
    }

    internal fun sha256Of(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /**
     * Verify [tmp]'s bytes against [expectedSha256] and, only on a match, promote
     * it to [dest]. A mismatch (corrupt, or a spoofed/MITM'd download) deletes
     * [tmp] and returns false so bad bytes can never become the installed APK.
     * The expected hash comes from the control plane and is the integrity anchor.
     */
    internal fun verifyAndPromote(tmp: File, dest: File, expectedSha256: String): Boolean {
        val actual = sha256Of(tmp)
        if (!actual.equals(expectedSha256, ignoreCase = true)) {
            Log.w(TAG, "APK hash mismatch (want ${expectedSha256.take(12)}…, got ${actual.take(12)}…) — discarding")
            tmp.delete()
            return false
        }
        if (tmp.renameTo(dest)) return true
        tmp.delete()
        return false
    }

    /** True iff the archive shares at least one signing cert with the running app. */
    internal fun signaturesMatch(self: Set<String>, archive: Set<String>): Boolean =
        self.isNotEmpty() && archive.isNotEmpty() && archive.any { it in self }

    /**
     * A cached apk-cache/<sha>.apk is trustworthy only if its bytes actually hash
     * to its sha name. The PRE-FIX build cached downloads with no hash check, so a
     * device upgrading to this build may hold an unverified (possibly MITM-planted)
     * file named by a server-claimed sha; this gates every use of the cache on the
     * real content hash so such a file is never trusted.
     */
    internal fun cachedFileIsValid(sha256: String): Boolean {
        if (!exists(sha256)) return false
        return sha256Of(apkFile(sha256)).equals(sha256, ignoreCase = true)
    }

    @Suppress("DEPRECATION")
    private fun installedSigners(context: Context): Set<String> {
        val pm = context.packageManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            certHashes(
                pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
                    .signingInfo?.apkContentsSigners
            )
        } else {
            certHashes(pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES).signatures)
        }
    }

    @Suppress("DEPRECATION")
    private fun archiveSigners(context: Context, apkPath: String): Set<String> {
        val pm = context.packageManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            certHashes(
                pm.getPackageArchiveInfo(apkPath, PackageManager.GET_SIGNING_CERTIFICATES)
                    ?.signingInfo?.apkContentsSigners
            )
        } else {
            certHashes(pm.getPackageArchiveInfo(apkPath, PackageManager.GET_SIGNATURES)?.signatures)
        }
    }

    private fun certHashes(sigs: Array<Signature>?): Set<String> {
        if (sigs == null) return emptySet()
        val md = MessageDigest.getInstance("SHA-256")
        return sigs.mapNotNull { sig ->
            runCatching { md.digest(sig.toByteArray()).joinToString("") { "%02x".format(it) } }.getOrNull()
        }.toSet()
    }

    fun installSilently(context: Context, sha256: String, commandId: Long, webView: WebView) =
        installSilently(context, sha256, commandId) { status ->
            webView.post {
                webView.evaluateJavascript("window.__otaResult($commandId, '$status')", null)
            }
        }

    /**
     * WebView-free variant for the native (ExoPlayer) player. Identical install
     * flow; the immediate failure paths (missing APK / session throw) report via
     * [onImmediateFailure] instead of a WebView JS call. The OS-delivered result
     * still arrives through [OtaInstallReceiver] → [OtaResultBus], so the native
     * caller passes `{ status -> OtaResultBus.notify(commandId, status) }`.
     */
    fun installSilently(
        context: Context,
        sha256: String,
        commandId: Long,
        onImmediateFailure: (status: String) -> Unit,
    ) {
        fun fail(status: String) { clearBusy(); onImmediateFailure(status) }

        val apk = apkFile(sha256)
        // Re-verify at the point of install (not just at download): refuse to commit
        // any cached file whose bytes don't hash to the expected sha. This closes the
        // stale/pre-fix-cache gap — bad bytes are un-installable regardless of how
        // they reached apk-cache.
        if (!cachedFileIsValid(sha256)) {
            apk.delete()
            Log.w(TAG, "OTA cache for $sha256 missing or hash-mismatched — refusing install")
            fail("failed")
            return
        }

        // Defense-in-depth: a device-owner install bypasses the OS same-signer
        // check, so refuse an APK signed by a different key than the running app.
        // Fail OPEN only when signatures are unreadable on this ROM (don't brick
        // OTA — the bytes were already SHA-verified at download); fail CLOSED on a
        // positive signer mismatch.
        val selfSigners = runCatching { installedSigners(context) }.getOrDefault(emptySet())
        val archiveSigners = runCatching { archiveSigners(context, apk.absolutePath) }.getOrDefault(emptySet())
        if (selfSigners.isNotEmpty() && archiveSigners.isNotEmpty() &&
            !signaturesMatch(selfSigners, archiveSigners)
        ) {
            Log.e(TAG, "OTA signer mismatch — refusing install of $sha256")
            fail("failed")
            return
        }

        // Refuse an archive that would install a DIFFERENT package — e.g. a stale
        // `ai.lanka.kiosk.vs` release from before the single-APK merge. A
        // device-owner install of a foreign package would put a second kiosk on the
        // box. Fail CLOSED: an archive whose package name can't be read is not
        // installed either (the SHA proves integrity, not identity).
        val archivePkg = runCatching {
            context.packageManager.getPackageArchiveInfo(apk.absolutePath, 0)?.packageName
        }.getOrNull()
        if (!packageNameMatches(context.packageName, archivePkg)) {
            Log.e(TAG, "OTA package mismatch: archive=$archivePkg self=${context.packageName} — refusing install")
            fail("failed")
            return
        }

        // Everything session-related inside ONE try so createSession/openSession
        // failures also reach fail() — otherwise busy would stay set.
        var session: PackageInstaller.Session? = null
        try {
            val installer = context.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // Android 12+: an app holding REQUEST_INSTALL_PACKAGES may update
                // *itself* (same signer) with no prompt. A device-owner install is
                // silent regardless; this also covers the non-owner self-update path
                // on certified boxes. If the box still refuses, the commit reports
                // STATUS_PENDING_USER_ACTION and OtaInstallReceiver falls back to the
                // system install prompt.
                params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
            val sessionId = installer.createSession(params)
            val s = installer.openSession(sessionId)
            session = s
            s.openWrite("base.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                s.fsync(out)
            }
            val intent = Intent(context, OtaInstallReceiver::class.java).apply {
                putExtra(OtaInstallReceiver.EXTRA_COMMAND_ID, commandId)
            }
            val pendingIntent = PendingIntent.getBroadcast(
                context, commandId.toInt(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            )
            s.commit(pendingIntent.intentSender)
        } catch (e: Exception) {
            runCatching { session?.abandon() }
            Log.e(TAG, "installSilently failed: ${e.message}")
            fail("failed")
        } finally {
            runCatching { session?.close() } // release our handle; a committed session is the OS's now
        }
    }

    companion object {
        private const val TAG = "OtaInstaller"

        @Volatile private var instance: OtaInstaller? = null

        fun get(context: Context): OtaInstaller =
            instance ?: synchronized(this) {
                instance ?: OtaInstaller(context.filesDir).also { instance = it }
            }

        /** For unit tests only. */
        internal fun forTesting(dir: File): OtaInstaller = OtaInstaller(dir)

        /**
         * Epoch ms when the current OTA started; 0 when idle. See [downloadApk].
         * Read through [busy] / [isBusy] so a wedged OTA expires after [BUSY_MAX_MS].
         */
        @Volatile private var busySince: Long = 0L
        const val BUSY_MAX_MS = 15 * 60_000L

        fun isBusy(now: Long = System.currentTimeMillis()): Boolean =
            busySince != 0L && now - busySince < BUSY_MAX_MS

        val busy: Boolean get() = isBusy()

        fun clearBusy() { busySince = 0L }

        /** Fail CLOSED: a foreign OR unreadable package name is refused. */
        internal fun packageNameMatches(self: String, archive: String?): Boolean =
            archive == self
    }
}
