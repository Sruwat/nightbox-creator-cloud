package simple.shayaribygenz

import android.annotation.SuppressLint
import android.app.PictureInPictureParams
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.Rational
import android.view.View
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.ui.PlayerView
import com.google.android.gms.ads.AdLoader
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.AdSize
import com.google.android.gms.ads.AdView
import com.google.android.gms.ads.nativead.NativeAd
import com.google.android.gms.ads.nativead.NativeAdView
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import androidx.media3.exoplayer.ima.ImaAdsLoader
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType

class VideoPlayerActivity : AppCompatActivity() {

    private lateinit var playerView: PlayerView
    private lateinit var playerViewFullscreen: PlayerView
    private lateinit var webViewPlayer: WebView
    private lateinit var loadingOverlay: LinearLayout
    private lateinit var errorOverlay: LinearLayout
    private lateinit var tvErrorMessage: TextView
    private lateinit var tvLoadingText: TextView
    private lateinit var tvVideoMetaDetails: TextView
    private lateinit var btnRetry: Button
    private lateinit var btnBackOverlay: ImageView
    private lateinit var btnFullscreen: ImageView
    private lateinit var btnExitFullscreen: ImageView
    private lateinit var mainContent: LinearLayout
    private lateinit var fullscreenPlayerContainer: FrameLayout
    private lateinit var adBannerContainerSticky: FrameLayout
    private lateinit var adBannerContainerPlayer: FrameLayout
    private lateinit var adBannerContainerTop: FrameLayout
    private lateinit var nativeAdContainerBottom: FrameLayout
    private var nativeAd: NativeAd? = null
    private var imaAdsLoader: ImaAdsLoader? = null

    private var player: ExoPlayer? = null
    private var videoId: String? = null
    private var localVideoUri: String? = null
    private var isFullscreen = false
    private var usingWebView = false
    private var viewSessionId: String? = null
    private var viewToken: String? = null
    private var viewQualified = false
    private var linkSlug: String? = null
    private var remoteHlsUrl: String? = null
    private var remoteStreamUrl: String? = null
    private var triedRangeFallback = false
    private var durationUpdateRunnable: Runnable? = null
    private var shouldResumePlayback = true
    private var restoredPositionMs = 0L
    private var restoredPlayWhenReady = true
    private val apiClient = OkHttpClient()

    companion object {
        private const val TAG = "VideoPlayerActivity"
    }

