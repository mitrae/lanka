# Lanka APK Kiosk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a sideloadable Android APK that wraps the existing Nuxt `/player` route in a fullscreen kiosk, embeds Tailscale via `tsnet` so TVs join the tailnet without any on-device typing, and auto-launches on boot.

**Architecture:** One new top-level directory `android/` containing a standalone Gradle project with three modules (`:app`, `:tsnet`, `:bridge`). `:app` is the Kotlin kiosk shell (activity, WebView, kiosk flags, key interception, storage, watchdog). `:tsnet` cross-compiles a Go shared library that runs Tailscale's `tsnet` plus a SOCKS5 listener on `localhost:1055`; the WebView client routes requests through that proxy. `:bridge` is an empty stub module reserved for Plan 6's `NativeFS`. On the Nuxt side, only `useNativeDevice.ts` changes — one capability check delegating to `window.NativeDevice` when present.

**Tech Stack:** Kotlin 1.9 · Gradle 8.5 · Android Gradle Plugin 8.2 · `minSdk` 24 / `targetSdk` 34 · Go 1.22 · `tailscale.com/tsnet` · `github.com/things-go/go-socks5` · JNI via `-buildmode=c-shared` · JUnit 4 for JVM-only unit tests · WorkManager for watchdog.

**Spec:** `docs/superpowers/specs/2026-04-19-lanka-apk-kiosk-design.md`

---

## Prerequisites for the implementing engineer

Install once on the build host:

1. **JDK 17+** (Gradle 8.x requirement). Verify: `java -version` prints 17 or newer.
2. **Android command-line tools** (`sdkmanager`) or Android Studio. Set `ANDROID_HOME`. Install `platform-tools`, `build-tools;34.0.0`, `platforms;android-34`, and `ndk;25.2.9519653`:
   ```bash
   sdkmanager "platform-tools" "build-tools;34.0.0" "platforms;android-34" "ndk;25.2.9519653"
   ```
3. **Go 1.22+**. Verify: `go version`.
4. **Physical Android TV** or emulator for manual QA. ADB-over-network helps: `adb connect <tv-ip>:5555`.

You will **not** need PhpStorm/Android Studio — the plan works entirely from the CLI via `./gradlew`.

---

## Phase 1 — Gradle bootstrap

Goal: `./gradlew tasks` succeeds from `android/`. No code yet.

### Task 1: Create root Gradle files and wrapper

**Files:**
- Create: `android/settings.gradle.kts`
- Create: `android/build.gradle.kts`
- Create: `android/gradle.properties`
- Create: `android/gradle/wrapper/gradle-wrapper.properties`
- Create: `android/gradlew`, `android/gradlew.bat`, `android/gradle/wrapper/gradle-wrapper.jar`

- [ ] **Step 1: Create `android/` directory**

```bash
mkdir -p android/gradle/wrapper
```

- [ ] **Step 2: Generate the Gradle wrapper**

You need a bootstrap Gradle install to generate the wrapper. If you don't have one:
```bash
# Ubuntu
sudo apt-get install -y gradle
# OR via sdkman
curl -s "https://get.sdkman.io" | bash && sdk install gradle 8.5
```
Then from the repo root:
```bash
cd android
gradle wrapper --gradle-version=8.5 --distribution-type=bin
```
Expected: `gradlew`, `gradlew.bat`, `gradle/wrapper/gradle-wrapper.jar`, `gradle/wrapper/gradle-wrapper.properties` appear. `./gradlew --version` prints Gradle 8.5.

- [ ] **Step 3: Write `android/settings.gradle.kts`**

```kotlin
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode = RepositoriesMode.FAIL_ON_PROJECT_REPOS
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "lanka-kiosk"

include(":app")
include(":tsnet")
include(":bridge")
```

- [ ] **Step 4: Write `android/build.gradle.kts` (root)**

```kotlin
plugins {
    id("com.android.application") version "8.2.2" apply false
    id("com.android.library")     version "8.2.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.22" apply false
}
```

- [ ] **Step 5: Write `android/gradle.properties`**

```properties
org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official

# Defaults — override via env vars at release-build time.
LANKA_SERVER_URL=http://lanka-server:3000
LANKA_TAILNET_AUTHKEY=
```

- [ ] **Step 6: Verify `./gradlew tasks` runs**

```bash
cd android
./gradlew tasks
```
Expected: Gradle downloads dependencies, then prints available tasks. No "project not found" errors. The `:app`, `:tsnet`, `:bridge` modules will be reported as missing — that's fine, we create them in following tasks.

*If Gradle errors because the sub-projects don't exist yet, temporarily comment out the `include(...)` lines in `settings.gradle.kts`, re-run, then un-comment after Task 2.*

- [ ] **Step 7: Commit**

```bash
cd ..
git add android/settings.gradle.kts android/build.gradle.kts android/gradle.properties \
        android/gradle/wrapper/gradle-wrapper.properties android/gradle/wrapper/gradle-wrapper.jar \
        android/gradlew android/gradlew.bat
git commit -m "feat(android): scaffold gradle wrapper + root build files"
```

---

### Task 2: Bootstrap the `:app` module

