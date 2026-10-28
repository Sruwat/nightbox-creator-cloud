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
        versionCode = 15
        versionName = "4.1.8"
        val configuredBackendUrl = providers.gradleProperty("BACKEND_URL").orNull
            ?: System.getenv("BACKEND_URL")
        buildConfigField("String", "BACKEND_URL", "\"${configuredBackendUrl ?: "https://api.nightbox.in"}\"")
    }

    signingConfigs {
        create("release") {
            val keystorePath = providers.gradleProperty("RELEASE_STORE_FILE").orNull
                ?: System.getenv("RELEASE_STORE_FILE")
                ?: "release.jks"
            val storePasswordValue = providers.gradleProperty("RELEASE_STORE_PASSWORD").orNull
                ?: System.getenv("RELEASE_STORE_PASSWORD")
                ?: ""
            val keyAliasValue = providers.gradleProperty("RELEASE_KEY_ALIAS").orNull
                ?: System.getenv("RELEASE_KEY_ALIAS")
                ?: "key0"
            val keyPasswordValue = providers.gradleProperty("RELEASE_KEY_PASSWORD").orNull
                ?: System.getenv("RELEASE_KEY_PASSWORD")
                ?: ""

            storeFile = file(keystorePath)
            storePassword = storePasswordValue
            keyAlias = keyAliasValue
            keyPassword = keyPasswordValue
        }
    }

    buildTypes {
        release {
            val releaseBackendUrl = providers.gradleProperty("BACKEND_URL").orNull
                ?: System.getenv("BACKEND_URL")
                ?: "https://api.nightbox.in"
            isMinifyEnabled = true
            // Resource shrinking stalls on the current Windows/AGP toolchain;
            // keep R8 code shrinking enabled for the production artifact.
            isShrinkResources = false
            // Keep production APKs usable even when the build runner does not
            // provide an override. CI can still pass -PBACKEND_URL for staging.
            buildConfigField("String", "BACKEND_URL", "\"$releaseBackendUrl\"")
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }
}

val productionBackendUrl = providers.gradleProperty("BACKEND_URL").orNull
    ?: System.getenv("BACKEND_URL")
    ?: "https://api.nightbox.in"
val releaseStoreFile = providers.gradleProperty("RELEASE_STORE_FILE").orNull
    ?: System.getenv("RELEASE_STORE_FILE")
    ?: "release.jks"
val releaseStorePassword = providers.gradleProperty("RELEASE_STORE_PASSWORD").orNull
    ?: System.getenv("RELEASE_STORE_PASSWORD")
    ?: ""
val releaseKeyAlias = providers.gradleProperty("RELEASE_KEY_ALIAS").orNull
    ?: System.getenv("RELEASE_KEY_ALIAS")
    ?: "key0"
val releaseKeyPassword = providers.gradleProperty("RELEASE_KEY_PASSWORD").orNull
    ?: System.getenv("RELEASE_KEY_PASSWORD")
    ?: ""
tasks.configureEach {
    if (name == "packageRelease" || name == "bundleRelease") {
        doFirst {
            if (productionBackendUrl.isNullOrBlank()) {
                throw GradleException("BACKEND_URL must be set for Android release builds (use -PBACKEND_URL=https://...)")
            }
            if (releaseStoreFile.isNullOrBlank() || releaseStorePassword.isNullOrBlank() || releaseKeyAlias.isNullOrBlank() || releaseKeyPassword.isNullOrBlank()) {
                throw GradleException("Release signing is required (set RELEASE_STORE_FILE, RELEASE_STORE_PASSWORD, RELEASE_KEY_ALIAS, and RELEASE_KEY_PASSWORD)")
            }
            if (!file(releaseStoreFile).isFile) {
                throw GradleException("Release keystore was not found at RELEASE_STORE_FILE ($releaseStoreFile)")
            }
        }
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
    implementation("androidx.media3:media3-ui:1.3.1")

    // Networking
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.code.gson:gson:2.10.1")

    // Google Mobile Ads (GMA) SDK & Mediation Bidding Adapters
    implementation("com.google.android.gms:play-services-ads:23.6.0")
    implementation("com.google.ads.mediation:facebook:6.18.0.0")
    implementation("com.google.ads.mediation:unity:4.12.2.0")
    implementation("com.google.ads.mediation:inmobi:10.7.7.0")
    implementation("androidx.browser:browser:1.8.0")
    implementation("com.google.ads.mediation:vungle:7.4.0.0")

    // In-App Updates & Reviews (Latest Google Play Core)
    implementation("com.google.android.play:app-update:2.1.0")
    implementation("com.google.android.play:app-update-ktx:2.1.0")
    implementation("com.google.android.play:review:2.0.2")
    implementation("com.google.android.play:review-ktx:2.0.2")

    // Google Play Billing Library (Latest Google Billing Client 8.0.0)
    implementation("com.android.billingclient:billing-ktx:8.0.0")

    // Google Play Install Referrer
    implementation("com.android.installreferrer:installreferrer:2.2")

    // Splash screen
    implementation("androidx.core:core-splashscreen:1.0.1")

    // Swipe refresh
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
}
