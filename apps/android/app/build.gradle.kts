import org.gradle.api.GradleException

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

fun resolveBuildOption(gradlePropName: String, envName: String): String? {
    val fromProp = (project.findProperty(gradlePropName) as? String)?.trim()
    if (!fromProp.isNullOrEmpty()) return fromProp
    val fromEnv = System.getenv(envName)?.trim()
    if (!fromEnv.isNullOrEmpty()) return fromEnv
    return null
}

fun isTruthyBuildOption(gradlePropName: String, envName: String): Boolean {
    val raw = resolveBuildOption(gradlePropName, envName)?.lowercase() ?: return false
    return raw == "1" || raw == "true" || raw == "yes"
}

val allowedAndroidAbis = setOf("arm64-v8a", "armeabi-v7a", "x86", "x86_64")
val rawAbiFilters = resolveBuildOption("dshAbiFilters", "DSH_ANDROID_ABI_FILTERS")
val requestedAbiFilters: List<String> = if (rawAbiFilters == null) {
    emptyList()
} else {
    val parsed = rawAbiFilters.split(',').map { it.trim() }
    if (parsed.isEmpty() || parsed.any { it.isEmpty() }) {
        throw GradleException(
            "Invalid empty ABI entry in dshAbiFilters / DSH_ANDROID_ABI_FILTERS='$rawAbiFilters'. " +
                "Allowed ABIs: ${allowedAndroidAbis.sorted().joinToString(", ")}.",
        )
    }
    val invalidAbis = parsed.filterNot { it in allowedAndroidAbis }
    if (invalidAbis.isNotEmpty()) {
        throw GradleException(
            "Unsupported ABI filter(s) ${invalidAbis.joinToString(", ")} in '$rawAbiFilters'. " +
                "Allowed ABIs: ${allowedAndroidAbis.sorted().joinToString(", ")}.",
        )
    }
    parsed.distinct()
}

val resolvedStorePath = resolveBuildOption("dshKeystorePath", "DSH_ANDROID_KEYSTORE_PATH")
val resolvedStorePassword = resolveBuildOption("dshKeystorePassword", "DSH_ANDROID_KEYSTORE_PASSWORD")
val resolvedKeyAlias = resolveBuildOption("dshKeyAlias", "DSH_ANDROID_KEY_ALIAS")
val resolvedKeyPassword = resolveBuildOption("dshKeyPassword", "DSH_ANDROID_KEY_PASSWORD")
val signingRequired = isTruthyBuildOption("dshSigningRequired", "DSH_ANDROID_SIGNING_REQUIRED")
val providedSigningFieldCount = listOf(
    resolvedStorePath,
    resolvedStorePassword,
    resolvedKeyAlias,
    resolvedKeyPassword,
).count { it != null }

if (signingRequired && providedSigningFieldCount < 4) {
    throw GradleException(
        "Android release signing is required (DSH_ANDROID_SIGNING_REQUIRED / -PdshSigningRequired), " +
            "but only $providedSigningFieldCount/4 signing inputs were provided. " +
            "Set DSH_ANDROID_KEYSTORE_PATH, DSH_ANDROID_KEYSTORE_PASSWORD, DSH_ANDROID_KEY_ALIAS, DSH_ANDROID_KEY_PASSWORD.",
    )
}
if (providedSigningFieldCount in 1..3) {
    throw GradleException(
        "Partial Android release signing configuration detected ($providedSigningFieldCount/4 inputs provided). " +
            "Provide all 4 of DSH_ANDROID_KEYSTORE_PATH, DSH_ANDROID_KEYSTORE_PASSWORD, DSH_ANDROID_KEY_ALIAS, DSH_ANDROID_KEY_PASSWORD, or none.",
    )
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
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        if (requestedAbiFilters.isNotEmpty()) {
            ndk {
                abiFilters.addAll(requestedAbiFilters)
            }
        }
    }

    signingConfigs {
        if (providedSigningFieldCount == 4) {
            val keystoreFile = project.file(resolvedStorePath!!)
            if (!keystoreFile.isFile) {
                throw GradleException("Android release keystore does not exist: ${keystoreFile.path}")
            }
            create("release") {
                storeFile = keystoreFile
                storePassword = resolvedStorePassword
                keyAlias = resolvedKeyAlias
                keyPassword = resolvedKeyPassword
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfigs.findByName("release")?.let { releaseSigning ->
                signingConfig = releaseSigning
            }
            // Remains UNVERIFIED for Play/public release until R6 real-device arm64 acceptance passes.
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
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.camera:camera-core:1.4.1")
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")
    implementation("com.google.zxing:core:3.5.3")
    implementation("io.github.webrtc-sdk:android:150.7871.04")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:core:1.6.1")
    androidTestImplementation("androidx.test:runner:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
