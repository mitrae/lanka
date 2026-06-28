package ai.lanka.kiosk.player
import org.junit.Assert.assertEquals
import org.junit.Test

class BackoffTest {
    @Test fun `grows exponentially from 1s`() {
        assertEquals(1000L, backoff(0)); assertEquals(2000L, backoff(1)); assertEquals(4000L, backoff(2))
    }
    @Test fun `caps at 30s`() {
        assertEquals(30_000L, backoff(10)); assertEquals(30_000L, backoff(100))
    }
}
