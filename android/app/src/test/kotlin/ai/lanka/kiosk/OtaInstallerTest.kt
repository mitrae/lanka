package ai.lanka.kiosk

import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class OtaInstallerTest {

    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun `downloadApk writes file to apk-cache dir`() {
        // We can't make a real HTTP call in JVM tests — test the path logic instead
        val installer = OtaInstaller.forTesting(tmp.root)
        val apkDir = File(tmp.root, "apk-cache")
        apkDir.mkdirs()
        // Write a fake APK directly to simulate a successful download
        val sha256 = "a".repeat(64)
        val dest = File(apkDir, "$sha256.apk")
        dest.writeBytes(byteArrayOf(0x50, 0x4B, 0x03, 0x04)) // PK magic bytes
        assertTrue(installer.exists(sha256))
    }

    @Test
    fun `exists returns false for unknown sha256`() {
        val installer = OtaInstaller.forTesting(tmp.root)
        assertFalse(installer.exists("b".repeat(64)))
    }

    // SHA-256 of the ASCII bytes "abc" (a standard test vector).
    private val abcSha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

    @Test
    fun `sha256Of computes the hex digest of the file bytes`() {
        val installer = OtaInstaller.forTesting(tmp.root)
        val f = File(tmp.root, "x.bin").apply { writeBytes("abc".toByteArray()) }
        assertEquals(abcSha, installer.sha256Of(f))
    }

    @Test
    fun `verifyAndPromote moves tmp to dest when the hash matches`() {
        val installer = OtaInstaller.forTesting(tmp.root)
        val src = File(tmp.root, "d.tmp").apply { writeBytes("abc".toByteArray()) }
        val dest = File(tmp.root, "d.apk")
        assertTrue(installer.verifyAndPromote(src, dest, abcSha))
        assertTrue(dest.exists())
        assertFalse(src.exists())
    }

    @Test
    fun `verifyAndPromote rejects mismatched bytes and never creates dest`() {
        val installer = OtaInstaller.forTesting(tmp.root)
        val src = File(tmp.root, "d.tmp").apply { writeBytes("abc".toByteArray()) }
        val dest = File(tmp.root, "d.apk")
        // The expected sha is the security anchor: bytes that don't match it must
        // NEVER become the installed APK (spoofed/MITM'd download).
        assertFalse(installer.verifyAndPromote(src, dest, "0".repeat(64)))
        assertFalse(dest.exists())
        assertFalse(src.exists()) // tmp cleaned up
    }

    @Test
    fun `verifyAndPromote accepts an uppercase expected hash`() {
        val installer = OtaInstaller.forTesting(tmp.root)
        val src = File(tmp.root, "d.tmp").apply { writeBytes("abc".toByteArray()) }
        val dest = File(tmp.root, "d.apk")
        assertTrue(installer.verifyAndPromote(src, dest, abcSha.uppercase()))
        assertTrue(dest.exists())
    }

    @Test
    fun `signaturesMatch is true only when archive shares a signer with the running app`() {
        val installer = OtaInstaller.forTesting(tmp.root)
        assertTrue(installer.signaturesMatch(setOf("aa", "bb"), setOf("aa")))
        assertFalse(installer.signaturesMatch(setOf("aa"), setOf("cc")))
        assertFalse(installer.signaturesMatch(setOf("aa"), emptySet())) // unsigned/unreadable archive
        assertFalse(installer.signaturesMatch(emptySet(), setOf("aa"))) // can't read self
    }

    @Test
    fun `cachedFileIsValid is true only when cached bytes hash to the sha filename`() {
        val installer = OtaInstaller.forTesting(tmp.root)
        val apkDir = File(tmp.root, "apk-cache").apply { mkdirs() }

        // Honest cache: file name == sha256 of its bytes.
        File(apkDir, "$abcSha.apk").writeBytes("abc".toByteArray())
        assertTrue(installer.cachedFileIsValid(abcSha))

        // Stale/pre-fix/planted file: name does NOT match content hash. A device
        // upgrading from the pre-fix APK may hold exactly this — it must not be
        // treated as a verified install candidate.
        File(apkDir, "${"0".repeat(64)}.apk").writeBytes("abc".toByteArray())
        assertFalse(installer.cachedFileIsValid("0".repeat(64)))

        // Absent.
        assertFalse(installer.cachedFileIsValid("b".repeat(64)))
    }

    @After
    fun resetBusy() { OtaInstaller.clearBusy() }

    @Test
    fun `packageNameMatches refuses a foreign or unreadable package`() {
        assertTrue(OtaInstaller.packageNameMatches("ai.lanka.kiosk", "ai.lanka.kiosk"))
        assertFalse(OtaInstaller.packageNameMatches("ai.lanka.kiosk", "ai.lanka.kiosk.vs"))
        assertFalse(OtaInstaller.packageNameMatches("ai.lanka.kiosk", null)) // fail CLOSED
    }

    @Test
    fun `busy clears when a download fails`() {
        val installer = OtaInstaller.forTesting(tmp.root)
        // MalformedURLException → the download's catch → false. Deterministic, no network.
        assertFalse(installer.downloadApk("c".repeat(64), "not-a-valid-url"))
        assertFalse(OtaInstaller.busy)
    }

    @Test
    fun `busy stays set after a successful download and expires after BUSY_MAX_MS`() {
        val installer = OtaInstaller.forTesting(tmp.root)
        val apkDir = File(tmp.root, "apk-cache").apply { mkdirs() }
        File(apkDir, "$abcSha.apk").writeBytes("abc".toByteArray()) // valid cache hit, no network
        val t0 = System.currentTimeMillis()
        assertTrue(installer.downloadApk(abcSha, "http://unused.invalid/x.apk"))
        assertTrue(OtaInstaller.busy)
        assertTrue(OtaInstaller.isBusy(t0 + OtaInstaller.BUSY_MAX_MS - 1_000))
        assertFalse(OtaInstaller.isBusy(t0 + OtaInstaller.BUSY_MAX_MS + 1_000))
    }
}
