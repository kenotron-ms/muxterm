plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Default URL the wrapper loads. Override at build time with:
//   ./gradlew assembleDebug -PmuxtermUrl=https://your.host
val muxtermUrl: String = (project.findProperty("muxtermUrl") as String?)
    ?: "https://muxterm.ampbox.io"

android {
    namespace = "io.ampbox.muxterm"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.ampbox.muxterm"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        buildConfigField("String", "MUXTERM_URL", "\"$muxtermUrl\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        // Debug-signed on purpose: this is a sideloaded demo build, not a Play release.
        getByName("debug") {
            isMinifyEnabled = false
        }
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
    // Scoped to debug so the shipped app keeps exactly one launcher entry.
    // Promoting this to a real Automotive OS build means a product flavor, not
    // moving this line.
    debugImplementation("androidx.car.app:app-automotive:1.7.0")
}
