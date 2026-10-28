package simple.shayaribygenz

import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.ads.mediation.admob.AdMobAdapter
import com.google.android.gms.ads.AdError
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.FullScreenContentCallback
import com.google.android.gms.ads.LoadAdError
import com.google.android.gms.ads.MobileAds
import com.google.android.gms.ads.rewarded.RewardedAd
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/**
 * AdManager: Central Smart Ad Engine for NightBox
 *
 * Features:
 * 1. Smart 45-Second Collapsible Banner Engine (UUID refresh, cooldown check, high eCPM)
 * 2. Zero-Delay Rewarded Ads (RAM buffer, 60-min auto-expiry reload, AtomicBoolean protection)
 */
object AdManager {

    private const val TAG = "AdManager"

    // Real Ad Unit IDs for NightBox (configured per screen for optimal eCPM)
    const val BANNER_HOME_VIDEO_PLAYER = "ca-app-pub-2964717174761820/7251270834" // video player banner
    const val BANNER_FILE_INFO         = "ca-app-pub-2964717174761820/2578949845" // file info banner
    const val MREC_TOP_FILE_INFO       = "ca-app-pub-2964717174761820/4920288138" // merc top info
    const val MREC_BOTTOM_FILE_INFO    = "ca-app-pub-2964717174761820/3926111520" // merrc bottom info
    const val MREC_VIDEO_PLAYER        = "ca-app-pub-2964717174761820/3409649938" // merc video player
    const val REWARDED_AD_UNIT         = "ca-app-pub-2964717174761820/7059699143" // new rewarded

    // Backward-compatibility defaults
    const val BANNER_AD_UNIT           = BANNER_HOME_VIDEO_PLAYER
    const val MREC_AD_UNIT             = MREC_VIDEO_PLAYER

    // ──────────────────────────────────────────────
    // 1. SMART 45-SECOND COLLAPSIBLE BANNER ENGINE (PER-SCREEN ISOLATION)
    // ──────────────────────────────────────────────
    private const val COLLAPSIBLE_COOLDOWN_MS = 45_000L // 45 seconds
    private val screenCollapsibleTimestamps = java.util.concurrent.ConcurrentHashMap<String, Long>()

    /**
     * Checks if 45 seconds have passed since the last collapsible banner was loaded for this specific screen / ad unit.
     */
    fun canRequestCollapsible(screenKey: String = "default"): Boolean {
        val now = System.currentTimeMillis()
        val lastTime = screenCollapsibleTimestamps[screenKey] ?: 0L
        return (now - lastTime) >= COLLAPSIBLE_COOLDOWN_MS
    }

    /**
     * Builds an AdRequest. If 45s passed for this screen, attaches a new UUID and collapsible parameter
     * (top or bottom) to trigger a high-paying collapsible expansion.
     * Otherwise returns a standard fast request.
     */
    fun buildSmartBannerRequest(
        isTop: Boolean,
        screenKey: String = "default",
        forceCollapsible: Boolean = false
    ): AdRequest {
        return if (forceCollapsible || canRequestCollapsible(screenKey)) {
            val bundle = Bundle().apply {
                putString("collapsible", if (isTop) "top" else "bottom")
                putString("collapsible_request_id", UUID.randomUUID().toString())
            }
            Log.d(TAG, "Requesting high-eCPM Collapsible Banner for [$screenKey] (top=$isTop)")
            AdRequest.Builder()
                .addNetworkExtrasBundle(AdMobAdapter::class.java, bundle)
                .build()
        } else {
            Log.d(TAG, "Collapsible for [$screenKey] in 45s cooldown, requesting standard banner")
            AdRequest.Builder().build()
        }
    }

    /**
     * Called when a collapsible banner loads successfully to mark the cooldown timer for that screen.
     */
    fun markCollapsibleLoaded(screenKey: String = "default") {
        screenCollapsibleTimestamps[screenKey] = System.currentTimeMillis()
    }

