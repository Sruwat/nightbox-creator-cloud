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
import com.google.android.gms.ads.AdLoader
import com.google.android.gms.ads.nativead.NativeAd
import com.google.android.gms.ads.nativead.NativeAdView
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.UpdateAvailability
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import java.io.File

class MainActivity : AppCompatActivity() {

    private lateinit var etPasteLink: EditText
    private lateinit var btnClearLink: ImageView
    private lateinit var btnPasteLink: ImageView
    private lateinit var btnWatch: FrameLayout
    private lateinit var adBannerContainer: FrameLayout

    private lateinit var btnSettings: ImageView
    private lateinit var prefs: SharedPreferences
    private var nativeAd: NativeAd? = null
    private var deepLinkProcessed = false
    
    private lateinit var appUpdateManager: AppUpdateManager
    private val UPDATE_REQUEST_CODE = 1002

    // Navigation Views
    private lateinit var homeSection: View
    private lateinit var feedSection: androidx.viewpager2.widget.ViewPager2
    private lateinit var navHome: LinearLayout
    private lateinit var navFeed: LinearLayout
    private lateinit var ivNavHome: ImageView
    private lateinit var ivNavFeed: ImageView
    private lateinit var tvNavHome: TextView
    private lateinit var tvNavFeed: TextView

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
        feedSection = findViewById(R.id.feedSection)
        navHome = findViewById(R.id.navHome)
        navFeed = findViewById(R.id.navFeed)
        ivNavHome = findViewById(R.id.ivNavHome)
        ivNavFeed = findViewById(R.id.ivNavFeed)
        tvNavHome = findViewById(R.id.tvNavHome)
        tvNavFeed = findViewById(R.id.tvNavFeed)

        // Do not ship bundled demo videos. The canonical app loads feed data
        // from the NightBox backend before populating this adapter.
        feedSection.adapter = FeedAdapter(emptyList())

        // Set Navigation Listeners
        navHome.setOnClickListener { showHome() }
        navFeed.setOnClickListener { showFeed() }

        // Check for first launch
        if (prefs.getBoolean("first_launch", true)) {
            showTermsDialog()
        }

        // Load banner ad — wait for AdMob SDK init to complete first
        loadBannerAdWhenReady()


