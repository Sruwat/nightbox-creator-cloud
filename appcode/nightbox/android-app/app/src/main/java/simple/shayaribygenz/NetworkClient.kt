package simple.shayaribygenz

import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * Singleton OkHttpClient sharing TCP connection pool, TLS 1.3 sessions,
 * and HTTP/2 multiplexing across all screens to eliminate connection handshake latency.
 */
object NetworkClient {
    val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(12, TimeUnit.SECONDS)
            .readTimeout(18, TimeUnit.SECONDS)
            .writeTimeout(18, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }
}
