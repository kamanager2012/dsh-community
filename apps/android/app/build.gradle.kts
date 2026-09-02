plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "org.dsh.community.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.dsh.community.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.2-alpha.4"

        ndk {
            // arm64-v8a for real devices; x86_64 for emulator smoke tests
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // No Android publish/signing workflow is active yet. This source
            // remains UNVERIFIED until the runtime-substrate and APK gates pass.
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

// Embedded Node is deliberately NOT wired here yet. The historical Labs
// plugin declaration was not a verified Gradle integration, and stock
// nodejs-mobile currently does not satisfy official DSH Node 22.19+ engines.
// See ../runtime-substrate.json and docs/android-endpoint.*.

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
}
