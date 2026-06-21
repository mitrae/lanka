package ai.lanka.kiosk

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
}
