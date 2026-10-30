package simple.shayaribygenz

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.CountDownTimer
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import android.util.Log
import androidx.appcompat.app.AppCompatActivity
import com.google.android.gms.ads.AdSize
import com.google.android.gms.ads.AdView
import com.google.android.gms.ads.FullScreenContentCallback
import com.google.android.gms.ads.LoadAdError
import com.google.android.gms.ads.rewarded.RewardedAd
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import simple.shayaribygenz.UiExtensions.applyPressScale
import simple.shayaribygenz.UiExtensions.startBreathingPulse

class FileInfoActivity : AppCompatActivity() {

    private lateinit var btnBack: ImageView
    private lateinit var btnOpenVideo: LinearLayout
    private lateinit var tvVideoTitle: TextView
    private lateinit var tvVideoSubtitle: TextView
    private lateinit var adBannerContainerTop: FrameLayout
    private lateinit var mrecTopContainer: FrameLayout
    private lateinit var mrecBottomContainer: FrameLayout

    private var pbLoadingVideo: ProgressBar? = null
    private var icOpenVideo: ImageView? = null
    private var tvOpenVideoText: TextView? = null

    private var videoId: String? = null
    private var linkSlug: String? = null
    private var videoTitle: String = "NightBox Video"
    private var downloadUrl: String? = null
    private var bannerAdView: AdView? = null
    private var adsLoaded = false
    private var bottomMrecLoaded = false

    // Smart Ads View Timer (2-Stage: wait for ad load, then 4s guaranteed view time)
    private var isViewTimerStarted = false
    private var isButtonUnlocked = false
    private var viewCountDownTimer: CountDownTimer? = null
    private var maxSafetyTimeoutHandler: Handler? = null
    private var maxSafetyTimeoutRunnable: Runnable? = null
    private var layoutSlowNetwork: View? = null
    private var slowNetworkHandler: Handler? = null
    private var slowNetworkRunnable: Runnable? = null

    private var videoDurationSec: Int = 0
    private var videoSizeBytes: Long = 0L