        // Settings Bottom Sheet
        btnSettings.setOnClickListener {
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
        btnClearLink.setOnClickListener {
            etPasteLink.text.clear()
        }

        // Paste button click
        btnPasteLink.setOnClickListener {
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

        // Watch button click — navigate to FileInfoActivity
        btnWatch.setOnClickListener {
            val input = etPasteLink.text.toString().trim()
            if (input.isEmpty()) {
                Toast.makeText(this, "Please paste a NightBox video link", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            val videoId = extractVideoId(input)
            if (videoId != null) {
                openFileInfo(videoId)
            } else {
                Toast.makeText(this, getString(R.string.error_invalid_link), Toast.LENGTH_LONG).show()
            }
        }

        // Play local files button
        findViewById<android.widget.Button>(R.id.btnPlayLocal)?.setOnClickListener {
            openGalleryPicker()
        }

        // Open Gallery link
        findViewById<LinearLayout>(R.id.btnOpenGallery)?.setOnClickListener {
            openGalleryPicker()
        }

        // Social section click listeners
        findViewById<LinearLayout>(R.id.btnJoinTelegram)?.setOnClickListener {
            openTelegram()
        }
        findViewById<LinearLayout>(R.id.btnJoinWhatsApp)?.setOnClickListener {
            openWhatsApp()
        }

        // Handle deep link if app was opened via link
        if (savedInstanceState == null) {
            handleDeepLink(intent)
        }
        
        // Preload rewarded ads removed
    }

    override fun onResume() {
        super.onResume()
        SecurityUtil.checkVpn(this)
        
        // Resume update if it was already in progress
        appUpdateManager.appUpdateInfo.addOnSuccessListener { appUpdateInfo ->
            if (appUpdateInfo.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS) {
                try {
                    appUpdateManager.startUpdateFlowForResult(
                        appUpdateInfo,
                        AppUpdateType.IMMEDIATE,
                        this,
                        UPDATE_REQUEST_CODE
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
            val pathSegments = data.pathSegments
            if (pathSegments.size >= 2 && pathSegments[0] == "watch") {
                val videoId = pathSegments[1]
                deepLinkProcessed = true
                // Clear intent data so it's not processed again
                intent.data = null
                intent.action = null
                setIntent(Intent())
                openFileInfo(videoId)
            }
        }
    }

    /**
     * Extract video ID from various input formats:
     * - Full URL: https://video.prernaupin.in/watch/VIDEO_ID
     * - Just the ID: VIDEO_ID (UUID-like format)
     * - Partial URL: video.prernaupin.in/watch/VIDEO_ID
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

    private fun openFileInfo(videoId: String) {
        val intent = Intent(this, FileInfoActivity::class.java)
        intent.putExtra("video_id", videoId)
        intent.flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        startActivity(intent)
    }

    private fun openGalleryPicker() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "video/*"
        }
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(intent, REQUEST_VIDEO_PICK)
        } catch (e: Exception) {
            Toast.makeText(this, "No file manager found", Toast.LENGTH_SHORT).show()
        }
    }

    @Deprecated("Use Activity Result API")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_VIDEO_PICK && resultCode == RESULT_OK) {
            val videoUri = data?.data
            if (videoUri != null) {
                // Grant persistent URI permission
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
        if (requestCode == UPDATE_REQUEST_CODE) {
            if (resultCode != RESULT_OK) {
                // UPDATE IS COMPULSORY: If user cancels or it fails, trigger it again immediately
                checkForAppUpdate()
            }
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
        val adView = AdView(this)
        
        // Calculate adaptive banner size
        val displayMetrics = resources.displayMetrics
        val adWidthPixels = displayMetrics.widthPixels.toFloat()
        val density = displayMetrics.density
        val adWidth = (adWidthPixels / density).toInt()
        val adSize = AdSize.getCurrentOrientationAnchoredAdaptiveBannerAdSize(this, adWidth)
        
        adView.setAdSize(adSize)
        // Real banner ad unit ID
        adView.adUnitId = "ca-app-pub-2964717174761820/7251270834"
        adBannerContainer.addView(adView)

        val adRequest = AdRequest.Builder().build()
        adView.loadAd(adRequest)
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

    private fun openWebLink(url: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        startActivity(intent)
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

    override fun onDestroy() {
        nativeAd?.destroy()
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
                        AppUpdateType.IMMEDIATE,
                        this,
                        UPDATE_REQUEST_CODE
                    )
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }
        }
    }

    private fun showHome() {
        homeSection.visibility = View.VISIBLE
        feedSection.visibility = View.GONE
        
        ivNavHome.setColorFilter(getColor(R.color.accent_violet))
        tvNavHome.setTextColor(getColor(R.color.accent_violet))
        tvNavHome.setTypeface(null, android.graphics.Typeface.BOLD)
        
        ivNavFeed.setColorFilter(getColor(R.color.text_secondary_dark))
        tvNavFeed.setTextColor(getColor(R.color.text_secondary_dark))
        tvNavFeed.setTypeface(null, android.graphics.Typeface.NORMAL)
    }

    private fun showFeed() {
        homeSection.visibility = View.GONE
        feedSection.visibility = View.VISIBLE
        
        ivNavFeed.setColorFilter(getColor(R.color.accent_violet))
        tvNavFeed.setTextColor(getColor(R.color.accent_violet))
        tvNavFeed.setTypeface(null, android.graphics.Typeface.BOLD)
        
        ivNavHome.setColorFilter(getColor(R.color.text_secondary_dark))
        tvNavHome.setTextColor(getColor(R.color.text_secondary_dark))
        tvNavHome.setTypeface(null, android.graphics.Typeface.NORMAL)
    }

    // Deprecated Downloads feature removed.

    private fun openUrl(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (_: Exception) {}
    }
}
