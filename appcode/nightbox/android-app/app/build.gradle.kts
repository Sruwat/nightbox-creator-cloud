plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "simple.shayaribygenz"
    compileSdk = 35

    defaultConfig {
        applicationId = "simple.shayaribygenz"
        minSdk = 24
        targetSdk = 35
        versionCode = 14
        versionName = "4.1.7"
        val configuredBackendUrl = providers.gradleProperty("BACKEND_URL").orNull
            ?: System.getenv("BACKEND_URL")
        buildConfigField("String", "BACKEND_URL", "\"${configuredBackendUrl ?: "https://api.nightbox.in"}\"")
    }

    signingConfigs {
        create("release") {
            val keystorePath = providers.gradleProperty("RELEASE_STORE_FILE").orNull
                ?: System.getenv("RELEASE_STORE_FILE")
            val storePasswordValue = providers.gradleProperty("RELEASE_STORE_PASSWORD").orNull
                ?: System.getenv("RELEASE_STORE_PASSWORD")
            val keyAliasValue = providers.gradleProperty("RELEASE_KEY_ALIAS").orNull
                ?: System.getenv("RELEASE_KEY_ALIAS")
            val keyPasswordValue = providers.gradleProperty("RELEASE_KEY_PASSWORD").orNull
                ?: System.getenv("RELEASE_KEY_PASSWORD")
            if (!keystorePath.isNullOrBlank() && !storePasswordValue.isNullOrBlank() && !keyAliasValue.isNullOrBlank() && !keyPasswordValue.isNullOrBlank()) {
                storeFile = file(keystorePath)
                storePassword = storePasswordValue
                keyAlias = keyAliasValue
                keyPassword = keyPasswordValue
            }
        }
    }

    buildTypes {
        release {
            val releaseBackendUrl = providers.gradleProperty("BACKEND_URL").orNull
                ?: System.getenv("BACKEND_URL")
            isMinifyEnabled = true
            // Resource shrinking stalls on the current Windows/AGP toolchain;
            // keep R8 code shrinking enabled for the production artifact.
            isShrinkResources = false
            buildConfigField("String", "BACKEND_URL", "\"${releaseBackendUrl ?: ""}\"")
            if (System.getenv("RELEASE_STORE_FILE") != null || providers.gradleProperty("RELEASE_STORE_FILE").isPresent) {
                signingConfig = signingConfigs.getByName("release")
            }
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
        buildConfig = true
    }
}

val productionBackendUrl = providers.gradleProperty("BACKEND_URL").orNull
    ?: System.getenv("BACKEND_URL")
val releaseStoreFile = providers.gradleProperty("RELEASE_STORE_FILE").orNull
    ?: System.getenv("RELEASE_STORE_FILE")
val releaseStorePassword = providers.gradleProperty("RELEASE_STORE_PASSWORD").orNull
    ?: System.getenv("RELEASE_STORE_PASSWORD")
val releaseKeyAlias = providers.gradleProperty("RELEASE_KEY_ALIAS").orNull
    ?: System.getenv("RELEASE_KEY_ALIAS")
val releaseKeyPassword = providers.gradleProperty("RELEASE_KEY_PASSWORD").orNull
    ?: System.getenv("RELEASE_KEY_PASSWORD")
tasks.configureEach {
    if (name.contains("Release")) {
        doFirst {
            if (productionBackendUrl.isNullOrBlank()) {
                throw GradleException("BACKEND_URL must be set for Android release builds (use -PBACKEND_URL=https://...)")
            }
            if (releaseStoreFile.isNullOrBlank() || releaseStorePassword.isNullOrBlank() || releaseKeyAlias.isNullOrBlank() || releaseKeyPassword.isNullOrBlank()) {
                throw GradleException("Release signing is required (set RELEASE_STORE_FILE, RELEASE_STORE_PASSWORD, RELEASE_KEY_ALIAS, and RELEASE_KEY_PASSWORD)")
            }
            if (!file(releaseStoreFile).isFile) {
                throw GradleException("Release keystore was not found at RELEASE_STORE_FILE")
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
