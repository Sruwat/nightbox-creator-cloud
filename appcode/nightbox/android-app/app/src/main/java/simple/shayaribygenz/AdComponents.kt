package simple.shayaribygenz

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.google.android.gms.ads.AdListener
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.AdSize
import com.google.android.gms.ads.AdView
import com.google.android.gms.ads.LoadAdError

/**
 * AdComponents: UI components for Smart Collapsible Banners and Policy-Compliant MREC Ads.
 */
object AdComponents {

    private const val TAG = "AdComponents"

    /**
     * Loads a Smart Collapsible Banner with:
     * - Smart 45-Second Collapsible Cooldown Engine
     * - No-Flicker Safety Guard (hasEverLoaded): Never destroys the currently visible banner
     *   during a background reload if there's a network glitch. Existing banner stays visible.
     * - Automatic RAM cleanup of previous views.
     */
    fun loadSmartCollapsibleBanner(
        context: Context,
        container: FrameLayout,
        isTop: Boolean,
        adUnitId: String = AdManager.BANNER_HOME_VIDEO_PLAYER,
        screenKey: String = adUnitId,
        forceCollapsible: Boolean = false,
        onLoaded: (() -> Unit)? = null
    ) {
        // If an ad is already showing and cooldown is active, preserve current high-paying banner
        val hasVisibleBanner = container.childCount > 0
        if (!forceCollapsible && hasVisibleBanner && !AdManager.canRequestCollapsible(screenKey)) {
            Log.d(TAG, "[$screenKey] Cooldown active and banner already visible. Keeping current high-eCPM banner.")
            return
        }

        val displayMetrics = context.resources.displayMetrics
        val density = displayMetrics.density
        // Robust width calculation taking container padding into account
        val containerPaddingPx = container.paddingLeft + container.paddingRight
        val availableWidthPx = (displayMetrics.widthPixels - containerPaddingPx).toFloat().coerceAtLeast(320f * density)
        val adWidth = (availableWidthPx / density).toInt()
        val adSize = AdSize.getCurrentOrientationAnchoredAdaptiveBannerAdSize(context, adWidth)

        // Create new candidate AdView in memory
        val newAdView = AdView(context).apply {
            setAdSize(adSize)
            this.adUnitId = adUnitId
        }

        val request = AdManager.buildSmartBannerRequest(
            isTop = isTop,
            screenKey = screenKey,
            forceCollapsible = forceCollapsible
        )

        var fallbackTriggered = false

        newAdView.adListener = object : AdListener() {
            override fun onAdLoaded() {
                val winner = newAdView.responseInfo?.mediationAdapterClassName ?: "Google"
                AdManager.markCollapsibleLoaded(screenKey)

                // Safe swap: find and destroy old AdViews
                val oldViews = mutableListOf<AdView>()
                for (i in 0 until container.childCount) {
                    val child = container.getChildAt(i)
                    if (child is AdView && child !== newAdView) {
                        oldViews.add(child)
                    }
                }

                container.removeAllViews()
                container.addView(newAdView)

                // Clean RAM of previous views
                for (old in oldViews) {
                    try {
                        old.destroy()
                    } catch (_: Exception) {}
                }

                onLoaded?.invoke()
            }

            override fun onAdFailedToLoad(error: LoadAdError) {
                Log.w(TAG, "Smart Banner failed to load for [$screenKey]: ${error.message} (code: ${error.code})")
                try {
                    newAdView.destroy()
                } catch (_: Exception) {}
            }
        }

        newAdView.loadAd(request)
    }

    /**
     * Loads an AdMob Policy-Compliant MREC (300x250 Medium Rectangle) Ad:
     * - Enforces 16dp buffer to prevent accidental-click policy strikes.
     * - Clear "Advertisement" compliance label.
     * - Loaded on-demand for near-zero background RAM footprint.
     * - Returns the created AdView so callers can destroy it on screen exit.
     */
    fun loadMrecAd(
        context: Context,
        container: ViewGroup,
        adUnitId: String = AdManager.MREC_VIDEO_PLAYER,
        onLoaded: (() -> Unit)? = null
    ): AdView {
        container.removeAllViews()
        container.visibility = View.VISIBLE // Keep reserved blank space visible so no sudden layout jumping

        val density = context.resources.displayMetrics.density
        val padding16dp = (16 * density).toInt()

        // Root vertical layout with policy buffer (0 horizontal padding ensures full 300dp+ width for video/rich media)
        val wrapper = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(0, padding16dp, 0, padding16dp)
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }

        // Compliance Advertisement Label
        val adBadge = TextView(context).apply {
            text = "ADVERTISEMENT"
            textSize = 9f
            letterSpacing = 0.08f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.parseColor("#A6FFFFFF"))
            setBackgroundResource(R.drawable.bg_advertisement_pill)
            setPadding((8 * density).toInt(), (2 * density).toInt(), (8 * density).toInt(), (2 * density).toInt())
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                bottomMargin = (8 * density).toInt()
                gravity = Gravity.CENTER_HORIZONTAL
            }
        }
        wrapper.addView(adBadge)

        // 300x250 Medium Rectangle AdView
        val adView = AdView(context).apply {
            setAdSize(AdSize.MEDIUM_RECTANGLE)
            this.adUnitId = adUnitId
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                gravity = Gravity.CENTER_HORIZONTAL
            }
        }

        adView.adListener = object : AdListener() {
            override fun onAdLoaded() {
                val winner = adView.responseInfo?.mediationAdapterClassName ?: "Google"
                Log.d(TAG, "MREC (300x250) ad loaded successfully. Winning Adapter: $winner")
                container.removeAllViews()
                container.addView(wrapper)
                container.visibility = View.VISIBLE
                onLoaded?.invoke()
            }

            override fun onAdFailedToLoad(error: LoadAdError) {
                Log.w(TAG, "MREC (300x250) failed to load: ${error.message} (code ${error.code})")
                try {
                    adView.destroy()
                } catch (_: Exception) {}
                container.removeAllViews()
                container.visibility = View.VISIBLE // Keep reserved space intact so UI does not shift
            }
        }

        wrapper.addView(adView)
        adView.loadAd(AdRequest.Builder().build())
        return adView
    }

    /**
     * Pauses any AdViews inside the container when activity is paused or goes to background.
     */
    fun pauseAdViews(container: ViewGroup?) {
        if (container == null) return
        for (i in 0 until container.childCount) {
            val child = container.getChildAt(i)
            if (child is AdView) {
                try {
                    child.pause()
                } catch (_: Exception) {}
            } else if (child is ViewGroup) {
                pauseAdViews(child)
            }
        }
    }

    /**
     * Resumes any AdViews inside the container when activity resumes.
     */
    fun resumeAdViews(container: ViewGroup?) {
        if (container == null) return
        for (i in 0 until container.childCount) {
            val child = container.getChildAt(i)
            if (child is AdView) {
                try {
                    child.resume()
                } catch (_: Exception) {}
            } else if (child is ViewGroup) {
                resumeAdViews(child)
            }
        }
    }

    /**
     * Destroys any AdViews inside the container and removes all views to free RAM.
     */
    fun destroyAdViews(container: ViewGroup?) {
        if (container == null) return
        for (i in 0 until container.childCount) {
            val child = container.getChildAt(i)
            if (child is AdView) {
                try {
                    child.destroy()
                } catch (_: Exception) {}
            } else if (child is ViewGroup) {
                destroyAdViews(child)
            }
        }
        container.removeAllViews()
    }
}
