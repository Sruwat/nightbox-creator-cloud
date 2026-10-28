package simple.shayaribygenz

import android.annotation.SuppressLint
import android.app.PictureInPictureParams
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.util.Log
import android.util.Rational
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.WebChromeClient
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
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.AdSize
import com.google.android.gms.ads.AdView
import com.google.android.gms.ads.LoadAdError
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import android.media.MediaMetadataRetriever
import androidx.appcompat.app.AlertDialog
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import simple.shayaribygenz.UiExtensions.applyPressScale
import simple.shayaribygenz.UiExtensions.vibrateTick

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
    private lateinit var btnTopBack: ImageView
    private lateinit var btnFullscreen: ImageView
    private lateinit var btnExitFullscreen: ImageView
    private lateinit var mainContent: LinearLayout
    private lateinit var fullscreenPlayerContainer: FrameLayout
    private lateinit var adBannerContainerTop: FrameLayout
    private lateinit var mrecPlayerContainer: FrameLayout
    private var bannerAdView: AdView? = null

    // Advance Player HUD & Controls
    private lateinit var hudOverlay: LinearLayout
    private lateinit var tvHudText: TextView
    private lateinit var hudOverlayFullscreen: LinearLayout
    private lateinit var tvHudTextFullscreen: TextView
    private var hudDismissRunnable: Runnable? = null

    // Advance Player State (Aspect ratio & Playback speeds)
    private var currentResizeModeIndex = 0
    private val resizeModes = intArrayOf(
        AspectRatioFrameLayout.RESIZE_MODE_FIT,
        AspectRatioFrameLayout.RESIZE_MODE_ZOOM,
        AspectRatioFrameLayout.RESIZE_MODE_FILL
    )
    private val resizeModeLabels = arrayOf("Fit (Original)", "Crop to Fill", "Stretch")

    private var currentSpeedIndex = 0
    private val playbackSpeeds = floatArrayOf(1.0f, 1.25f, 1.5f, 2.0f, 0.75f)
    private var isTemporaryFastForward = false
    private var speedBeforeFastForward = 1.0f

    private var player: ExoPlayer? = null
    private var videoId: String? = null
    private var localVideoUri: String? = null
    private var isFullscreen = false
    private var usingWebView = false
    private var viewSessionId: String? = null
    private var viewToken: String? = null
    private var viewQualified = false
    private var viewTrackingStarted = false
    private var viewTrackingRetries = 0
    private var processingRetryCount = 0
    private var linkSlug: String? = null
    private var remoteHlsUrl: String? = null
    private var downloadUrl: String? = null
    private var originHlsUrl: String? = null
    private var originFallbackAttempted = false
    private var durationUpdateRunnable: Runnable? = null
    private var shouldResumePlayback = true
    private var restoredPositionMs = 0L
    private var restoredPlayWhenReady = true
    private var resolvedVideoTitle: String = "NightBox Video"
    private var resolvedDurationMs: Long = 256_000L
    private var resolvedContentLength: Long = 11_220_967L
    private val apiClient get() = NetworkClient.client
    private var videoPlaybackEnded = false
    private var indexingJob: kotlinx.coroutines.Job? = null
    private var indexingCall: okhttp3.Call? = null

    private fun formatCleanTitle(raw: String): String {
        return raw.replace("_", " ")
            .replace(Regex("""\?+"""), "")
            .replace(Regex("""\s+"""), " ")
            .trim()
    }

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
        btnTopBack = findViewById(R.id.btnTopBack)
        btnFullscreen = findViewById(R.id.btnFullscreen)
        btnExitFullscreen = findViewById(R.id.btnExitFullscreen)
        mainContent = findViewById(R.id.mainContent)
        fullscreenPlayerContainer = findViewById(R.id.fullscreenPlayerContainer)
        adBannerContainerTop = findViewById(R.id.adBannerContainerTop)
        mrecPlayerContainer = findViewById(R.id.mrecPlayerContainer)

        // Advance Player HUD views
        hudOverlay = findViewById(R.id.hudOverlay)
        tvHudText = findViewById(R.id.tvHudText)
        hudOverlayFullscreen = findViewById(R.id.hudOverlayFullscreen)
        tvHudTextFullscreen = findViewById(R.id.tvHudTextFullscreen)

        // Get video ID from intent or deep link
        videoId = getVideoIdFromIntent()
        linkSlug = intent?.getStringExtra("link_slug") ?: intent?.data?.getQueryParameter("link")
        localVideoUri = intent?.getStringExtra("local_video_uri") ?: intent?.getStringExtra("local_path")
        val videoTitle = intent?.getStringExtra("video_title")

        // Always refresh playback metadata: a link may have switched from a
        // legacy MP4 to the CDN HLS playlist since FileInfoActivity opened.
        val passedDurationSec = intent?.getIntExtra("video_duration_sec", 0) ?: 0
        if (passedDurationSec > 0) {
            resolvedDurationMs = passedDurationSec * 1000L
        }
        val passedSizeBytes = intent?.getLongExtra("video_size_bytes", 0L) ?: 0L
        if (passedSizeBytes > 0L) {
            resolvedContentLength = passedSizeBytes
        }

        if (videoId == null && localVideoUri == null) {
            showError("Invalid video link. No video ID found.")
            return
        }

        if (!videoTitle.isNullOrBlank()) {
            resolvedVideoTitle = formatCleanTitle(videoTitle)
        }
        tvVideoMetaDetails.text = resolvedVideoTitle

        btnTopBack.visibility = View.VISIBLE
        loadVideoAndAds()

        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                handleBackNavigation()
            }
        })

        // Back button for loading/error overlay with press-scale feedback
        btnTopBack.applyPressScale {
            handleBackNavigation()
        }

        // Retry button
        btnRetry.applyPressScale {
            errorOverlay.visibility = View.GONE
            loadingOverlay.visibility = View.VISIBLE
            btnTopBack.visibility = View.VISIBLE
            processingRetryCount = 0
            if (localVideoUri == null) loadRemoteVideoMetadata() else initializePlayer()
        }

        // Fullscreen buttons
        btnFullscreen.setOnClickListener { enterFullscreen() }
        btnExitFullscreen.setOnClickListener { exitFullscreen() }

        // Modern PlayerControlView Fullscreen Button Listener
        playerView.setFullscreenButtonClickListener { isFullscreen ->
            if (isFullscreen) enterFullscreen() else exitFullscreen()
        }
        playerViewFullscreen.setFullscreenButtonClickListener { isFullscreen ->
            if (isFullscreen) enterFullscreen() else exitFullscreen()
        }

        // Setup Advance Player controls & gestures
        setupAdvanceControls(playerView)
        setupAdvanceControls(playerViewFullscreen)
        setupAdvanceGestures(playerView)
        setupAdvanceGestures(playerViewFullscreen)

        // Share button with modern haptic press feedback
        findViewById<LinearLayout>(R.id.btnShare)?.applyPressScale {
            shareVideo()
        }

        // Download is deliberately separate from playback. Playback uses
        // bounded network buffering; a full file is fetched only after this
        // explicit user action.
        findViewById<LinearLayout>(R.id.btnDownloadVideo)?.applyPressScale {
            startManualDownload()
        }

        // Telegram join button with modern haptic press feedback
        findViewById<LinearLayout>(R.id.btnTelegramJoin)?.applyPressScale {
            openTelegram()
        }

    }

    private fun loadVideoAndAds() {
        lifecycleScope.launch {
            if (videoId != null && localVideoUri == null) {
                loadRemoteVideoMetadata()
            } else {
                initializePlayer()
            }
            loadBannerAdWhenReady(adBannerContainerTop)
            loadMrecAdUnderPlayer()
        }
    }

    private fun loadRemoteVideoMetadata() {
        val vid = videoId ?: return
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                // If title is default, try resolving from link slug
                val currentSlug = linkSlug
                if (!currentSlug.isNullOrBlank() && (resolvedVideoTitle == "NightBox Video" || resolvedVideoTitle == "Exclusive Premium Video")) {
                    try {
                        val linkReq = Request.Builder()
                            .url("${BuildConfig.BACKEND_URL}/api/links/${Uri.encode(currentSlug)}")
                            .build()
                        apiClient.newCall(linkReq).execute().use { resp ->
                            if (resp.isSuccessful) {
                                val linkJson = org.json.JSONObject(resp.body?.string().orEmpty())
                                val rawTitle = linkJson.optJSONObject("link")?.optString("title")
                                if (!rawTitle.isNullOrBlank()) {
                                    resolvedVideoTitle = formatCleanTitle(rawTitle)
                                }
                            }
                        }
                    } catch (_: Exception) {}
                }

                val request = Request.Builder()
                    .url("${BuildConfig.BACKEND_URL}/video/${Uri.encode(vid)}")
                    .get()
                    .build()
                apiClient.newCall(request).execute().use { response ->
                    if (response.code == 202 || response.code == 409) {
                        val status = org.json.JSONObject(response.body?.string().orEmpty()).optString("playbackStatus")
                        withContext(Dispatchers.Main) {
                            if (status == "failed" || response.code == 409) {
                                showError("Video processing failed. Please contact the uploader.")
                            } else {
                                tvLoadingText.text = "Video is processing. Waiting for playback…"
                                if (++processingRetryCount <= 24) {
                                    window.decorView.postDelayed({
                                        if (!isFinishing && !isDestroyed) loadRemoteVideoMetadata()
                                    }, 5_000L)
                                } else {
                                    showError("Video is still processing. Tap Retry in a moment.")
                                }
                            }
                        }
                        return@use
                    }
                    if (!response.isSuccessful) throw IllegalStateException("Video metadata request failed: ${response.code}")
                    val payload = org.json.JSONObject(response.body?.string().orEmpty())
                    val video = payload.optJSONObject("video") ?: throw IllegalStateException("Video metadata missing")
                    val playbackUrl = listOf("hlsUrl", "cdnUrl", "streamUrl")
                        .firstNotNullOfOrNull { key -> video.optString(key).takeIf { it.isNotBlank() } }
                        ?: throw IllegalStateException("Playable video stream missing")
                    val fallbackUrl = video.optString("originHlsUrl").takeIf { it.startsWith("https://") }
                    val fetchedDownloadUrl = video.optString("downloadUrl")
                        .takeIf { it.startsWith("https://") }
                    val title = video.optString("title").takeIf { it.isNotBlank() }
                    val videoSize = video.optLong("size", 0L)
                    if (videoSize > 0L) {
                        resolvedContentLength = videoSize
                    }
                    val durationSec = video.optInt("duration", 0)
                    if (durationSec > 0) {
                        resolvedDurationMs = durationSec * 1000L
                    }


                    withContext(Dispatchers.Main) {
                        processingRetryCount = 0
                        remoteHlsUrl = playbackUrl
                        originHlsUrl = fallbackUrl
                        downloadUrl = fetchedDownloadUrl
                        originFallbackAttempted = false
                        title?.let { resolvedVideoTitle = formatCleanTitle(it) }
                        updateVideoMetaDetails()
                        startViewTrackingIfNeeded()
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
        val loadControl = androidx.media3.exoplayer.DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                /* minBufferMs = */ 10_000,
                /* maxBufferMs = */ 25_000,
                /* bufferForPlaybackMs = */ 500,
                /* bufferForPlaybackAfterRebufferMs = */ 1_500
            )
            .setPrioritizeTimeOverSizeThresholds(true)
            .build()

        player = ExoPlayer.Builder(this)
            .setLoadControl(loadControl)
            .build()
        playerView.player = player
        // Only attach to playerViewFullscreen when entering fullscreen mode

        val mediaItem = MediaItem.fromUri(Uri.parse(localVideoUri))
        player?.setMediaItem(mediaItem)
        player?.prepare()
        player?.playWhenReady = true

        addPlayerListener()
    }

    /**
     * ExoPlayer with a CDN MP4 source.
     */
    @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
    private fun initExoPlayerHls() {
        val vid = videoId ?: return

        val mediaUrl = remoteHlsUrl ?: run {
            showError("Video URL is unavailable.")
            return
        }
        Log.d(TAG, "Trying CDN URL: $mediaUrl")

        // Create HTTP data source with proper headers & cross-protocol redirects
        val httpDataSourceFactory = DefaultHttpDataSource.Factory()
            .setDefaultRequestProperties(mapOf(
                "Referer" to "$backendOrigin/",
                "Origin" to backendOrigin
            ))
            .setAllowCrossProtocolRedirects(true)
            .setKeepPostFor302Redirects(true)
            .setConnectTimeoutMs(8000)
            .setReadTimeoutMs(15000)

        // Playback must remain session-only. Do not attach a persistent disk
        // cache here: HLS/progressive sources should fetch only the segments
        // needed for the current bounded buffer. The explicit Download action
        // (when available) remains the only path that should save a full file.
        val playbackDataSourceFactory = httpDataSourceFactory

        // HLS loads short segments; plain MP4 uses Media3's real container metadata
        // and HTTP byte ranges. Never guess a seek map or video duration.
        val isHlsStream = mediaUrl.contains(".m3u8", ignoreCase = true) || mediaUrl.contains("/hls/", ignoreCase = true)
        val mediaSource = if (isHlsStream) {
            HlsMediaSource.Factory(playbackDataSourceFactory)
                .setAllowChunklessPreparation(true)
                .createMediaSource(MediaItem.fromUri(mediaUrl))
        } else {
            ProgressiveMediaSource.Factory(playbackDataSourceFactory)
                .createMediaSource(MediaItem.fromUri(mediaUrl))
        }

        // Fast-start Smart LoadControl: starts playback in 1.0s, caps buffer at 30s to prevent bandwidth waste
        val loadControl = androidx.media3.exoplayer.DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                /* minBufferMs = */ 15_000,
                /* maxBufferMs = */ 30_000,
                /* bufferForPlaybackMs = */ 1_000,
                /* bufferForPlaybackAfterRebufferMs = */ 2_500
            )
            .setPrioritizeTimeOverSizeThresholds(true)
            .build()

        // Hardware decoder fallback: fixes "sound plays but video is black" bug
        val renderersFactory = DefaultRenderersFactory(this)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER)
            .setEnableDecoderFallback(true)

        // 720p Mobile Resolution Cap: saves 60% bandwidth while staying crystal clear on 6" mobile screens
        val trackSelector = DefaultTrackSelector(this).apply {
            setParameters(
                buildUponParameters()
                    .setMaxVideoSize(1280, 720)
                    .setMaxVideoBitrate(2_200_000)
                    .setExceedVideoConstraintsIfNecessary(true)
            )
        }

        player = ExoPlayer.Builder(this, renderersFactory)
            .setTrackSelector(trackSelector)
            .setLoadControl(loadControl)
            .setSeekBackIncrementMs(5000L)
            .setSeekForwardIncrementMs(15000L)
            .build()

        playerView.player = player
        player?.setMediaSource(mediaSource)
        player?.prepare()
        player?.playWhenReady = true

        // Listen for errors — if native playback fails, fallback to WebView.
        player?.addListener(object : Player.Listener {
            override fun onRenderedFirstFrame() {
                loadingOverlay.visibility = View.GONE
                btnTopBack.visibility = View.GONE
                playerView.visibility = View.VISIBLE
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (isPlaying) {
                    loadingOverlay.visibility = View.GONE
                    btnTopBack.visibility = View.GONE
                    playerView.visibility = View.VISIBLE
                    qualifyAfterFiveSeconds()
                }
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                when (playbackState) {
                    Player.STATE_READY -> {
                        Log.d(TAG, "ExoPlayer CDN media ready")
                        loadingOverlay.visibility = View.GONE
                        btnTopBack.visibility = View.GONE
                        playerView.visibility = View.VISIBLE
                        updateVideoMetaDetails()
                        restorePlayerPositionIfNeeded()
                        scheduleDurationUpdates()
                    }
                    Player.STATE_BUFFERING -> {
                        if (playerView.visibility != View.VISIBLE) {
                            loadingOverlay.visibility = View.VISIBLE
                            btnTopBack.visibility = View.VISIBLE
                        }
                    }
                    Player.STATE_ENDED -> {
                        Log.d(TAG, "Video playback ended.")
                        videoPlaybackEnded = true
                    }
                    Player.STATE_IDLE -> { /* Idle */ }
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                Log.e(TAG, "Native playback failed (${error.errorCode})", error)
                val fallback = originHlsUrl?.takeIf {
                    isHlsStream && !originFallbackAttempted && it != remoteHlsUrl
                }
                if (fallback != null) {
                    originFallbackAttempted = true
                    window.decorView.post {
                        if (!isFinishing && !isDestroyed) {
                            remoteHlsUrl = fallback
                            initializePlayer()
                        }
                    }
                } else {
                    releasePlayer()
                    showError("Video stream could not be played. Tap Retry.")
                }
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
                        btnTopBack.visibility = View.GONE
                        playerView.visibility = View.VISIBLE
                        updateVideoMetaDetails()
                        restorePlayerPositionIfNeeded()
                        scheduleDurationUpdates()
                    }
                    Player.STATE_BUFFERING -> {
                        if (playerView.visibility != View.VISIBLE) {
                            loadingOverlay.visibility = View.VISIBLE
                            btnTopBack.visibility = View.VISIBLE
                        }
                    }
                    Player.STATE_ENDED -> {
                        Log.d(TAG, "Local video playback ended.")
                        videoPlaybackEnded = true
                    }
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
                if (viewSessionId == null) withContext(Dispatchers.Main) { retryViewTracking() }
            } catch (error: Exception) {
                Log.w(TAG, "View tracking start failed", error)
                withContext(Dispatchers.Main) { retryViewTracking() }
            }
        }
    }

    private fun retryViewTracking() {
        if (viewSessionId != null || viewTrackingRetries >= 3 || isFinishing || isDestroyed) return
        viewTrackingRetries++
        window.decorView.postDelayed({
            if (!isFinishing && !isDestroyed && viewSessionId == null) {
                viewTrackingStarted = false
                startViewTrackingIfNeeded()
            }
        }, 5_000L)
    }

    private fun startViewTrackingIfNeeded() {
        val slug = linkSlug?.takeIf { it.isNotBlank() } ?: return
        if (viewTrackingStarted || localVideoUri != null) return
        viewTrackingStarted = true
        startViewTracking(slug)
    }

    private fun qualifyView() {
        val sessionId = viewSessionId ?: return
        viewQualified = true
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                val body = org.json.JSONObject().put("viewToken", viewToken).toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder().url("${BuildConfig.BACKEND_URL}/api/views/${Uri.encode(sessionId)}/qualify").post(body).build()
                apiClient.newCall(request).execute().use { response -> Log.d(TAG, "View qualification response: ${response.code}") }
            } catch (error: Exception) { Log.w(TAG, "View qualification failed", error) }
        }
    }

    private fun updateVideoMetaDetails() {
        tvVideoMetaDetails.text = resolvedVideoTitle
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
        btnTopBack.visibility = View.VISIBLE
        loadingOverlay.visibility = View.VISIBLE

        // Configure WebView
        webViewPlayer.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        webViewPlayer.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                loadingOverlay.visibility = View.GONE
                webViewPlayer.visibility = View.VISIBLE
            }

            override fun onReceivedError(
                view: WebView?,
                request: android.webkit.WebResourceRequest?,
                error: android.webkit.WebResourceError?
            ) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame == true) {
                    showError("Failed to load video: ${error?.description ?: "Network error"}")
                }
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

                adBannerContainerTop.visibility = View.GONE
                // Player banner removed for compliance

                requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                hideSystemBars()

                val rootLayout = findViewById<FrameLayout>(R.id.rootLayout)
                rootLayout.addView(view)
                mainContent.visibility = View.GONE
            }

            override fun onHideCustomView() {
                isFullscreen = false

                adBannerContainerTop.visibility = View.VISIBLE
                // Player banner removed for compliance

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

        val streamUrl = remoteHlsUrl ?: run {
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
                    <video src="$streamUrl" autoplay controls playsinline></video>
                </div>
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
        playerViewFullscreen.player = player
        playerViewFullscreen.resizeMode = resizeModes[currentResizeModeIndex]
        setupAdvanceControls(playerViewFullscreen)

        // Show fullscreen container, hide main content and sticky ads
        fullscreenPlayerContainer.visibility = View.VISIBLE
        mainContent.visibility = View.GONE
        adBannerContainerTop.visibility = View.GONE

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
        playerView.player = player
        playerView.resizeMode = resizeModes[currentResizeModeIndex]
        setupAdvanceControls(playerView)

        // Show main content and sticky ads, hide fullscreen container
        mainContent.visibility = View.VISIBLE
        adBannerContainerTop.visibility = View.VISIBLE
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
        btnTopBack.visibility = View.VISIBLE
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

    private fun startManualDownload() {
        val url = downloadUrl
        if (url.isNullOrBlank()) {
            Toast.makeText(this, "Download is not available yet", Toast.LENGTH_SHORT).show()
            return
        }

        val safeTitle = resolvedVideoTitle
            .replace(Regex("[^a-zA-Z0-9._-]+"), "_")
            .trim('_')
            .ifBlank { "nightbox_video" }

        try {
            val request = DownloadManager.Request(Uri.parse(url)).apply {
                setTitle("$safeTitle.mp4")
                setDescription("Downloading from NightBox")
                setMimeType("video/mp4")
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setAllowedOverMetered(true)
                setAllowedOverRoaming(false)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "$safeTitle.mp4")
            }
            val manager = getSystemService(DOWNLOAD_SERVICE) as DownloadManager
            manager.enqueue(request)
            Toast.makeText(this, "Download started. Check Downloads.", Toast.LENGTH_LONG).show()
        } catch (error: Exception) {
            Log.e(TAG, "Manual download failed", error)
            Toast.makeText(this, "Unable to start download", Toast.LENGTH_LONG).show()
        }
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
        // video player banner: ca-app-pub-2964717174761820/7251270834
        AdComponents.loadSmartCollapsibleBanner(
            this,
            container,
            isTop = true,
            adUnitId = AdManager.BANNER_HOME_VIDEO_PLAYER,
            screenKey = "video_player",
            onLoaded = {
                bannerAdView = container.getChildAt(0) as? com.google.android.gms.ads.AdView
            }
        )
    }

    private fun loadMrecAdUnderPlayer() {
        if (!::mrecPlayerContainer.isInitialized) return
        // merc video player: ca-app-pub-2964717174761820/3409649938
        AdComponents.loadMrecAd(
            this,
            mrecPlayerContainer,
            adUnitId = AdManager.MREC_VIDEO_PLAYER
        )
    }

    // ──────────────────────────────────────────────
    // Advance Player Control & Gesture Engine
    // ──────────────────────────────────────────────

    private fun showHud(message: String) {
        tvHudText.text = message
        tvHudTextFullscreen.text = message
        hudOverlay.visibility = View.VISIBLE
        hudOverlayFullscreen.visibility = View.VISIBLE

        hudDismissRunnable?.let { window.decorView.removeCallbacks(it) }
        val dismiss = Runnable {
            hudOverlay.visibility = View.GONE
            hudOverlayFullscreen.visibility = View.GONE
        }
        hudDismissRunnable = dismiss
        window.decorView.postDelayed(dismiss, 1200L)
    }

    private fun cycleAspectRatio() {
        currentResizeModeIndex = (currentResizeModeIndex + 1) % resizeModes.size
        val mode = resizeModes[currentResizeModeIndex]
        val label = resizeModeLabels[currentResizeModeIndex]
        playerView.resizeMode = mode
        playerViewFullscreen.resizeMode = mode
        showHud("Aspect: $label")
    }

    private fun cyclePlaybackSpeed() {
        currentSpeedIndex = (currentSpeedIndex + 1) % playbackSpeeds.size
        val speed = playbackSpeeds[currentSpeedIndex]
        player?.playbackParameters = PlaybackParameters(speed)
        speedBeforeFastForward = speed
        val text = "${speed}x"
        showHud("Speed: $text")
    }

    private fun showSettingsDialog() {
        val options = arrayOf(
            "Playback Speed (${playbackSpeeds[currentSpeedIndex]}x)",
            "Aspect Ratio (${resizeModeLabels[currentResizeModeIndex]})"
        )
        AlertDialog.Builder(this)
            .setTitle("Player Settings")
            .setItems(options) { _, which ->
                when (which) {
                    0 -> showSpeedSelectionDialog()
                    1 -> cycleAspectRatio()
                }
            }
            .show()
    }

    private fun showSpeedSelectionDialog() {
        val labels = playbackSpeeds.map { "${it}x" }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("Playback Speed")
            .setSingleChoiceItems(labels, currentSpeedIndex) { dialog, which ->
                currentSpeedIndex = which
                val speed = playbackSpeeds[currentSpeedIndex]
                player?.playbackParameters = PlaybackParameters(speed)
                speedBeforeFastForward = speed
                showHud("Speed: ${speed}x")
                dialog.dismiss()
            }
            .show()
    }

    private fun setupAdvanceControls(pv: PlayerView) {
        val bindListeners = {
            pv.findViewById<View>(R.id.exo_settings)?.setOnClickListener {
                showSettingsDialog()
            }
            pv.findViewById<View>(R.id.btnBackOverlay)?.setOnClickListener {
                handleBackNavigation()
            }
            pv.findViewById<androidx.media3.ui.DefaultTimeBar>(androidx.media3.ui.R.id.exo_progress)?.addListener(object : androidx.media3.ui.TimeBar.OnScrubListener {
                override fun onScrubStart(timeBar: androidx.media3.ui.TimeBar, position: Long) {
                    vibrateTick()
                }
                override fun onScrubMove(timeBar: androidx.media3.ui.TimeBar, position: Long) {}
                override fun onScrubStop(timeBar: androidx.media3.ui.TimeBar, position: Long, canceled: Boolean) {
                    vibrateTick()
                    if (!canceled) {
                        player?.seekTo(position)
                    }
                }
            })
        }

        pv.setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { visibility ->
            if (visibility == View.VISIBLE) {
                bindListeners()
            }
        })
        pv.post {
            bindListeners()
        }
    }

    private fun startIndexingFragments(mediaUrl: String) {
        // Disabled: Media3 uses HLS segments or HTTP byte ranges when seeking.
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun setupAdvanceGestures(view: PlayerView) {
        val audioManager = getSystemService(Context.AUDIO_SERVICE) as? AudioManager

        val gestureDetector = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDoubleTap(e: MotionEvent): Boolean {
                val width = view.width.toFloat()
                if (width <= 0f) return false
                val currentPos = player?.currentPosition ?: 0L
                val duration = player?.duration ?: 0L
                vibrateTick()
                if (e.x < width / 2) {
                    val target = (currentPos - 10_000L).coerceAtLeast(0L)
                    player?.seekTo(target)
                    showHud("-10s ⏪")
                } else {
                    val maxSeek = if (duration > 0L) duration else currentPos + 10_000L
                    val target = (currentPos + 10_000L).coerceAtMost(maxSeek)
                    player?.seekTo(target)
                    showHud("+10s ⏩")
                }
                return true
            }

            override fun onLongPress(e: MotionEvent) {
                val currentPlayer = player ?: return
                if (!isTemporaryFastForward) {
                    speedBeforeFastForward = currentPlayer.playbackParameters.speed
                    currentPlayer.playbackParameters = PlaybackParameters(2.0f)
                    isTemporaryFastForward = true
                    showHud("2X Speed >>")
                }
            }

            override fun onScroll(
                e1: MotionEvent?,
                e2: MotionEvent,
                distanceX: Float,
                distanceY: Float
            ): Boolean {
                if (e1 == null) return false
                val width = view.width.toFloat()
                val height = view.height.toFloat()
                if (width <= 0f || height <= 0f) return false

                if (kotlin.math.abs(distanceY) > kotlin.math.abs(distanceX)) {
                    val delta = distanceY / height

                    if (e1.x < width / 2) {
                        // Left side: Brightness
                        val lp = window.attributes
                        val currentBrightness = if (lp.screenBrightness < 0f) 0.5f else lp.screenBrightness
                        val newBrightness = (currentBrightness + delta).coerceIn(0.05f, 1.0f)
                        lp.screenBrightness = newBrightness
                        window.attributes = lp
                        showHud("Brightness: ${(newBrightness * 100).toInt()}% ☀️")
                        return true
                    } else {
                        // Right side: Volume
                        audioManager?.let { am ->
                            val maxVol = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
                            val curVol = am.getStreamVolume(AudioManager.STREAM_MUSIC)
                            val step = (delta * maxVol * 1.5f).toInt()
                            if (step != 0) {
                                val targetVol = (curVol + step).coerceIn(0, maxVol)
                                am.setStreamVolume(AudioManager.STREAM_MUSIC, targetVol, 0)
                                showHud("Volume: ${(targetVol * 100 / maxVol)}% 🔊")
                            }
                        }
                        return true
                    }
                }
                return false
            }
        })

        view.setOnTouchListener { _, event ->
            // Let bottom controls (seekbar and under-bar) handle touches cleanly without interference
            if (view.isControllerFullyVisible && event.y > (view.height - 180)) {
                return@setOnTouchListener false
            }
            val handled = gestureDetector.onTouchEvent(event)
            if (event.action == MotionEvent.ACTION_UP || event.action == MotionEvent.ACTION_CANCEL) {
                if (isTemporaryFastForward) {
                    player?.playbackParameters = PlaybackParameters(speedBeforeFastForward)
                    isTemporaryFastForward = false
                    showHud("Speed: ${speedBeforeFastForward}x")
                }
            }
            handled
        }
    }

    // ──────────────────────────────────────────────
    // Player lifecycle
    // ──────────────────────────────────────────────

    private fun releasePlayer() {
        indexingCall?.cancel()
        indexingJob?.cancel()
        indexingCall = null
        indexingJob = null
        durationUpdateRunnable?.let { window.decorView.removeCallbacks(it) }
        durationUpdateRunnable = null
        hudDismissRunnable?.let { window.decorView.removeCallbacks(it) }
        hudDismissRunnable = null
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
        if (adBannerContainerTop.childCount == 0 || (bannerAdView != null && AdManager.canRequestCollapsible("video_player"))) {
            loadBannerAd(adBannerContainerTop)
        }
    }

    override fun onDestroy() {
        releasePlayer()
        AdComponents.destroyAdViews(adBannerContainerTop)
        if (::mrecPlayerContainer.isInitialized) {
            AdComponents.destroyAdViews(mrecPlayerContainer)
        }
        bannerAdView = null
        if (usingWebView) webViewPlayer.destroy()
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putLong("player_position_ms", player?.currentPosition ?: 0L)
        outState.putBoolean("player_play_when_ready", player?.playWhenReady ?: true)
        super.onSaveInstanceState(outState)
    }

    private fun handleBackNavigation() {
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
        finish()
    }
}