**Files:**
- Create: `android/app/build.gradle.kts`
- Create: `android/app/proguard-rules.pro`
- Create: `android/app/src/main/AndroidManifest.xml`
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/MainActivity.kt`
- Create: `android/app/src/main/res/layout/activity_main.xml`
- Create: `android/app/src/main/res/values/strings.xml`
- Create: `android/app/src/main/res/values/styles.xml`
- Create: `android/app/src/main/res/values/colors.xml`
- Create: `android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`

- [ ] **Step 1: Write `android/app/build.gradle.kts`**

```kotlin
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ai.lanka.kiosk"
    compileSdk = 34
    ndkVersion = "25.2.9519653"

    defaultConfig {
        applicationId = "ai.lanka.kiosk"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        buildConfigField(
            "String",
            "LANKA_SERVER_URL",
            "\"${providers.gradleProperty("LANKA_SERVER_URL").getOrElse("http://lanka-server:3000")}\""
        )
        buildConfigField(
            "String",
            "LANKA_TAILNET_AUTHKEY",
            "\"${providers.gradleProperty("LANKA_TAILNET_AUTHKEY").getOrElse("")}\""
        )
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
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
        getByName("test") {
            java.srcDirs("src/test/kotlin")
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.webkit:webkit:1.9.0")
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    testImplementation("junit:junit:4.13.2")
}
```

- [ ] **Step 2: Write `android/app/proguard-rules.pro`**

```
# Keep @JavascriptInterface methods exposed to WebView.
-keepclasseswithmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
```

- [ ] **Step 3: Write `android/app/src/main/AndroidManifest.xml`**

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET"/>
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED"/>
    <uses-permission android:name="android.permission.WAKE_LOCK"/>

    <uses-feature android:name="android.software.leanback" android:required="false"/>
    <uses-feature android:name="android.hardware.touchscreen" android:required="false"/>

    <application
        android:label="@string/app_name"
        android:icon="@mipmap/ic_launcher"
        android:allowBackup="false"
        android:usesCleartextTraffic="true"
        android:theme="@style/Theme.Lanka.Kiosk">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTask"
            android:configChanges="orientation|screenSize|keyboardHidden|navigation"
            android:screenOrientation="landscape">
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.HOME"/>
                <category android:name="android.intent.category.LEANBACK_LAUNCHER"/>
                <category android:name="android.intent.category.DEFAULT"/>
            </intent-filter>
        </activity>

    </application>
</manifest>
```

- [ ] **Step 4: Write a minimal `MainActivity.kt`**

Path: `android/app/src/main/kotlin/ai/lanka/kiosk/MainActivity.kt`

```kotlin
package ai.lanka.kiosk

import android.app.Activity
import android.os.Bundle

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
    }
}
```

- [ ] **Step 5: Write the layout**

`android/app/src/main/res/layout/activity_main.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="@android:color/black">

    <WebView
        android:id="@+id/web"
        android:layout_width="match_parent"
        android:layout_height="match_parent"/>

    <TextView
        android:id="@+id/splash"
        android:layout_width="match_parent"
        android:layout_height="match_parent"
        android:gravity="center"
        android:text="@string/splash_connecting"
        android:textColor="@android:color/white"
        android:textSize="24sp"
        android:background="@android:color/black"
        android:visibility="visible"/>
</FrameLayout>
```

- [ ] **Step 6: Write resources**

`android/app/src/main/res/values/strings.xml`:

```xml
<resources>
    <string name="app_name">Lanka</string>
    <string name="splash_connecting">Joining tailnet…</string>
    <string name="splash_loading">Loading player…</string>
    <string name="splash_error">Connection failed — retrying</string>
    <string name="override_title">Lanka kiosk — override</string>
    <string name="override_server_url">Server URL</string>
    <string name="override_device_id">Device ID</string>
    <string name="override_apply">Apply</string>
    <string name="override_reset">Reset</string>
    <string name="override_cancel">Cancel</string>
</resources>
```

`android/app/src/main/res/values/colors.xml`:

```xml
<resources>
    <color name="black">#FF000000</color>
    <color name="white">#FFFFFFFF</color>
</resources>
```

`android/app/src/main/res/values/styles.xml`:

```xml
<resources>
    <style name="Theme.Lanka.Kiosk" parent="android:Theme.Material.NoActionBar.Fullscreen">
        <item name="android:windowBackground">@android:color/black</item>
        <item name="android:windowFullscreen">true</item>
        <item name="android:windowContentOverlay">@null</item>
        <item name="android:windowLightStatusBar">false</item>
    </style>
</resources>
```

`android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@android:color/black"/>
    <foreground android:drawable="@android:color/white"/>
</adaptive-icon>
```

(A proper icon is out of scope for this plan; a solid black square is fine for v1.)

- [ ] **Step 7: Build a debug APK to verify the skeleton compiles**

```bash
cd android
./gradlew :app:assembleDebug
```
Expected: `BUILD SUCCESSFUL` and an APK at `android/app/build/outputs/apk/debug/app-debug.apk`. If Gradle can't find the NDK, double-check `ANDROID_HOME` and that `ndk;25.2.9519653` is installed.

- [ ] **Step 8: Commit**

```bash
cd ..
git add android/app
git commit -m "feat(android): :app module skeleton (empty MainActivity, manifest, theme)"
```

---

### Task 3: Update `.gitignore` for the Android build

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Read current `.gitignore`**

```bash
cat .gitignore
```
Note where the existing patterns live so you append logically.

- [ ] **Step 2: Append Android-related ignores**

Add to the bottom of `.gitignore`:

```
# Android
android/.gradle/
android/local.properties
android/**/build/
android/app/release/
android/*.jks
android/*.keystore
android/tsnet/src/main/go/go.sum
```

- [ ] **Step 3: Confirm untracked files are sensible**

```bash
git status android/
```
Expected: The wrapper files (`gradlew`, `gradle-wrapper.jar`, `gradle-wrapper.properties`, `gradlew.bat`), the module sources, and Gradle scripts are tracked. No `build/` directories, no `.gradle/`, no keystores appear.

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore(gitignore): exclude android build artifacts + keystores"
```

---

## Phase 2 — Storage classes (TDD, JVM-only)

Every storage class in this phase depends on a `KeyValueStore` interface so tests run on plain JUnit without Robolectric. Production code wires in a `SharedPreferences`-backed implementation.

### Task 4: `KeyValueStore` interface + test helper

**Files:**
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/storage/KeyValueStore.kt`
- Create: `android/app/src/test/kotlin/ai/lanka/kiosk/storage/InMemoryKeyValueStore.kt`

- [ ] **Step 1: Write the interface + production impl**

```kotlin
// android/app/src/main/kotlin/ai/lanka/kiosk/storage/KeyValueStore.kt
package ai.lanka.kiosk.storage

import android.content.Context
import android.content.SharedPreferences

interface KeyValueStore {
    fun getString(key: String): String?
    fun getLong(key: String): Long?
    fun putString(key: String, value: String)
    fun putLong(key: String, value: Long)
    fun remove(key: String)
}

class PrefsKeyValueStore(ctx: Context) : KeyValueStore {
    private val prefs: SharedPreferences =
        ctx.getSharedPreferences("lanka_kiosk", Context.MODE_PRIVATE)

    override fun getString(key: String): String? =
        if (prefs.contains(key)) prefs.getString(key, null) else null

    override fun getLong(key: String): Long? =
        if (prefs.contains(key)) prefs.getLong(key, 0L) else null

    override fun putString(key: String, value: String) {
        prefs.edit().putString(key, value).apply()
    }

    override fun putLong(key: String, value: Long) {
        prefs.edit().putLong(key, value).apply()
    }

    override fun remove(key: String) {
        prefs.edit().remove(key).apply()
    }
}
```

- [ ] **Step 2: Write the in-memory test helper**

```kotlin
// android/app/src/test/kotlin/ai/lanka/kiosk/storage/InMemoryKeyValueStore.kt
package ai.lanka.kiosk.storage

class InMemoryKeyValueStore : KeyValueStore {
    private val data = mutableMapOf<String, Any>()

    override fun getString(key: String): String? = data[key] as? String
    override fun getLong(key: String): Long? = data[key] as? Long
    override fun putString(key: String, value: String) { data[key] = value }
    override fun putLong(key: String, value: Long) { data[key] = value }
    override fun remove(key: String) { data.remove(key) }
}
```

- [ ] **Step 3: Compile**

```bash
cd android && ./gradlew :app:compileDebugKotlin :app:compileDebugUnitTestKotlin
```
Expected: `BUILD SUCCESSFUL`, no errors.

- [ ] **Step 4: Commit**

```bash
cd ..
git add android/app/src/main/kotlin/ai/lanka/kiosk/storage/KeyValueStore.kt \
        android/app/src/test/kotlin/ai/lanka/kiosk/storage/InMemoryKeyValueStore.kt
git commit -m "feat(android): KeyValueStore interface + in-memory test helper"
```

---

### Task 5: `DeviceIdStore` (TDD)

**Files:**
- Create: `android/app/src/test/kotlin/ai/lanka/kiosk/storage/DeviceIdStoreTest.kt`
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/storage/DeviceIdStore.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
// android/app/src/test/kotlin/ai/lanka/kiosk/storage/DeviceIdStoreTest.kt
package ai.lanka.kiosk.storage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class DeviceIdStoreTest {

    @Test
    fun `first call generates a valid UUID and persists it`() {
        val kv = InMemoryKeyValueStore()
        val store = DeviceIdStore(kv) { UUID.fromString("11111111-1111-1111-1111-111111111111") }

        val id = store.deviceId()

        assertEquals("11111111-1111-1111-1111-111111111111", id)
        assertEquals("11111111-1111-1111-1111-111111111111", kv.getString("deviceId"))
    }

    @Test
    fun `second call returns the same UUID`() {
        val kv = InMemoryKeyValueStore()
        val store = DeviceIdStore(kv) { UUID.randomUUID() }

        val first = store.deviceId()
        val second = store.deviceId()

        assertEquals(first, second)
    }

    @Test
    fun `corrupt stored value is regenerated`() {
        val kv = InMemoryKeyValueStore().apply { putString("deviceId", "not-a-uuid") }
        val store = DeviceIdStore(kv) { UUID.fromString("22222222-2222-2222-2222-222222222222") }

        val id = store.deviceId()

        assertEquals("22222222-2222-2222-2222-222222222222", id)
        assertEquals("22222222-2222-2222-2222-222222222222", kv.getString("deviceId"))
    }

    @Test
    fun `different store instances over the same kv see the same id`() {
        val kv = InMemoryKeyValueStore()
        val id = DeviceIdStore(kv) { UUID.randomUUID() }.deviceId()

        val rebound = DeviceIdStore(kv) { UUID.fromString("33333333-3333-3333-3333-333333333333") }
        assertEquals(id, rebound.deviceId())
        assertNotEquals("33333333-3333-3333-3333-333333333333", rebound.deviceId())
    }

    @Test
    fun `generator produces a parseable UUID`() {
        val kv = InMemoryKeyValueStore()
        val store = DeviceIdStore(kv)   // default generator
        val id = store.deviceId()
        assertTrue(runCatching { UUID.fromString(id) }.isSuccess)
    }
}
```

- [ ] **Step 2: Run the test and confirm it fails with "unresolved reference: DeviceIdStore"**

```bash
cd android && ./gradlew :app:testDebugUnitTest
```
Expected: compile failure (`unresolved reference: DeviceIdStore`).

- [ ] **Step 3: Write the minimal implementation**

```kotlin
// android/app/src/main/kotlin/ai/lanka/kiosk/storage/DeviceIdStore.kt
package ai.lanka.kiosk.storage

import java.util.UUID

class DeviceIdStore(
    private val kv: KeyValueStore,
    private val generate: () -> UUID = { UUID.randomUUID() }
) {
    fun deviceId(): String {
        val existing = kv.getString(KEY)
        if (existing != null && runCatching { UUID.fromString(existing) }.isSuccess) {
            return existing
        }
        val fresh = generate().toString()
        kv.putString(KEY, fresh)
        return fresh
    }

    companion object {
        const val KEY: String = "deviceId"
    }
}
```

- [ ] **Step 4: Run tests and confirm green**

```bash
cd android && ./gradlew :app:testDebugUnitTest
```
Expected: `DeviceIdStoreTest > ... PASSED` for all five cases.

- [ ] **Step 5: Commit**

```bash
cd ..
git add android/app/src/main/kotlin/ai/lanka/kiosk/storage/DeviceIdStore.kt \
        android/app/src/test/kotlin/ai/lanka/kiosk/storage/DeviceIdStoreTest.kt
git commit -m "feat(android): DeviceIdStore with UUID persistence + regeneration on corruption"
```

---

### Task 6: `ServerUrlResolver` (TDD)

**Files:**
- Create: `android/app/src/test/kotlin/ai/lanka/kiosk/storage/ServerUrlResolverTest.kt`
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/storage/ServerUrlResolver.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
// android/app/src/test/kotlin/ai/lanka/kiosk/storage/ServerUrlResolverTest.kt
package ai.lanka.kiosk.storage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ServerUrlResolverTest {

    @Test
    fun `returns build default when no override is set`() {
        val kv = InMemoryKeyValueStore()
        val resolver = ServerUrlResolver(kv, default = "http://lanka-server:3000")
        assertEquals("http://lanka-server:3000", resolver.resolve())
    }

    @Test
    fun `returns override when set`() {
        val kv = InMemoryKeyValueStore()
        val resolver = ServerUrlResolver(kv, default = "http://lanka-server:3000")
        resolver.setOverride("http://100.64.0.5:5100")
        assertEquals("http://100.64.0.5:5100", resolver.resolve())
    }

    @Test
    fun `clearing override restores default`() {
        val kv = InMemoryKeyValueStore()
        val resolver = ServerUrlResolver(kv, default = "http://lanka-server:3000")
        resolver.setOverride("http://bogus:1234")
        resolver.clearOverride()
        assertEquals("http://lanka-server:3000", resolver.resolve())
    }

    @Test
    fun `reading override on a new instance sees persisted value`() {
        val kv = InMemoryKeyValueStore()
        ServerUrlResolver(kv, default = "http://lanka-server:3000")
            .setOverride("http://persisted:9999")
        val second = ServerUrlResolver(kv, default = "http://lanka-server:3000")
        assertEquals("http://persisted:9999", second.resolve())
    }

    @Test
    fun `getOverrideOrNull returns null when unset`() {
        val kv = InMemoryKeyValueStore()
        val resolver = ServerUrlResolver(kv, default = "http://lanka-server:3000")
        assertNull(resolver.getOverrideOrNull())
    }

    @Test
    fun `empty override string is treated as no override`() {
        val kv = InMemoryKeyValueStore()
        val resolver = ServerUrlResolver(kv, default = "http://lanka-server:3000")
        resolver.setOverride("")
        assertEquals("http://lanka-server:3000", resolver.resolve())
    }
}
```

- [ ] **Step 2: Run tests, confirm they fail (unresolved reference)**

```bash
cd android && ./gradlew :app:testDebugUnitTest
```
Expected: compile failure.

- [ ] **Step 3: Write the implementation**

```kotlin
// android/app/src/main/kotlin/ai/lanka/kiosk/storage/ServerUrlResolver.kt
package ai.lanka.kiosk.storage

class ServerUrlResolver(
    private val kv: KeyValueStore,
    private val default: String
) {
    fun resolve(): String {
        val override = kv.getString(KEY_OVERRIDE)
        return if (!override.isNullOrEmpty()) override else default
    }

    fun getOverrideOrNull(): String? = kv.getString(KEY_OVERRIDE)

    fun setOverride(url: String) {
        if (url.isEmpty()) kv.remove(KEY_OVERRIDE) else kv.putString(KEY_OVERRIDE, url)
    }

    fun clearOverride() {
        kv.remove(KEY_OVERRIDE)
    }

    companion object {
        const val KEY_OVERRIDE: String = "serverUrlOverride"
    }
}
```

- [ ] **Step 4: Run tests, confirm green**

```bash
cd android && ./gradlew :app:testDebugUnitTest
```
Expected: all `ServerUrlResolverTest` cases pass.

- [ ] **Step 5: Commit**

```bash
cd ..
git add android/app/src/main/kotlin/ai/lanka/kiosk/storage/ServerUrlResolver.kt \
        android/app/src/test/kotlin/ai/lanka/kiosk/storage/ServerUrlResolverTest.kt
git commit -m "feat(android): ServerUrlResolver with override + clear"
```

---

### Task 7: `HeartbeatStore` (TDD)

**Files:**
- Create: `android/app/src/test/kotlin/ai/lanka/kiosk/storage/HeartbeatStoreTest.kt`
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/storage/HeartbeatStore.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
// android/app/src/test/kotlin/ai/lanka/kiosk/storage/HeartbeatStoreTest.kt
package ai.lanka.kiosk.storage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HeartbeatStoreTest {

    @Test
    fun `write and read round-trip returns the timestamp`() {
        val kv = InMemoryKeyValueStore()
        val store = HeartbeatStore(kv)
        store.write(1_700_000_000_000L)
        assertEquals(1_700_000_000_000L, store.read())
    }

    @Test
    fun `read with no prior write returns null`() {
        val kv = InMemoryKeyValueStore()
        val store = HeartbeatStore(kv)
        assertEquals(null, store.read())
    }

    @Test
    fun `isStale returns false when heartbeat is recent`() {
        val kv = InMemoryKeyValueStore()
        val store = HeartbeatStore(kv)
        store.write(1_700_000_000_000L)
        assertFalse(store.isStale(now = 1_700_000_001_000L, thresholdMs = 5 * 60_000))
    }

    @Test
    fun `isStale returns true when heartbeat is older than threshold`() {
        val kv = InMemoryKeyValueStore()
        val store = HeartbeatStore(kv)
        store.write(1_700_000_000_000L)
        assertTrue(store.isStale(now = 1_700_000_000_000L + 5 * 60_000 + 1, thresholdMs = 5 * 60_000))
    }

    @Test
    fun `isStale returns true when no heartbeat was ever written`() {
        val kv = InMemoryKeyValueStore()
        val store = HeartbeatStore(kv)
        assertTrue(store.isStale(now = 1_700_000_000_000L, thresholdMs = 5 * 60_000))
    }

    @Test
    fun `isStale is inclusive of threshold — exact match is NOT stale`() {
        val kv = InMemoryKeyValueStore()
        val store = HeartbeatStore(kv)
        store.write(1_700_000_000_000L)
        assertFalse(store.isStale(now = 1_700_000_000_000L + 5 * 60_000, thresholdMs = 5 * 60_000))
    }
}
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd android && ./gradlew :app:testDebugUnitTest
```

- [ ] **Step 3: Write the implementation**

```kotlin
// android/app/src/main/kotlin/ai/lanka/kiosk/storage/HeartbeatStore.kt
package ai.lanka.kiosk.storage

class HeartbeatStore(private val kv: KeyValueStore) {
    fun write(tsMillis: Long) {
        kv.putLong(KEY, tsMillis)
    }

    fun read(): Long? = kv.getLong(KEY)

    fun isStale(now: Long, thresholdMs: Long): Boolean {
        val last = read() ?: return true
        return (now - last) > thresholdMs
    }

    companion object {
        const val KEY: String = "heartbeat"
    }
}
```

- [ ] **Step 4: Run, confirm green, commit**

```bash
cd android && ./gradlew :app:testDebugUnitTest
cd ..
git add android/app/src/main/kotlin/ai/lanka/kiosk/storage/HeartbeatStore.kt \
        android/app/src/test/kotlin/ai/lanka/kiosk/storage/HeartbeatStoreTest.kt
git commit -m "feat(android): HeartbeatStore with stale detection"
```

---

## Phase 3 — Kiosk mechanics (pure logic, TDD)

### Task 8: `KeyEventHandler` (TDD)

**Files:**
- Create: `android/app/src/test/kotlin/ai/lanka/kiosk/kiosk/KeyEventHandlerTest.kt`
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/kiosk/KeyEventHandler.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
// android/app/src/test/kotlin/ai/lanka/kiosk/kiosk/KeyEventHandlerTest.kt
package ai.lanka.kiosk.kiosk

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Test

class KeyEventHandlerTest {

    private val handler = KeyEventHandler()

    @Test fun `swallows BACK`() =
        assertEquals(KeyDisposition.SWALLOW, handler.classify(KeyEvent.KEYCODE_BACK))

    @Test fun `swallows D-pad CENTER`() =
        assertEquals(KeyDisposition.SWALLOW, handler.classify(KeyEvent.KEYCODE_DPAD_CENTER))

    @Test fun `swallows D-pad directions`() {
        assertEquals(KeyDisposition.SWALLOW, handler.classify(KeyEvent.KEYCODE_DPAD_UP))
        assertEquals(KeyDisposition.SWALLOW, handler.classify(KeyEvent.KEYCODE_DPAD_DOWN))
        assertEquals(KeyDisposition.SWALLOW, handler.classify(KeyEvent.KEYCODE_DPAD_LEFT))
        assertEquals(KeyDisposition.SWALLOW, handler.classify(KeyEvent.KEYCODE_DPAD_RIGHT))
    }

    @Test fun `swallows MENU`() =
        assertEquals(KeyDisposition.SWALLOW, handler.classify(KeyEvent.KEYCODE_MENU))

    @Test fun `swallows MEDIA_PLAY_PAUSE`() =
        assertEquals(KeyDisposition.SWALLOW, handler.classify(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE))

    @Test fun `passes through volume keys`() {
        assertEquals(KeyDisposition.PASS_THROUGH, handler.classify(KeyEvent.KEYCODE_VOLUME_UP))
        assertEquals(KeyDisposition.PASS_THROUGH, handler.classify(KeyEvent.KEYCODE_VOLUME_DOWN))
        assertEquals(KeyDisposition.PASS_THROUGH, handler.classify(KeyEvent.KEYCODE_VOLUME_MUTE))
    }

    @Test fun `passes through unknown keys`() {
        assertEquals(KeyDisposition.PASS_THROUGH, handler.classify(KeyEvent.KEYCODE_A))
        assertEquals(KeyDisposition.PASS_THROUGH, handler.classify(KeyEvent.KEYCODE_UNKNOWN))
    }
}
```

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Write the implementation**

```kotlin
// android/app/src/main/kotlin/ai/lanka/kiosk/kiosk/KeyEventHandler.kt
package ai.lanka.kiosk.kiosk

import android.view.KeyEvent

enum class KeyDisposition { SWALLOW, PASS_THROUGH }

class KeyEventHandler {
    fun classify(keyCode: Int): KeyDisposition = when (keyCode) {
        KeyEvent.KEYCODE_BACK,
        KeyEvent.KEYCODE_DPAD_CENTER,
        KeyEvent.KEYCODE_DPAD_UP,
        KeyEvent.KEYCODE_DPAD_DOWN,
        KeyEvent.KEYCODE_DPAD_LEFT,
        KeyEvent.KEYCODE_DPAD_RIGHT,
        KeyEvent.KEYCODE_MENU,
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> KeyDisposition.SWALLOW
        else -> KeyDisposition.PASS_THROUGH
    }
}
```

- [ ] **Step 4: Run, confirm green, commit**

```bash
cd android && ./gradlew :app:testDebugUnitTest
cd ..
git add android/app/src/main/kotlin/ai/lanka/kiosk/kiosk/KeyEventHandler.kt \
        android/app/src/test/kotlin/ai/lanka/kiosk/kiosk/KeyEventHandlerTest.kt
git commit -m "feat(android): KeyEventHandler classifies SWALLOW/PASS_THROUGH"
```

---

### Task 9: `LongPressDetector` (TDD)

Detects a 5-second hold of D-pad CENTER to open the override dialog. Pure logic, injected clock.

**Files:**
- Create: `android/app/src/test/kotlin/ai/lanka/kiosk/kiosk/LongPressDetectorTest.kt`
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/kiosk/LongPressDetector.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
// android/app/src/test/kotlin/ai/lanka/kiosk/kiosk/LongPressDetectorTest.kt
package ai.lanka.kiosk.kiosk

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Test

class LongPressDetectorTest {

    private class Clock(var t: Long = 0) { val now: () -> Long = { t } }

    @Test
    fun `fires after 5 seconds of continuous CENTER hold`() {
        val clock = Clock(1000)
        var fired = 0
        val d = LongPressDetector(holdMs = 5000, triggerKey = KeyEvent.KEYCODE_DPAD_CENTER,
                                  now = clock.now) { fired++ }

        d.onKeyDown(KeyEvent.KEYCODE_DPAD_CENTER)          // t = 1000
        clock.t = 1000 + 4999
        assertEquals(0, fired)
        clock.t = 1000 + 5000
        d.tick()
        assertEquals(1, fired)
    }

    @Test
    fun `does not fire on short press`() {
        val clock = Clock(0)
        var fired = 0
        val d = LongPressDetector(holdMs = 5000, triggerKey = KeyEvent.KEYCODE_DPAD_CENTER,
                                  now = clock.now) { fired++ }

        d.onKeyDown(KeyEvent.KEYCODE_DPAD_CENTER)
        clock.t = 100
        d.onKeyUp(KeyEvent.KEYCODE_DPAD_CENTER)
        clock.t = 10_000
        d.tick()
        assertEquals(0, fired)
    }

    @Test
    fun `cancels on different key while holding`() {
        val clock = Clock(0)
        var fired = 0
        val d = LongPressDetector(holdMs = 5000, triggerKey = KeyEvent.KEYCODE_DPAD_CENTER,
                                  now = clock.now) { fired++ }

        d.onKeyDown(KeyEvent.KEYCODE_DPAD_CENTER)
        clock.t = 1000
        d.onKeyDown(KeyEvent.KEYCODE_DPAD_UP)          // interleaved press cancels the hold
        clock.t = 10_000
        d.tick()
        assertEquals(0, fired)
    }

    @Test
    fun `re-arms after a cancelled hold if user starts over`() {
        val clock = Clock(0)
        var fired = 0
        val d = LongPressDetector(holdMs = 5000, triggerKey = KeyEvent.KEYCODE_DPAD_CENTER,
                                  now = clock.now) { fired++ }

        d.onKeyDown(KeyEvent.KEYCODE_DPAD_CENTER)
        d.onKeyUp(KeyEvent.KEYCODE_DPAD_CENTER)        // short press cancels
        clock.t = 100
        d.onKeyDown(KeyEvent.KEYCODE_DPAD_CENTER)      // restart
        clock.t = 100 + 5000
        d.tick()
        assertEquals(1, fired)
    }

    @Test
    fun `tick without a press does nothing`() {
        val clock = Clock(0)
        var fired = 0
        val d = LongPressDetector(holdMs = 5000, triggerKey = KeyEvent.KEYCODE_DPAD_CENTER,
                                  now = clock.now) { fired++ }
        clock.t = 10_000
        d.tick()
        assertEquals(0, fired)
    }

    @Test
    fun `only fires once per hold`() {
        val clock = Clock(0)
        var fired = 0
        val d = LongPressDetector(holdMs = 5000, triggerKey = KeyEvent.KEYCODE_DPAD_CENTER,
                                  now = clock.now) { fired++ }

        d.onKeyDown(KeyEvent.KEYCODE_DPAD_CENTER)
        clock.t = 5000
        d.tick()
        clock.t = 6000
        d.tick()
        clock.t = 7000
        d.tick()
        assertEquals(1, fired)
    }
}
```

- [ ] **Step 2: Run, confirm compile failure**

- [ ] **Step 3: Write the implementation**

```kotlin
// android/app/src/main/kotlin/ai/lanka/kiosk/kiosk/LongPressDetector.kt
package ai.lanka.kiosk.kiosk

class LongPressDetector(
    private val holdMs: Long,
    private val triggerKey: Int,
    private val now: () -> Long,
    private val onFire: () -> Unit
) {
    private var pressStart: Long? = null
    private var fired: Boolean = false

    fun onKeyDown(keyCode: Int) {
        if (keyCode == triggerKey) {
            pressStart = now()
            fired = false
            return
        }
        // any other key press cancels an in-flight hold
        pressStart = null
    }

    fun onKeyUp(keyCode: Int) {
        if (keyCode == triggerKey) {
            pressStart = null
        }
    }

    fun tick() {
        val start = pressStart ?: return
        if (fired) return
        if (now() - start >= holdMs) {
            fired = true
            onFire()
        }
    }
}
```

- [ ] **Step 4: Run, commit**

```bash
cd android && ./gradlew :app:testDebugUnitTest
cd ..
git add android/app/src/main/kotlin/ai/lanka/kiosk/kiosk/LongPressDetector.kt \
        android/app/src/test/kotlin/ai/lanka/kiosk/kiosk/LongPressDetectorTest.kt
git commit -m "feat(android): LongPressDetector with clock-injected hold detection"
```

---

### Task 10: `KioskFlags.apply` helper

No unit test — pure UI side-effects against `Window` / `WindowInsetsController`.

**Files:**
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/kiosk/KioskFlags.kt`

- [ ] **Step 1: Write the helper**

```kotlin
// android/app/src/main/kotlin/ai/lanka/kiosk/kiosk/KioskFlags.kt
package ai.lanka.kiosk.kiosk

import android.app.Activity
import android.os.Build
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager

object KioskFlags {
    fun apply(activity: Activity) {
        val window = activity.window
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            val controller = window.insetsController
            controller?.hide(WindowInsets.Type.systemBars())
            controller?.systemBarsBehavior =
                WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility =
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_FULLSCREEN
        }
    }
}
```

- [ ] **Step 2: Compile to confirm**

```bash
cd android && ./gradlew :app:compileDebugKotlin
```
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit**

```bash
cd ..
git add android/app/src/main/kotlin/ai/lanka/kiosk/kiosk/KioskFlags.kt
git commit -m "feat(android): KioskFlags.apply for immersive + keep-screen-on"
```

---

## Phase 4 — Native bridge

### Task 11: `NativeDeviceBridge` JavaScript interface

**Files:**
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/bridge/NativeDeviceBridge.kt`

No JUnit tests — this class is pure glue (`@JavascriptInterface` methods delegate to storage classes that are already tested). Manual QA covers it.

- [ ] **Step 1: Write the bridge**

```kotlin
// android/app/src/main/kotlin/ai/lanka/kiosk/bridge/NativeDeviceBridge.kt
package ai.lanka.kiosk.bridge

import android.os.Build
import android.webkit.JavascriptInterface
import android.webkit.WebView
import ai.lanka.kiosk.BuildConfig
import ai.lanka.kiosk.storage.DeviceIdStore
import ai.lanka.kiosk.storage.ServerUrlResolver
import org.json.JSONObject

class NativeDeviceBridge(
    private val webView: WebView,
    private val deviceIdStore: DeviceIdStore,
    private val serverUrlResolver: ServerUrlResolver
) {
    @JavascriptInterface
    fun deviceId(): String = deviceIdStore.deviceId()

    @JavascriptInterface
    fun reload() {
        webView.post { webView.reload() }
    }

    @JavascriptInterface
    fun version(): String = JSONObject(
        mapOf(
            "app"   to BuildConfig.VERSION_NAME,
            "os"    to "Android ${Build.VERSION.RELEASE}",
            "model" to "${Build.MANUFACTURER} ${Build.MODEL}"
        )
    ).toString()

    @JavascriptInterface
    fun serverUrl(): String = serverUrlResolver.resolve()
}
```

- [ ] **Step 2: Compile**

```bash
cd android && ./gradlew :app:compileDebugKotlin
```

- [ ] **Step 3: Commit**

```bash
cd ..
git add android/app/src/main/kotlin/ai/lanka/kiosk/bridge/NativeDeviceBridge.kt
git commit -m "feat(android): NativeDeviceBridge @JavascriptInterface"
```

---

## Phase 5 — WebView wiring (no tsnet yet; server URL hardcoded for smoke test)

### Task 12: `LankaChromeClient` (forwards `console.log` to logcat)

**Files:**
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/LankaChromeClient.kt`

- [ ] **Step 1: Write the class**

```kotlin
// android/app/src/main/kotlin/ai/lanka/kiosk/LankaChromeClient.kt
package ai.lanka.kiosk

import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient

class LankaChromeClient : WebChromeClient() {
    override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
        val tag = "LankaPlayer"
        val text = "${msg.sourceId()}:${msg.lineNumber()} ${msg.message()}"
        when (msg.messageLevel()) {
            ConsoleMessage.MessageLevel.ERROR   -> Log.e(tag, text)
            ConsoleMessage.MessageLevel.WARNING -> Log.w(tag, text)
            ConsoleMessage.MessageLevel.DEBUG   -> Log.d(tag, text)
            else                                -> Log.i(tag, text)
        }
        return true
    }
}
```

- [ ] **Step 2: Compile + commit**

```bash
cd android && ./gradlew :app:compileDebugKotlin
cd ..
git add android/app/src/main/kotlin/ai/lanka/kiosk/LankaChromeClient.kt
git commit -m "feat(android): LankaChromeClient forwards console.log to logcat"
```

---

### Task 13: `LankaWebViewClient` (direct-dial stub; SOCKS routing in Task 24)

For Phase 5 the WebView talks to the network directly (your laptop's dev server). Task 24 replaces the HTTP client with one that goes through the SOCKS proxy.

**Files:**
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/LankaWebViewClient.kt`

- [ ] **Step 1: Write a minimal client**

```kotlin
// android/app/src/main/kotlin/ai/lanka/kiosk/LankaWebViewClient.kt
package ai.lanka.kiosk

import android.webkit.WebView
import android.webkit.WebViewClient

class LankaWebViewClient : WebViewClient() {
    // Phase 5: default behavior (direct network) is what we want for smoke testing.
    // Phase 7 Task 24 overrides shouldInterceptRequest to route via tsnet's SOCKS proxy.
    override fun onReceivedError(
        view: WebView?,
        errorCode: Int,
        description: String?,
        failingUrl: String?
    ) {
        android.util.Log.e("LankaWebView", "load error $errorCode $description — $failingUrl")
    }
}
```

- [ ] **Step 2: Compile + commit**

```bash
cd android && ./gradlew :app:compileDebugKotlin
cd ..
git add android/app/src/main/kotlin/ai/lanka/kiosk/LankaWebViewClient.kt
git commit -m "feat(android): LankaWebViewClient skeleton (direct-dial for Phase 5)"
```

---

### Task 14: Flesh out `MainActivity` (hardcoded URL, no tsnet)

Wire everything together: kiosk flags, WebView config, bridge injection, key dispatch, splash, `loadUrl`.

**Files:**
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/MainActivity.kt`

- [ ] **Step 1: Replace MainActivity with the full wiring**

```kotlin
package ai.lanka.kiosk

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.TextView
import ai.lanka.kiosk.bridge.NativeDeviceBridge
import ai.lanka.kiosk.kiosk.KeyDisposition
import ai.lanka.kiosk.kiosk.KeyEventHandler
import ai.lanka.kiosk.kiosk.KioskFlags
import ai.lanka.kiosk.kiosk.LongPressDetector
import ai.lanka.kiosk.storage.DeviceIdStore
import ai.lanka.kiosk.storage.PrefsKeyValueStore
import ai.lanka.kiosk.storage.ServerUrlResolver

class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var splash: TextView
    private lateinit var keyEvents: KeyEventHandler
    private lateinit var longPress: LongPressDetector
    private lateinit var deviceIdStore: DeviceIdStore
    private lateinit var serverUrlResolver: ServerUrlResolver
    private val handler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        KioskFlags.apply(this)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.web)
        splash  = findViewById(R.id.splash)

        val kv = PrefsKeyValueStore(applicationContext)
        deviceIdStore     = DeviceIdStore(kv)
        serverUrlResolver = ServerUrlResolver(kv, default = BuildConfig.LANKA_SERVER_URL)

        keyEvents = KeyEventHandler()
        longPress = LongPressDetector(
            holdMs = 5000,
            triggerKey = KeyEvent.KEYCODE_DPAD_CENTER,
            now = { System.currentTimeMillis() }
        ) { /* Task 26 fills this in */ }

        handler.post(object : Runnable {
            override fun run() {
                longPress.tick()
                handler.postDelayed(this, 200)
            }
        })

        configureWebView()
        showSplash(getString(R.string.splash_loading))

        // Phase 5: no tsnet; go straight to loadUrl. Replaced in Phase 7 Task 25.
        val url = serverUrlResolver.resolve() + "/player?deviceId=" + deviceIdStore.deviceId()
        webView.loadUrl(url)
        hideSplash()
    }

    private fun configureWebView() {
        webView.setBackgroundColor(Color.BLACK)
        webView.webViewClient   = LankaWebViewClient()
        webView.webChromeClient = LankaChromeClient()
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = "$userAgentString LankaKiosk/${BuildConfig.VERSION_NAME}"
        }
        webView.addJavascriptInterface(
            NativeDeviceBridge(webView, deviceIdStore, serverUrlResolver),
            "NativeDevice"
        )
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) longPress.onKeyDown(event.keyCode)
        if (event.action == KeyEvent.ACTION_UP)   longPress.onKeyUp(event.keyCode)

        return when (keyEvents.classify(event.keyCode)) {
            KeyDisposition.SWALLOW      -> true
            KeyDisposition.PASS_THROUGH -> super.dispatchKeyEvent(event)
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) KioskFlags.apply(this)
    }

    private fun showSplash(text: String) {
        splash.text = text
        splash.visibility = View.VISIBLE
    }

    private fun hideSplash() {
        splash.visibility = View.GONE
    }
}
```

- [ ] **Step 2: Build a debug APK**

```bash
cd android && ./gradlew :app:assembleDebug
```
Expected: `BUILD SUCCESSFUL`. APK at `app/build/outputs/apk/debug/app-debug.apk`.

- [ ] **Step 3: Smoke-install against a running dev server**

Prereqs:
- `pnpm dev` running on your laptop bound to a tailnet-reachable IP (e.g., `HOST=0.0.0.0 PORT=5100 pnpm dev`). For the local emulator, `10.0.2.2` is the host's loopback from the emulator's perspective.
- Set the override for the smoke test via a rebuild with a dev URL: pass `-PLANKA_SERVER_URL=http://10.0.2.2:5100` to Gradle.

```bash
./gradlew -PLANKA_SERVER_URL=http://10.0.2.2:5100 :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n ai.lanka.kiosk/.MainActivity
adb logcat -s LankaPlayer LankaWebView
```
Expected: splash briefly shows, WebView loads the player page, logcat shows no red errors. Device appears in the dashboard's unclaimed tray.

- [ ] **Step 4: Commit**

```bash
cd ..
git add android/app/src/main/kotlin/ai/lanka/kiosk/MainActivity.kt
git commit -m "feat(android): MainActivity wires WebView + bridge + key dispatch"
```

---

## Phase 6 — Boot receiver + watchdog

### Task 15: `BootReceiver`

**Files:**
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/BootReceiver.kt`
- Modify: `android/app/src/main/AndroidManifest.xml`

- [ ] **Step 1: Write the receiver**

```kotlin
// android/app/src/main/kotlin/ai/lanka/kiosk/BootReceiver.kt
package ai.lanka.kiosk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val launch = Intent(ctx, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        ctx.startActivity(launch)
    }
}
```

- [ ] **Step 2: Register the receiver in the manifest**

Inside the `<application>` element, add before the closing `</application>`:

```xml
<receiver android:name=".BootReceiver" android:exported="true">
    <intent-filter>
        <action android:name="android.intent.action.BOOT_COMPLETED"/>
    </intent-filter>
</receiver>
```

- [ ] **Step 3: Build**

```bash
cd android && ./gradlew :app:assembleDebug
```

- [ ] **Step 4: Commit**

```bash
cd ..
git add android/app/src/main/kotlin/ai/lanka/kiosk/BootReceiver.kt \
        android/app/src/main/AndroidManifest.xml
git commit -m "feat(android): BootReceiver auto-launches MainActivity on BOOT_COMPLETED"
```

---

### Task 16: `HeartbeatWriter`

**Files:**
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/watchdog/HeartbeatWriter.kt`
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/MainActivity.kt`

- [ ] **Step 1: Write the helper**

```kotlin
// android/app/src/main/kotlin/ai/lanka/kiosk/watchdog/HeartbeatWriter.kt
package ai.lanka.kiosk.watchdog

import android.os.Handler
import android.os.Looper
import ai.lanka.kiosk.storage.HeartbeatStore

class HeartbeatWriter(
    private val store: HeartbeatStore,
    private val intervalMs: Long = 30_000
) {
    private val handler = Handler(Looper.getMainLooper())
    private val loop = object : Runnable {
        override fun run() {
            store.write(System.currentTimeMillis())
            handler.postDelayed(this, intervalMs)
        }
    }

    fun start() {
        handler.removeCallbacks(loop)
        handler.post(loop)
    }

    fun stop() {
        handler.removeCallbacks(loop)
    }
}
```

- [ ] **Step 2: Start the writer from `MainActivity.onCreate`**

In `MainActivity.kt`, add:

```kotlin
import ai.lanka.kiosk.storage.HeartbeatStore
import ai.lanka.kiosk.watchdog.HeartbeatWriter
```

Declare the field near the other `lateinit`s:

```kotlin
private lateinit var heartbeatWriter: HeartbeatWriter
```

In `onCreate`, after `serverUrlResolver = ...`, add:

```kotlin
heartbeatWriter = HeartbeatWriter(HeartbeatStore(kv))
heartbeatWriter.start()
```

And override `onDestroy`:

```kotlin
override fun onDestroy() {
    heartbeatWriter.stop()
    super.onDestroy()
}
```

- [ ] **Step 3: Build + commit**

```bash
cd android && ./gradlew :app:assembleDebug
cd ..
git add android/app/src/main/kotlin/ai/lanka/kiosk/watchdog/HeartbeatWriter.kt \
        android/app/src/main/kotlin/ai/lanka/kiosk/MainActivity.kt
git commit -m "feat(android): HeartbeatWriter posts liveness every 30s from MainActivity"
```

---

### Task 17: `WatchdogWorker`

WorkManager `PeriodicWorkRequest` that restarts the Activity when the heartbeat is stale.

**Files:**
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/watchdog/WatchdogWorker.kt`
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/MainActivity.kt`

- [ ] **Step 1: Write the worker**

```kotlin
// android/app/src/main/kotlin/ai/lanka/kiosk/watchdog/WatchdogWorker.kt
package ai.lanka.kiosk.watchdog

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import ai.lanka.kiosk.MainActivity
import ai.lanka.kiosk.storage.HeartbeatStore
import ai.lanka.kiosk.storage.PrefsKeyValueStore
import java.util.concurrent.TimeUnit

class WatchdogWorker(
    ctx: Context,
    params: WorkerParameters
) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val heartbeat = HeartbeatStore(PrefsKeyValueStore(applicationContext))
        if (heartbeat.isStale(now = System.currentTimeMillis(), thresholdMs = STALE_MS)) {
            Log.w("LankaWatchdog", "heartbeat stale — restarting MainActivity")
            val restart = Intent(applicationContext, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            }
            applicationContext.startActivity(restart)
        }
        return Result.success()
    }

    companion object {
        const val NAME = "lanka-watchdog"
        const val STALE_MS: Long = 5 * 60_000

        fun schedule(ctx: Context) {
            val req = PeriodicWorkRequestBuilder<WatchdogWorker>(
                repeatInterval = 15,
                repeatIntervalTimeUnit = TimeUnit.MINUTES
            )
                .setConstraints(Constraints.Builder().build())
                .build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                req
            )
        }
    }
}
```

- [ ] **Step 2: Schedule it from `MainActivity.onCreate`**

Add the import:

```kotlin
import ai.lanka.kiosk.watchdog.WatchdogWorker
```

At the end of `onCreate` (after `webView.loadUrl(...)` and `hideSplash()`):

```kotlin
WatchdogWorker.schedule(applicationContext)
```

- [ ] **Step 3: Build**

```bash
cd android && ./gradlew :app:assembleDebug
```

- [ ] **Step 4: Commit**

```bash
cd ..
git add android/app/src/main/kotlin/ai/lanka/kiosk/watchdog/WatchdogWorker.kt \
        android/app/src/main/kotlin/ai/lanka/kiosk/MainActivity.kt
