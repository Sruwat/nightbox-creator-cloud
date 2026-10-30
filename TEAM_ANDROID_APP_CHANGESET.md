# NightBox Android App — Final Team Change Set

This file consolidates the required secure playback changes and the additional changes already present in the current NightBox Android app. Apply the changes by searching for the method/anchor names below; do not duplicate methods that already exist.

## Files

```text
appcode/nightbox/android-app/app/src/main/java/simple/shayaribygenz/FileInfoActivity.kt
appcode/nightbox/android-app/app/src/main/java/simple/shayaribygenz/VideoPlayerActivity.kt
appcode/nightbox/android-app/app/src/main/java/simple/shayaribygenz/MainActivity.kt
appcode/nightbox/android-app/app/src/main/AndroidManifest.xml
```

## 1. FileInfoActivity.kt — secure handoff

Search `openVideoPlayer()` (current area: around line 290).

Keep this intent payload:

```kotlin
private fun openVideoPlayer() {
    val vid = videoId ?: return
    val intent = Intent(this, VideoPlayerActivity::class.java).apply {
        putExtra("video_id", vid)
        linkSlug?.let { putExtra("link_slug", it) }
        putExtra("video_title", videoTitle)
        if (videoDurationSec > 0) putExtra("video_duration_sec", videoDurationSec)
        if (videoSizeBytes > 0L) putExtra("video_size_bytes", videoSizeBytes)
        flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    startActivity(intent)
    finish()
}
```

Remove this line if it is present:

```kotlin
streamUrl?.let { putExtra("stream_url", it) }
```

The `streamUrl` field may also be removed if no other local-file flow uses it. In `fetchVideoInfo()` keep the video metadata only and set:

```kotlin
// Never cache or pass unsigned HLS/MP4 URLs.
// Playback authorization happens only after Play is pressed.
streamUrl = null
```

Do not read `hlsUrl`, `cdnUrl`, `streamUrl`, or `originHlsUrl` from the metadata response.

## 2. VideoPlayerActivity.kt — playback authorization

### Imports and fields

Keep:

```kotlin
import org.json.JSONObject
import android.app.DownloadManager
```

Do not import or use `ProgressiveMediaSource` for remote playback.

Keep these fields:

```kotlin
private var playbackTokenRetryUsed = false
private var processingRetryCount = 0
private var viewSessionId: String? = null
private var viewToken: String? = null
```

Remove old fields/fallbacks:

```kotlin
private var originHlsUrl: String? = null
private var originFallbackAttempted: Boolean = false
```

### Player initialization

Remote playback must use the token endpoint:

```kotlin
private fun initializePlayer() {
    releasePlayer()
    usingWebView = false
    if (localVideoUri != null) {
        initExoPlayerLocal()
    } else {
        requestPlaybackTokenAndInitialize()
    }
}
```

The method `requestPlaybackTokenAndInitialize()` must:

1. POST to `/api/videos/{videoId}/playback-token`.
2. Send `linkSlug` when available.
3. Treat `202` as processing and retry every 5 seconds, maximum 24 attempts.
4. Treat `403` as approval/rejection/availability state and show the server reason.
5. Accept only `manifestUrl`, `sessionId`, and `viewToken` from the successful response.
6. Pass only the returned `manifestUrl` to the HLS player.
7. Store `sessionId` and `viewToken` for qualified-view tracking.

The current implementation already contains this method around line 411. Do not add a second copy.

### HLS-only remote player

Inside `initExoPlayerHls()`, remove all MP4/progressive/origin fallback logic. The remote media source must be only:

```kotlin
val mediaSource = HlsMediaSource.Factory(playbackDataSourceFactory)
    .setAllowChunklessPreparation(true)
    .createMediaSource(MediaItem.fromUri(mediaUrl))
```

Do not use `ProgressiveMediaSource` for remote playback.

### Bounded buffer and decoder fallback

For the remote HLS player keep:

```kotlin
val loadControl = DefaultLoadControl.Builder()
    .setBufferDurationsMs(
        15_000,
        30_000,
        1_000,
        2_500
    )
    .setPrioritizeTimeOverSizeThresholds(true)
    .build()
```

Create the player with decoder fallback:

```kotlin
val renderersFactory = DefaultRenderersFactory(this)
    .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER)
    .setEnableDecoderFallback(true)

player = ExoPlayer.Builder(this, renderersFactory)
    .setTrackSelector(trackSelector)
    .setLoadControl(loadControl)
    .setSeekBackIncrementMs(5_000L)
    .setSeekForwardIncrementMs(15_000L)
    .build()
```

The current app also caps remote playback at 1280x720 and 2,200,000 bps to reduce mobile bandwidth. Keep this unless product explicitly requests full resolution:

