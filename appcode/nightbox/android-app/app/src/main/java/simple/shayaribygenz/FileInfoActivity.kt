package simple.shayaribygenz

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import com.google.android.gms.ads.AdLoader
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.AdSize
import com.google.android.gms.ads.AdView
import com.google.android.gms.ads.FullScreenContentCallback
import com.google.android.gms.ads.LoadAdError
import com.google.android.gms.ads.interstitial.InterstitialAd
import com.google.android.gms.ads.interstitial.InterstitialAdLoadCallback
import com.google.android.gms.ads.nativead.NativeAd
import com.google.android.gms.ads.nativead.NativeAdView
import com.google.android.gms.ads.rewarded.RewardedAd
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.URL

class FileInfoActivity : AppCompatActivity() {

    private lateinit var btnBack: ImageView
    private lateinit var btnOpenVideo: LinearLayout
    private lateinit var adBannerContainerTop: FrameLayout
    private lateinit var adBannerContainerBottom: FrameLayout
    private lateinit var nativeAdContainer1: FrameLayout
    private lateinit var nativeAdContainer2: FrameLayout
    
    private lateinit var icOpenVideo: ImageView
    private lateinit var pbLoadingVideo: ProgressBar
    private lateinit var tvOpenVideoText: TextView

    private var videoId: String? = null
    private var linkSlug: String? = null
    private var videoTitle: String = "Video"
    private var downloadUrl: String? = null
    private var nativeAd1: NativeAd? = null
    private var nativeAd2: NativeAd? = null
    private var premium = PremiumEntitlement()
    
    private val handler = Handler(Looper.getMainLooper())
    private var timerRunnable: Runnable? = null

    companion object {
        private const val INTERSTITIAL_INTERVAL = 3
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_file_info)

        // Get video ID from intent extras only (deep links are handled by MainActivity)
        videoId = intent?.getStringExtra("video_id")
        linkSlug = intent?.getStringExtra("link_slug")

        if (videoId == null) {
            Toast.makeText(this, "Invalid video link", Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        // Bind views
        btnBack = findViewById(R.id.btnBack)
        btnOpenVideo = findViewById(R.id.btnOpenVideo)
        adBannerContainerTop = findViewById(R.id.adBannerContainerTop)
        adBannerContainerBottom = findViewById(R.id.adBannerContainerBottom)
        nativeAdContainer1 = findViewById(R.id.nativeAdContainer1)
        nativeAdContainer2 = findViewById(R.id.nativeAdContainer2)
        icOpenVideo = findViewById(R.id.icOpenVideo)
        pbLoadingVideo = findViewById(R.id.pbLoadingVideo)
        tvOpenVideoText = findViewById(R.id.tvOpenVideoText)

        // Fetch video info (title/download link)
        fetchVideoInfo()

        // Back button
        btnBack.setOnClickListener { finish() }

        // Open Video button
        btnOpenVideo.setOnClickListener {
            if (premium.videoAdsRemoved) {
                openVideoPlayer(false)
                return@setOnClickListener
            }
            val prefs = getSharedPreferences("nightbox_prefs", MODE_PRIVATE)
            var currentCount = prefs.getInt("open_video_count", 0)
            currentCount++
            
            // Save the updated count immediately so it persists even if user closes the app
            prefs.edit().putInt("open_video_count", currentCount).apply()
            
            val cyclePosition = currentCount % 6
            
            when (cyclePosition) {
                1, 3 -> {
                    // Click 1 and 3 (and 7, 9, 13, 15...): Interstitial Ad
                    loadAndShowInterstitial()
                }
                5 -> {
                    // Click 5 (and 11, 17...): Rewarded Ad
                    loadAndShowRewarded()
                }
                else -> {
                    // Clicks 2, 4, 0 (which means 6) etc: Free (No Ad)
                    openVideoPlayer(true)
                }
            }
        }

        // Social buttons
        findViewById<LinearLayout>(R.id.btnJoinTelegram).setOnClickListener {
            openTelegram()
        }

        findViewById<LinearLayout>(R.id.btnJoinWhatsApp).setOnClickListener {
            openWhatsApp()
        }

    }

    override fun onResume() {
        super.onResume()
        SecurityUtil.checkVpn(this)
        
        lifecycleScope.launch {
            premium = PremiumAccess.entitlement(this@FileInfoActivity)
            if (premium.allAdsRemoved) {
                adBannerContainerTop.visibility = View.GONE
                adBannerContainerBottom.visibility = View.GONE
                nativeAdContainer1.visibility = View.GONE
                nativeAdContainer2.visibility = View.GONE
            } else {
                loadBannerAdWhenReady(adBannerContainerTop)
                loadBannerAdWhenReady(adBannerContainerBottom)
                loadNativeAd(nativeAdContainer1, { nativeAd1?.destroy(); nativeAd1 = it })
                loadNativeAd(nativeAdContainer2, { nativeAd2?.destroy(); nativeAd2 = it })
            }
        }
        
        // Start 7-second timer for Open Video button
        startOpenVideoTimer()
    }
    
    override fun onDestroy() {
        super.onDestroy()
        nativeAd1?.destroy()
        nativeAd2?.destroy()
        timerRunnable?.let { handler.removeCallbacks(it) }
    }

    private fun startOpenVideoTimer() {
        // Reset button to loading state
        btnOpenVideo.isClickable = false
        icOpenVideo.visibility = View.GONE
        pbLoadingVideo.visibility = View.VISIBLE
        tvOpenVideoText.text = "Loading..."
        tvOpenVideoText.alpha = 0.7f

        // Cancel previous timer if any
        timerRunnable?.let { handler.removeCallbacks(it) }

        // 7 seconds delay
        timerRunnable = Runnable {
            btnOpenVideo.isClickable = true
            icOpenVideo.visibility = View.VISIBLE
            pbLoadingVideo.visibility = View.GONE
            tvOpenVideoText.text = getString(R.string.open_video)
            tvOpenVideoText.alpha = 1.0f
        }
        handler.postDelayed(timerRunnable!!, 7000)
    }

    private fun getVideoIdFromDeepLink(): String? {
        val data: Uri? = intent?.data
        if (data != null) {
            val pathSegments = data.pathSegments
            if (pathSegments.size >= 2 && pathSegments[0] == "watch") {
                return pathSegments[1]
            }
        }
        return null
    }

    private fun openVideoPlayer(showVastAd: Boolean = false) {
        val vid = videoId ?: return
        val intent = Intent(this, VideoPlayerActivity::class.java)
        intent.putExtra("video_id", vid)
        linkSlug?.let { intent.putExtra("link_slug", it) }
        intent.putExtra("show_vast_ad", showVastAd)
        startActivity(intent)
    }

    private fun openTelegram() {
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://t.me/nightboxupdate"))
            startActivity(intent)
        } catch (_: Exception) {
            Toast.makeText(this, "Could not open Telegram", Toast.LENGTH_SHORT).show()
        }
    }

