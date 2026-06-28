package ai.lanka.kiosk.player

import ai.lanka.kiosk.MediaCache
import ai.lanka.kiosk.R
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import java.util.concurrent.Executors

/**
 * Native (ExoPlayer) analogue of the web player's `PlayerStage.vue`.
 *
 * Two A/B slots, each a Media3 [PlayerView] (TextureView output, for alpha
 * blending) stacked over an [ImageView]. The *front* slot is visible and
 * playing; the *back* slot preloads the next item. On a scheduler transition we
 * flip which slot is front, crossfade their alphas (~120ms), play the new
 * front, and arm the new back slot with the next preload target.
 *
 * Self-heal mirrors PlayerStage: after [MAX_CONSECUTIVE_ERRORS] consecutive
 * media errors we stop error-driven advancing, show a "stalled" banner, and
 * retry the current items after [RECOVERY_DELAY_MS] — a slow self-healing loop
 * rather than a permanently dark screen. A successful item start / image load
 * resets the counter.
 *
 * Construction is decoupled from networking: pass a [fileUrlResolver]
 * (sha → playable [Uri]: the cached local file when present, else a CDN/proxy
 * URL) and the telemetry callbacks the host activity wants forwarded.
 */
@UnstableApi
class PlaybackView @JvmOverloads constructor(
    context: Context,
    private val mediaCache: MediaCache,
    /** sha256 → playable Uri. Defaults to local-file-if-cached, else CDN/proxy. */
    private val fileUrlResolver: (String) -> Uri = { sha ->
        if (mediaCache.exists(sha)) Uri.fromFile(mediaCache.file(sha))
        else Uri.parse(sha) // host should always supply a real resolver
    },
    private val onItemStarted: (itemId: Int) -> Unit = {},
    private val onItemFailed: (itemId: Int?, sha256: String?, message: String) -> Unit = { _, _, _ -> },
    private val onCleared: () -> Unit = {}
) : FrameLayout(context) {

    private companion object {
        const val MAX_CONSECUTIVE_ERRORS = 5
        const val RECOVERY_DELAY_MS = 15_000L
        const val CROSSFADE_MS = 120L
    }

    // Slot A/B swap. When `frontIsA` is true, slot A is front (visible), B is back.
    private var frontIsA = true

    // The two A/B slot containers (crossfaded as a unit), their PlayerViews and ImageViews.
    private val slotAView: FrameLayout
    private val slotBView: FrameLayout
    private val playerViewA: PlayerView
    private val playerViewB: PlayerView
    private val imageViewA: ImageView
    private val imageViewB: ImageView
    private val stalledBanner: TextView

    // One ExoPlayer per slot.
    private val exoA: ExoPlayer
    private val exoB: ExoPlayer

    // Which manifest item each slot currently holds (for type/ended/error routing).
    private var itemInA: ManifestItem? = null
    private var itemInB: ManifestItem? = null

    private var manifest: Manifest? = null
    private var scheduler: Scheduler? = null
    private val unsubscribers = mutableListOf<() -> Unit>()

    // Self-heal state.
    private var consecutiveErrors = 0
    private var stalled = false
    private val mainHandler = Handler(Looper.getMainLooper())
    private var recoveryPending = false
    private val recoveryRunnable = Runnable {
        recoveryPending = false
        // Retry the current items. If media/network recovered, the stall clears
        // and playback resumes; if not, errors climb back to the threshold and we
        // re-arm — a slow self-healing retry instead of a permanently dark screen.
        consecutiveErrors = 0
        setStalled(false)
        mountInitial()
    }

    // Off-UI-thread image decode pool (mirrors the web <img> async decode).
    private val decodeIo = Executors.newSingleThreadExecutor { r ->
        Thread(r, "playback-decode").apply { isDaemon = true }
    }
    private var released = false

    init {
        LayoutInflater.from(context).inflate(R.layout.activity_player, this, true)
        slotAView = findViewById(R.id.slotA)
        slotBView = findViewById(R.id.slotB)
        playerViewA = findViewById(R.id.videoA)
        playerViewB = findViewById(R.id.videoB)
        imageViewA = findViewById(R.id.imageA)
        imageViewB = findViewById(R.id.imageB)
        stalledBanner = findViewById(R.id.stalledBanner)

        exoA = buildPlayer(SlotId.A)
        exoB = buildPlayer(SlotId.B)
        playerViewA.player = exoA
        playerViewB.player = exoB

        // Front = A starts visible; back = B starts transparent (matches XML alpha=0).
        slotAView.alpha = 1f
        slotBView.alpha = 0f
    }

    private enum class SlotId { A, B }

    private fun buildPlayer(slot: SlotId): ExoPlayer =
        ExoPlayer.Builder(context).build().apply {
            volume = 0f // muted, like the web <video muted>
            repeatMode = Player.REPEAT_MODE_OFF
            addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(state: Int) {
                    if (state == Player.STATE_ENDED) onVideoEnded(slot)
                }
                override fun onPlayerError(error: PlaybackException) {
                    onVideoError(slot, error.errorCodeName)
                }
            })
        }

    /** Bind a manifest + scheduler and start playback. Idempotent re-bind is not
     *  supported — the host recreates this view (or calls [release] first) on a
     *  manifest change, matching PlayerStage.vue's `:key`-driven remount. */
    fun bind(manifest: Manifest, scheduler: Scheduler) {
        this.manifest = manifest
        this.scheduler = scheduler

        // Front video repeat policy: single-video loops natively (counts once/session).
        val loop = scheduler.mode == SchedulerMode.SINGLE_VIDEO
        exoA.repeatMode = if (loop) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
        exoB.repeatMode = if (loop) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF

        mountInitial()

        unsubscribers += scheduler.onTransition { e ->
            runOnUi {
                // The NEW front is the current back slot — flip which slot is front.
                frontIsA = !frontIsA
                // The old front (now back) becomes the next preload target.
                val nextItem = manifest.items.getOrNull(e.nextPreload)
                setItemInSlot(backSlot(), nextItem)
                playFrontVideoIfNeeded()
                crossfade()
            }
        }
        unsubscribers += scheduler.onItemStart { index ->
            // SINGLE_IMAGE re-emits onItemStart(0) each cycle; the image element
            // stays mounted, so nothing to swap here — just forward telemetry.
            manifest.items.getOrNull(index)?.let { runOnUi { onItemStarted(it.id) } }
        }
        unsubscribers += scheduler.onItemError { index, msg ->
            val item = manifest.items.getOrNull(index)
            runOnUi { onItemFailed(item?.id, item?.sha256, msg) }
        }

        scheduler.start()
    }

    private fun frontSlot(): SlotId = if (frontIsA) SlotId.A else SlotId.B
    private fun backSlot(): SlotId = if (frontIsA) SlotId.B else SlotId.A

    private fun exoFor(slot: SlotId) = if (slot == SlotId.A) exoA else exoB
    private fun imageFor(slot: SlotId) = if (slot == SlotId.A) imageViewA else imageViewB
    private fun playerViewFor(slot: SlotId) = if (slot == SlotId.A) playerViewA else playerViewB
    private fun itemFor(slot: SlotId) = if (slot == SlotId.A) itemInA else itemInB
    private fun setHeldItem(slot: SlotId, item: ManifestItem?) {
        if (slot == SlotId.A) itemInA = item else itemInB = item
    }

    private fun setItemInSlot(slot: SlotId, item: ManifestItem?) {
        setHeldItem(slot, item)
        val exo = exoFor(slot)
        val imageView = imageFor(slot)
        val playerView = playerViewFor(slot)

        if (item == null) {
            exo.stop()
            exo.clearMediaItems()
            imageView.setImageBitmap(null)
            imageView.visibility = View.GONE
            playerView.visibility = View.VISIBLE
            return
        }

        val uri = fileUrlResolver(item.sha256)
        if (item.type == "video") {
            // Video: show the PlayerView, prepare (preload) the media on this slot's player.
            imageView.visibility = View.GONE
            imageView.setImageBitmap(null)
            playerView.visibility = View.VISIBLE
            exo.setMediaItem(MediaItem.fromUri(uri))
            exo.playWhenReady = false // preload only; front is started explicitly
            exo.prepare()
        } else {
            // Image: stop any video on this slot, decode the bitmap off the UI thread.
            exo.stop()
            exo.clearMediaItems()
            playerView.visibility = View.GONE
            imageView.visibility = View.VISIBLE
            loadImage(slot, item, uri)
        }
    }

    private fun loadImage(slot: SlotId, item: ManifestItem, uri: Uri) {
        decodeIo.execute {
            val bmp: Bitmap? = try {
                val path = uri.path
                if (uri.scheme == "file" && path != null) BitmapFactory.decodeFile(path) else null
            } catch (_: Throwable) {
                null
            }
            runOnUi {
                if (released) return@runOnUi
                // Stale-guard: the slot may have been re-armed while we decoded.
                if (itemFor(slot)?.id != item.id) return@runOnUi
                if (bmp != null) {
                    imageFor(slot).setImageBitmap(bmp)
                    onImageLoaded()
                } else {
                    onImageError(slot, "image decode error")
                }
            }
        }
    }

    private fun playFrontVideoIfNeeded() {
        val item = itemFor(frontSlot()) ?: return
        if (item.type != "video") return
        val exo = exoFor(frontSlot())
        exo.repeatMode =
            if (scheduler?.mode == SchedulerMode.SINGLE_VIDEO) Player.REPEAT_MODE_ONE
            else Player.REPEAT_MODE_OFF
        exo.playWhenReady = true
        exo.play()
    }

    private fun mountInitial() {
        val m = manifest ?: return
        val sched = scheduler ?: return
        val frontItem = m.items.getOrNull(sched.getFrontIndex())
        val backItem = m.items.getOrNull(sched.getBackIndex())
        setItemInSlot(frontSlot(), frontItem)
        setItemInSlot(backSlot(), backItem)
        playFrontVideoIfNeeded()
    }

    private fun crossfade() {
        // Front to alpha 1, back to alpha 0 (~120ms). The newly-front slot rises
        // over the fading old front. Hard-cut fallback: replace the animators with
        // direct `alpha = …` assignments (same scheduler events, no other change).
        val front = if (frontIsA) slotAView else slotBView
        val back = if (frontIsA) slotBView else slotAView
        front.animate().cancel()
        back.animate().cancel()
        front.animate().alpha(1f).setDuration(CROSSFADE_MS).start()
        back.animate().alpha(0f).setDuration(CROSSFADE_MS).start()
    }

    // ---- error / ended routing (only the FRONT slot drives the scheduler) ----

    private fun onVideoEnded(slot: SlotId) {
        if (released || slot != frontSlot()) return
        val item = itemFor(slot) ?: return
        consecutiveErrors = 0
        val index = manifest?.items?.indexOfFirst { it.id == item.id } ?: return
        if (index >= 0) scheduler?.itemEnded(index)
    }

    private fun onVideoError(slot: SlotId, msg: String) {
        if (released) return
        // Errors from the back (preloading) slot still count toward the heal
        // budget but we only advance via the FRONT slot — mirror PlayerStage,
        // which reports against whichever slot raised the error.
        val item = itemFor(slot) ?: return
        val index = manifest?.items?.indexOfFirst { it.id == item.id } ?: return
        if (index >= 0) reportError(index, "video decode/load error: $msg")
    }

    private fun onImageError(slot: SlotId, msg: String) {
        if (released) return
        val item = itemFor(slot) ?: return
        val index = manifest?.items?.indexOfFirst { it.id == item.id } ?: return
        if (index >= 0) reportError(index, msg)
    }

    private fun onImageLoaded() {
        consecutiveErrors = 0
    }

    private fun reportError(index: Int, msg: String) {
        consecutiveErrors += 1
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            // Pause error-driven advancing and retry after a delay. Do NOT call
            // scheduler.stop() — that permanently clears its handlers, so the
            // screen could only recover via a manifest change (operator action).
            setStalled(true)
            scheduleRecovery()
            return
        }
        scheduler?.itemErrored(index, msg)
    }

    private fun setStalled(value: Boolean) {
        stalled = value
        stalledBanner.visibility = if (value) View.VISIBLE else View.GONE
    }

    private fun scheduleRecovery() {
        if (recoveryPending) return
        recoveryPending = true
        mainHandler.postDelayed(recoveryRunnable, RECOVERY_DELAY_MS)
    }

    private fun clearRecovery() {
        mainHandler.removeCallbacks(recoveryRunnable)
        recoveryPending = false
    }

    private fun runOnUi(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block()
        else mainHandler.post { if (!released) block() }
    }

    /** Release both ExoPlayers, cancel animators + the recovery handler, and
     *  unsubscribe every scheduler handler. Safe to call more than once. */
    fun release() {
        if (released) return
        released = true
        unsubscribers.forEach { runCatching { it() } }
        unsubscribers.clear()
        clearRecovery()
        slotAView.animate().cancel()
        slotBView.animate().cancel()
        playerViewA.player = null
        playerViewB.player = null
        runCatching { exoA.release() }
        runCatching { exoB.release() }
        decodeIo.shutdownNow()
        onCleared()
    }
}
