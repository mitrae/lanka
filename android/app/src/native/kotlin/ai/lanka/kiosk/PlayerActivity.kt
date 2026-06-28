package ai.lanka.kiosk

import android.app.Activity
import android.os.Bundle

/** Native (ExoPlayer) player entry point. Filled in by later tasks. */
class PlayerActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        KioskFlags.apply(this)
        DevicePolicy.applyKioskPolicies(this)
        setContentView(R.layout.activity_player)
    }
}