git commit -m "feat(android): WatchdogWorker restarts MainActivity on stale heartbeat"
```

---

## Phase 7 — tsnet integration

This is the riskiest phase. Go + NDK cross-compile + JNI has many configuration details that vary by Go and NDK version. Budget extra time. Keep a scratch log of what works.

### Task 18: `:tsnet` module bootstrap + hello-world JNI round-trip

**Files:**
- Create: `android/tsnet/build.gradle.kts`
- Create: `android/tsnet/src/main/AndroidManifest.xml`
- Create: `android/tsnet/src/main/go/go.mod`
- Create: `android/tsnet/src/main/go/lanka_tsnet.go`
- Create: `android/tsnet/src/main/kotlin/ai/lanka/tsnet/TsnetService.kt`
- Create: `android/tsnet/src/main/kotlin/ai/lanka/tsnet/SocksProxy.kt`
- Modify: `android/app/build.gradle.kts` (add dependency on `:tsnet`)
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/MainActivity.kt` (call into TsnetService stub)

- [ ] **Step 1: Create the module directory structure**

```bash
mkdir -p android/tsnet/src/main/{go,kotlin/ai/lanka/tsnet,jniLibs}
```

- [ ] **Step 2: Write `android/tsnet/build.gradle.kts`**

```kotlin
import org.gradle.internal.os.OperatingSystem

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ai.lanka.tsnet"
    compileSdk = 34
    ndkVersion = "25.2.9519653"

    defaultConfig {
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions { jvmTarget = "17" }

    sourceSets {
        getByName("main") {
            java.srcDirs("src/main/kotlin")
            jniLibs.srcDirs("src/main/jniLibs")
        }
    }
}

// --- Go cross-compile tasks -------------------------------------------------

val goSrcDir = layout.projectDirectory.dir("src/main/go")
val jniLibsDir = layout.projectDirectory.dir("src/main/jniLibs")

data class Target(val abi: String, val goArch: String, val clang: String)

val targets = listOf(
    Target("arm64-v8a",   "arm64", "aarch64-linux-android24-clang"),
    Target("armeabi-v7a", "arm",   "armv7a-linux-androideabi24-clang"),
    Target("x86_64",      "amd64", "x86_64-linux-android24-clang")
)

fun ndkToolchainDir(): String {
    val ndkRoot = android.ndkDirectory.absolutePath
    val hostTag = when {
        OperatingSystem.current().isLinux   -> "linux-x86_64"
        OperatingSystem.current().isMacOsX  -> "darwin-x86_64"
        OperatingSystem.current().isWindows -> "windows-x86_64"
        else -> error("unsupported build host")
    }
    return "$ndkRoot/toolchains/llvm/prebuilt/$hostTag/bin"
}

val buildGoTasks = targets.map { t ->
    tasks.register<Exec>("buildGo${t.abi.replace("-", "")}") {
        group = "build"
        description = "Cross-compile lanka_tsnet for ${t.abi}"
        workingDir = goSrcDir.asFile
        val outDir = jniLibsDir.dir(t.abi).asFile
        outputs.dir(outDir)
        inputs.dir(goSrcDir)
        doFirst { outDir.mkdirs() }
        environment(
            "CGO_ENABLED" to "1",
            "GOOS"   to "android",
            "GOARCH" to t.goArch,
            "CC"     to "${ndkToolchainDir()}/${t.clang}"
        )
        commandLine(
            "go", "build",
            "-buildmode=c-shared",
            "-o", "${outDir.absolutePath}/liblanka_tsnet.so",
            "."
        )
    }
}

tasks.register("buildGoAll") {
    group = "build"
    description = "Cross-compile lanka_tsnet for all ABIs"
    dependsOn(buildGoTasks)
}

tasks.named("preBuild") {
    dependsOn("buildGoAll")
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
}
```

