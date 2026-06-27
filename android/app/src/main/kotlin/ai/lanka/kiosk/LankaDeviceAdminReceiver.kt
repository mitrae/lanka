package ai.lanka.kiosk

import android.app.admin.DeviceAdminReceiver

/**
 * Device admin component for Lanka's device-owner provisioning. Provisioning is
 * a one-time step on a factory-fresh box with no accounts added:
 *
 *   adb shell dpm set-device-owner ai.lanka.kiosk/.LankaDeviceAdminReceiver
 *
 * No callbacks are overridden — Lanka exercises its device-owner powers directly
 * via [DevicePolicy] (silent OTA, reboot, lock-task kiosk). This class only needs
 * to exist and be declared in the manifest so `set-device-owner` has a target.
 */
class LankaDeviceAdminReceiver : DeviceAdminReceiver()
