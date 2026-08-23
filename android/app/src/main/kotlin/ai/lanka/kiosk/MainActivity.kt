package ai.lanka.kiosk

import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.TextView
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi

/**
 * The ONE launcher component (`ai.lanka.kiosk/.MainActivity`). Hosts whichever
 * [PlayerSurface] the box is set to — [WebViewSurface] or [NativeSurface] —
 * and applies the crash-loop guard ([SurfaceStore]). Boot, the device-owner
 * HOME pin, lock task, the snap-back watchdog and the PIN pad (all in
 * [KioskActivity] / [DevicePolicy]) never see the difference.
 *
 * A surface switch is `SurfaceStore.requestSwitch` + `recreate()`: onDestroy
 * stops the old surface, onCreate reads the new choice and starts it.
 */
class MainActivity : KioskActivity() {

    private lateinit var store: SurfaceStore
    private var surface: PlayerSurface? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        KioskFlags.apply(this)
        // Device-owner kiosk lockdown (lock-task whitelist, HOME launcher,
        // keyguard/status-bar off, deferred OS updates). No-op when Lanka is not
        // provisioned as device owner, so the same APK still runs anywhere.
        DevicePolicy.applyKioskPolicies(this, MainActivity::class.java)

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        setContentView(root)

        store = SurfaceStore(this)
        // Cold start (new process) vs recreate() is decided by SurfaceStore via
        // ProcessToken — that is how the guard tells a crash loop from a switch.
        val kind = store.onActivityCreate()
        Log.i(TAG, "starting ${kind.wire} surface")

        // Assign BEFORE start(): a surface that throws halfway through start()
        // still owns whatever it created, and only stop() can release it.
        val candidate = createSurface(kind, root)
        surface = candidate
        try {
            candidate.start()
        } catch (e: Exception) {
            Log.e(TAG, "${kind.wire} surface failed to start: $e")
            candidate.stop()
            surface = null
            if (store.startFailed()) {
                recreate() // reverted → come back up on the last-known-good surface
            } else {
                // Nothing to fall back to. Never loop on a synchronous failure:
                // show a banner and wait — same as a crash, but visible.
                root.addView(
                    TextView(this).apply {
                        text = "Lanka — player failed to start"
                        setTextColor(Color.parseColor("#F4F4F5"))
                        gravity = Gravity.CENTER
                    },
                    FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT
                    )
                )
            }
        }
    }

    @OptIn(UnstableApi::class) // NativeSurface is built on Media3's unstable API
    private fun createSurface(kind: SurfaceKind, root: FrameLayout): PlayerSurface {
        val switch: (String) -> String? = { SurfaceSwitcher.request(this, it) }
        return when (kind) {
            SurfaceKind.WEBVIEW -> WebViewSurface(
                this, root,
                onConfirmed = store::confirm,
                onStartFailed = ::handleStartFailure,
                switchSurface = switch
            )
            SurfaceKind.NATIVE -> NativeSurface(this, root, onConfirmed = store::confirm, switchSurface = switch)
        }
    }

    /**
     * A surface gave up before confirming health (WebView renderer died during
     * the initial load). Revert a pending switch if there is one, then restart
     * either way — the renderer-recovery behaviour the kiosk always had. Not a
     * tight loop: renderer deaths are spaced by the WebView's own startup.
     */
    private fun handleStartFailure() {
        store.startFailed()
        recreate()
    }

    override fun onDestroy() {
        surface?.stop()
        surface = null
        super.onDestroy()
    }

    companion object {
        private const val TAG = "LankaKiosk"
    }
}
