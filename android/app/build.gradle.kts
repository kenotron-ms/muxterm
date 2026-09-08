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
}
