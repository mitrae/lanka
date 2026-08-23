package ai.lanka.kiosk.player
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShouldReconcileTest {
    @Test fun `null prev always reconciles`() = assertTrue(shouldReconcile(null, ManifestKey(1, 1)))
    @Test fun `same key does not reconcile`() = assertFalse(shouldReconcile(ManifestKey(1, 2), ManifestKey(1, 2)))
    @Test fun `version change reconciles`() = assertTrue(shouldReconcile(ManifestKey(1, 1), ManifestKey(1, 2)))
    @Test fun `playlist change reconciles`() = assertTrue(shouldReconcile(ManifestKey(1, 1), ManifestKey(2, 1)))
}
