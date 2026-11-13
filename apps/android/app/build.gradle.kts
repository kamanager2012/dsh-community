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
        versionCode = 2
        versionName = "0.2.2-rc.2"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Remains UNVERIFIED until R6 real-device Remote Acceptance passes.
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

    testOptions {
        unitTests {
            isReturnDefaultValues = true
        }
    }
}

// Pure thin Remote Client (R5): ZERO embedded Node.js runtime, ZERO official DSH packages,
// ZERO WebView local host, and ZERO unverified native `.so` runtime carriers.
dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")

    testImplementation("junit:junit:4.13.2")
}
