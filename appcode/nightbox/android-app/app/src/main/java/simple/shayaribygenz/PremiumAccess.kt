package simple.shayaribygenz

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class PremiumEntitlement(
    val active: Boolean = false,
    val videoAdsRemoved: Boolean = false,
    val allAdsRemoved: Boolean = false,
    val planName: String? = null,
    val expiresAt: String? = null,
)

object PremiumAccess {
    private const val PREFS = "nightbox_prefs"
    private const val TOKEN = "account_token"
    private val client = OkHttpClient()

    fun token(context: Context): String? = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .getString(TOKEN, null)?.takeIf { it.isNotBlank() }

    fun saveToken(context: Context, value: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(TOKEN, value).apply()
    }

    fun clearToken(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(TOKEN).apply()
    }

    suspend fun entitlement(context: Context): PremiumEntitlement = withContext(Dispatchers.IO) {
        val bearer = token(context) ?: return@withContext PremiumEntitlement()
        try {
            val request = Request.Builder()
                .url("${BuildConfig.BACKEND_URL}/api/me/subscription")
                .header("Authorization", "Bearer $bearer")
                .get()
                .build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@withContext PremiumEntitlement()
                val subscription = JSONObject(response.body?.string().orEmpty()).optJSONObject("subscription")
                    ?: return@withContext PremiumEntitlement()
                val expiry = subscription.optString("expiresAt").takeIf { it.isNotBlank() }
                // A provider-confirmed entitlement always has an expiry. Do not
                // grant benefits to pending/cancelled records with no expiry.
                val notExpired = expiry != null && runCatching {
                    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSX", Locale.US).parse(expiry)?.after(Date()) == true
                }.getOrDefault(false)
                val active = notExpired && subscription.optString("status") in listOf("active", "cancelled")
                PremiumEntitlement(
                    active = active,
                    videoAdsRemoved = active && subscription.optInt("videoAdsRemoved") == 1,
                    allAdsRemoved = active && subscription.optInt("allAdsRemoved") == 1,
                    planName = subscription.optString("name").takeIf { it.isNotBlank() },
                    expiresAt = expiry,
                )
            }
        } catch (_: Exception) {
            PremiumEntitlement()
        }
    }
}
