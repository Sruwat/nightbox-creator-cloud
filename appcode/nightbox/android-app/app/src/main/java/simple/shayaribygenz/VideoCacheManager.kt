package simple.shayaribygenz

import android.content.Context
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import java.io.File

@UnstableApi
object VideoCacheManager {

    @Volatile
    private var simpleCache: SimpleCache? = null

    @Synchronized
    fun getCache(context: Context): SimpleCache {
        val current = simpleCache
        if (current != null) return current

        val appContext = context.applicationContext
        val cacheDir = File(appContext.cacheDir, "nightbox_video_cache")
        if (!cacheDir.exists()) {
            cacheDir.mkdirs()
        }
        val evictor = LeastRecentlyUsedCacheEvictor(150L * 1024L * 1024L) // 150 MB auto-clearing LRU cache
        val databaseProvider = StandaloneDatabaseProvider(appContext)
        val cache = SimpleCache(cacheDir, evictor, databaseProvider)
        simpleCache = cache
        return cache
    }

    fun buildCacheDataSourceFactory(
        context: Context,
        upstreamFactory: DefaultHttpDataSource.Factory
    ): DataSource.Factory {
        val cache = getCache(context)
        return CacheDataSource.Factory()
            .setCache(cache)
            .setUpstreamDataSourceFactory(upstreamFactory)
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
    }
}
