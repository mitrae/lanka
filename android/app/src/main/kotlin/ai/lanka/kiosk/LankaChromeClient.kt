package ai.lanka.kiosk

import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient

class LankaChromeClient : WebChromeClient() {
    override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
        val tag = "LankaPlayer"
        val text = "${msg.sourceId()}:${msg.lineNumber()} ${msg.message()}"
        when (msg.messageLevel()) {
            ConsoleMessage.MessageLevel.ERROR   -> Log.e(tag, text)
            ConsoleMessage.MessageLevel.WARNING -> Log.w(tag, text)
            ConsoleMessage.MessageLevel.DEBUG   -> Log.d(tag, text)
            else                                -> Log.i(tag, text)
        }
        return true
    }
}
