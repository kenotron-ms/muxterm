plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Default URL the wrapper loads. Override at build time with:
//   ./gradlew assemblePhone -PmuxtermUrl=https://your.host
val muxtermUrl: String = (project.findProperty("muxtermUrl") as String?)
    ?: "https://muxterm.ampbox.io"
val releaseVersion: String? = project.findProperty("muxtermVersion") as String?
val releaseVersionCode: Int? = (project.findProperty("muxtermVersionCode") as String?)?.toIntOrNull()
if ((releaseVersion == null) != (releaseVersionCode == null)) {
    error("muxtermVersion and muxtermVersionCode must be provided together")
}

android {
    namespace = "io.ampbox.muxterm"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.ampbox.muxterm"
        minSdk = 26
        targetSdk = 34
        versionCode = releaseVersionCode ?: 2
        versionName = releaseVersion ?: "0.1.1"

        buildConfigField("String", "MUXTERM_URL", "\"$muxtermUrl\"")
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.8"
    }

    signingConfigs {
        create("githubRelease") {
            System.getenv("ANDROID_RELEASE_KEYSTORE_FILE")?.let { storeFile = file(it) }
            storePassword = System.getenv("ANDROID_RELEASE_KEYSTORE_PASSWORD")
            keyAlias = "muxterm-android"
            keyPassword = System.getenv("ANDROID_RELEASE_KEYSTORE_PASSWORD")
        }
    }

    buildTypes {
        // The debug variant includes an Automotive OS emulator launcher from
        // src/debug. It must not be sent to a phone: that extra launcher opens
        // CarAppActivity and reports "System requires update" without a car host.
        getByName("debug") {
            isMinifyEnabled = false
            // Side-by-side installs, for when two people are verifying two
            // branches on the one phone:
            //   ./gradlew assembleDebug -PappIdSuffix=.notify
            // Default is unset, so a plain build installs over the usual app
            // exactly as before. `namespace` is untouched, so BuildConfig and
            // R stay where the code expects them.
            (project.findProperty("appIdSuffix") as String?)
                ?.takeIf { it.isNotBlank() }
                ?.let { applicationIdSuffix = it }
        }

        // Sideloadable phone build: debug-signed, with the native satellite as
        // launcher. A separate build type keeps src/debug's Automotive OS
        // emulator overlay and dependency out of the phone APK.
        create("phone") {
            initWith(getByName("debug"))
            matchingFallbacks += listOf("debug")
        }

        getByName("release") {
            signingConfig = signingConfigs.getByName("githubRelease")
        }
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.activity:activity-compose:1.8.2")
    implementation(platform("androidx.compose:compose-bom:2024.02.02"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    // Android Auto projection screen. 1.7.0 is current stable at compileSdk 34;
    // fall back to 1.4.0 here (comment only, left in place) if it ever fails
    // to resolve or demands a compileSdk bump - compileSdk stays at 34.
    implementation("androidx.car.app:app:1.7.0")

    // Car screen's session feed: a WebSocket client for /ws. org.json (already
    // on the platform) parses the six fields we need - no Moshi/Gson/kotlinx.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // DEBUG ONLY, and the "debug" matters. The target is Android AUTO -- the
    // phone projects to the car screen -- which needs androidx.car.app:app and
    // nothing else. app-automotive is the OTHER product: it supplies the
    // CarAppActivity that launches templates on Android Automotive OS, a car
    // with Android built in.
    //
    // It is here because AAOS runs in an emulator and Android Auto does not:
    // the DHU is not a standalone emulator, it tethers to a real phone. So the
    // only way to SEE this screen render on this machine is to install the
    // debug build on an AAOS emulator, which has the same templates host.
    //
    // Scoped to debug so the phone build keeps exactly one launcher entry.
    debugImplementation("androidx.car.app:app-automotive:1.7.0")

    // JVM unit tests for the notification logic. The transition detector and
    // the coalescing buffer are deliberately Android-free so they can be tested
    // here, in milliseconds, without a device. org.json is stubbed by the
    // Android plugin's mockable jar, hence testOptions.returnDefaultValues -
    // the parser tests use the real thing via the json artifact below.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20231013")
}
