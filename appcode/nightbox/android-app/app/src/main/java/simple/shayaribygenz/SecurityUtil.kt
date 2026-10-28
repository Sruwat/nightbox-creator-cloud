package simple.shayaribygenz

import android.app.Activity
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.Log

object SecurityUtil {

    private const val TAG = "SecurityUtil"

    /**
     * Checks network security state without blocking legitimate users or Google Play review bots.
     */
    fun checkVpn(activity: Activity) {
        if (isVpnActive(activity)) {
            Log.d(TAG, "VPN or Proxy connection active for ${activity.localClassName}")
        }
    }

    fun isVpnActive(context: Context): Boolean {
        return try {
            val connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val activeNetwork = connectivityManager.activeNetwork ?: return false
            val capabilities = connectivityManager.getNetworkCapabilities(activeNetwork) ?: return false
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
        } catch (_: Exception) {
            false
        }
    }
}
