package simple.shayaribygenz

import android.app.Application
import android.os.Handler
import android.os.Looper
import com.google.android.gms.ads.AdListener
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.AdSize
import com.google.android.gms.ads.AdView
import com.google.android.gms.ads.LoadAdError
import com.google.android.gms.ads.MobileAds
import com.google.android.gms.ads.interstitial.InterstitialAd
import com.google.android.gms.ads.interstitial.InterstitialAdLoadCallback
import com.google.android.gms.ads.rewarded.RewardedAd
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback
import com.facebook.ads.AudienceNetworkAds

class NightBoxApp : Application() {

    companion object {
        // Flag: true once AdMob SDK finishes initializing
        @Volatile var adsInitialized = false

        // Ad Unit IDs
        const val BANNER_AD_UNIT    = "ca-app-pub-2964717174761820/7251270834"
        const val INTERSTITIAL_AD_UNIT = "ca-app-pub-2964717174761820/3355198364"
        const val REWARDED_AD_UNIT  = "ca-app-pub-2964717174761820/7059699143"
        const val NATIVE_AD_UNIT    = "ca-app-pub-2964717174761820/2042116691"

        // Preloaded ads cache — activities pull from these
        @Volatile var preloadedInterstitial: InterstitialAd? = null
        @Volatile var preloadedRewarded: RewardedAd? = null

        // Singleton AdRequest reused across app
        val adRequest: AdRequest get() = AdRequest.Builder().build()
    }

    override fun onCreate() {
        super.onCreate()

        // Initialize AdMob SDK ONCE at app startup
        MobileAds.initialize(this) {
            adsInitialized = true
            // Once SDK is ready, immediately preload Interstitial and Rewarded ads
            preloadInterstitial()
            preloadRewarded()
        }

        // Initialize Meta Audience Network for bidding mediation
        AudienceNetworkAds.initialize(this)

        // Initialize InMobi SDK explicitly with your Account ID
        try {
            val consentObject = org.json.JSONObject()
            consentObject.put(com.inmobi.sdk.InMobiSdk.IM_GDPR_CONSENT_AVAILABLE, true)
            consentObject.put("gdpr", "1")
            com.inmobi.sdk.InMobiSdk.init(
                this,
                "b97370b485e546d89df9760faabbdd98",
                consentObject,
                object : com.inmobi.sdk.SdkInitializationListener {
                    override fun onInitializationComplete(error: Error?) {
                        // InMobi SDK initialization complete
                    }
                }
            )
        } catch (e: Exception) {
            // InMobi init failed — AdMob mediation adapter will still handle it
        }

        // Liftoff Monetize (Vungle) — set CCPA consent
        try {
            com.vungle.ads.VunglePrivacySettings.setCCPAStatus(true)
        } catch (e: Exception) {
            // Adapter handles its own initialization
        }
    }

    private fun preloadInterstitial() {
        if (preloadedInterstitial != null) return
        InterstitialAd.load(
            this,
            INTERSTITIAL_AD_UNIT,
            adRequest,
            object : InterstitialAdLoadCallback() {
                override fun onAdLoaded(ad: InterstitialAd) {
                    preloadedInterstitial = ad
                    // When used, immediately reload so next one is ready
                    ad.fullScreenContentCallback = object : com.google.android.gms.ads.FullScreenContentCallback() {
                        override fun onAdDismissedFullScreenContent() {
                            preloadedInterstitial = null
                            preloadInterstitial()
                        }
                        override fun onAdFailedToShowFullScreenContent(e: com.google.android.gms.ads.AdError) {
                            preloadedInterstitial = null
                            preloadInterstitial()
                        }
                    }
                }
                override fun onAdFailedToLoad(error: LoadAdError) {
                    preloadedInterstitial = null
                    // Retry after 30 seconds on failure
                    Handler(Looper.getMainLooper()).postDelayed({ preloadInterstitial() }, 30_000)
                }
            }
        )
    }

    private fun preloadRewarded() {
        if (preloadedRewarded != null) return
        RewardedAd.load(
            this,
            REWARDED_AD_UNIT,
            adRequest,
            object : RewardedAdLoadCallback() {
                override fun onAdLoaded(ad: RewardedAd) {
                    preloadedRewarded = ad
                    ad.fullScreenContentCallback = object : com.google.android.gms.ads.FullScreenContentCallback() {
                        override fun onAdDismissedFullScreenContent() {
                            preloadedRewarded = null
                            preloadRewarded()
                        }
                        override fun onAdFailedToShowFullScreenContent(e: com.google.android.gms.ads.AdError) {
                            preloadedRewarded = null
                            preloadRewarded()
                        }
                    }
                }
                override fun onAdFailedToLoad(error: LoadAdError) {
                    preloadedRewarded = null
                    Handler(Looper.getMainLooper()).postDelayed({ preloadRewarded() }, 30_000)
                }
            }
        )
    }
}
