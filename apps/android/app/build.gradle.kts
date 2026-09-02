plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.github.nodejs-mobile")
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
            // signing happens in CI via android.injected.signing.* (see
            // .github/workflows/android-build.yml); no keystore in the repo
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

nodejs {
    nodejsVersion = "22.19.0" // match official runtime engines: ^22.19.0 || >=24.0.0
    nodeModulesDir = file("nodejs-project")
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
}
