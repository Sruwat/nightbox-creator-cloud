package simple.shayaribygenz

import android.app.Application
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.MobileAds

import android.util.Log

class NightBoxApp : Application() {

    companion object {
        private const val TAG = "NightBoxApp"

        // Flag: true once AdMob SDK finishes initializing
        @Volatile var adsInitialized = false

        // Ad Unit IDs
        const val BANNER_AD_UNIT   = AdManager.BANNER_HOME_VIDEO_PLAYER
        const val REWARDED_AD_UNIT = AdManager.REWARDED_AD_UNIT

        val adRequest: AdRequest get() = AdRequest.Builder().build()
    }

    override fun onCreate() {
        super.onCreate()

        // Real Live Ads Mode (Test device configuration removed)
        val configuration = com.google.android.gms.ads.RequestConfiguration.Builder()
            .build()
        MobileAds.setRequestConfiguration(configuration)

        // Initialize AdMob SDK ONCE at app startup
        MobileAds.initialize(this) { initStatus ->
            adsInitialized = true
            val statusMap = initStatus.adapterStatusMap
            for ((adapterClass, status) in statusMap) {
                Log.d(TAG, "Bidding Mediation Adapter: $adapterClass -> state=${status.initializationState}")
            }
            AdManager.preloadRewarded(this)
        }
    }
}