- [ ] **Step 3: Write a stub manifest for the library module**

```xml
<!-- android/tsnet/src/main/AndroidManifest.xml -->
<manifest xmlns:android="http://schemas.android.com/apk/res/android"/>
```

- [ ] **Step 4: Initialize the Go module**

```bash
cd android/tsnet/src/main/go
cat > go.mod <<'EOF'
module ai.lanka/tsnet

go 1.22
EOF
```

- [ ] **Step 5: Write a minimal `lanka_tsnet.go` that exports one function**

```go
// android/tsnet/src/main/go/lanka_tsnet.go
package main

import "C"

//export HelloTsnet
func HelloTsnet() *C.char {
    return C.CString("hello from go")
}

func main() {}
```

- [ ] **Step 6: Write the Kotlin JNI wrapper (hello-world version)**

```kotlin
// android/tsnet/src/main/kotlin/ai/lanka/tsnet/TsnetService.kt
package ai.lanka.tsnet

object TsnetService {
    init { System.loadLibrary("lanka_tsnet") }

    external fun helloTsnet(): String

    // Real implementation ships in Task 20+.
}
```

Note: Go's `//export` generates a header file but the Kotlin `external fun` will bind via JNI function-name conventions. For a single cross-platform function, Go's default C-shared export is **not** a JNI-callable symbol — we need explicit JNI wrappers. Two paths exist:

