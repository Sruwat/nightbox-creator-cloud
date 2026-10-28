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

    private var streamUrl: String? = null
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

        // Stage 1: Button starts in preparing state while ads load
        pbLoadingVideo?.visibility = View.VISIBLE
        icOpenVideo?.visibility = View.GONE
        tvOpenVideoText?.text = "Connecting to stream..."

        // Safety fallback: auto-unlock if ads take too long (max 10s)
        maxSafetyTimeoutHandler = Handler(Looper.getMainLooper())
        maxSafetyTimeoutRunnable = Runnable {
            if (!isButtonUnlocked) {
                Log.d("FileInfoActivity", "Safety timeout reached (10s). Unlocking stream button.")
                unlockButtonForPlayback()
            }
        }
        maxSafetyTimeoutHandler?.postDelayed(maxSafetyTimeoutRunnable!!, 10_000L)

        val passedTitle = intent?.getStringExtra("video_title")
        if (!passedTitle.isNullOrBlank()) {
            videoTitle = formatCleanTitle(passedTitle)
            tvVideoTitle.text = videoTitle
        }

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

        // Fetch video title and details from server
        fetchVideoInfo()

        // Preload rewarded ad immediately so it is ready on click
        AdManager.preloadRewarded(this)

        // Open video action: check if unlocked, then show rewarded ad + play
        btnOpenVideo.applyPressScale {
            if (!isButtonUnlocked) {
                Toast.makeText(this, "Preparing secure stream, please wait a moment...", Toast.LENGTH_SHORT).show()
                return@applyPressScale
            }
            showRewardedThenPlay()
        }

        // Social button click listeners with haptic press-scale
        findViewById<LinearLayout>(R.id.btnJoinTelegram)?.applyPressScale { openTelegram() }
        findViewById<LinearLayout>(R.id.btnJoinWhatsApp)?.applyPressScale { openWhatsApp() }

        // Load ads once on creation (instantly on entering screen)
        loadScreenAds()
    }

    override fun onResume() {
        super.onResume()
        SecurityUtil.checkVpn(this)
        if (adBannerContainerTop.childCount == 0 || (bannerAdView != null && AdManager.canRequestCollapsible("file_info"))) {
            loadBannerAd()
        }
    }

    override fun onDestroy() {
        viewCountDownTimer?.cancel()
        maxSafetyTimeoutRunnable?.let { maxSafetyTimeoutHandler?.removeCallbacks(it) }
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
        Log.d("FileInfoActivity", "Ad is now visible on screen. Starting 4s Ads View Timer.")

        pbLoadingVideo?.visibility = View.GONE
        icOpenVideo?.visibility = View.VISIBLE

        viewCountDownTimer = object : CountDownTimer(4_000L, 1_000L) {
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

        pbLoadingVideo?.visibility = View.GONE
        icOpenVideo?.visibility = View.VISIBLE
        tvOpenVideoText?.text = "Open File"

        btnOpenVideo.startBreathingPulse()
    }

    private fun loadScreenAds() {
        if (adsLoaded) return
        adsLoaded = true

        loadBannerAd()
        loadMrecTopAd()

        // Lazy load bottom MREC only when user scrolls down to view it
        val scrollView = findViewById<android.widget.ScrollView>(R.id.scrollView)
        scrollView?.setOnScrollChangeListener { _, _, scrollY, _, _ ->
            if (!bottomMrecLoaded && scrollY > 200) {
                bottomMrecLoaded = true
                loadMrecBottomAd()
            }
        }
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
        AdManager.showOrWaitForRewardedAd(
            activity = this,
            maxWaitMs = 2000L,
            onLoadingStateChanged = { isLoading ->
                pbLoadingVideo?.visibility = if (isLoading) View.VISIBLE else View.GONE
                icOpenVideo?.visibility = if (isLoading) View.GONE else View.VISIBLE
                tvOpenVideoText?.text = if (isLoading) "Unlocking..." else "Open File"
            },
            onRewardGranted = {
                openVideoPlayer()
            },
            onDismissedEarly = {
                // If user closes/dismisses ad, navigate directly to player per requirements
                openVideoPlayer()
            }
        )
    }

    private fun openVideoPlayer() {
        val vid = videoId ?: return
        val intent = Intent(this, VideoPlayerActivity::class.java).apply {
            putExtra("video_id", vid)
            linkSlug?.let { putExtra("link_slug", it) }
            putExtra("video_title", videoTitle)
            streamUrl?.let { putExtra("stream_url", it) }
            if (videoDurationSec > 0) putExtra("video_duration_sec", videoDurationSec)
            if (videoSizeBytes > 0L) putExtra("video_size_bytes", videoSizeBytes)
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        startActivity(intent)
        finish() // Clean transition, no duplicate back-stack trap
    }

    private fun fetchVideoInfo() {
        val vid = videoId ?: return
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                val client = apiClient

                // If title was not passed, resolve from link slug
                val currentSlug = linkSlug
                if (!currentSlug.isNullOrBlank() && (videoTitle == "NightBox Video" || videoTitle == "Exclusive Premium Video")) {
                    try {
                        val linkReq = Request.Builder()
                            .url("${BuildConfig.BACKEND_URL}/api/links/${Uri.encode(currentSlug)}")
                            .build()
                        client.newCall(linkReq).execute().use { linkResp ->
                            if (linkResp.isSuccessful) {
                                val linkJson = JSONObject(linkResp.body?.string().orEmpty())
                                val rawTitle = linkJson.optJSONObject("link")?.optString("title")
                                if (!rawTitle.isNullOrBlank()) {
                                    videoTitle = formatCleanTitle(rawTitle)
                                    withContext(Dispatchers.Main) {
                                        tvVideoTitle.text = videoTitle
                                    }
                                }
                            }
                        }
                    } catch (_: Exception) {}
                }

                val request = Request.Builder()
                    .url("${BuildConfig.BACKEND_URL}/video/$vid")
                    .build()
                client.newCall(request).execute().use { response ->
                    if (response.isSuccessful) {
                        val jsonData = response.body?.string()
                        val json = JSONObject(jsonData ?: "{}")
                        if (json.optBoolean("success", false)) {
                            val video = json.optJSONObject("video")
                            val fetchedTitle = video?.optString("title")
                            val durationSec = video?.optInt("duration", 0) ?: 0
                            val sizeBytes = video?.optLong("size", 0L) ?: 0L
                            val fetchedStream = listOf("hlsUrl", "cdnUrl", "streamUrl")
                                .firstNotNullOfOrNull { key -> video?.optString(key)?.takeIf { it.isNotBlank() } }
                            if (!fetchedStream.isNullOrBlank()) {
                                streamUrl = fetchedStream
                            }
                            videoDurationSec = durationSec
                            videoSizeBytes = sizeBytes

                            withContext(Dispatchers.Main) {
                                if (!fetchedTitle.isNullOrBlank()) {
                                    videoTitle = formatCleanTitle(fetchedTitle)
                                    tvVideoTitle.text = videoTitle
                                }
                                if (durationSec > 0) {
                                    findViewById<TextView>(R.id.tvSpecDuration)?.text =
                                        String.format("%02d:%02d", durationSec / 60, durationSec % 60)
                                }
                                if (sizeBytes > 0) {
                                    val sizeMb = (sizeBytes / (1024 * 1024)).coerceAtLeast(1)
                                    findViewById<TextView>(R.id.tvSpecSize)?.text = "~$sizeMb MB"
                                } else if (durationSec > 0) {
                                    val sizeMb = ((durationSec * 220) / 1024).coerceAtLeast(42)
                                    findViewById<TextView>(R.id.tvSpecSize)?.text = "~$sizeMb MB"
                                }
                            }
                        }
                    }
                }
            } catch (_: Exception) {}
        }
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
