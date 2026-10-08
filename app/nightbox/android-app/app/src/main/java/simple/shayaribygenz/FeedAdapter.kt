package simple.shayaribygenz

import android.annotation.SuppressLint
import android.net.Uri
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.recyclerview.widget.RecyclerView

class FeedAdapter(private val videoLinks: List<String>) : RecyclerView.Adapter<FeedAdapter.FeedViewHolder>() {

    inner class FeedViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        val webView: WebView = itemView.findViewById(R.id.webView)

        @SuppressLint("SetJavaScriptEnabled")
        fun bind(embedUrl: String) {
            val settings = webView.settings
            settings.javaScriptEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.domStorageEnabled = true
            settings.allowContentAccess = true
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true
            settings.userAgentString = "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"

            webView.webChromeClient = WebChromeClient()

            // Override URL loading to BLOCK YouTube app from opening, force inline only
            webView.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url.toString()
                    // Block any intent:// or vnd.youtube:// or youtu.be links that would open the app
                    return when {
                        url.startsWith("intent://") -> true   // block intent redirects
                        url.startsWith("vnd.youtube") -> true // block YouTube app scheme
                        url.startsWith("market://") -> true   // block Play Store
                        url.contains("youtu.be") -> true      // block short links that redirect to app
                        else -> false // allow everything else inside the WebView
                    }
                }
            }

            // Construct the YouTube video ID and use a special nocookie embed
            // This loads the video inline without any YouTube app redirect
            val videoId = extractVideoId(embedUrl)

            val htmlData = """
                <!DOCTYPE html>
                <html>
                <head>
                  <meta name="viewport" content="width=device-width, initial-scale=1.0">
                  <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body {
                      background: #000;
                      width: 100vw;
                      height: 100vh;
                      overflow: hidden;
                      display: flex;
                      align-items: center;
                      justify-content: center;
                    }
                    .video-container {
                      position: relative;
                      width: 100%;
                      height: 100%;
                    }
                    iframe {
                      position: absolute;
                      top: 0; left: 0;
                      width: 100%;
                      height: 100%;
                      border: none;
                    }
                  </style>
                </head>
                <body>
                  <div class="video-container">
                    <iframe
                      src="https://www.youtube-nocookie.com/embed/$videoId?autoplay=1&mute=0&playsinline=1&rel=0&modestbranding=1&controls=1&enablejsapi=1&origin=https://www.youtube-nocookie.com"
                      frameborder="0"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowfullscreen>
                    </iframe>
                  </div>
                </body>
                </html>
            """.trimIndent()

            webView.loadDataWithBaseURL(
                "https://www.youtube-nocookie.com",
                htmlData,
                "text/html",
                "UTF-8",
                null
            )
        }

        /** Extracts the raw video ID from a YouTube embed URL */
        private fun extractVideoId(url: String): String {
            return try {
                val uri = Uri.parse(url)
                // handles https://www.youtube.com/embed/VIDEO_ID
                val segments = uri.pathSegments
                val embedIndex = segments.indexOf("embed")
                if (embedIndex != -1 && embedIndex + 1 < segments.size) {
                    segments[embedIndex + 1]
                } else {
                    // fallback: last path segment
                    segments.lastOrNull() ?: ""
                }
            } catch (e: Exception) {
                url // return as-is if parsing fails
            }
        }
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): FeedViewHolder {
        val view = LayoutInflater.from(parent.context).inflate(R.layout.item_feed_video, parent, false)
        return FeedViewHolder(view)
    }

    override fun onBindViewHolder(holder: FeedViewHolder, position: Int) {
        holder.bind(videoLinks[position])
    }

    override fun onViewRecycled(holder: FeedViewHolder) {
        super.onViewRecycled(holder)
        holder.webView.loadUrl("about:blank")
        holder.webView.onPause()
    }

    override fun getItemCount(): Int = videoLinks.size
}
