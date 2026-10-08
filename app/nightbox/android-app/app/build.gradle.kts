plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "simple.shayaribygenz"
    compileSdk = 36

    defaultConfig {
        applicationId = "simple.shayaribygenz"
        minSdk = 24
        targetSdk = 36
        versionCode = 14
        versionName = "4.1.7"
    }

    signingConfigs {
        create("release") {
            storeFile = file("D:/video play keystore/key")
            storePassword = "Aman123456@1"
            keyAlias = "key0"
            keyPassword = "Aman123456@1"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    kotlinOptions {
        jvmTarget = "1.8"
    }

    buildFeatures {
        viewBinding = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")

    // ExoPlayer / Media3
    implementation("androidx.media3:media3-exoplayer:1.3.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.3.1")
    implementation("androidx.media3:media3-exoplayer-ima:1.3.1")
    implementation("androidx.media3:media3-ui:1.3.1")

    // Networking
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.code.gson:gson:2.10.1")

    // AdMob
    implementation("com.google.android.gms:play-services-ads:23.1.0")

    // AdMob Mediation Adapters
    implementation("com.google.ads.mediation:inmobi:10.6.7.1")
    implementation("com.facebook.android:audience-network-sdk:6.21.0")
    implementation("com.google.ads.mediation:facebook:6.18.0.0")
    implementation("com.google.ads.mediation:vungle:7.7.2.0")

    // In-App Updates
    implementation("com.google.android.play:app-update:2.1.0")
    implementation("com.google.android.play:app-update-ktx:2.1.0")

    // Splash screen
    implementation("androidx.core:core-splashscreen:1.0.1")

    // Swipe refresh
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
}