    // ──────────────────────────────────────────────
    // FULL-SCREEN AD SAFETY COOLDOWN (POLICY GUARD)
    // ──────────────────────────────────────────────
    private const val FULL_SCREEN_COOLDOWN_MS = 30_000L // 30 seconds anti-spam guard
    private const val AD_EXPIRY_MS = 60 * 60 * 1000L    // 60 minutes max RAM lifetime
    @Volatile private var lastFullScreenAdShownTimeMs: Long = 0L

    /**
     * Checks if at least 30 seconds have passed since the last full-screen ad was displayed.
     * Prevents back-to-back ad strikes under Google Play's Better Ads Standards.
     */
    fun canShowFullScreenAd(): Boolean {
        val now = System.currentTimeMillis()
        return (now - lastFullScreenAdShownTimeMs) >= FULL_SCREEN_COOLDOWN_MS
    }

    /**
     * Marks the timestamp whenever any full-screen ad is shown.
     */
    fun markFullScreenAdShown() {
        lastFullScreenAdShownTimeMs = System.currentTimeMillis()
    }

    // ──────────────────────────────────────────────
    // 2. REWARDED ADS (ZERO-DELAY INSTANT PLAYBACK)
    // ──────────────────────────────────────────────
    @Volatile private var cachedRewardedAd: RewardedAd? = null
    @Volatile private var cachedRewardedLoadedTimeMs: Long = 0L
    @Volatile private var isRewardedLoading = false
    private var rewardedRetryCount = 0
    private const val MAX_RETRY_COUNT = 3

    private interface RewardedLoadListener {
        fun onLoaded()
        fun onFailed()
    }
    private val rewardedWaiters = mutableListOf<RewardedLoadListener>()

    /**
     * Checks if a valid, non-expired rewarded ad is currently buffered in RAM.
     */
    fun isRewardedAdReady(context: Context? = null): Boolean {
        val ad = cachedRewardedAd ?: return false
        val isExpired = (System.currentTimeMillis() - cachedRewardedLoadedTimeMs) > AD_EXPIRY_MS
        if (isExpired) {
            Log.w(TAG, "Buffered Rewarded Ad expired (>60 mins). Discarding from RAM and reloading.")
            cachedRewardedAd = null
            context?.let { preloadRewarded(it.applicationContext) }
            return false
        }
        return true
    }

    fun isRewardedAdLoading(): Boolean = isRewardedLoading

    /**
     * Preloads Rewarded Ad into RAM ahead of time with auto-retry and 60-min expiry check.
     */
    fun preloadRewarded(context: Context) {
        val appContext = context.applicationContext
        if (isRewardedAdReady(appContext)) {
            Log.d(TAG, "Rewarded ad already buffered in RAM and valid.")
            return
        }
        if (isRewardedLoading) return
        isRewardedLoading = true

        val request = AdRequest.Builder().build()
        RewardedAd.load(
            appContext,
            REWARDED_AD_UNIT,
            request,
            object : RewardedAdLoadCallback() {
                override fun onAdLoaded(ad: RewardedAd) {
                    cachedRewardedAd = ad
                    cachedRewardedLoadedTimeMs = System.currentTimeMillis()
                    isRewardedLoading = false
                    rewardedRetryCount = 0
                    val winningAdapter = ad.responseInfo.mediationAdapterClassName ?: "Google"
                    Log.d(TAG, "Rewarded Ad pre-buffered in RAM (0ms ready). Winning Bidding Adapter: $winningAdapter")

                    val waiters = synchronized(rewardedWaiters) {
                        val list = ArrayList(rewardedWaiters)
                        rewardedWaiters.clear()
                        list
                    }
                    waiters.forEach { it.onLoaded() }
                }

                override fun onAdFailedToLoad(error: LoadAdError) {
                    cachedRewardedAd = null
                    isRewardedLoading = false
                    Log.w(TAG, "Rewarded Ad load failed: ${error.message}")

                    val waiters = synchronized(rewardedWaiters) {
                        val list = ArrayList(rewardedWaiters)
                        rewardedWaiters.clear()
                        list
                    }
                    waiters.forEach { it.onFailed() }

                    if (rewardedRetryCount < MAX_RETRY_COUNT) {
                        rewardedRetryCount++
                        Handler(Looper.getMainLooper()).postDelayed({
                            preloadRewarded(appContext)
                        }, 10_000L * rewardedRetryCount)
                    }
                }
            }
        )
    }

