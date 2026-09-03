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
 * Self-heal mirrors PlayerStage (as revised 2026-09-03): a [StallWatchdog] is
 * sampled every [STALL_SAMPLE_MS] on the front player's position, since Media3
 * can sit in STATE_BUFFERING — or STATE_READY with a hung Amlogic MediaCodec —
 * forever without raising onPlayerError. A stall is reported down the same
 * path as an error. In single-item modes (nowhere to advance) the view
 * re-prepares the front item itself; after [MAX_CONSECUTIVE_ERRORS]
 * consecutive failures it shows a "stalled" banner and retries after
 * [RECOVERY_DELAY_MS]. Only the FRONT slot may drive any of this — a failure
 * in the hidden preload slot is recorded for telemetry and nothing else.
 * Sustained progress ([HEALTHY_PROGRESS_MS] of media time) forgives earlier
 * failures.
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
        const val STALL_SAMPLE_MS = 2000L
        /** Mid-clip freeze: position frozen after the load reached STATE_READY. */
        const val STALL_PLAYING_MS = 8000L
        /** Cold prepare(): position sits at 0 while the extractor reads the moov
         *  atom. On the CDN fallback path re-preparing at 8 s would discard the
         *  buffered progress and restart the clock — a loop that never
         *  converges on a slow link. */
        const val STALL_STARTUP_MS = 45_000L
        /** Media ms a load must advance before earlier failures are forgiven;
         *  one frame every few seconds is a crawling decoder, not health. */
        const val HEALTHY_PROGRESS_MS = 5000L
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

    // Freeze detection (see class doc). All main-thread: ExoPlayer is not
    // thread-safe, and the tick reads it directly.
    private val watchdog = StallWatchdog(startupMs = STALL_STARTUP_MS, playingMs = STALL_PLAYING_MS)
    private var everReady = false // this load has reached STATE_READY at least once
    private var budgetAnchorMs = -1L // position when the error budget was last charged/forgiven
    private var playNudged = false // a paused stall already got its one play() before a re-prepare
    private val stallRunnable = object : Runnable {
        override fun run() {
            if (released) return
            sampleProgress()
            mainHandler.postDelayed(this, STALL_SAMPLE_MS)
        }
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
                    if (state == Player.STATE_READY && slot == frontSlot()) everReady = true
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
        mainHandler.removeCallbacks(stallRunnable)
        mainHandler.postDelayed(stallRunnable, STALL_SAMPLE_MS)

        unsubscribers += scheduler.onTransition { e ->
            runOnUi {
                // The NEW front is the current back slot — flip which slot is front.
                frontIsA = !frontIsA
                // The old front (now back) becomes the next preload target.
                val nextItem =
                    if (e.nextPreload == e.to) null else manifest.items.getOrNull(e.nextPreload)
                setItemInSlot(backSlot(), nextItem)
                playFrontVideoIfNeeded()
                resetProgressTracking()
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
        val frontIdx = sched.getFrontIndex()
        val backIdx = sched.getBackIndex()
        val frontItem = m.items.getOrNull(frontIdx)
        // Single-item modes report back == front. Preparing the same item on the
        // hidden player too meant two ExoPlayers on one 176 MB file — two
        // extractors, two buffers and, on an Amlogic box with a handful of
        // hardware decoder instances, a real chance of starving the visible one.
        val backItem = if (backIdx == frontIdx) null else m.items.getOrNull(backIdx)
        setItemInSlot(frontSlot(), frontItem)
        setItemInSlot(backSlot(), backItem)
        playFrontVideoIfNeeded()
        resetProgressTracking()
    }

    /** Re-prepare the current front item in place — the only recovery available
     *  when there is nothing to advance to. */
    private fun retryFrontItem() {
        val item = itemFor(frontSlot()) ?: return
        setItemInSlot(frontSlot(), item)
        playFrontVideoIfNeeded()
        resetProgressTracking()
    }

    private fun resetProgressTracking() {
        watchdog.reset()
        everReady = false
        budgetAnchorMs = -1L
        playNudged = false
    }

    /** Poll the front player for a frozen position; report a stall as an error
     *  so it gets a device_errors row and the same retry/backoff treatment. */
    private fun sampleProgress() {
        if (stalled) return // the recovery runnable owns retries in this state
        val item = itemFor(frontSlot())
        if (item == null || item.type != "video") {
            resetProgressTracking()
            return
        }
        val exo = exoFor(frontSlot())
        val state = exo.playbackState
        // IDLE is the error path's territory (onPlayerError already fired, or
        // nothing is prepared); ENDED cannot happen under REPEAT_MODE_ONE and
        // is handled by onVideoEnded otherwise.
        val expectPlaying = exo.mediaItemCount > 0 &&
            state != Player.STATE_IDLE && state != Player.STATE_ENDED
        val position = exo.currentPosition
        val stalledNow = watchdog.observe(
            nowMs = android.os.SystemClock.elapsedRealtime(),
            positionMs = position,
            expectPlaying = expectPlaying,
            started = everReady
        )
        if (stalledNow) {
            if (!exo.playWhenReady && !playNudged) {
                // Cheapest recovery first: a player that lost playWhenReady
                // (audio-focus policy, a stray pause) needs play(), not a
                // re-prepare that throws away buffered data. One attempt.
                playNudged = true
                exo.playWhenReady = true
                exo.play()
                return
            }
            val index = manifest?.items?.indexOfFirst { it.id == item.id } ?: return
            if (index >= 0) reportError(index, if (everReady) "video stalled" else "video never started")
            return
        }
        if (!expectPlaying) return
        if (budgetAnchorMs < 0L || position < budgetAnchorMs) {
            budgetAnchorMs = position // first sample after a charge, or a repeat wrap
            return
        }
        if (position - budgetAnchorMs >= HEALTHY_PROGRESS_MS) {
            consecutiveErrors = 0
            budgetAnchorMs = position
        }
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

    /** Route a failure by which slot raised it. Only the visible slot may
     *  drive playback; the hidden preload slot's failure is recorded for
     *  telemetry and nothing else. Before this guard a back-slot error charged
     *  the budget and — once retryFrontItem existed — re-prepared the perfectly
     *  healthy front item from 0. */
    private fun onSlotError(slot: SlotId, msg: String) {
        if (released) return
        val item = itemFor(slot) ?: return
        val index = manifest?.items?.indexOfFirst { it.id == item.id } ?: return
        if (index < 0) return
        if (slot != frontSlot()) {
            scheduler?.noteError(index, "$msg (preload)")
            return
        }
        reportError(index, msg)
    }

    private fun onVideoError(slot: SlotId, msg: String) = onSlotError(slot, "video decode/load error: $msg")

    private fun onImageError(slot: SlotId, msg: String) = onSlotError(slot, msg)

    private fun onImageLoaded() {
        consecutiveErrors = 0
    }

    private fun reportError(index: Int, msg: String) {
        consecutiveErrors += 1
        budgetAnchorMs = -1L // forgiveness needs fresh sustained progress from here
        val sched = scheduler ?: return
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            // Record it first: this is the failure that trips the stalled state,
            // and it used to be the one failure that never reached device_errors.
            // Then pause error-driven advancing and retry after a delay. Do NOT
            // call scheduler.stop() — that permanently clears its handlers, so
            // the screen could only recover via a manifest change.
            sched.noteError(index, msg)
            setStalled(true)
            scheduleRecovery()
            return
        }
        sched.itemErrored(index, msg)
        // A single-item playlist has nowhere to advance to: the scheduler records
        // the error and returns. Without this the first ExoPlayer error was
        // terminal — the dead-end the web surface fixed on 2026-09-03.
        if (!sched.advancesOnError) retryFrontItem()
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
        mainHandler.removeCallbacks(stallRunnable)
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
