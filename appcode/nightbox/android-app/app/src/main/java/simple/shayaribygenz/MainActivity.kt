package simple.shayaribygenz

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.AdSize
import com.google.android.gms.ads.AdView
import com.google.android.gms.ads.MobileAds
import android.app.Dialog
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.text.SpannableString
import android.text.Spanned
import android.text.TextPaint
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.widget.Button
import android.widget.TextView
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.UpdateAvailability
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import java.io.File
import org.json.JSONObject
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import simple.shayaribygenz.UiExtensions.applyPressScale

class MainActivity : AppCompatActivity() {

    private lateinit var etPasteLink: EditText
    private lateinit var btnClearLink: ImageView
    private lateinit var btnPasteLink: ImageView
    private lateinit var btnWatch: FrameLayout
    private lateinit var adBannerContainer: FrameLayout
    private lateinit var chipClipboardLink: LinearLayout
    private var lastCheckedClipText: String? = null

    private lateinit var btnSettings: ImageView
    private lateinit var prefs: SharedPreferences
    private var bannerAdView: AdView? = null
    private var deepLinkProcessed = false
    private val apiClient get() = NetworkClient.client
    private val videoPickerLauncher = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            val videoUri = result.data?.data
            if (videoUri != null) {
                try {
                    contentResolver.takePersistableUriPermission(
                        videoUri, Intent.FLAG_GRANT_READ_URI_PERMISSION
                    )
                } catch (_: Exception) { }

                val intent = Intent(this, VideoPlayerActivity::class.java)
                intent.putExtra("local_video_uri", videoUri.toString())
                startActivity(intent)
            }
        }
    }
    private lateinit var appUpdateManager: AppUpdateManager
    private val appUpdateLauncher = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.StartIntentSenderForResult()
    ) { result ->
        if (result.resultCode != RESULT_OK) {
            // Update cancelled or failed - continue gracefully
        }
    }

    // Navigation Views
    private lateinit var homeSection: View
    private lateinit var downloadsSection: LinearLayout
    private lateinit var navHome: LinearLayout
    private lateinit var navDownloads: LinearLayout
    private lateinit var ivNavHome: ImageView
    private lateinit var ivNavDownloads: ImageView
    private lateinit var tvNavHome: TextView
    private lateinit var tvNavDownloads: TextView

    companion object {
        private const val PREFS_NAME = "nightbox_prefs"
        private const val KEY_DARK_MODE = "dark_mode"
        private const val REQUEST_VIDEO_PICK = 1001
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Apply theme before setContentView
        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        val isDarkMode = prefs.getBoolean(KEY_DARK_MODE, true)
        applyTheme(isDarkMode, false)

        val splashScreen = installSplashScreen()

        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // Ad SDKs initialized in NightBoxApp (Application class)

        // Initialize AppUpdateManager
        appUpdateManager = AppUpdateManagerFactory.create(this)
        checkForAppUpdate()

        // Bind views
        etPasteLink = findViewById<EditText>(R.id.etPasteLink)
        btnClearLink = findViewById<ImageView>(R.id.btnClearLink)
        btnPasteLink = findViewById<ImageView>(R.id.btnPasteLink)
        btnWatch = findViewById(R.id.btnWatch)
        adBannerContainer = findViewById(R.id.adBannerContainer)
        btnSettings = findViewById(R.id.btnSettings)
        
        // Initialize Navigation Views
        homeSection = findViewById(R.id.homeSection)
        downloadsSection = findViewById(R.id.downloadsSection)
        navHome = findViewById(R.id.navHome)
        navDownloads = findViewById(R.id.navDownloads)
        ivNavHome = findViewById(R.id.ivNavHome)
        ivNavDownloads = findViewById(R.id.ivNavDownloads)
        tvNavHome = findViewById(R.id.tvNavHome)
        tvNavDownloads = findViewById(R.id.tvNavDownloads)

        // Floating Smart Clipboard Pill
        chipClipboardLink = findViewById(R.id.chipClipboardLink)
        chipClipboardLink.applyPressScale {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            val clipText = clipboard?.primaryClip?.getItemAt(0)?.text?.toString()?.trim()
            if (!clipText.isNullOrEmpty()) {
                etPasteLink.setText(clipText)
                etPasteLink.setSelection(etPasteLink.text.length)
                chipClipboardLink.visibility = View.GONE
                btnWatch.performClick()
            }
        }

        findViewById<Button>(R.id.btnDownloadsBackHome)?.applyPressScale {
            showHome()
        }

        // Set Navigation Listeners with press-scale feedback
        navHome.applyPressScale { showHome() }
        navDownloads.applyPressScale { showDownloads() }

        // Check for first launch
        if (prefs.getBoolean("first_launch", true)) {
            showTermsDialog()
        }

        // Load banner ad — wait for AdMob SDK init to complete first
        loadAds()

        // Settings Bottom Sheet
        btnSettings.applyPressScale {
            showSettingsBottomSheet()
        }

        // Handle text changes to show/hide clear and paste buttons
        etPasteLink.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                if (s.isNullOrEmpty()) {
                    btnClearLink.visibility = View.GONE
                    btnPasteLink.visibility = View.VISIBLE
                } else {
                    btnClearLink.visibility = View.VISIBLE
                    btnPasteLink.visibility = View.GONE
                }
            }
            override fun afterTextChanged(s: Editable?) {}
        })

        // Clear button click
        btnClearLink.applyPressScale {
            etPasteLink.text.clear()
        }

        // Paste button click
        btnPasteLink.applyPressScale {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            if (clipboard.hasPrimaryClip() && (clipboard.primaryClip?.itemCount ?: 0) > 0) {
                val pastedText = clipboard.primaryClip?.getItemAt(0)?.text
                if (!pastedText.isNullOrEmpty()) {
                    etPasteLink.setText(pastedText)
                    etPasteLink.setSelection(etPasteLink.text.length)
                }
            } else {
                Toast.makeText(this, "Clipboard is empty", Toast.LENGTH_SHORT).show()
            }
        }

        // Watch button click with modern press feedback
        btnWatch.applyPressScale {
            val input = etPasteLink.text.toString().trim()
            if (input.isEmpty()) {
                Toast.makeText(this, "Please paste a NightBox video link", Toast.LENGTH_SHORT).show()
                return@applyPressScale
            }

            val shareSlug = extractLinkSlug(input)
            val videoId = extractVideoId(input)
            if (shareSlug != null && !isWatchPath(input)) {
                resolveShareLink(shareSlug)
            } else if (videoId != null) {
                openFileInfo(videoId, shareSlug)
            } else {
                Toast.makeText(this, getString(R.string.error_invalid_link), Toast.LENGTH_LONG).show()
            }
        }

        // Play local files button
        findViewById<android.widget.Button>(R.id.btnPlayLocal)?.applyPressScale {
            openGalleryPicker()
        }

        // Open Gallery link
        findViewById<View>(R.id.btnOpenGallery)?.applyPressScale {
            openGalleryPicker()
        }

        // Social section click listeners
        findViewById<LinearLayout>(R.id.btnJoinTelegram)?.applyPressScale {
            openTelegram()
        }
        findViewById<LinearLayout>(R.id.btnJoinWhatsApp)?.applyPressScale {
            openWhatsApp()
        }

        // Handle deep link if app was opened via link
        if (savedInstanceState == null) {
            handleDeepLink(intent)
        }
    }

    override fun onResume() {
        super.onResume()
        SecurityUtil.checkVpn(this)
        checkClipboardForNightBoxLink()
        if (adBannerContainer.childCount == 0 || (bannerAdView != null && AdManager.canRequestCollapsible("home"))) {
            loadAds()
        }
        
        // Resume update if it was already in progress
        appUpdateManager.appUpdateInfo.addOnSuccessListener { appUpdateInfo ->
            if (appUpdateInfo.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS) {
                try {
                    appUpdateManager.startUpdateFlowForResult(
                        appUpdateInfo,
                        appUpdateLauncher,
                        AppUpdateOptions.defaultOptions(AppUpdateType.IMMEDIATE)
                    )
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        deepLinkProcessed = false
        intent?.let { handleDeepLink(it) }
    }

    private fun handleDeepLink(intent: Intent) {
        if (deepLinkProcessed) return
        val data: Uri? = intent.data
        if (data != null) {
            val pathSegments = if (data.scheme.equals("nightbox", ignoreCase = true)) {
                listOf(data.host.orEmpty()) + data.pathSegments
            } else data.pathSegments
            if (pathSegments.size >= 2 && pathSegments[0].equals("watch", ignoreCase = true)) {
                val videoId = pathSegments[1]
                deepLinkProcessed = true
                // Clear intent data so it's not processed again
                intent.data = null
                intent.action = null
                setIntent(Intent())
                // Every public link must land on the file-info screen first.
                // Playback is intentionally started only after the user taps
                // "Open File" there (the same flow as a pasted link).
                openFileInfo(videoId, data.getQueryParameter("link"))
            } else if (pathSegments.size >= 2 && pathSegments[0].equals("l", ignoreCase = true)) {
                val slug = pathSegments[1]
                deepLinkProcessed = true
                intent.data = null
                intent.action = null
                setIntent(Intent())
                resolveShareLink(slug)
            }
        }
    }

    private fun resolveShareLink(slug: String) {
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                val request = Request.Builder()
                    .url("${BuildConfig.BACKEND_URL}/api/links/${Uri.encode(slug)}")
                    .get()
                    .build()
                apiClient.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) throw IllegalStateException("Share link not found")
                    val link = JSONObject(response.body?.string().orEmpty()).getJSONObject("link")
                    val videoId = link.getString("videoId")
                    val title = link.optString("title", "")
                    // Keep share links consistent with /watch links and
                    // pasted links: show metadata first, then let the user
                    // explicitly start playback from FileInfoActivity.
                    withContext(Dispatchers.Main) { openFileInfo(videoId, slug, title) }
                }
            } catch (_: Exception) {
                withContext(Dispatchers.Main) {
                    Toast.makeText(this@MainActivity, "This NightBox link is not available", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    /**
     * Extract video ID from various input formats:
     * - Full URL: https://public-video-host/watch/VIDEO_ID
     * - Just the ID: VIDEO_ID (UUID-like format)
     * - Partial URL: public-video-host/watch/VIDEO_ID
     */
    private fun extractVideoId(input: String): String? {
        // Try to extract from full URL
        val urlPattern = Regex("""/watch/([a-f0-9-]+)""", RegexOption.IGNORE_CASE)
        val matchUrl = urlPattern.find(input)
        if (matchUrl != null) {
            return matchUrl.groupValues[1]
        }

        // Check if input looks like a UUID/GUID (video ID)
        val guidPattern = Regex("""^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$""", RegexOption.IGNORE_CASE)
        if (guidPattern.matches(input)) {
            return input
        }

        // Check if it's a simple alphanumeric ID (at least 10 chars)
        if (input.length >= 10 && input.matches(Regex("""^[a-f0-9-]+$""", RegexOption.IGNORE_CASE))) {
            return input
        }

        return null
    }

    private fun extractLinkSlug(input: String): String? {
        return try {
            val normalized = if (input.contains("://")) input else "https://$input"
            val uri = Uri.parse(normalized)
            val querySlug = uri.getQueryParameter("link")?.takeIf { it.isNotBlank() }
            if (querySlug != null) return querySlug
            val segments = uri.pathSegments
            val linkIndex = segments.indexOfFirst { it.equals("l", ignoreCase = true) }
            if (linkIndex >= 0) segments.getOrNull(linkIndex + 1)?.takeIf { it.isNotBlank() } else null
        } catch (_: Exception) {
            null
        }
    }

    private fun isWatchPath(input: String): Boolean {
        return try {
            val normalized = if (input.contains("://")) input else "https://$input"
            Uri.parse(normalized).pathSegments.firstOrNull()?.equals("watch", ignoreCase = true) == true
        } catch (_: Exception) {
            false
        }
    }

    private fun openFileInfo(videoId: String, linkSlug: String? = null, videoTitle: String? = null) {
        val intent = Intent(this, FileInfoActivity::class.java)
        intent.putExtra("video_id", videoId)
        linkSlug?.let { intent.putExtra("link_slug", it) }
        videoTitle?.let { intent.putExtra("video_title", it) }
        intent.flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        startActivity(intent)
    }

    private fun openGalleryPicker() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "video/*"
        }
        try {
            videoPickerLauncher.launch(intent)
        } catch (e: Exception) {
            Toast.makeText(this, "No file manager found", Toast.LENGTH_SHORT).show()
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

    private fun openWhatsApp() {
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://whatsapp.com/channel/0029VbDV1LR3GJP5XqCMb309"))
            startActivity(intent)
        } catch (_: Exception) {
            Toast.makeText(this, "Could not open WhatsApp", Toast.LENGTH_SHORT).show()
        }
    }

    private fun loadBannerAdWhenReady() {
        if (NightBoxApp.adsInitialized) {
            loadBannerAd()
        } else {
            // Retry every 500ms until SDK is ready (max 10 seconds)
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                loadBannerAdWhenReady()
            }, 500)
        }
    }

    private fun loadBannerAd() {
        AdComponents.loadSmartCollapsibleBanner(
            this,
            adBannerContainer,
            isTop = true,
            adUnitId = AdManager.BANNER_HOME_VIDEO_PLAYER,
            screenKey = "home",
            onLoaded = {
                bannerAdView = adBannerContainer.getChildAt(0) as? com.google.android.gms.ads.AdView
            }
        )
    }

    private fun applyTheme(isDark: Boolean, recreateActivity: Boolean) {
        if (isDark) {
            AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_YES)
        } else {
            AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_NO)
        }
        if (recreateActivity) {
            recreate()
        }
    }

    private fun showTermsDialog() {
        val dialog = Dialog(this)
        dialog.setContentView(R.layout.dialog_terms_agreement)
        dialog.setCancelable(false) // Compulsory to accept
        dialog.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        dialog.window?.setLayout(
            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
            android.view.ViewGroup.LayoutParams.MATCH_PARENT
        )

        val tvTerms = dialog.findViewById<TextView>(R.id.tvTermsAgreement)
        val btnContinue = dialog.findViewById<Button>(R.id.btnContinue)

        // Make "Terms & Conditions" and "Privacy Policy" clickable
        val fullText = tvTerms.text.toString()
        val spannableString = SpannableString(fullText)

        val termsSpan = object : ClickableSpan() {
            override fun onClick(widget: View) {
                openWebLink("https://sites.google.com/view/nightbox-terms-and-conditions?usp=sharing")
            }
            override fun updateDrawState(ds: TextPaint) {
                super.updateDrawState(ds)
                ds.isUnderlineText = true
                ds.color = Color.parseColor("#80CBC4") // Accent color
            }
        }

        val privacySpan = object : ClickableSpan() {
            override fun onClick(widget: View) {
                openWebLink("https://sites.google.com/view/nightbox-privacy-policy/home")
            }
            override fun updateDrawState(ds: TextPaint) {
                super.updateDrawState(ds)
                ds.isUnderlineText = true
                ds.color = Color.parseColor("#80CBC4")
            }
        }

        val termsStart = fullText.indexOf("Terms & Conditions")
        if (termsStart != -1) {
            spannableString.setSpan(termsSpan, termsStart, termsStart + "Terms & Conditions".length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }

        val privacyStart = fullText.indexOf("Privacy Policy")
        if (privacyStart != -1) {
            spannableString.setSpan(privacySpan, privacyStart, privacyStart + "Privacy Policy".length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }

        tvTerms.text = spannableString
        tvTerms.movementMethod = LinkMovementMethod.getInstance()

        btnContinue.setOnClickListener {
            prefs.edit().putBoolean("first_launch", false).apply()
            dialog.dismiss()
        }

        dialog.show()
    }

    private fun showSettingsBottomSheet() {
        val bottomSheet = BottomSheetDialog(this)
        val view = layoutInflater.inflate(R.layout.bottom_sheet_settings, null)
        bottomSheet.setContentView(view)

        view.findViewById<LinearLayout>(R.id.btnTerms).setOnClickListener {
            openWebLink("https://sites.google.com/view/nightbox-terms-and-conditions?usp=sharing")
            bottomSheet.dismiss()
        }

        view.findViewById<LinearLayout>(R.id.btnPrivacy).setOnClickListener {
            openWebLink("https://sites.google.com/view/nightbox-privacy-policy/home")
            bottomSheet.dismiss()
        }

        bottomSheet.show()
    }

    private fun loadAds() {
        adBannerContainer.visibility = View.VISIBLE
        loadBannerAdWhenReady()
    }

    private fun openWebLink(url: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        startActivity(intent)
    }

    override fun onDestroy() {
        AdComponents.destroyAdViews(adBannerContainer)
        bannerAdView = null
        super.onDestroy()
    }

    private fun checkForAppUpdate() {
        val appUpdateInfoTask = appUpdateManager.appUpdateInfo
        appUpdateInfoTask.addOnSuccessListener { appUpdateInfo ->
            if (appUpdateInfo.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE
                && appUpdateInfo.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE)
            ) {
                try {
                    appUpdateManager.startUpdateFlowForResult(
                        appUpdateInfo,
                        appUpdateLauncher,
                        AppUpdateOptions.defaultOptions(AppUpdateType.IMMEDIATE)
                    )
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }
        }
    }

    private fun showHome() {
        homeSection.visibility = View.VISIBLE
        downloadsSection.visibility = View.GONE
        
        navHome.setBackgroundResource(R.drawable.bg_nav_active_capsule)
        ivNavHome.setColorFilter(getColor(R.color.accent_violet))
        tvNavHome.setTextColor(getColor(R.color.accent_violet))
        tvNavHome.setTypeface(null, android.graphics.Typeface.BOLD)
        
        navDownloads.background = null
        val inactiveColor = android.graphics.Color.parseColor("#80FFFFFF")
        ivNavDownloads.setColorFilter(inactiveColor)
        tvNavDownloads.setTextColor(inactiveColor)
        tvNavDownloads.setTypeface(null, android.graphics.Typeface.NORMAL)

        if (adBannerContainer.childCount == 0 && AdManager.canRequestCollapsible("home")) {
            loadAds()
        }
    }

    private fun showDownloads() {
        homeSection.visibility = View.GONE
        downloadsSection.visibility = View.VISIBLE
        
        navDownloads.setBackgroundResource(R.drawable.bg_nav_active_capsule)
        ivNavDownloads.setColorFilter(getColor(R.color.accent_violet))
        tvNavDownloads.setTextColor(getColor(R.color.accent_violet))
        tvNavDownloads.setTypeface(null, android.graphics.Typeface.BOLD)
        
        navHome.background = null
        val inactiveColor = android.graphics.Color.parseColor("#80FFFFFF")
        ivNavHome.setColorFilter(inactiveColor)
        tvNavHome.setTextColor(inactiveColor)
        tvNavHome.setTypeface(null, android.graphics.Typeface.NORMAL)

        Toast.makeText(this, "Downloads feature coming soon!", Toast.LENGTH_SHORT).show()

        if (adBannerContainer.childCount == 0 && AdManager.canRequestCollapsible("home")) {
            loadAds()
        }
    }

    private fun checkClipboardForNightBoxLink() {
        try {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
            if (clipboard.hasPrimaryClip() && (clipboard.primaryClip?.itemCount ?: 0) > 0) {
                val clipText = clipboard.primaryClip?.getItemAt(0)?.text?.toString()?.trim().orEmpty()
                if (clipText.isNotEmpty() && clipText != lastCheckedClipText) {
                    val isCandidate = clipText.contains("nightbox", ignoreCase = true) ||
                            clipText.contains("/watch/") ||
                            clipText.contains("/l/")
                    val alreadyInInput = etPasteLink.text.toString().trim() == clipText
                    if (isCandidate && !alreadyInInput) {
                        val vid = extractVideoId(clipText)
                        val slug = extractLinkSlug(clipText)
                        if (vid != null || slug != null) {
                            lastCheckedClipText = clipText
                            chipClipboardLink.visibility = View.VISIBLE
                            return
                        }
                    }
                }
            }
            chipClipboardLink.visibility = View.GONE
        } catch (_: Exception) {}
    }
}
