import java.io.FileInputStream
import java.util.Properties
import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
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
        versionName = "0.3.0-surface"

        buildConfigField(
            "String",
            "LANKA_SERVER_URL",
            "\"${providers.gradleProperty("LANKA_SERVER_URL").getOrElse("http://lanka-server:3000")}\""
        )

        // On-device PIN escape hatch (see docs/superpowers/specs/2026-08-23-kiosk-pin-unlock-design.md).
        // Hashed at configure time so the plaintext PIN never ships in the APK.
        // Empty default = feature DISABLED, so a build without -PKIOSK_PIN has no
        // hatch at all rather than a fleet-wide well-known one.
        val kioskPin = providers.gradleProperty("KIOSK_PIN").getOrElse("")
        // A PIN the pad can never complete (non-digits — KioskPin ignores them —
        // or a stray space from shell quoting) must fail the BUILD, not the 11pm
        // site visit. Empty stays allowed: it disables the feature.
        require(kioskPin.isEmpty() || (kioskPin.length >= 4 && kioskPin.all(Char::isDigit))) {
            "KIOSK_PIN must be 4+ digits (0-9) or unset; got ${kioskPin.length} chars"
        }
        val kioskPinSha = if (kioskPin.isEmpty()) "" else
            MessageDigest.getInstance("SHA-256")
                .digest(kioskPin.toByteArray())
                .joinToString("") { "%02x".format(it) }
        buildConfigField("String", "KIOSK_PIN_SHA256", "\"$kioskPinSha\"")
        buildConfigField("int", "KIOSK_PIN_LENGTH", "${kioskPin.length}")
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

    // Pure-logic JVM unit tests may incidentally call android.util.Log (e.g. the
    // OTA hash-mismatch path). Return stub defaults instead of throwing
    // "Method ... not mocked" so those branches are testable without Robolectric.
    testOptions {
        unitTests.isReturnDefaultValues = true
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

    // Native (ExoPlayer) surface. Formerly nativeImplementation-scoped; one APK
    // now carries both surfaces (~6 MB instead of 1.9 MB — accepted in the spec).
    val media3 = "1.3.1"
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-ui:$media3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

    testImplementation("junit:junit:4.13.2")
}