```kotlin
.setMaxVideoSize(1280, 720)
.setMaxVideoBitrate(2_200_000)
```

The local-file player may use its own buffer values; do not confuse local playback with the remote HLS configuration.

### Error handling

On the first remote playback error, request a fresh playback token once. Do not fall back to an unsigned origin URL or MP4 URL:

```kotlin
if (!playbackTokenRetryUsed && localVideoUri == null) {
    playbackTokenRetryUsed = true
    window.decorView.postDelayed({
        if (!isFinishing && !isDestroyed) initializePlayer()
    }, 350L)
} else {
    releasePlayer()
    showError("Video stream could not be played. Tap Retry.")
}
```

## 3. Manual Download

Playback must never enqueue a download. Only the Download button may call `startManualDownload()`.

Keep the current `DownloadManager` implementation around line 985. It must use `downloadUrl`, not `remoteHlsUrl`, and must show a user notification. If `downloadUrl` is unavailable, show `Download is not available yet`.

## 4. View counting

Do not start view tracking immediately after metadata loading. Start it only after the playback-token response provides a valid `sessionId`/`viewToken` and the player has actually started playing for the configured threshold.

Keep the existing retry path:

```text
viewSessionId → playback starts → qualified-view request → retry up to 3 times
```

Do not count metadata loading, File Info opening, buffering, or a failed player attempt as a qualified view.

## 5. Deep links and File Info screen

### AndroidManifest.xml

Keep verified HTTPS App Links for these hosts and paths:

```xml
<data android:scheme="https" />
<data android:host="nightbox.in" />
<data android:pathPrefix="/watch/" />
<data android:pathPrefix="/l/" />
```

The same filters must exist for `www.nightbox.in` and `api.nightbox.in` with `android:autoVerify="true"`.

Keep the explicit schemes:

```xml
<data android:scheme="nightbox" android:host="watch" />
<data android:scheme="nightbox" android:host="l" />
```

### MainActivity.kt

Keep parsing for:

```text
https://nightbox.in/watch/{videoId}
https://nightbox.in/l/{slug}
nightbox://watch/{videoId}
nightbox://l/{slug}
```

Every external link must open `FileInfoActivity` first. The player opens only after the user presses Play.

## 6. Additional changes already present in the current app

These are not optional duplicate changes; preserve them while applying the team patch:

- Direct app-scheme fallback for Telegram/in-app browsers.
- Separate verified App Link filters for `nightbox.in`, `www.nightbox.in`, and `api.nightbox.in`.
- Link-slug title resolution before showing File Info.
- Processing polling and approval/rejection messages.
- Signed-manifest-only HLS playback.
- One fresh-token retry after player failure.
- HLS playback without persistent disk cache.
- 30-second maximum remote ahead-buffer.
- 720p/2.2 Mbps mobile track cap for bandwidth control.
- Decoder fallback for sound-only/black-video devices.
- Manual MP4 Download through Android DownloadManager only.
- View session retry when the first qualified-view callback fails.
- Player release on close/destroy so playback buffer is cleared.

## 7. Current source anchors

Use these anchors rather than relying on stale absolute line numbers:

```text
FileInfoActivity.kt:
  openVideoPlayer()       around line 290
  fetchVideoInfo()        around line 305

VideoPlayerActivity.kt:
  initializePlayer()      around line 397
  requestPlaybackToken... around line 411
  initExoPlayerHls()      around line 495
  onPlayerError()         around line 610
  view tracking           around lines 695–742
  startManualDownload()   around line 985

MainActivity.kt:
  deep-link parsing        around lines 289–347

AndroidManifest.xml:
  verified App Links      around lines 39–64
  nightbox schemes        around lines 69–79
```

## 8. Validation before APK delivery

```text
[ ] File Info does not cache/pass unsigned playback URLs
[ ] Play requests playback-token
[ ] 202 processing retries and eventually opens playback
[ ] 403 approval/rejection reason is shown
[ ] Only signed manifestUrl goes to HlsMediaSource
[ ] No ProgressiveMediaSource/origin/MP4 playback fallback remains
[ ] Remote buffer max is 30 seconds
[ ] Decoder fallback is enabled
[ ] Manual Download works only from Download button
[ ] Player release clears playback resources
[ ] View count starts only from authorized playback session
[ ] watch/l deep links open File Info first
[ ] Debug APK builds successfully
[ ] Test with a real installed APK from Telegram and Chrome
```

## 9. Important backend dependency

The app cannot create a signed CDN URL itself. The backend must provide:

```text
POST /api/videos/{videoId}/playback-token
```

with:

```json
{
  "manifestUrl": "https://...signed.../master.m3u8",
  "sessionId": "...",
  "viewToken": "..."
}
```

Without this response, the app must show processing/approval/playback error and must not fall back to an unsigned URL.