1. Write a tiny C shim that wraps Go's exported C function and exposes `Java_ai_lanka_tsnet_TsnetService_helloTsnet`. Built alongside the Go code.
2. Use `gomobile bind` (the official Android binding tool) — much heavier, produces an `.aar`.

**Go path (option 1) preferred** — less tooling, more control. Add the shim:

`android/tsnet/src/main/go/jni_shim.c`:

```c
#include <jni.h>
#include <string.h>

extern char* HelloTsnet();

JNIEXPORT jstring JNICALL
Java_ai_lanka_tsnet_TsnetService_helloTsnet(JNIEnv *env, jobject thiz) {
    char *msg = HelloTsnet();
    jstring out = (*env)->NewStringUTF(env, msg);
    // HelloTsnet returns a Go-allocated C string. Freeing it requires a Go-side free;
    // for the hello-world case leak is tolerable (called once). Task 20 introduces proper
    // memory management.
    return out;
}
```

Add the shim to the Go compilation by importing it via CGO. Update `lanka_tsnet.go`:

```go
package main

/*
#include <stdlib.h>
#include <string.h>
*/
import "C"

//export HelloTsnet
func HelloTsnet() *C.char {
    return C.CString("hello from go")
}

func main() {}
```

And include the shim C file in the Go package by **placing `jni_shim.c` in the same package directory** (`android/tsnet/src/main/go/jni_shim.c`). The Go toolchain automatically compiles sibling `.c` files in a CGO package.

- [ ] **Step 7: Write the SocksProxy constants file (populated later, placeholder now)**

```kotlin
// android/tsnet/src/main/kotlin/ai/lanka/tsnet/SocksProxy.kt
package ai.lanka.tsnet

object SocksProxy {
    const val HOST: String = "127.0.0.1"
    const val PORT: Int = 1055
}
```

- [ ] **Step 8: Wire the `:app` module to depend on `:tsnet`**

In `android/app/build.gradle.kts`, add to the `dependencies { }` block:

```kotlin
implementation(project(":tsnet"))
```

- [ ] **Step 9: Build all ABIs**

```bash
cd android && ./gradlew :tsnet:buildGoAll
```
Expected: `BUILD SUCCESSFUL`. Verify the libraries exist:
```bash
ls tsnet/src/main/jniLibs/*/
```
Expected: `liblanka_tsnet.so` in each of `arm64-v8a`, `armeabi-v7a`, `x86_64`.

- [ ] **Step 10: Call `helloTsnet()` from `MainActivity.onCreate` as a smoke test**

In `MainActivity.kt`, add an import:

```kotlin
import ai.lanka.tsnet.TsnetService
```

At the top of `onCreate` (after `super.onCreate`):

```kotlin
android.util.Log.i("LankaKiosk", "tsnet says: " + TsnetService.helloTsnet())
```

- [ ] **Step 11: Install, run, verify the message appears in logcat**

```bash
./gradlew :app:installDebug
adb shell am start -n ai.lanka.kiosk/.MainActivity
adb logcat -s LankaKiosk
```
Expected: `tsnet says: hello from go`.

**If you see `UnsatisfiedLinkError`**, the symbol name in `jni_shim.c` doesn't match the Kotlin package+class+method. The pattern is `Java_<package_with_underscores>_<ClassName>_<methodName>`. Double-check that the package is `ai.lanka.tsnet` (→ `ai_lanka_tsnet`) and the class is `TsnetService`.

- [ ] **Step 12: Commit**

```bash
cd ..
git add android/tsnet android/app/build.gradle.kts android/app/src/main/kotlin/ai/lanka/kiosk/MainActivity.kt
git commit -m "feat(android): :tsnet module with Go cross-compile + hello-world JNI"
```

---

### Task 19: Swap the hello-world for tsnet bring-up

Replace the stub with real tsnet. The Go side starts a `tsnet.Server`, connects with the supplied auth key, and signals readiness via a callback channel.

**Files:**
- Modify: `android/tsnet/src/main/go/lanka_tsnet.go`
- Modify: `android/tsnet/src/main/go/jni_shim.c`
- Modify: `android/tsnet/src/main/go/go.mod`
- Modify: `android/tsnet/src/main/kotlin/ai/lanka/tsnet/TsnetService.kt`

- [ ] **Step 1: Add tsnet dependency to `go.mod`**

```bash
cd android/tsnet/src/main/go
go get tailscale.com/tsnet@latest
```
This populates `go.mod` and creates `go.sum`. `go.sum` stays git-ignored per Task 3.

- [ ] **Step 2: Rewrite `lanka_tsnet.go`**