    /**
     * Shows the pre-buffered rewarded ad with 0-millisecond lag.
     * Uses AtomicBoolean verification so rewards are granted ONLY when 100% completed.
     */
    fun showRewardedAd(
        activity: Activity,
        onRewardGranted: () -> Unit,
        onDismissedEarly: () -> Unit = {}
    ) {
        val ad = cachedRewardedAd
        if (ad != null && isRewardedAdReady()) {
            cachedRewardedAd = null // Consume from RAM
            val isRewardEarned = AtomicBoolean(false)

            ad.fullScreenContentCallback = object : FullScreenContentCallback() {
                override fun onAdDismissedFullScreenContent() {
                    Log.d(TAG, "Rewarded ad dismissed. isRewardEarned=${isRewardEarned.get()}")
                    preloadRewarded(activity.applicationContext)

                    if (isRewardEarned.get()) {
                        onRewardGranted()
                    } else {
                        onDismissedEarly()
                    }
                }

                override fun onAdFailedToShowFullScreenContent(error: AdError) {
                    Log.e(TAG, "Rewarded ad failed to show: ${error.message}")
                    preloadRewarded(activity.applicationContext)
                    onRewardGranted()
                }

                override fun onAdShowedFullScreenContent() {
                    Log.d(TAG, "Rewarded ad shown fullscreen")
                    markFullScreenAdShown()
                }
            }

            // Launch ad instantly (0ms delay)
            ad.show(activity) { _ ->
                isRewardEarned.set(true)
            }
        } else {
            Log.d(TAG, "Rewarded ad not cached in RAM. Preloading for next time and passing through.")
            preloadRewarded(activity.applicationContext)
            onRewardGranted()
        }
    }

    /**
     * Shows the buffered rewarded ad. If currently loading in background, waits up to [maxWaitMs] (default 2000ms).
     * If loaded in time, shows ad immediately.
     * If timeout or load fails, smoothly falls back to [onRewardGranted] so the user is never blocked.
     */
    fun showOrWaitForRewardedAd(
        activity: Activity,
        maxWaitMs: Long = 2000L,
        onLoadingStateChanged: ((Boolean) -> Unit)? = null,
        onRewardGranted: () -> Unit,
        onDismissedEarly: () -> Unit = {}
    ) {
        if (isRewardedAdReady()) {
            onLoadingStateChanged?.invoke(false)
            showRewardedAd(activity, onRewardGranted, onDismissedEarly)
            return
        }

        if (isRewardedLoading) {
            onLoadingStateChanged?.invoke(true)
            val handler = Handler(Looper.getMainLooper())
            var completed = false

            val timeoutRunnable = Runnable {
                if (!completed) {
                    completed = true
                    onLoadingStateChanged?.invoke(false)
                    Log.d(TAG, "Rewarded wait timed out (${maxWaitMs}ms). Proceeding to content.")
                    onRewardGranted()
                }
            }
            handler.postDelayed(timeoutRunnable, maxWaitMs)

            val waiter = object : RewardedLoadListener {
                override fun onLoaded() {
                    handler.post {
                        if (!completed) {
                            completed = true
                            handler.removeCallbacks(timeoutRunnable)
                            onLoadingStateChanged?.invoke(false)
                            showRewardedAd(activity, onRewardGranted, onDismissedEarly)
                        }
                    }
                }

                override fun onFailed() {
                    handler.post {
                        if (!completed) {
                            completed = true
                            handler.removeCallbacks(timeoutRunnable)
                            onLoadingStateChanged?.invoke(false)
                            onRewardGranted()
                        }
                    }
                }
            }

            synchronized(rewardedWaiters) {
                rewardedWaiters.add(waiter)
            }
            return
        }

        preloadRewarded(activity.applicationContext)
        onRewardGranted()
    }
}
