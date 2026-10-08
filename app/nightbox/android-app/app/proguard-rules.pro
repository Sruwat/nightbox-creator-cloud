# Add project specific ProGuard rules here.
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

# Facebook Audience Network
-dontwarn com.facebook.infer.annotation.**
-dontwarn com.facebook.ads.**

# Vungle / Liftoff Monetize
-dontwarn com.vungle.**
-keep class com.vungle.** { *; }
-keep class com.google.ads.mediation.vungle.** { *; }