```go
// android/tsnet/src/main/go/lanka_tsnet.go
package main

/*
#include <stdlib.h>
*/
import "C"

import (
    "context"
    "log"
    "os"
    "path/filepath"
    "sync"
    "unsafe"

    "tailscale.com/tsnet"
)

var (
    serverMu sync.Mutex
    server   *tsnet.Server
    ready    bool
)

//export StartTsnet
// Starts tsnet with the supplied auth key. Blocks until the tailnet node is up
// or the first error. Returns 1 on success, 0 on failure. Subsequent calls
// while a server is running are no-ops returning 1.
func StartTsnet(cAuthKey *C.char, cStateDir *C.char, cHostname *C.char) C.int {
    authKey  := C.GoString(cAuthKey)
    stateDir := C.GoString(cStateDir)
    hostname := C.GoString(cHostname)

    serverMu.Lock()
    defer serverMu.Unlock()
    if server != nil && ready {
        return 1
    }

    if err := os.MkdirAll(filepath.Clean(stateDir), 0o700); err != nil {
        log.Printf("lanka_tsnet: mkdir state dir: %v", err)
        return 0
    }

    s := &tsnet.Server{
        Hostname:  hostname,
        AuthKey:   authKey,
        Dir:       stateDir,
        Ephemeral: true,
        Logf:      func(f string, a ...interface{}) { log.Printf("tsnet: "+f, a...) },
    }

    if _, err := s.Up(context.Background()); err != nil {
        log.Printf("lanka_tsnet: Up: %v", err)
        return 0
    }
    server = s
    ready  = true
    return 1
}

//export StopTsnet
func StopTsnet() {
    serverMu.Lock()
    defer serverMu.Unlock()
    if server != nil {
        _ = server.Close()
        server = nil
        ready = false
    }
}

//export FreeCString
func FreeCString(s *C.char) { C.free(unsafe.Pointer(s)) }

func main() {}
```

Note: the Go API for tsnet is current as of Tailscale v1.68+. If the method names differ when you run `go get`, consult the `tsnet` godoc (`go doc tailscale.com/tsnet`) and adjust — the important calls are `(*Server).Up(ctx)` to start and `(*Server).Dial(ctx, net, addr)` to outbound-dial. Task 20 relies on `Dial`.

- [ ] **Step 3: Expose `StartTsnet` / `StopTsnet` through JNI**

Rewrite `jni_shim.c`:

```c
// android/tsnet/src/main/go/jni_shim.c
#include <jni.h>
#include <string.h>
#include <stdlib.h>

extern int  StartTsnet(char *authKey, char *stateDir, char *hostname);
extern void StopTsnet();

JNIEXPORT jboolean JNICALL
Java_ai_lanka_tsnet_TsnetService_nativeStart(
    JNIEnv *env, jobject thiz,
    jstring authKey, jstring stateDir, jstring hostname)
{
    const char *a = (*env)->GetStringUTFChars(env, authKey,  NULL);
    const char *d = (*env)->GetStringUTFChars(env, stateDir, NULL);
    const char *h = (*env)->GetStringUTFChars(env, hostname, NULL);

    int ok = StartTsnet((char*)a, (char*)d, (char*)h);

    (*env)->ReleaseStringUTFChars(env, authKey,  a);
    (*env)->ReleaseStringUTFChars(env, stateDir, d);
    (*env)->ReleaseStringUTFChars(env, hostname, h);
    return ok ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_ai_lanka_tsnet_TsnetService_nativeStop(JNIEnv *env, jobject thiz)
{
    StopTsnet();
}
```

- [ ] **Step 4: Update the Kotlin wrapper**

```kotlin
// android/tsnet/src/main/kotlin/ai/lanka/tsnet/TsnetService.kt
package ai.lanka.tsnet

import android.content.Context
import android.util.Log
import kotlin.concurrent.thread

object TsnetService {
    init { System.loadLibrary("lanka_tsnet") }

    private external fun nativeStart(authKey: String, stateDir: String, hostname: String): Boolean
    private external fun nativeStop()

    @Volatile private var started: Boolean = false

    fun startAndWait(
        ctx: Context,
        authKey: String,
        hostname: String = "lanka-kiosk",
        onResult: (ok: Boolean) -> Unit
    ) {
        if (started) { onResult(true); return }
        val stateDir = ctx.filesDir.resolve("tsnet").absolutePath
        thread(name = "tsnet-start") {
            val ok = nativeStart(authKey, stateDir, hostname)
            if (ok) started = true
            Log.i("LankaTsnet", "nativeStart → $ok")
            // Jump back to main thread via Handler would be cleaner; for Plan 5
            // we keep it simple — the caller is responsible for marshalling.
            onResult(ok)
        }
    }

    fun stop() {
        if (!started) return
        nativeStop()
        started = false
    }
}
```

- [ ] **Step 5: Build all ABIs**

```bash
cd android && ./gradlew :tsnet:buildGoAll
```
Expected: `BUILD SUCCESSFUL`. First build will download the Go module cache and take a minute. If `go build` complains about tsnet incompatibilities, consult `go doc tailscale.com/tsnet` and adjust method names. If the build fails with linker errors about missing `libdl`, add `-extldflags=-ldl` to `ldflags` in `build.gradle.kts`'s `go build` invocation.

- [ ] **Step 6: Commit**

```bash
cd ..
git add android/tsnet/src/main/go android/tsnet/src/main/kotlin/ai/lanka/tsnet/TsnetService.kt
git commit -m "feat(android): tsnet StartTsnet/StopTsnet via JNI"
```

---

### Task 20: Add the SOCKS5 listener in Go

tsnet exposes `Dial`. We run a SOCKS5 server on `localhost:1055` that proxies every connection through `server.Dial`, giving the Kotlin WebView a single proxy endpoint.

**Files:**
- Modify: `android/tsnet/src/main/go/lanka_tsnet.go`
- Modify: `android/tsnet/src/main/go/go.mod`

- [ ] **Step 1: Add `go-socks5`**

```bash
cd android/tsnet/src/main/go
go get github.com/things-go/go-socks5@latest
```

- [ ] **Step 2: Update `lanka_tsnet.go` to spawn the SOCKS5 listener alongside tsnet**

Replace the file with:

```go
package main

/*
#include <stdlib.h>
*/
import "C"

import (
    "context"
    "log"
    "net"
    "os"
    "path/filepath"
    "sync"
    "unsafe"

    "github.com/things-go/go-socks5"
    "tailscale.com/tsnet"
)

const socksAddr = "127.0.0.1:1055"

var (
    mu       sync.Mutex
    server   *tsnet.Server
    socksLn  net.Listener
    ready    bool
)

//export StartTsnet
func StartTsnet(cAuthKey *C.char, cStateDir *C.char, cHostname *C.char) C.int {
    authKey  := C.GoString(cAuthKey)
    stateDir := C.GoString(cStateDir)
    hostname := C.GoString(cHostname)

    mu.Lock()
    defer mu.Unlock()
    if ready {
        return 1
    }

    if err := os.MkdirAll(filepath.Clean(stateDir), 0o700); err != nil {
        log.Printf("lanka_tsnet: mkdir state dir: %v", err)
        return 0
    }

    s := &tsnet.Server{
        Hostname:  hostname,
        AuthKey:   authKey,
        Dir:       stateDir,
        Ephemeral: true,
        Logf:      func(f string, a ...interface{}) { log.Printf("tsnet: "+f, a...) },
    }
    if _, err := s.Up(context.Background()); err != nil {
        log.Printf("lanka_tsnet: tsnet Up: %v", err)
        return 0
    }
    server = s

    proxy := socks5.NewServer(
        socks5.WithDial(func(ctx context.Context, network, addr string) (net.Conn, error) {
            return s.Dial(ctx, network, addr)
        }),
        socks5.WithLogger(socks5.NewLogger(log.New(log.Writer(), "socks5 ", log.LstdFlags))),
    )
    ln, err := net.Listen("tcp", socksAddr)
    if err != nil {
        log.Printf("lanka_tsnet: socks listen: %v", err)
        _ = s.Close()
        server = nil
        return 0
    }
    socksLn = ln
    go func() {
        if err := proxy.Serve(ln); err != nil {
            log.Printf("lanka_tsnet: socks serve ended: %v", err)
        }
    }()

    ready = true
    log.Printf("lanka_tsnet: up — SOCKS5 on %s", socksAddr)
    return 1
}

//export StopTsnet
func StopTsnet() {
    mu.Lock()
    defer mu.Unlock()
    if socksLn != nil {
        _ = socksLn.Close()
        socksLn = nil
    }
    if server != nil {
        _ = server.Close()
        server = nil
    }
    ready = false
}

//export FreeCString
func FreeCString(s *C.char) { C.free(unsafe.Pointer(s)) }

func main() {}
```

- [ ] **Step 3: Build**

```bash
cd android && ./gradlew :tsnet:buildGoAll
```
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Smoke-test locally**

Even without an Android device, you can validate the Go logic runs:

```bash
cd android/tsnet/src/main/go
# run without CGO+Android flags for a quick compile check
go build ./...
```
Expected: no output (successful). If `go build` errors on the `-buildmode=c-shared` paths (it won't with plain `go build`), you've flagged a Go-side type issue independent of Android.

- [ ] **Step 5: Commit**

```bash
cd ../../../../..
git add android/tsnet/src/main/go
git commit -m "feat(android): SOCKS5 listener on 127.0.0.1:1055 tunnels through tsnet"
```

---

### Task 21: Route WebView traffic through SOCKS via `OkHttp`

`WebView.shouldInterceptRequest` intercepts every fetch; we replay it through an `OkHttpClient` configured with a SOCKS5 proxy on `localhost:1055`.

**Files:**
- Modify: `android/app/build.gradle.kts` (add OkHttp)
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/LankaWebViewClient.kt`
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/MainActivity.kt`

- [ ] **Step 1: Add OkHttp dependency**

In `android/app/build.gradle.kts`, inside `dependencies { }`:

```kotlin
implementation("com.squareup.okhttp3:okhttp:4.12.0")
```

- [ ] **Step 2: Replace `LankaWebViewClient`**

```kotlin
// android/app/src/main/kotlin/ai/lanka/kiosk/LankaWebViewClient.kt
package ai.lanka.kiosk

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.ByteArrayInputStream
import java.net.InetSocketAddress
import java.net.Proxy

class LankaWebViewClient(
    socksHost: String,
    socksPort: Int
) : WebViewClient() {

    private val client = OkHttpClient.Builder()
        .proxy(Proxy(Proxy.Type.SOCKS, InetSocketAddress(socksHost, socksPort)))
        .build()

    override fun shouldInterceptRequest(
        view: WebView?,
        request: WebResourceRequest?
    ): WebResourceResponse? {
        if (request == null) return null
        if (request.method != "GET") return null   // let WebView handle POST/etc directly

        return try {
            val req = Request.Builder()
                .url(request.url.toString())
                .apply {
                    request.requestHeaders.forEach { (k, v) -> header(k, v) }
                }
                .build()
            val resp = client.newCall(req).execute()

            val body = resp.body?.bytes() ?: byteArrayOf()
            val contentType = resp.header("Content-Type") ?: "application/octet-stream"
            val mime = contentType.substringBefore(';').trim()
            val charset = contentType
                .split(';')
                .map { it.trim() }
                .firstOrNull { it.startsWith("charset=", ignoreCase = true) }
                ?.substringAfter('=')
                ?.trim()

            val headers = HashMap<String, String>()
            resp.headers.names().forEach { name -> headers[name] = resp.header(name) ?: "" }

            WebResourceResponse(
                mime,
                charset,
                resp.code,
                resp.message.ifEmpty { "OK" },
                headers,
                ByteArrayInputStream(body)
            )
        } catch (e: Exception) {
            android.util.Log.e("LankaWebView", "proxy fetch failed: ${request.url}", e)
            null
        }
    }

    override fun onReceivedError(
        view: WebView?,
        errorCode: Int,
        description: String?,
        failingUrl: String?
    ) {
        android.util.Log.e("LankaWebView", "load error $errorCode $description — $failingUrl")
    }
}
```

- [ ] **Step 3: Pass SOCKS coordinates when constructing the client**

In `MainActivity.configureWebView`, change:

```kotlin
webView.webViewClient = LankaWebViewClient()
```

to:

```kotlin
webView.webViewClient = LankaWebViewClient(
    socksHost = ai.lanka.tsnet.SocksProxy.HOST,
    socksPort = ai.lanka.tsnet.SocksProxy.PORT
)
```

- [ ] **Step 4: Build**

```bash
cd android && ./gradlew :app:assembleDebug
```

- [ ] **Step 5: Commit**

```bash
cd ..
git add android/app
git commit -m "feat(android): WebViewClient tunnels GETs through SOCKS via OkHttp"
```

---

### Task 22: Gate `loadUrl` on tsnet connection

Currently `MainActivity.onCreate` calls `webView.loadUrl` immediately. Move that call inside the `TsnetService.startAndWait` callback.

**Files:**
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/MainActivity.kt`

- [ ] **Step 1: Update `onCreate`**

Replace the block

```kotlin
// Phase 5: no tsnet; go straight to loadUrl.
val url = serverUrlResolver.resolve() + "/player?deviceId=" + deviceIdStore.deviceId()
webView.loadUrl(url)
hideSplash()
```

with:

```kotlin
showSplash(getString(R.string.splash_connecting))
ai.lanka.tsnet.TsnetService.startAndWait(
    ctx = applicationContext,
    authKey = BuildConfig.LANKA_TAILNET_AUTHKEY,
    hostname = "lanka-${deviceIdStore.deviceId().take(8)}"
) { ok ->
    runOnUiThread {
        if (!ok) {
            showSplash(getString(R.string.splash_error))
            return@runOnUiThread
        }
        val url = serverUrlResolver.resolve() + "/player?deviceId=" + deviceIdStore.deviceId()
        webView.loadUrl(url)
        hideSplash()
    }
}
```

- [ ] **Step 2: Stop tsnet on Activity destroy**

In `MainActivity.onDestroy`, before `super.onDestroy()`:

```kotlin
ai.lanka.tsnet.TsnetService.stop()
```

- [ ] **Step 3: Manual smoke test**

You need a real auth key and server for an end-to-end smoke test. The mechanics:

```bash
# Generate an ephemeral reusable auth key from the Tailscale admin console,
# tagged tag:lanka-kiosk. Export it:
export LANKA_TAILNET_AUTHKEY=tskey-auth-xxxxxxxxxxxxxx

# Server URL — use the MagicDNS name of your lanka server.
export LANKA_SERVER_URL=http://lanka-server:3000

cd android
./gradlew -PLANKA_TAILNET_AUTHKEY=$LANKA_TAILNET_AUTHKEY \
          -PLANKA_SERVER_URL=$LANKA_SERVER_URL \
          :app:installDebug
adb shell am start -n ai.lanka.kiosk/.MainActivity
adb logcat -s LankaKiosk LankaTsnet LankaPlayer LankaWebView tsnet
```

Expected: logcat shows tsnet coming up (~2–5s), SOCKS listener starts, WebView requests the player page, player loads.

If the connect stalls, verify the auth key is valid (`tailscale status` on the server should show `lanka-*` as a pending node).

- [ ] **Step 4: Commit**

```bash
cd ..
git add android/app/src/main/kotlin/ai/lanka/kiosk/MainActivity.kt
git commit -m "feat(android): gate player load on tsnet connection"
```

---

## Phase 8 — Escape hatch (override dialog)

### Task 23: `OverrideDialog` wired to long-press

**Files:**
- Create: `android/app/src/main/res/layout/dialog_override.xml`
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/ui/OverrideDialog.kt`
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/MainActivity.kt`

- [ ] **Step 1: Write the dialog layout**

```xml
<!-- android/app/src/main/res/layout/dialog_override.xml -->
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:orientation="vertical"
    android:padding="24dp"
    android:layout_width="match_parent"
    android:layout_height="wrap_content">

    <TextView
        android:text="@string/override_server_url"
        android:textStyle="bold"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"/>

    <EditText
        android:id="@+id/serverUrl"
        android:inputType="textUri"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginBottom="16dp"/>

    <TextView
        android:text="@string/override_device_id"
        android:textStyle="bold"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"/>

    <TextView
        android:id="@+id/deviceId"
        android:textIsSelectable="true"
        android:fontFamily="monospace"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"/>
</LinearLayout>
```

- [ ] **Step 2: Write the dialog helper**

```kotlin
// android/app/src/main/kotlin/ai/lanka/kiosk/ui/OverrideDialog.kt
package ai.lanka.kiosk.ui

import android.app.Activity
import android.app.AlertDialog
import android.view.LayoutInflater
import android.widget.EditText
import android.widget.TextView
import ai.lanka.kiosk.R
import ai.lanka.kiosk.storage.DeviceIdStore
import ai.lanka.kiosk.storage.ServerUrlResolver

object OverrideDialog {
    fun show(
        activity: Activity,
        deviceIdStore: DeviceIdStore,
        serverUrlResolver: ServerUrlResolver,
        onApply: () -> Unit
    ) {
        val view = LayoutInflater.from(activity).inflate(R.layout.dialog_override, null, false)
        val urlField  = view.findViewById<EditText>(R.id.serverUrl)
        val idField   = view.findViewById<TextView>(R.id.deviceId)
        urlField.setText(serverUrlResolver.getOverrideOrNull() ?: serverUrlResolver.resolve())
        idField.text = deviceIdStore.deviceId()

        AlertDialog.Builder(activity)
            .setTitle(R.string.override_title)
            .setView(view)
            .setPositiveButton(R.string.override_apply) { _, _ ->
                serverUrlResolver.setOverride(urlField.text.toString().trim())
                onApply()
            }
            .setNeutralButton(R.string.override_reset) { _, _ ->
                serverUrlResolver.clearOverride()
                onApply()
            }
            .setNegativeButton(R.string.override_cancel, null)
            .show()
    }
}
```

- [ ] **Step 3: Wire the long-press callback in `MainActivity`**

Find the `longPress = LongPressDetector(...) { /* Task 26 fills this in */ }` line and replace the callback body with:

```kotlin
longPress = LongPressDetector(
    holdMs = 5000,
    triggerKey = KeyEvent.KEYCODE_DPAD_CENTER,
    now = { System.currentTimeMillis() }
) {
    runOnUiThread {
        if (splash.visibility == View.VISIBLE) {
            ai.lanka.kiosk.ui.OverrideDialog.show(
                this,
                deviceIdStore,
                serverUrlResolver
            ) {
                recreate()
            }
        }
    }
}
```

- [ ] **Step 4: Build + commit**

```bash
cd android && ./gradlew :app:assembleDebug
cd ..
git add android/app
git commit -m "feat(android): OverrideDialog reachable via 5s D-pad hold on splash"
```

---

## Phase 9 — `:bridge` stub module

### Task 24: Empty `:bridge` Gradle module for Plan 6

**Files:**
- Create: `android/bridge/build.gradle.kts`
- Create: `android/bridge/src/main/AndroidManifest.xml`

- [ ] **Step 1: Create the module directory**

```bash
mkdir -p android/bridge/src/main
```

- [ ] **Step 2: Write a minimal library `build.gradle.kts`**

```kotlin
// android/bridge/build.gradle.kts
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ai.lanka.bridge"
    compileSdk = 34
    defaultConfig { minSdk = 24 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
```

- [ ] **Step 3: Write the empty manifest**

```xml
<!-- android/bridge/src/main/AndroidManifest.xml -->
<manifest xmlns:android="http://schemas.android.com/apk/res/android"/>
```

- [ ] **Step 4: Build to confirm**

```bash
cd android && ./gradlew :bridge:assembleDebug
```
Expected: `BUILD SUCCESSFUL`. Empty AAR produced — that's fine.

- [ ] **Step 5: Commit**

```bash
cd ..
git add android/bridge
git commit -m "feat(android): empty :bridge module stub reserved for Plan 6 NativeFS"
```

---

## Phase 10 — Nuxt-side changes

### Task 25: `useNativeDevice` capability check + vitest tests

**Files:**
- Modify: `app/composables/player/useNativeDevice.ts`
- Create: `tests/player/useNativeDevice.test.ts`

- [ ] **Step 1: Read the current shim for context**

```bash
cat app/composables/player/useNativeDevice.ts
```

- [ ] **Step 2: Replace the file with the capability-aware version**

```ts
// app/composables/player/useNativeDevice.ts
//
// Web shim for the NativeDevice contract from the parent spec. When the
// APK (Plan 5) is hosting the WebView it injects `window.NativeDevice`
// with JNI-backed methods; otherwise we use the web flow (persisted
// UUID in localStorage, navigator.userAgent, etc.).
import { resolveDeviceId } from './resolveDeviceId'

export const PLAYER_VERSION = '3.0.0-web'

export interface NativeDevice {
  deviceId(): string
  reload(): void
  version(): { app: string; os: string; model: string }
  serverUrl(): string
}

type NativeDeviceBridge = {
  deviceId(): string
  reload(): void
  version(): string     // JSON string — @JavascriptInterface can't return complex types
  serverUrl(): string
}

declare global {
  interface Window {
    NativeDevice?: NativeDeviceBridge
  }
}

let _cachedId: string | null = null

function getQueryDeviceId(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const params = new URLSearchParams(window.location.search)
  return params.get('deviceId') ?? undefined
}

function getStorage() {
  if (typeof window === 'undefined') {
    return {
      get: () => null,
      set: () => {
        /* noop in SSR */
      }
    }
  }
  return {
    get: (k: string) => window.localStorage.getItem(k),
    set: (k: string, v: string) => window.localStorage.setItem(k, v)
  }
}

function webShim(): NativeDevice {
  return {
    deviceId() {
      if (_cachedId) return _cachedId
      _cachedId = resolveDeviceId({
        query: getQueryDeviceId(),
        storage: getStorage(),
        generate: () => crypto.randomUUID()
      })
      return _cachedId
    },
    reload() {
      if (typeof window !== 'undefined') window.location.reload()
    },
    version() {
      return {
        app: PLAYER_VERSION,
        os: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
        model: 'Browser'
      }
    },
    serverUrl() {
      return typeof window !== 'undefined' ? window.location.origin : ''
    }
  }
}

function nativeAdapter(bridge: NativeDeviceBridge): NativeDevice {
  return {
    deviceId: () => bridge.deviceId(),
    reload:   () => bridge.reload(),
    version() {
      const parsed = JSON.parse(bridge.version()) as { app: string; os: string; model: string }
      return parsed
    },
    serverUrl: () => bridge.serverUrl()
  }
}

export function useNativeDevice(): NativeDevice {
  const bridge = typeof window !== 'undefined' ? window.NativeDevice : undefined
  if (bridge) return nativeAdapter(bridge)
  return webShim()
}

// Test-only helper — lets unit tests wipe the cached id between runs.
export function _resetNativeDeviceCache(): void {
  _cachedId = null
}
```

- [ ] **Step 3: Write vitest coverage**

```ts
// tests/player/useNativeDevice.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetNativeDeviceCache, useNativeDevice } from '~/app/composables/player/useNativeDevice'

describe('useNativeDevice — web shim branch', () => {
  beforeEach(() => {
    _resetNativeDeviceCache()
    window.localStorage.clear()
    // Ensure no bridge is present.
    // @ts-expect-error test-only manipulation
    delete window.NativeDevice
  })

  it('generates a UUID via crypto.randomUUID and caches it', () => {
    const a = useNativeDevice()
    const first = a.deviceId()
    expect(first).toMatch(/^[0-9a-f-]{36}$/i)
    expect(a.deviceId()).toBe(first)
    expect(window.localStorage.getItem('lanka:deviceId')).toBe(first)
  })

  it('version returns the web player version with navigator data', () => {
    const a = useNativeDevice()
    const v = a.version()
    expect(v.app).toBe('3.0.0-web')
    expect(v.model).toBe('Browser')
    expect(typeof v.os).toBe('string')
  })
})

describe('useNativeDevice — native bridge branch', () => {
  beforeEach(() => {
    _resetNativeDeviceCache()
    // @ts-expect-error test-only manipulation
    window.NativeDevice = {
      deviceId: () => 'native-uuid',
      reload:   () => { /* spy not needed for these tests */ },
      version:  () => JSON.stringify({ app: '0.1.0', os: 'Android 13', model: 'Test TV' }),
      serverUrl: () => 'http://lanka-server:3000'
    }
  })

  afterEach(() => {
    // @ts-expect-error test-only manipulation
    delete window.NativeDevice
  })

  it('delegates deviceId to the native bridge', () => {
    const d = useNativeDevice()
    expect(d.deviceId()).toBe('native-uuid')
  })

  it('parses the JSON version string from the bridge', () => {
    const d = useNativeDevice()
    expect(d.version()).toEqual({ app: '0.1.0', os: 'Android 13', model: 'Test TV' })
  })

  it('uses the bridge serverUrl instead of window.location.origin', () => {
    const d = useNativeDevice()
    expect(d.serverUrl()).toBe('http://lanka-server:3000')
  })
})
```

- [ ] **Step 4: Run tests**

```bash
pnpm test -- tests/player/useNativeDevice.test.ts
```
Expected: all cases pass.

- [ ] **Step 5: Commit**

```bash
git add app/composables/player/useNativeDevice.ts tests/player/useNativeDevice.test.ts
git commit -m "feat(player): useNativeDevice detects window.NativeDevice bridge"
```

---

### Task 26: Supersede note in the parent design spec

**Files:**
- Modify: `docs/superpowers/specs/2026-04-18-lanka-digital-signage-design.md`

- [ ] **Step 1: Locate the device-identity paragraph**

Run:
```bash
grep -n "Android ID" docs/superpowers/specs/2026-04-18-lanka-digital-signage-design.md
```
Expected lines: 35, 83, 255.

- [ ] **Step 2: Prepend a note above the "Trust model" section's device-identity bullet (around line 35)**

Use the Edit tool. Replace:
```
- Device identity is a device-generated identifier (Android ID on real devices, fallback to a stored UUID on emulators or if Android ID is unavailable) claimed by the operator in the dashboard.
```

with:

```
- Device identity is a device-generated UUID stored on the device, claimed by the operator in the dashboard.

  > **Superseded 2026-04-19:** Earlier drafts of this document described an Android-ID-based identifier with a UUID fallback. Plan 5's APK uses **UUID-only**; see `docs/superpowers/specs/2026-04-19-lanka-apk-kiosk-design.md` §Device identity for the rationale. The schema (`devices.id TEXT`) is unchanged.
```

- [ ] **Step 3: Update the `devices` table comment (line ~83)**

Replace:
```
  id              TEXT PRIMARY KEY,           -- device-generated: Android ID, or stored UUID fallback
```

with:
```
  id              TEXT PRIMARY KEY,           -- device-generated UUID (see Plan 5 spec)
```

- [ ] **Step 4: Update the native-bridge comment (line ~255)**

Replace:
```
  deviceId(): string                // Android ID — stable per-device, survives reinstall
```

with:
```
  deviceId(): string                // UUID — generated on first run, stored in SharedPreferences
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-04-18-lanka-digital-signage-design.md
git commit -m "docs(spec): supersede Android-ID identity with UUID (per Plan 5)"
```

---

## Phase 11 — Release packaging

### Task 27: Release signing config

**Files:**
- Modify: `android/app/build.gradle.kts`
- Create: `android/SIGNING.md` (quick operator doc)

- [ ] **Step 1: Add a `signingConfigs` block to `:app`**

In `android/app/build.gradle.kts`, inside `android { }`, add before `buildTypes { }`:

```kotlin
signingConfigs {
    create("release") {
        val keystorePath = providers.environmentVariable("LANKA_KEYSTORE_PATH").getOrNull()
        if (keystorePath != null) {
            storeFile = file(keystorePath)
            storePassword = providers.environmentVariable("LANKA_KEYSTORE_PASS").get()
            keyAlias      = providers.environmentVariable("LANKA_KEY_ALIAS").get()
            keyPassword   = providers.environmentVariable("LANKA_KEY_PASS").get()
        }
    }
}
```

And inside `buildTypes { release { ... } }`, add at the top:

```kotlin
signingConfig = signingConfigs.getByName("release")
```

- [ ] **Step 2: Write `android/SIGNING.md`**

```markdown
# Release signing

## One-time keystore generation

```bash
cd android
keytool -genkey -v \
  -keystore lanka-release.jks \
  -alias lanka \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000
```

**BACK THIS UP.** Losing the keystore means every TV must reinstall the APK from scratch (Android treats re-signed APKs as a different app, wiping SharedPreferences — new device IDs, operator re-claims).

## Environment variables for a release build

```bash
export LANKA_KEYSTORE_PATH=/abs/path/to/lanka-release.jks
export LANKA_KEYSTORE_PASS=...
export LANKA_KEY_ALIAS=lanka
export LANKA_KEY_PASS=...
export LANKA_TAILNET_AUTHKEY=tskey-auth-xxxxxxxxxxxxxx
export LANKA_SERVER_URL=http://lanka-server:3000
```

`./gradlew :app:assembleRelease` will pick these up.

## The keystore is NEVER in git

Both `*.jks` and `*.keystore` are gitignored. If you see a keystore in a diff, stop the commit.
```

- [ ] **Step 3: Dry-run a release build (signing config optional — skipped if env vars absent)**

```bash
cd android
./gradlew :app:assembleRelease
```
Expected: if no env vars are set, the APK is produced unsigned (AGP will warn). If env vars are set, a signed APK appears at `app/build/outputs/apk/release/app-release.apk`.

- [ ] **Step 4: Commit**

```bash
cd ..
git add android/app/build.gradle.kts android/SIGNING.md
git commit -m "feat(android): env-driven release signing config + SIGNING.md"
```

---

### Task 28: `android/README.md`

**Files:**
- Create: `android/README.md`

- [ ] **Step 1: Write the README**

```markdown
# Lanka Kiosk APK

Thin Android WebView kiosk for the Lanka signage system. Wraps the Nuxt
`/player` route, embeds Tailscale via `tsnet`, and auto-launches on boot.

## Modules

| Module   | Purpose                                                          |
|----------|------------------------------------------------------------------|
| `:app`   | Activity, WebView, kiosk flags, key dispatch, storage, watchdog |
| `:tsnet` | Go cross-compile (tsnet + SOCKS5 on `localhost:1055`) + JNI      |
| `:bridge`| Reserved for Plan 6's `NativeFS`. Empty in Plan 5.               |

## Build toolchain

- JDK 17+
- Android SDK 34, NDK 25.2.9519653
- Go 1.22+
- Gradle wrapper (`./gradlew`)

## Debug build (no signing)

```bash
cd android
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

For a local dev server on your laptop, pass `-PLANKA_SERVER_URL` and skip tsnet by
using the override dialog after first boot (long-press D-pad CENTER for 5s).

## Release build

See `SIGNING.md` for keystore setup. Then:

```bash
./gradlew :app:assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

## Provisioning a new TV

1. Enable developer options + ADB-over-network on the TV.
2. `adb connect <tv-ip>:5555`
3. `adb install -r app-release.apk`
4. `adb shell am start -n ai.lanka.kiosk/.MainActivity` (or reboot the TV)
5. When the OS prompts "Set as default launcher?", select Lanka.
6. Splash → "Joining tailnet…" → WebView loads the player.
7. In the Lanka dashboard, the device appears in the unclaimed tray.
   Assign a name, group, and playlist.

## Manual QA checklist

Run this before tagging a release.

- [ ] Fresh install on a clean TV → launcher-picker prompt → accept → splash → tsnet connects → WebView loads → unclaimed tray shows the device.
- [ ] Assign a playlist → player shows content within ~5s via SSE.
- [ ] Reboot the TV → cold-boot time-to-first-frame ≤ 20s, no launcher prompt.
- [ ] `adb shell am force-stop ai.lanka.kiosk` → watchdog restarts within 15 minutes → playback resumes.
- [ ] Disconnect the TV's network for 60s → `<StandbyScreen>` appears → reconnect → player recovers.
- [ ] Press BACK, D-pad, MENU, play/pause during playback → no visible effect.
- [ ] Press VOLUME_UP/DOWN → system volume changes.
- [ ] Long-press D-pad CENTER for 5s on the splash screen → override dialog appears. Enter a bogus URL → Apply → splash reappears with the bogus URL. Reset → BuildConfig default restored.
- [ ] `adb uninstall` + reinstall → new UUID → operator must re-claim. Document as expected.
- [ ] Re-sign with a different keystore + reinstall → new UUID → operator must re-claim. Document as expected.

## Troubleshooting

- **`UnsatisfiedLinkError: liblanka_tsnet`** — the Go shared library wasn't built for the device's ABI. Run `./gradlew :tsnet:buildGoAll` and re-install.
- **Stuck on "Joining tailnet…"** — check `adb logcat -s LankaTsnet tsnet`. Common causes: invalid auth key, server's tailnet IP unreachable from the TV's network (Tailscale relays will usually work around this — give it 30s).
- **Player loads but no content** — check the dashboard unclaimed tray. Until the operator claims + assigns, the server returns 204 and the player shows `<NoContentScreen>`.
- **Watchdog never restarts** — WorkManager's minimum interval is 15 minutes. For faster testing: `adb shell am force-stop ai.lanka.kiosk` then wait, or trigger a one-off run via `adb shell cmd jobscheduler run ai.lanka.kiosk`.
```

- [ ] **Step 2: Commit**

```bash
git add android/README.md
git commit -m "docs(android): README with build + provisioning + QA checklist"
```

---

## Phase 12 — End-to-end validation

### Task 29: Full QA pass on a real TV

Not a code task — the moment where all the pieces meet the hardware.

- [ ] **Step 1: Generate a proper Tailscale auth key**

From the Tailscale admin console:
- Type: Auth key
- Reusable: **yes**
- Ephemeral: **yes**
- Pre-authorized: **yes**
- Tags: `tag:lanka-kiosk`

Save to the env var `LANKA_TAILNET_AUTHKEY`.

- [ ] **Step 2: Configure ACL**

In the Tailscale admin → Access Controls, ensure `tag:lanka-kiosk` can only talk to the Lanka server's port 3000:

```json
{
  "tagOwners": { "tag:lanka-kiosk": ["your-email@example.com"] },
  "acls": [
    { "action": "accept", "src": ["tag:lanka-kiosk"], "dst": ["tag:lanka-server:3000"] }
  ]
}
```

(Adjust server-side tag ownership to whatever your existing tailnet uses.)

- [ ] **Step 3: Run the release build**

```bash
cd android
./gradlew :app:assembleRelease
```

- [ ] **Step 4: Install on a real Android TV**

```bash
adb connect <tv-ip>:5555
adb install -r app/build/outputs/apk/release/app-release.apk
adb shell am start -n ai.lanka.kiosk/.MainActivity
```

- [ ] **Step 5: Walk the QA checklist in `android/README.md`**

Tick every box. File any bugs in a TODO list for a follow-up plan, not this one.

- [ ] **Step 6: Tag v0.1.0**

```bash
cd ..
git tag -a apk-v0.1.0 -m "Lanka APK v0.1.0 — Plan 5 initial release"
```

(Push tag only if the user approves.)

---

## Self-review notes for the implementing engineer

This plan has three known scale-of-effort unknowns. Budget accordingly:

1. **Go + NDK cross-compile (Task 18–19).** The first time you wire CGO + Android NDK, expect 2–4 hours of fussing with CC paths, linker flags, and symbol mangling. Keep a scratch note of what works.
2. **`tailscale.com/tsnet` API currency (Task 19).** Tailscale evolves quickly. If `Server.Up(ctx)` or `Server.Dial(ctx, …)` signatures differ at implementation time, consult `go doc tailscale.com/tsnet` and the tsnet example in the Tailscale repo.
3. **WebView autoplay policy on Android TV.** On some TV WebView builds, `mediaPlaybackRequiresUserGesture = false` is not enough for autoplay-with-sound. Since the player stays muted in Plan 5, this shouldn't bite — but if video doesn't start, grep logcat for `BLOCK_AUTOPLAY`.

When in doubt, run the full TDD cycle for the Kotlin class you're touching, commit, and move on. Fast feedback beats a perfect first attempt.
