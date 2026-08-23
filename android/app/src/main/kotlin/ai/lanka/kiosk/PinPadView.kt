package ai.lanka.kiosk

import android.content.Context
import android.graphics.Color
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Full-screen PIN entry overlay drawn OVER the player by KioskActivity via
 * addContentView(). Deliberately a native View rather than an HTML overlay in
 * the web player: the escape hatch is most needed exactly when the WebView
 * renderer has died or JS is wedged, and a native view still draws then.
 *
 * NEVER takes focus. KioskActivity.dispatchKeyEvent routes every key here via
 * [handleKey] while the pad is showing; selection is a plain index drawn by
 * the pad itself. Holds no policy — every decision is delegated to [pin].
 *
 * Grid (selection indices):  1 2 3 / 4 5 6 / 7 8 9 / _ 0 _
 *                            0 1 2   3 4 5   6 7 8     9
 */
class PinPadView(
    context: Context,
    private val pin: KioskPin,
    private val onUnlock: () -> Unit,
    private val onDismiss: () -> Unit
) : LinearLayout(context) {

    private val dots = textView(32f, Color.WHITE)
    private val message = textView(14f, Color.LTGRAY)
    private val keys = ArrayList<TextView>(10)
    private var selected = 4 // start on "5", the middle of the grid

    init {
        orientation = VERTICAL
        gravity = Gravity.CENTER
        setBackgroundColor(SCRIM)
        isFocusable = false
        isFocusableInTouchMode = false

        addView(textView(20f, Color.WHITE).apply {
            text = "Enter PIN"
            setPadding(0, 0, 0, dp(12))
        })
        addView(dots)
        addView(row('1', '2', '3'))
        addView(row('4', '5', '6'))
        addView(row('7', '8', '9'))
        addView(row('0'))
        addView(message.apply { setPadding(0, dp(12), 0, 0) })

        render()
    }

    /** Replaces the message line (used for "Unlock failed — …"). */
    fun showMessage(text: String) {
        message.text = text
    }

    /**
     * Handles one hardware key. Acts only on an INITIAL press (ACTION_DOWN with
     * repeatCount == 0): the long-press BACK that opened the pad is still held
     * and its auto-repeats arrive here — without this check the pad would
     * dismiss itself before the finger lifts — and a held digit key would
     * otherwise enter "5555" and burn an attempt. Always returns true: the pad
     * is modal and nothing may leak to the player beneath.
     */
    fun handleKey(event: KeyEvent): Boolean {
        if (event.action != KeyEvent.ACTION_DOWN || event.repeatCount != 0) return true
        when (val kc = event.keyCode) {
            KeyEvent.KEYCODE_BACK -> onDismiss()
            KeyEvent.KEYCODE_DPAD_LEFT -> move(dx = -1, dy = 0)
            KeyEvent.KEYCODE_DPAD_RIGHT -> move(dx = 1, dy = 0)
            KeyEvent.KEYCODE_DPAD_UP -> move(dx = 0, dy = -1)
            KeyEvent.KEYCODE_DPAD_DOWN -> move(dx = 0, dy = 1)
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER ->
                submit(keys[selected].text[0])
            in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> submit('0' + (kc - KeyEvent.KEYCODE_0))
            in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_9 ->
                submit('0' + (kc - KeyEvent.KEYCODE_NUMPAD_0))
            else -> Unit
        }
        return true
    }

    // ── selection ──────────────────────────────────────────────────────────

    private fun move(dx: Int, dy: Int) {
        val row = if (selected == 9) 3 else selected / 3
        val col = if (selected == 9) 1 else selected % 3
        val next = when {
            dy == 1 -> if (row == 2) 9 else if (row < 2) selected + 3 else selected
            dy == -1 -> if (row == 3) 7 else if (row > 0) selected - 3 else selected
            dx != 0 && row == 3 -> selected // "0" has no horizontal neighbours
            else -> (col + dx).coerceIn(0, 2) + row * 3
        }
        selected = next
        render()
    }

    private fun submit(digit: Char) {
        when (pin.append(digit)) {
            KioskPin.Result.INCOMPLETE -> render()
            KioskPin.Result.UNLOCKED -> { render(); onUnlock() }
            KioskPin.Result.WRONG -> {
                render()
                if (!pin.isLockedOut()) message.text = "Wrong PIN"
            }
            KioskPin.Result.LOCKED_OUT -> message.text = lockoutText()
        }
    }

    private fun lockoutText(): String =
        "$LOCKOUT_PREFIX${(pin.lockedOutMsRemaining() + 999) / 1000}s"

    private fun render() {
        dots.text = buildString { repeat(pin.entryLength) { append("● ") } }.trim().ifEmpty { "·" }
        keys.forEachIndexed { i, v -> v.setBackgroundColor(if (i == selected) HIGHLIGHT else Color.TRANSPARENT) }
        // Opened during an active lockout → say so immediately rather than on the next key.
        when {
            pin.isLockedOut() -> message.text = lockoutText()
            pin.entryLength > 0 -> message.text = ""
            // Lockout just expired (or nothing typed yet): clear any stale
            // "wait Ns" so the operator is not misled into giving up.
            message.text.startsWith(LOCKOUT_PREFIX) -> message.text = ""
        }
    }

    // ── construction ───────────────────────────────────────────────────────

    private fun row(vararg digits: Char): LinearLayout =
        LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER
            for (c in digits) addView(key(c).also { keys.add(it) })
        }

    private fun key(c: Char): TextView =
        textView(28f, Color.WHITE).apply {
            text = c.toString()
            isFocusable = false
            minWidth = dp(64)
            setPadding(dp(16), dp(10), dp(16), dp(10))
        }

    private fun textView(sizeSp: Float, color: Int): TextView =
        TextView(context).apply {
            setTextColor(color)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
            gravity = Gravity.CENTER
            isFocusable = false
        }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private companion object {
        // NOT `const val` — 0xE6000000 is a Long literal, so .toInt() is not a
        // compile-time constant expression and `const` would fail to compile.
        val SCRIM = 0xE6000000.toInt()
        const val HIGHLIGHT = 0x40FFFFFF
        const val LOCKOUT_PREFIX = "Too many attempts — wait "
    }
}