    private val backendOrigin: String by lazy {
        val backend = Uri.parse(BuildConfig.BACKEND_URL)
        buildString {
            append(backend.scheme ?: "https")
            append("://")
            append(backend.host ?: "localhost")
            if (backend.port != -1) append(":${backend.port}")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Fullscreen immersive (modern approach)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        setContentView(R.layout.activity_video_player)

        restoredPositionMs = savedInstanceState?.getLong("player_position_ms", 0L) ?: 0L
        restoredPlayWhenReady = savedInstanceState?.getBoolean("player_play_when_ready", true) ?: true

        // Bind views
        playerView = findViewById(R.id.playerView)
        playerViewFullscreen = findViewById(R.id.playerViewFullscreen)
        webViewPlayer = findViewById(R.id.webViewPlayer)
        loadingOverlay = findViewById(R.id.loadingOverlay)
        errorOverlay = findViewById(R.id.errorOverlay)
        tvErrorMessage = findViewById(R.id.tvErrorMessage)
        tvLoadingText = findViewById(R.id.tvLoadingText)
        tvVideoMetaDetails = findViewById(R.id.tvVideoMetaDetails)
        btnRetry = findViewById(R.id.btnRetry)
        btnBackOverlay = findViewById(R.id.btnBackOverlay)
        btnFullscreen = findViewById(R.id.btnFullscreen)
        btnExitFullscreen = findViewById(R.id.btnExitFullscreen)
        mainContent = findViewById(R.id.mainContent)
        fullscreenPlayerContainer = findViewById(R.id.fullscreenPlayerContainer)
        adBannerContainerSticky = findViewById(R.id.adBannerContainerSticky)
        adBannerContainerPlayer = findViewById(R.id.adBannerContainerPlayer)
        adBannerContainerTop = findViewById(R.id.adBannerContainerTop)
        nativeAdContainerBottom = findViewById(R.id.nativeAdContainerBottom)

        // Get video ID from intent or deep link
        videoId = getVideoIdFromIntent()
        linkSlug = intent?.getStringExtra("link_slug") ?: intent?.data?.getQueryParameter("link")
        localVideoUri = intent?.getStringExtra("local_video_uri") ?: intent?.getStringExtra("local_path")
        val videoTitle = intent?.getStringExtra("video_title")
        
        val showVastAd = intent?.getBooleanExtra("show_vast_ad", false) ?: false

        if (videoId == null && localVideoUri == null) {
            showError("Invalid video link. No video ID found.")
            return
        }
        if (videoId != null && !linkSlug.isNullOrBlank()) startViewTracking(linkSlug!!)
        
        if (videoTitle != null) {
            tvVideoMetaDetails.text = videoTitle
        }

        loadVideoAndAds(showVastAd)

        // Back button
        btnBackOverlay.setOnClickListener { finish() }

        // Retry button
        btnRetry.setOnClickListener {
            errorOverlay.visibility = View.GONE
            loadingOverlay.visibility = View.VISIBLE
            initializePlayer()
        }

        // Fullscreen button
        btnFullscreen.setOnClickListener { enterFullscreen() }

        // Exit fullscreen button
        btnExitFullscreen.setOnClickListener { exitFullscreen() }

        // Share button
        findViewById<LinearLayout>(R.id.btnShare)?.setOnClickListener {
            shareVideo()
        }

        // Telegram join button
        findViewById<LinearLayout>(R.id.btnTelegramJoin)?.setOnClickListener {
            openTelegram()
        }

    }

    private fun loadVideoAndAds(requestedVastAd: Boolean) {
        lifecycleScope.launch {
            if (requestedVastAd) {
                imaAdsLoader = ImaAdsLoader.Builder(this@VideoPlayerActivity).build()
            }
            if (videoId != null && localVideoUri == null) loadRemoteVideoMetadata() else initializePlayer()
            loadBannerAdWhenReady(adBannerContainerTop)
            loadBannerAdWhenReady(adBannerContainerSticky)
            loadBannerAdWhenReady(adBannerContainerPlayer)
            loadNativeAd()
        }
    }

    private fun loadRemoteVideoMetadata() {
        val vid = videoId ?: return
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                val request = Request.Builder()
                    .url("${BuildConfig.BACKEND_URL}/video/${Uri.encode(vid)}")
                    .get()
                    .build()
                var response = apiClient.newCall(request).execute()
                var processingAttempts = 0
                while (response.code == 202 && processingAttempts < 60) {
                    response.close()
                    processingAttempts += 1
                    withContext(Dispatchers.Main) {
                        loadingOverlay.visibility = View.VISIBLE
                        tvVideoMetaDetails.text = "Video processing… checking again in 5 seconds"
                    }
                    kotlinx.coroutines.delay(5000)
                    response = apiClient.newCall(request).execute()
                }
                response.use { readyResponse ->
                    if (!readyResponse.isSuccessful) throw IllegalStateException("Video metadata request failed: ${readyResponse.code}")
                    val payload = org.json.JSONObject(readyResponse.body?.string().orEmpty())
                    val video = payload.optJSONObject("video") ?: throw IllegalStateException("Video metadata missing")
                    // Prefer the direct Bunny CDN object. The backend proxy is
                    // only a fallback for legacy/local-storage videos.
                    // HLS must be preferred over the original MP4. Large or
                    // unsupported MP4 files can expose audio without video.
                    remoteHlsUrl = video.optString("hlsUrl").takeIf {
                        it.isNotBlank() && it.substringBefore('?').endsWith(".m3u8", ignoreCase = true)
                    }
                    remoteStreamUrl = video.optString("streamUrl").takeIf { it.isNotBlank() }
                    val title = video.optString("title").takeIf { it.isNotBlank() }
                    withContext(Dispatchers.Main) {
                        title?.let { tvVideoMetaDetails.text = it }
                        initializePlayer()
                    }
                }
            } catch (error: Exception) {
                Log.e(TAG, "Video metadata load failed", error)
                withContext(Dispatchers.Main) { showError("Video is not available right now.") }
            }
        }
    }

    /**
     * Extract video ID from deep link or intent extras
     */
    private fun getVideoIdFromIntent(): String? {
        // Check for deep link
        val data: Uri? = intent?.data
        if (data != null) {
            // URL format: https://video.nightbox.in/watch/VIDEO_ID
            val pathSegments = data.pathSegments
            if (pathSegments.size >= 2 && pathSegments[0] == "watch") {
                linkSlug = data.getQueryParameter("link")
                return pathSegments[1]
            }
        }

        // Check for explicit extra
        val extraId = intent?.getStringExtra("video_id")
        if (extraId != null) return extraId

        return null
    }

    /**
     * Initialize player — tries native ExoPlayer first, falls back to WebView embed
     */
    @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
    private fun initializePlayer() {
        // Release any existing player
        releasePlayer()
        usingWebView = false

        if (localVideoUri != null) {
            // Local files always use ExoPlayer
            initExoPlayerLocal()
        } else {
            // The API returns a range-capable MP4 stream for local VPS storage
            // and the Bunny CDN URL when the Bunny driver is enabled.
            initExoPlayerHls()
        }
    }

    /**
     * ExoPlayer for local video files
     */
    @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
    private fun initExoPlayerLocal() {
        player = ExoPlayer.Builder(this).build()
        playerView.player = player
        // Only attach to playerViewFullscreen when entering fullscreen mode

        val mediaItem = MediaItem.fromUri(Uri.parse(localVideoUri))
        player?.setMediaItem(mediaItem)
        player?.prepare()
        player?.playWhenReady = true

        addPlayerListener()
    }

    /**
     * ExoPlayer with a CDN MP4 source + IMA VAST ads.
     */
    @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
    private fun initExoPlayerHls() {
        val vid = videoId ?: return

        // Prefer the direct CDN URL to avoid an unnecessary VPS hop. Keep the
        // range-capable API stream as a fallback for unavailable CDN objects.
        val mediaUrl = remoteHlsUrl ?: remoteStreamUrl ?: run {
            showError("Video URL is unavailable.")
            return
        }
        Log.d(TAG, "Trying CDN URL: $mediaUrl")
        val isHls = mediaUrl.substringBefore('?').lowercase().endsWith(".m3u8")

        // Create HTTP data source with proper headers
        val dataSourceFactory = DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15000)
            .setReadTimeoutMs(15000)

        // Set up MediaSourceFactory with IMA AdsLoader for VAST
        // IMPORTANT: Build the player ONCE with this factory - do not call ExoPlayer.Builder again
        val mediaSourceFactory = DefaultMediaSourceFactory(dataSourceFactory)
        imaAdsLoader?.let { loader ->
            mediaSourceFactory.setLocalAdInsertionComponents({ loader }, playerView)
        }

        // Build player ONCE with the correct media source factory (includes IMA support)
        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(mediaSourceFactory)
            .build()

        playerView.player = player
        imaAdsLoader?.setPlayer(player)

        // InMobi VAST tag URL
        val adTagUri = Uri.parse("https://api.inmobi.com/showad/v3.1?site-id=10000219819&pl-id=10000775406&rt=vast3&r=4")

        val mediaItemBuilder = MediaItem.Builder()
            .setUri(mediaUrl)
            .setMimeType(if (isHls) MimeTypes.APPLICATION_M3U8 else MimeTypes.VIDEO_MP4)
        if (imaAdsLoader != null) {
            mediaItemBuilder.setAdsConfiguration(
                MediaItem.AdsConfiguration.Builder(adTagUri).build()
            )
        }
        val mediaItem = mediaItemBuilder.build()

        player?.setMediaItem(mediaItem)
        player?.prepare()
        player?.playWhenReady = true

        // Listen for errors — if native playback fails, fallback to WebView.
        player?.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (isPlaying) qualifyAfterFiveSeconds()
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                when (playbackState) {
                    Player.STATE_READY -> {
                        Log.d(TAG, "ExoPlayer CDN media ready")
                        loadingOverlay.visibility = View.GONE
                        playerView.visibility = View.VISIBLE
                        updateVideoMetaDetails()
                        restorePlayerPositionIfNeeded()
                        scheduleDurationUpdates()
                    }
                    Player.STATE_BUFFERING -> {
                        if (playerView.visibility != View.VISIBLE) {
                            loadingOverlay.visibility = View.VISIBLE
                        }
                    }
                    Player.STATE_ENDED -> { /* Video ended */ }
                    Player.STATE_IDLE -> { /* Idle */ }
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                if (isHls && !triedRangeFallback && !remoteStreamUrl.isNullOrBlank()) {
                    // Retry through the byte-range endpoint instead of opening
                    // a WebView that may wait for the complete MP4 download.
                    triedRangeFallback = true
                    remoteHlsUrl = null
                    Log.w(TAG, "HLS playback failed; retrying range MP4", error)
                    releasePlayer()
                    initializePlayer()
                    return
                }
                Log.e(TAG, "ExoPlayer playback failed: ${error.message}, falling back to WebView")
                // Native playback failed — fallback to the same range-capable stream.
                releasePlayer()
                fallbackToWebView()
            }

            override fun onTimelineChanged(timeline: androidx.media3.common.Timeline, reason: Int) {
                updateVideoMetaDetails()
            }
        })
    }

    /**
     * Add standard player listener for local files
     */
    private fun addPlayerListener() {
        player?.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (isPlaying) qualifyAfterFiveSeconds()
            }
            override fun onPlaybackStateChanged(playbackState: Int) {
                when (playbackState) {
                    Player.STATE_READY -> {
                        loadingOverlay.visibility = View.GONE
                        playerView.visibility = View.VISIBLE
                        updateVideoMetaDetails()
                        restorePlayerPositionIfNeeded()
                        scheduleDurationUpdates()
                    }
                    Player.STATE_BUFFERING -> {
                        if (playerView.visibility != View.VISIBLE) {
                            loadingOverlay.visibility = View.VISIBLE
                        }
                    }
                    Player.STATE_ENDED -> { /* Video ended */ }
                    Player.STATE_IDLE -> { /* Idle */ }
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                showError("Playback error: ${error.message}")
            }

            override fun onTimelineChanged(timeline: androidx.media3.common.Timeline, reason: Int) {
                updateVideoMetaDetails()
            }
        })
    }

    private fun restorePlayerPositionIfNeeded() {
        player?.let { current ->
            if (restoredPositionMs > 0L && current.duration > 0L) {
                current.seekTo(restoredPositionMs.coerceAtMost(current.duration))
                restoredPositionMs = 0L
            }
            current.playWhenReady = restoredPlayWhenReady
        }
    }

    private fun scheduleDurationUpdates() {
        durationUpdateRunnable?.let { window.decorView.removeCallbacks(it) }
        val runnable = object : Runnable {
            override fun run() {
                updateVideoMetaDetails()
                val duration = player?.duration ?: 0L
                if (duration <= 0L && !isFinishing) {
                    window.decorView.postDelayed(this, 500L)
                }
            }
        }
        durationUpdateRunnable = runnable
        window.decorView.post(runnable)
    }

    private fun qualifyAfterFiveSeconds() {
        lifecycleScope.launch {
            while (!viewQualified && !isFinishing) {
                if (viewSessionId != null && (player?.currentPosition ?: 0L) >= 5000L) {
                    qualifyView()
                    return@launch
                }
                kotlinx.coroutines.delay(500)
            }
        }
    }

    private fun startViewTracking(slug: String) {
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                val request = Request.Builder().url("${BuildConfig.BACKEND_URL}/api/links/${Uri.encode(slug)}/view/start").post(ByteArray(0).toRequestBody(null)).build()
                apiClient.newCall(request).execute().use { response ->
                    if (response.isSuccessful) {
                        val payload = org.json.JSONObject(response.body?.string().orEmpty())
                        viewSessionId = payload.optString("sessionId").takeIf { it.isNotBlank() }
                        viewToken = payload.optString("viewToken").takeIf { it.isNotBlank() }
                    }
                }
            } catch (error: Exception) { Log.w(TAG, "View tracking start failed", error) }
        }
    }

    private fun qualifyView() {
        val sessionId = viewSessionId ?: return
        val token = viewToken ?: return
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                val body = org.json.JSONObject().put("viewToken", token).toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder().url("${BuildConfig.BACKEND_URL}/api/views/${Uri.encode(sessionId)}/qualify").post(body).build()
                apiClient.newCall(request).execute().use { response ->
                    val succeeded = response.isSuccessful
                    Log.d(TAG, "View qualification response: ${response.code}")
                    withContext(Dispatchers.Main) {
                        if (succeeded) {
                            viewQualified = true
                        } else if (!isFinishing) {
                            // Do not permanently lose a valid view after a
                            // transient proxy, network, or rate-limit failure.
                            window.decorView.postDelayed({ if (!viewQualified) qualifyView() }, 2000L)
                        }
                    }
                }
            } catch (error: Exception) {
                Log.w(TAG, "View qualification failed", error)
                withContext(Dispatchers.Main) {
                    if (!isFinishing) window.decorView.postDelayed({ if (!viewQualified) qualifyView() }, 2000L)
                }
            }
        }
    }

    private fun updateVideoMetaDetails() {
        val durationMs = player?.duration ?: 0L
        if (durationMs > 0) {
            val totalSeconds = durationMs / 1000
            val minutes = totalSeconds / 60
            val seconds = totalSeconds % 60
            val timeString = String.format("%d:%02d min", minutes, seconds)
            tvVideoMetaDetails.text = timeString
        } else {
            tvVideoMetaDetails.text = "Preparing video…"
        }
    }

    /**
     * Fallback: use the backend-resolved HLS URL in the system WebView.
     */
    @SuppressLint("SetJavaScriptEnabled")
    private fun fallbackToWebView() {
        usingWebView = true
        val vid = videoId ?: return

        Log.d(TAG, "Using WebView fallback for video: $vid")

        // Hide ExoPlayer views, show WebView
        playerView.visibility = View.GONE
        fullscreenPlayerContainer.visibility = View.GONE
        btnFullscreen.visibility = View.GONE
        webViewPlayer.visibility = View.VISIBLE
        loadingOverlay.visibility = View.VISIBLE

        // Configure WebView
        webViewPlayer.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            allowFileAccess = true
            allowContentAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        // ExoPlayer can fall back to WebView for streams that fail native
        // playback. Keep the same server-side view qualification contract in
        // that path instead of silently losing the view.
        webViewPlayer.addJavascriptInterface(object {
            @JavascriptInterface
            fun onVideoProgress(positionSeconds: Double) {
                if (positionSeconds >= 5.0) {
                    runOnUiThread { if (!viewQualified) qualifyView() }
                }
            }
        }, "NightboxViewTracker")

        webViewPlayer.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                loadingOverlay.visibility = View.GONE
                webViewPlayer.visibility = View.VISIBLE
            }

            override fun onReceivedError(
                view: WebView?, errorCode: Int, description: String?, failingUrl: String?
            ) {
                super.onReceivedError(view, errorCode, description, failingUrl)
                showError("Failed to load video: $description")
            }
        }

        // WebView fullscreen handling
        webViewPlayer.webChromeClient = object : WebChromeClient() {
            private var customView: View? = null
            private var customViewCallback: CustomViewCallback? = null

            override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                customView = view
                customViewCallback = callback
                isFullscreen = true

                adBannerContainerSticky.visibility = View.GONE
                adBannerContainerPlayer.visibility = View.GONE

                requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                hideSystemBars()

                val rootLayout = findViewById<FrameLayout>(R.id.rootLayout)
                rootLayout.addView(view)
                mainContent.visibility = View.GONE
            }

            override fun onHideCustomView() {
                isFullscreen = false

                adBannerContainerSticky.visibility = View.VISIBLE
                adBannerContainerPlayer.visibility = View.VISIBLE

                val rootLayout = findViewById<FrameLayout>(R.id.rootLayout)
                customView?.let { rootLayout.removeView(it) }
                mainContent.visibility = View.VISIBLE
                customView = null

                requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                showSystemBars()

                customViewCallback?.onCustomViewHidden()
                customViewCallback = null
            }
        }

        val streamUrl = remoteStreamUrl ?: remoteHlsUrl ?: run {
            showError("Video stream URL is unavailable.")
            return
        }

        val html = """
            <!DOCTYPE html>
            <html>
            <head>
                <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
                    .video-container {
                        position: relative;
                        width: 100%;
                        padding-bottom: 56.25%;
                        height: 0;
                        overflow: hidden;
                    }
                    video {
                        position: absolute;
                        top: 0;
                        left: 0;
                        width: 100%;
                        height: 100%;
                        border: none;
                    }
                </style>
            </head>
            <body>
                <div class="video-container">
                    <video id="nightboxVideo" src="$streamUrl" autoplay controls playsinline></video>
                </div>
                <script>
                    const video = document.getElementById('nightboxVideo');
                    video.addEventListener('timeupdate', () => {
                        if (window.NightboxViewTracker) {
                            window.NightboxViewTracker.onVideoProgress(video.currentTime || 0);
                        }
                    });
                </script>
            </body>
            </html>
        """.trimIndent()

        webViewPlayer.loadDataWithBaseURL(
            backendOrigin,
            html,
            "text/html",
            "UTF-8",
            null
        )
    }

    /**
     * Enter fullscreen mode — player covers the entire display (ExoPlayer only)
     */
    private fun enterFullscreen() {
        if (usingWebView) return // WebView handles its own fullscreen

        isFullscreen = true

        // Switch player to fullscreen view
        playerView.player = null
        imaAdsLoader?.setPlayer(null)
        playerViewFullscreen.player = player
        imaAdsLoader?.setPlayer(player)

        // Show fullscreen container, hide main content and sticky ads
        fullscreenPlayerContainer.visibility = View.VISIBLE
        mainContent.visibility = View.GONE
        adBannerContainerSticky.visibility = View.GONE

        // Go landscape
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE

        // Hide system bars for true immersive fullscreen
        hideSystemBars()
    }

    /**
     * Exit fullscreen mode — return to normal portrait layout
     */
    private fun exitFullscreen() {
        if (usingWebView) return

        isFullscreen = false

        // Switch player back to normal view
        playerViewFullscreen.player = null
        imaAdsLoader?.setPlayer(null)
        playerView.player = player
        imaAdsLoader?.setPlayer(player)

        // Show main content and sticky ads, hide fullscreen container
        mainContent.visibility = View.VISIBLE
        adBannerContainerSticky.visibility = View.VISIBLE
        fullscreenPlayerContainer.visibility = View.GONE

        // Back to portrait
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED

        // Show system bars
        showSystemBars()
    }

    /**
     * Hide system bars for immersive fullscreen
     */
    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    /**
     * Show system bars when exiting fullscreen
     */
    private fun showSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, true)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.show(WindowInsetsCompat.Type.systemBars())
    }

    private fun showError(message: String) {
        loadingOverlay.visibility = View.GONE
        playerView.visibility = View.GONE
        webViewPlayer.visibility = View.GONE
        errorOverlay.visibility = View.VISIBLE
        tvErrorMessage.text = message
    }

    private fun shareVideo() {
        val vid = videoId ?: return
        val shareUrl = "$backendOrigin/watch/$vid${linkSlug?.let { "?link=${Uri.encode(it)}" } ?: ""}"
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "NightBox Video")
            putExtra(Intent.EXTRA_TEXT, "Watch this video on NightBox: $shareUrl")
        }
        startActivity(Intent.createChooser(shareIntent, "Share via"))
    }

    private fun openTelegram() {
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://t.me/nightboxupdate"))
            startActivity(intent)
        } catch (_: Exception) {
            Toast.makeText(this, "Could not open Telegram", Toast.LENGTH_SHORT).show()
        }
    }

    // ──────────────────────────────────────────────
    // AdMob Integration
    // ──────────────────────────────────────────────

    private fun loadBannerAdWhenReady(container: FrameLayout) {
        if (NightBoxApp.adsInitialized) {
            loadBannerAd(container)
        } else {
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                loadBannerAdWhenReady(container)
            }, 500)
        }
    }

    private fun loadBannerAd(container: FrameLayout) {
        val adView = AdView(this)
        
        // Calculate adaptive banner size
        val displayMetrics = resources.displayMetrics
        val adWidthPixels = displayMetrics.widthPixels.toFloat()
        val density = displayMetrics.density
        val adWidth = (adWidthPixels / density).toInt()
        val adSize = AdSize.getCurrentOrientationAnchoredAdaptiveBannerAdSize(this, adWidth)
        
        adView.setAdSize(adSize)
        adView.adUnitId = "ca-app-pub-2964717174761820/7251270834" // Real ID
        container.removeAllViews()
        container.addView(adView)
        adView.loadAd(AdRequest.Builder().build())
    }

    private fun loadNativeAd() {
        val adLoader = AdLoader.Builder(this, "ca-app-pub-2964717174761820/2042116691") // Real ID
            .forNativeAd { ad: NativeAd ->
                nativeAd?.destroy()
                nativeAd = ad
                val adView = layoutInflater.inflate(R.layout.layout_native_ad, null) as NativeAdView
                populateNativeAdView(ad, adView)
                nativeAdContainerBottom.removeAllViews()
                nativeAdContainerBottom.addView(adView)
                nativeAdContainerBottom.background = null // Remove placeholder background
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

    // ──────────────────────────────────────────────
    // Player lifecycle
    // ──────────────────────────────────────────────

    private fun releasePlayer() {
        durationUpdateRunnable?.let { window.decorView.removeCallbacks(it) }
        durationUpdateRunnable = null
        player?.let {
            it.stop()
            it.release()
        }
        player = null
    }

    override fun onPause() {
        super.onPause()
        shouldResumePlayback = player?.isPlaying == true
        player?.pause()
        if (usingWebView) webViewPlayer.onPause()
    }

    override fun onResume() {
        super.onResume()
        SecurityUtil.checkVpn(this)
        if (shouldResumePlayback) player?.play()
        if (usingWebView) webViewPlayer.onResume()
    }

    override fun onDestroy() {
        releasePlayer()
        imaAdsLoader?.release()
        nativeAd?.destroy()
        if (usingWebView) webViewPlayer.destroy()
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putLong("player_position_ms", player?.currentPosition ?: 0L)
        outState.putBoolean("player_play_when_ready", player?.playWhenReady ?: true)
        super.onSaveInstanceState(outState)
    }

    @Deprecated("Use onBackPressedDispatcher")
    override fun onBackPressed() {
        if (isFullscreen) {
            if (usingWebView) {
                webViewPlayer.evaluateJavascript("document.exitFullscreen();", null)
            } else {
                exitFullscreen()
            }
            return
        }
        if (usingWebView && webViewPlayer.canGoBack()) {
            webViewPlayer.goBack()
            return
        }
        super.onBackPressed()
    }
}
