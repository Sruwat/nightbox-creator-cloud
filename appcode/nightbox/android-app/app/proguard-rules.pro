# Add project specific ProGuard rules here.
-dontoptimize
-keepattributes Signature
-keepattributes *Annotation*

# Gson - Keep classes with SerializedName as they use reflection
-keepclassmembers class * {
    @com.google.gson.annotations.SerializedName <fields>;
}

# OkHttp
-dontwarn okhttp3.**

# ExoPlayer / Media3
-dontwarn androidx.media3.**

# Google AdMob Mediation Adapters
-keep class com.google.ads.mediation.** { *; }

# Meta Audience Network
-dontwarn com.facebook.ads.**
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Unity Ads
-keep class com.unity3d.ads.** { *; }
-keep class com.unity3d.services.** { *; }
-dontwarn com.unity3d.ads.**
-dontwarn com.unity3d.services.**

# InMobi
-keep class com.inmobi.** { *; }
-dontwarn com.inmobi.**

# Liftoff Monetize (Vungle)
-keep class com.vungle.ads.** { *; }
-dontwarn com.vungle.ads.**
