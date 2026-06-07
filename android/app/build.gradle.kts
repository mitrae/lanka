import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing is read from android/keystore.properties (kept out of git),
// or, failing that, the LANKA_KEYSTORE_* environment variables (for CI). When
// neither is present the release build is left unsigned, so a plain
// `assembleDebug` on a fresh checkout still works without any secrets.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) FileInputStream(f).use { load(it) }
}
fun signProp(prop: String, env: String): String? =
    keystoreProps.getProperty(prop) ?: System.getenv(env)
val releaseStoreFile = signProp("storeFile", "LANKA_KEYSTORE_PATH")?.let { rootProject.file(it) }
val hasReleaseSigning = releaseStoreFile?.exists() == true

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

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = releaseStoreFile
                storePassword = signProp("storePassword", "LANKA_KEYSTORE_PASS")
                keyAlias = signProp("keyAlias", "LANKA_KEY_ALIAS")
                keyPassword = signProp("keyPassword", "LANKA_KEY_PASS")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
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