    private fun openWhatsApp() {
        try {
            // Replace with your actual WhatsApp group or channel link
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://whatsapp.com/channel/0029VbDV1LR3GJP5XqCMb309"))
            startActivity(intent)
        } catch (_: Exception) {
            Toast.makeText(this, "Could not open WhatsApp", Toast.LENGTH_SHORT).show()
        }
    }

    private fun loadBannerAdWhenReady(container: FrameLayout) {
        if (premium.allAdsRemoved) return
        if (NightBoxApp.adsInitialized) {
            loadBannerAd(container)
        } else {
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                loadBannerAdWhenReady(container)
            }, 500)
        }
    }

    private fun loadBannerAd(container: FrameLayout) {
        if (premium.allAdsRemoved) return
        val adView = AdView(this)
        
        // Calculate adaptive banner size
        val displayMetrics = resources.displayMetrics
        val adWidthPixels = displayMetrics.widthPixels.toFloat()
        val density = displayMetrics.density
        val adWidth = (adWidthPixels / density).toInt()
        val adSize = AdSize.getCurrentOrientationAnchoredAdaptiveBannerAdSize(this, adWidth)
        
        adView.setAdSize(adSize)
        adView.adUnitId = "ca-app-pub-2964717174761820/7251270834" // Real Banner ID
        container.removeAllViews()
        container.addView(adView)
        adView.loadAd(AdRequest.Builder().build())
    }

    private fun loadNativeAd(container: FrameLayout, onLoaded: (NativeAd) -> Unit) {
        if (premium.allAdsRemoved) return
        val adLoader = AdLoader.Builder(this, "ca-app-pub-2964717174761820/2042116691") // Real Native ID
            .forNativeAd { ad: NativeAd ->
                onLoaded(ad)
                val adView = layoutInflater.inflate(R.layout.layout_native_ad, null) as NativeAdView
                populateNativeAdView(ad, adView)
                container.removeAllViews()
                container.addView(adView)
                container.background = null // Remove placeholder background if any
            }
            .build()

        adLoader.loadAd(AdRequest.Builder().build())
    }

    private fun populateNativeAdView(nativeAd: NativeAd, adView: NativeAdView) {
        adView.headlineView = adView.findViewById(R.id.ad_headline)
        adView.bodyView = adView.findViewById(R.id.ad_body)
        adView.callToActionView = adView.findViewById(R.id.ad_call_to_action)
        adView.iconView = adView.findViewById(R.id.ad_app_icon)
        adView.mediaView = adView.findViewById(R.id.ad_media)

        (adView.headlineView as TextView).text = nativeAd.headline
        nativeAd.mediaContent?.let { adView.mediaView?.setMediaContent(it) }

        if (nativeAd.body == null) {
            adView.bodyView?.visibility = View.INVISIBLE
        } else {
            adView.bodyView?.visibility = View.VISIBLE
            (adView.bodyView as TextView).text = nativeAd.body
        }

        if (nativeAd.callToAction == null) {
            adView.callToActionView?.visibility = View.INVISIBLE
        } else {
            adView.callToActionView?.visibility = View.VISIBLE
            (adView.callToActionView as Button).text = nativeAd.callToAction
        }

        if (nativeAd.icon == null) {
            adView.iconView?.visibility = View.GONE
        } else {
            (adView.iconView as ImageView).setImageDrawable(nativeAd.icon?.drawable)
            adView.iconView?.visibility = View.VISIBLE
        }

        adView.setNativeAd(nativeAd)
    }

    private fun loadAndShowInterstitial() {
        // Use globally preloaded interstitial from NightBoxApp (already ready)
        val ad = NightBoxApp.preloadedInterstitial
        if (ad != null) {
            NightBoxApp.preloadedInterstitial = null
            ad.fullScreenContentCallback = object : FullScreenContentCallback() {
                override fun onAdDismissedFullScreenContent() {
                    openVideoPlayer()
                }
                override fun onAdFailedToShowFullScreenContent(e: com.google.android.gms.ads.AdError) {
                    openVideoPlayer()
                }
            }
            ad.show(this)
        } else {
            // Not ready yet — load on-demand and show
            InterstitialAd.load(
                this,
                NightBoxApp.INTERSTITIAL_AD_UNIT,
                NightBoxApp.adRequest,
                object : InterstitialAdLoadCallback() {
                    override fun onAdLoaded(ad: InterstitialAd) {
                        ad.fullScreenContentCallback = object : FullScreenContentCallback() {
                            override fun onAdDismissedFullScreenContent() { openVideoPlayer() }
                            override fun onAdFailedToShowFullScreenContent(e: com.google.android.gms.ads.AdError) { openVideoPlayer() }
                        }
                        ad.show(this@FileInfoActivity)
                    }
                    override fun onAdFailedToLoad(error: LoadAdError) {
                        openVideoPlayer() // Ad failed, just open the video
                    }
                }
            )
        }
    }

    private fun loadAndShowRewarded() {
        val ad = NightBoxApp.preloadedRewarded
        if (ad != null) {
            NightBoxApp.preloadedRewarded = null
            ad.fullScreenContentCallback = object : FullScreenContentCallback() {
                override fun onAdDismissedFullScreenContent() {
                    openVideoPlayer()
                }
                override fun onAdFailedToShowFullScreenContent(e: com.google.android.gms.ads.AdError) {
                    openVideoPlayer()
                }
            }
            ad.show(this) { /* reward granted */ }
        } else {
            // Not ready yet — load on-demand and show
            RewardedAd.load(
                this,
                NightBoxApp.REWARDED_AD_UNIT,
                NightBoxApp.adRequest,
                object : RewardedAdLoadCallback() {
                    override fun onAdLoaded(ad: RewardedAd) {
                        ad.fullScreenContentCallback = object : FullScreenContentCallback() {
                            override fun onAdDismissedFullScreenContent() { openVideoPlayer() }
                            override fun onAdFailedToShowFullScreenContent(e: com.google.android.gms.ads.AdError) { openVideoPlayer() }
                        }
                        ad.show(this@FileInfoActivity) { /* reward granted */ }
                    }
                    override fun onAdFailedToLoad(error: LoadAdError) {
                        openVideoPlayer()
                    }
                }
            )
        }
    }

    private fun fetchVideoInfo() {
        val vid = videoId ?: return
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                val client = OkHttpClient()
                val request = Request.Builder()
                    .url("${BuildConfig.BACKEND_URL}/video/$vid")
                    .build()
                val response = client.newCall(request).execute()
                if (response.isSuccessful) {
                    val jsonData = response.body?.string()
                    val json = JSONObject(jsonData ?: "{}")
                    if (json.getBoolean("success")) {
                        val video = json.getJSONObject("video")
                        videoTitle = video.getString("title")
                        // Use download proxy URL from backend API
                        val dlUrl = video.optString("downloadUrl", "")
                        downloadUrl = if (dlUrl.isNotEmpty()) dlUrl else null
                    }
                }
            } catch (_: Exception) {}
        }
    }
}
