package simple.shayaribygenz

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.animation.OvershootInterpolator

/**
 * Modern Micro-Interaction and Haptic Feedback Extensions for NightBox.
 */
object UiExtensions {

    @SuppressLint("ClickableViewAccessibility")
    fun View.applyPressScale(onClick: (() -> Unit)? = null) {
        isClickable = true
        isFocusable = true
        if (onClick != null) {
            setOnClickListener { onClick() }
        }
        setOnTouchListener { v, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    v.animate()
                        .scaleX(0.96f)
                        .scaleY(0.96f)
                        .setDuration(80)
                        .setInterpolator(AccelerateDecelerateInterpolator())
                        .start()
                    try {
                        v.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                    } catch (_: Exception) {}
                }
                MotionEvent.ACTION_UP -> {
                    v.animate()
                        .scaleX(1.0f)
                        .scaleY(1.0f)
                        .setDuration(120)
                        .setInterpolator(OvershootInterpolator(1.8f))
                        .start()
                    val isInside = event.x >= 0 && event.x <= v.width && event.y >= 0 && event.y <= v.height
                    if (isInside) {
                        v.performClick()
                    }
                }
                MotionEvent.ACTION_CANCEL -> {
                    v.animate()
                        .scaleX(1.0f)
                        .scaleY(1.0f)
                        .setDuration(100)
                        .start()
                }
            }
            true
        }
    }

    fun Context.vibrateTick() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vibratorManager = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                vibratorManager?.defaultVibrator?.vibrate(
                    VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK)
                )
            } else {
                @Suppress("DEPRECATION")
                val vibrator = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    vibrator?.vibrate(VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK))
                } else {
                    @Suppress("DEPRECATION")
                    vibrator?.vibrate(20L)
                }
            }
        } catch (_: Exception) {}
    }

    /**
     * Subtle breathing pulse animation for primary CTA buttons (e.g. "Open File").
     */
    fun View.startBreathingPulse() {
        val anim = android.view.animation.ScaleAnimation(
            1.0f, 1.03f, 1.0f, 1.03f,
            android.view.animation.Animation.RELATIVE_TO_SELF, 0.5f,
            android.view.animation.Animation.RELATIVE_TO_SELF, 0.5f
        ).apply {
            duration = 1200
            repeatMode = android.view.animation.Animation.REVERSE
            repeatCount = android.view.animation.Animation.INFINITE
            interpolator = AccelerateDecelerateInterpolator()
        }
        startAnimation(anim)
    }
}