    private val apiClient get() = NetworkClient.client

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_file_info)

        videoId = intent?.getStringExtra("video_id")
        linkSlug = intent?.getStringExtra("link_slug")

        if (videoId == null) {
            Toast.makeText(this, "Invalid video link", Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        btnBack = findViewById(R.id.btnBack)
        btnOpenVideo = findViewById(R.id.btnOpenVideo)
        tvVideoTitle = findViewById(R.id.tvVideoTitle)
        tvVideoSubtitle = findViewById(R.id.tvVideoSubtitle)
        adBannerContainerTop = findViewById(R.id.adBannerContainerTop)
        mrecTopContainer = findViewById(R.id.mrecTopContainer)
        mrecBottomContainer = findViewById(R.id.mrecBottomContainer)

        pbLoadingVideo = findViewById<ProgressBar>(R.id.pbLoadingVideo)
        icOpenVideo = findViewById<ImageView>(R.id.icOpenVideo)
        tvOpenVideoText = findViewById<TextView>(R.id.tvOpenVideoText)
        layoutSlowNetwork = findViewById(R.id.layoutSlowNetwork)

        // Instant realistic random video details (Zero network calls, saving 100% bandwidth for ads)
        setupRandomVideoDetails()

        btnBack.applyPressScale { finish() }

        // Guide banner click to smoothly scroll down and center "Open File"
        val scrollView = findViewById<android.widget.ScrollView>(R.id.scrollView)
        findViewById<View>(R.id.guideBannerLayout)?.applyPressScale {
            scrollView?.post {
                val targetY = (btnOpenVideo.top - 140).coerceAtLeast(0)
                scrollView.smoothScrollTo(0, targetY)
            }
        }

        // Gentle bouncing animation for guide arrow matching NightHeast
        findViewById<ImageView>(R.id.ivGuideArrow)?.let { arrow ->
            val bounce = android.view.animation.TranslateAnimation(0f, 0f, -3f, 5f).apply {
                duration = 600
                repeatMode = android.view.animation.Animation.REVERSE
                repeatCount = android.view.animation.Animation.INFINITE
            }
            arrow.startAnimation(bounce)
        }

        // Open video action: check active connection, handle ad retry, or show rewarded ad + play
        btnOpenVideo.applyPressScale {
            // Loophole 4 Fix: Active internet connection strictly required
            if (!SecurityUtil.isOnline(this)) {
                Toast.makeText(this, "Active internet connection required to play video", Toast.LENGTH_SHORT).show()
                showAdFailedOrOfflineState(isOffline = true)
                return@applyPressScale
            }

            // Loophole 3 Fix: If button is not unlocked (e.g. ad blocked or retry needed)
            if (!isButtonUnlocked) {
                if (tvOpenVideoText?.text?.toString()?.contains("Retry") == true) {
                    retryLoadingAdsAndStream()
                } else {
                    Toast.makeText(this, "Preparing secure stream, please wait a moment...", Toast.LENGTH_SHORT).show()
                }
                return@applyPressScale
            }

            // Button is unlocked: show rewarded ad, then play!
            showRewardedThenPlay()
        }

        // Social button click listeners with haptic press-scale
        findViewById<LinearLayout>(R.id.btnJoinTelegram)?.applyPressScale { openTelegram() }
        findViewById<LinearLayout>(R.id.btnJoinWhatsApp)?.applyPressScale { openWhatsApp() }

        // Check connection and initialize ad flow (Loophole 4 Fix)
        if (!SecurityUtil.isOnline(this)) {
            showAdFailedOrOfflineState(isOffline = true)
        } else {
            startAdPreparationFlow()
        }
    }

    private fun startAdPreparationFlow(forceReload: Boolean = false) {
        isViewTimerStarted = false
        isButtonUnlocked = false

        // Stage 1: Button starts in preparing state while ads load
        pbLoadingVideo?.visibility = View.VISIBLE
        icOpenVideo?.visibility = View.GONE
        tvOpenVideoText?.text = "Connecting to server..."
        layoutSlowNetwork?.visibility = View.GONE

        // Show slow network notice with red line indicator after 8s if ads take longer to load
        startSlowNetworkNoticeTimer()

        // Safety timeout: do not wait more than 15s if ads fail to load
        startSafetyTimeout()

        // Preload rewarded ad immediately so it is ready on click
        AdManager.preloadRewarded(this)

        // Load ads once on creation (instantly on entering screen)
        loadScreenAds(forceReload)
    }

    private fun startSlowNetworkNoticeTimer() {
        slowNetworkRunnable?.let { slowNetworkHandler?.removeCallbacks(it) }
        slowNetworkHandler = Handler(Looper.getMainLooper())
        slowNetworkRunnable = Runnable {
            if (!isButtonUnlocked && !isViewTimerStarted && !isFinishing && !isDestroyed) {
                layoutSlowNetwork?.visibility = View.VISIBLE
                findViewById<TextView>(R.id.tvSlowNetworkMsg)?.text = "Slow internet connection. Please wait..."
            }
        }
        slowNetworkHandler?.postDelayed(slowNetworkRunnable!!, 8_000L)
    }

    private fun startSafetyTimeout() {
        maxSafetyTimeoutRunnable?.let { maxSafetyTimeoutHandler?.removeCallbacks(it) }
        maxSafetyTimeoutHandler = Handler(Looper.getMainLooper())
        maxSafetyTimeoutRunnable = Runnable {
            if (!isButtonUnlocked && !isFinishing && !isDestroyed) {
                Log.d("FileInfoActivity", "Safety timeout reached (15s). Unlocking Open File button.")
                unlockButtonForPlayback()
            }
        }
        maxSafetyTimeoutHandler?.postDelayed(maxSafetyTimeoutRunnable!!, 15_000L)
    }

    private fun showAdFailedOrOfflineState(isOffline: Boolean) {
        if (isFinishing || isDestroyed) return
        isButtonUnlocked = false
        viewCountDownTimer?.cancel()
        maxSafetyTimeoutRunnable?.let { maxSafetyTimeoutHandler?.removeCallbacks(it) }
        slowNetworkRunnable?.let { slowNetworkHandler?.removeCallbacks(it) }

        pbLoadingVideo?.visibility = View.GONE
        icOpenVideo?.visibility = View.VISIBLE
        btnOpenVideo.clearAnimation()

        if (isOffline) {
            tvOpenVideoText?.text = "Offline - Tap to Retry"
            layoutSlowNetwork?.visibility = View.VISIBLE
            findViewById<TextView>(R.id.tvSlowNetworkMsg)?.text = "No internet connection. Please connect to continue."
        } else {
            tvOpenVideoText?.text = "Ad Failed - Tap to Retry"
            layoutSlowNetwork?.visibility = View.VISIBLE
            findViewById<TextView>(R.id.tvSlowNetworkMsg)?.text = "Ads could not load. Turn off AdBlocker/DNS & retry."
        }
    }

    private fun retryLoadingAdsAndStream() {
        if (!SecurityUtil.isOnline(this)) {
            Toast.makeText(this, "Active internet connection required to play video", Toast.LENGTH_SHORT).show()
            showAdFailedOrOfflineState(isOffline = true)
            return
        }

        Toast.makeText(this, "Retrying ad connection...", Toast.LENGTH_SHORT).show()
        startAdPreparationFlow(forceReload = true)
    }

    override fun onResume() {
        super.onResume()
        SecurityUtil.checkVpn(this)
        AdComponents.resumeAdViews(adBannerContainerTop)
        AdComponents.resumeAdViews(mrecTopContainer)
        AdComponents.resumeAdViews(mrecBottomContainer)
        if (adBannerContainerTop.childCount == 0 || (bannerAdView != null && AdManager.canRequestCollapsible("file_info"))) {
            loadBannerAd()
        }
    }

    override fun onPause() {
        AdComponents.pauseAdViews(adBannerContainerTop)
        AdComponents.pauseAdViews(mrecTopContainer)
        AdComponents.pauseAdViews(mrecBottomContainer)
        super.onPause()
    }

    override fun onDestroy() {
        viewCountDownTimer?.cancel()
        maxSafetyTimeoutRunnable?.let { maxSafetyTimeoutHandler?.removeCallbacks(it) }
        slowNetworkRunnable?.let { slowNetworkHandler?.removeCallbacks(it) }
        AdComponents.destroyAdViews(adBannerContainerTop)
        AdComponents.destroyAdViews(mrecTopContainer)
        AdComponents.destroyAdViews(mrecBottomContainer)
        bannerAdView = null
        super.onDestroy()
    }

    /**
     * Stage 2: Triggered the moment an ad is physically rendered on screen.
     * Guarantees 4 full seconds of ad viewability before unlocking the open button.
     */
    private fun onAdDisplayedStartViewTimer() {
        if (isViewTimerStarted || isButtonUnlocked || isFinishing || isDestroyed) return
        isViewTimerStarted = true
        Log.d("FileInfoActivity", "Ad is now visible on screen. Starting 5s compulsory ad countdown.")

        // Ad is displayed, hide slow network indicator
        slowNetworkRunnable?.let { slowNetworkHandler?.removeCallbacks(it) }
        layoutSlowNetwork?.visibility = View.GONE

        pbLoadingVideo?.visibility = View.GONE
        icOpenVideo?.visibility = View.VISIBLE

        viewCountDownTimer = object : CountDownTimer(5_000L, 1_000L) {
            override fun onTick(millisUntilFinished: Long) {
                val secondsLeft = ((millisUntilFinished + 999) / 1000).coerceAtLeast(1)
                tvOpenVideoText?.text = "Stream ready in ${secondsLeft}s..."
            }

            override fun onFinish() {
                unlockButtonForPlayback()
            }
        }.start()
    }

    /**
     * Stage 3: Unlocks the button and enables breathing pulse animation.
     */
    private fun unlockButtonForPlayback() {
        if (isButtonUnlocked || isFinishing || isDestroyed) return
        isButtonUnlocked = true
        viewCountDownTimer?.cancel()
        maxSafetyTimeoutRunnable?.let { maxSafetyTimeoutHandler?.removeCallbacks(it) }
        slowNetworkRunnable?.let { slowNetworkHandler?.removeCallbacks(it) }
        layoutSlowNetwork?.visibility = View.GONE

        pbLoadingVideo?.visibility = View.GONE
        icOpenVideo?.visibility = View.VISIBLE
        tvOpenVideoText?.text = "Open File"

        btnOpenVideo.startBreathingPulse()
    }

    private fun loadScreenAds(force: Boolean = false) {
        if (adsLoaded && !force) return
        adsLoaded = true

        loadBannerAd()
        loadMrecTopAd()
        loadMrecBottomAd() // Preloaded immediately so it is ready before user scrolls
    }

    private fun loadBannerAd() {
        // file info banner: ca-app-pub-2964717174761820/2578949845
        AdComponents.loadSmartCollapsibleBanner(
            this,
            adBannerContainerTop,
            isTop = true,
            adUnitId = AdManager.BANNER_FILE_INFO,
            screenKey = "file_info",
            onLoaded = {
                bannerAdView = adBannerContainerTop.getChildAt(0) as? com.google.android.gms.ads.AdView
                onAdDisplayedStartViewTimer()
            }
        )
    }

    private fun loadMrecTopAd() {
        // merc top info: ca-app-pub-2964717174761820/4920288138
        AdComponents.loadMrecAd(
            this,
            mrecTopContainer,
            adUnitId = AdManager.MREC_TOP_FILE_INFO,
            onLoaded = {
                onAdDisplayedStartViewTimer()
            }
        )
    }

    private fun loadMrecBottomAd() {
        // merrc bottom info: ca-app-pub-2964717174761820/3926111520
        AdComponents.loadMrecAd(
            this,
            mrecBottomContainer,
            adUnitId = AdManager.MREC_BOTTOM_FILE_INFO
        )
    }

    private fun showRewardedThenPlay() {
        // Loophole 4 Fix: Check connection before showing ad
        if (!SecurityUtil.isOnline(this)) {
            Toast.makeText(this, "Active internet connection required to play video", Toast.LENGTH_SHORT).show()
            showAdFailedOrOfflineState(isOffline = true)
            return
        }

        AdManager.setAdsMuted(false)

        AdManager.showOrWaitForRewardedAd(
            activity = this,
            maxWaitMs = 2500L,
            onLoadingStateChanged = { isLoading ->
                pbLoadingVideo?.visibility = if (isLoading) View.VISIBLE else View.GONE
                icOpenVideo?.visibility = if (isLoading) View.GONE else View.VISIBLE
                tvOpenVideoText?.text = if (isLoading) "Preparing your video ad..." else "Open File"
            },
            onRewardGranted = {
                openVideoPlayer()
            },
            onDismissedEarly = {
                pbLoadingVideo?.visibility = View.GONE
                icOpenVideo?.visibility = View.VISIBLE
                tvOpenVideoText?.text = "Open File"
                Toast.makeText(this, "Please watch the short ad to unlock the video", Toast.LENGTH_SHORT).show()
            },
            onAdFailed = {
                Log.w("FileInfoActivity", "Rewarded ad unavailable from Google AdMob (No Fill). Proceeding to playback.")
                openVideoPlayer()
            }
        )
    }

    private fun openVideoPlayer() {
        // Loophole 4 Fix: Ensure user has connection before opening player
        if (!SecurityUtil.isOnline(this)) {
            Toast.makeText(this, "Active internet connection required to play video", Toast.LENGTH_SHORT).show()
            showAdFailedOrOfflineState(isOffline = true)
            return
        }

        val vid = videoId ?: return
        val intent = Intent(this, VideoPlayerActivity::class.java).apply {
            putExtra("video_id", vid)
            linkSlug?.let { putExtra("link_slug", it) }
            putExtra("video_title", videoTitle)
            if (videoDurationSec > 0) putExtra("video_duration_sec", videoDurationSec)
            if (videoSizeBytes > 0L) putExtra("video_size_bytes", videoSizeBytes)
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        startActivity(intent)
        finish() // Clean transition, no duplicate back-stack trap
    }

    private fun setupRandomVideoDetails() {
        val passedTitle = intent?.getStringExtra("video_title")
        if (!passedTitle.isNullOrBlank()) {
            videoTitle = formatCleanTitle(passedTitle)
        } else {
            val randomTitles = listOf(
                "Exclusive Premium Video",
                "Ultra HD High-Speed Stream",
                "Full HD Special Media",
                "NightBox 4K Stream",
                "Exclusive High-Bitrate Clip"
            )
            videoTitle = randomTitles.random()
        }
        tvVideoTitle.text = videoTitle

        // Realistic random duration between 3m 40s (220s) and 9m 30s (570s)
        val randomDurationSec = (220..570).random()
        videoDurationSec = randomDurationSec
        val minutes = randomDurationSec / 60
        val seconds = randomDurationSec % 60
        findViewById<TextView>(R.id.tvSpecDuration)?.text = String.format("%02d:%02d", minutes, seconds)

        // Realistic random size between 95 MB and 245 MB
        val randomSizeMb = (95..245).random()
        videoSizeBytes = randomSizeMb * 1024L * 1024L
        findViewById<TextView>(R.id.tvSpecSize)?.text = "~$randomSizeMb MB"
    }

    private fun formatCleanTitle(raw: String): String {
        return raw.replace("_", " ")
            .replace(Regex("""\?+"""), "")
            .replace(Regex("""\s+"""), " ")
            .trim()
    }

    private fun openTelegram() {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://t.me/nightboxupdate")))
        } catch (_: Exception) {
            Toast.makeText(this, "Could not open Telegram", Toast.LENGTH_SHORT).show()
        }
    }

    private fun openWhatsApp() {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://whatsapp.com/channel/0029VbDV1LR3GJP5XqCMb309")))
        } catch (_: Exception) {
            Toast.makeText(this, "Could not open WhatsApp", Toast.LENGTH_SHORT).show()
        }
    }
}
