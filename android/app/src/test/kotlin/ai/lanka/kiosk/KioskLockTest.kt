package ai.lanka.kiosk

import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class KioskLockTest {

    @After
    fun restoreDefaults() {
        KioskLock.listener = null
        KioskLock.locked = true
    }

    @Test
    fun `defaults to locked`() {
        assertTrue(KioskLock.locked)
    }

    @Test
    fun `setting locked notifies the listener with the new value`() {
        val seen = mutableListOf<Boolean>()
        KioskLock.listener = { seen.add(it) }
        KioskLock.locked = false
        KioskLock.locked = true
        assertEquals(listOf(false, true), seen)
    }

    @Test
    fun `a cleared listener is not called`() {
        val seen = mutableListOf<Boolean>()
        KioskLock.listener = { seen.add(it) }
        KioskLock.listener = null
        KioskLock.locked = false
        assertTrue(seen.isEmpty())
    }
}
