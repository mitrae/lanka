plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ai.lanka.kiosk"
    compileSdk = 34

    defaultConfig {
        applicationId = "ai.lanka.kiosk"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0-poc"

        buildConfigField(
            "String",
            "LANKA_SERVER_URL",
            "\"${providers.gradleProperty("LANKA_SERVER_URL").getOrElse("http://lanka-server:3000")}\""
        )
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
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

    sourceSets {
        getByName("main") {
            java.srcDirs("src/main/kotlin")
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.webkit:webkit:1.9.0")
}
