package ai.lanka.kiosk

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import android.webkit.WebView
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

class OtaInstaller private constructor(private val baseDir: File) {

    private val apkDir = File(baseDir, "apk-cache").also { it.mkdirs() }

    fun exists(sha256: String): Boolean =
        File(apkDir, "$sha256.apk").let { it.exists() && it.length() > 0L }

    fun apkFile(sha256: String): File = File(apkDir, "$sha256.apk")

    fun downloadApk(sha256: String, url: String): Boolean {
        if (exists(sha256)) return true
        val dest = apkFile(sha256)
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
                    return false
                }
                conn.inputStream.use { input -> tmp.outputStream().use { input.copyTo(it) } }
                tmp.renameTo(dest)
            } finally {
                conn.disconnect()
            }
            true
        } catch (e: Exception) {
            tmp.delete()
            Log.w(TAG, "downloadApk failed for $sha256: ${e.message}")
            false
        }
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
        val apk = apkFile(sha256)
        if (!apk.exists()) {
            onImmediateFailure("failed")
            return
        }
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
        val session = installer.openSession(sessionId)
        try {
            session.openWrite("base.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val intent = Intent(context, OtaInstallReceiver::class.java).apply {
                putExtra(OtaInstallReceiver.EXTRA_COMMAND_ID, commandId)
            }
            val pendingIntent = PendingIntent.getBroadcast(
                context, commandId.toInt(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            )
            session.commit(pendingIntent.intentSender)
        } catch (e: Exception) {
            session.abandon()
            Log.e(TAG, "installSilently failed: ${e.message}")
            onImmediateFailure("failed")
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
    }
}
