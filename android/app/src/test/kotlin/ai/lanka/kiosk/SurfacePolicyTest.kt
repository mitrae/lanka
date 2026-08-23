package ai.lanka.kiosk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SurfacePolicyTest {
    private val t0 = 1_000_000L
    private val window = SurfacePolicy.WINDOW_MS

    @Test fun `parse accepts exact wire names only`() {
        assertEquals(SurfaceKind.NATIVE, SurfaceKind.parse("native"))
        assertEquals(SurfaceKind.WEBVIEW, SurfaceKind.parse("webview"))
        assertNull(SurfaceKind.parse("Native"))
        assertNull(SurfaceKind.parse(null))
    }

    @Test fun `absent state runs webview and is not pending`() {
        val s = SurfaceState()
        assertEquals(SurfaceKind.WEBVIEW, s.surface)
        assertEquals(SurfaceKind.WEBVIEW, s.lastGood)
        assertFalse(s.pending)
    }

    @Test fun `requesting the current surface is a no-op`() {
        assertNull(SurfacePolicy.requestSwitch(SurfaceState(), SurfaceKind.WEBVIEW, t0))
    }

    @Test fun `a switch sets pending and keeps lastGood`() {
        val s = SurfacePolicy.requestSwitch(SurfaceState(), SurfaceKind.NATIVE, t0)!!
        assertEquals(SurfaceKind.NATIVE, s.surface)
        assertEquals(SurfaceKind.WEBVIEW, s.lastGood)
        assertEquals(t0, s.pendingSince)
        assertEquals(0, s.starts)
    }

    @Test fun `cold start when not pending changes nothing`() {
        val out = SurfacePolicy.onColdStart(SurfaceState(), t0)
        assertEquals(SurfaceState(), out.state)
        assertFalse(out.reverted)
    }

    @Test fun `cold starts inside the window count and the third reverts`() {
        var s = SurfacePolicy.requestSwitch(SurfaceState(), SurfaceKind.NATIVE, t0)!!
        s = SurfacePolicy.onColdStart(s, t0 + 1_000).also { assertFalse(it.reverted) }.state
        assertEquals(1, s.starts)
        s = SurfacePolicy.onColdStart(s, t0 + 2_000).also { assertFalse(it.reverted) }.state
        assertEquals(2, s.starts)
        val out = SurfacePolicy.onColdStart(s, t0 + 3_000)
        assertTrue(out.reverted)
        assertEquals(SurfaceKind.WEBVIEW, out.state.surface)
        assertEquals(SurfaceKind.WEBVIEW, out.state.lastGood)
        assertFalse(out.state.pending)
        assertEquals(0, out.state.starts)
    }

    @Test fun `a cold start after the window stops guarding without reverting`() {
        val s = SurfacePolicy.requestSwitch(SurfaceState(), SurfaceKind.NATIVE, t0)!!.copy(starts = 2)
        val out = SurfacePolicy.onColdStart(s, t0 + window + 1)
        assertFalse(out.reverted)
        assertEquals(SurfaceKind.NATIVE, out.state.surface)
        assertEquals(SurfaceKind.WEBVIEW, out.state.lastGood)
        assertFalse(out.state.pending)
        assertEquals(0, out.state.starts)
    }

    @Test fun `confirm promotes the surface to lastGood and clears pending`() {
        val s = SurfacePolicy.confirm(SurfacePolicy.requestSwitch(SurfaceState(), SurfaceKind.NATIVE, t0)!!)
        assertEquals(SurfaceKind.NATIVE, s.surface)
        assertEquals(SurfaceKind.NATIVE, s.lastGood)
        assertFalse(s.pending)
        assertEquals(0, s.starts)
    }

    @Test fun `startFailed reverts only while pending`() {
        val pending = SurfacePolicy.requestSwitch(SurfaceState(), SurfaceKind.NATIVE, t0)!!
        val out = SurfacePolicy.startFailed(pending)
        assertTrue(out.reverted)
        assertEquals(SurfaceKind.WEBVIEW, out.state.surface)
        assertFalse(out.state.pending)

        val settled = SurfacePolicy.startFailed(SurfaceState(surface = SurfaceKind.NATIVE, lastGood = SurfaceKind.NATIVE))
        assertFalse(settled.reverted)
        assertEquals(SurfaceKind.NATIVE, settled.state.surface)
    }

    @Test fun `a flip back before confirmation leaves nothing to revert to`() {
        val toNative = SurfacePolicy.requestSwitch(SurfaceState(), SurfaceKind.NATIVE, t0)!!
        val back = SurfacePolicy.requestSwitch(toNative, SurfaceKind.WEBVIEW, t0 + 10)!!
        assertEquals(SurfaceKind.WEBVIEW, back.surface)
        assertEquals(SurfaceKind.WEBVIEW, back.lastGood)
        assertTrue(back.pending)
        var s = back
        repeat(2) { s = SurfacePolicy.onColdStart(s, t0 + 20).state }
        val out = SurfacePolicy.onColdStart(s, t0 + 30)
        assertFalse(out.reverted)
        assertEquals(SurfaceKind.WEBVIEW, out.state.surface)
        assertFalse(out.state.pending)
    }
}
