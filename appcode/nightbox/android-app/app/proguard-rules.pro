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

# Google AdMob SDK & Play Services Ads
-keep public class com.google.android.gms.ads.** {
    public *;
}
-keep class com.google.ads.** { *; }
-keep class com.google.android.gms.common.** { *; }
-dontwarn com.google.android.gms.**

# NightBox App & Ad Engine
-keep class simple.shayaribygenz.AdManager { *; }
-keep class simple.shayaribygenz.AdComponents { *; }
-keep class simple.shayaribygenz.NightBoxApp { *; }
-keep class simple.shayaribygenz.SecurityUtil { *; }
-keep public class * extends android.app.Activity
-keep public class * extends android.view.View {
    public <init>(android.content.Context);
    public <init>(android.content.Context, android.util.AttributeSet);
    public <init>(android.content.Context, android.util.AttributeSet, int);
}

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

