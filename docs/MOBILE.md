# Mobile (Capacitor Android)

ReadAloud ships the same static Next.js export inside a Capacitor Android shell. The native layer adds OS text-to-speech and access to the device's voice engine; PDF parsing, OCR, history, and UI remain in the WebView.

## How the pieces fit

```text
Next.js static export (out/)
        │  npx cap sync android
        ▼
android/app/src/main/assets/public/   (generated — do not edit)
        │  Gradle
        ▼
app-debug.apk
        │
        ▼
Android WebView + Capacitor plugins
        └─ @capacitor-community/text-to-speech
```

Relevant configuration (`capacitor.config.ts`):

```ts
{
  appId: 'app.readaloud.reader',
  appName: 'ReadAloud',
  webDir: 'out',
  server: { androidScheme: 'https', cleartext: true },
  android: { allowMixedContent: true }
}
```

The Android project uses min SDK 24 and compile/target SDK 36. Gradle 8.14.3 and Android Gradle Plugin 8.13 are pinned by the wrapper/build files.

## Build workflow

### Prerequisites

- Node.js 20+ and npm.
- Android Studio or the Android SDK with API 36 platform and build tools.
- JDK 21 recommended. Gradle 8.14.3 supports newer JDKs, but the Android Studio bundled JBR is the least surprising choice.
- `JAVA_HOME` set, and either `ANDROID_HOME`/`ANDROID_SDK_ROOT` set or `android/local.properties` present.

If `android/local.properties` is missing, opening `android/` once in Android Studio usually creates it:

```properties
sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
```

Do not commit machine-specific paths or signing secrets.

### PowerShell (recommended on Windows)

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"

java -version
npm install
npm run mobile:apk
```

### Command Prompt

```bat
set JAVA_HOME=C:\Program Files\Android\Android Studio\jbr
set PATH=%JAVA_HOME%\bin;%PATH%
set ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk

npm install
npm run mobile:apk
```

### What the npm scripts do

| Script | Action |
| --- | --- |
| `npm run mobile:sync` | `npm run build`, then `cap sync android` |
| `npm run mobile:apk` | `npm run mobile:sync`, then `cd android && gradlew.bat assembleDebug` |
| `npm run android` | `cap open android` (opens Android Studio) |

On macOS/Linux, the debug build is:

```bash
npm run mobile:sync
cd android
./gradlew assembleDebug
```

### Output and install

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Install on a connected device or emulator:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Or open the project with `npm run android` and use Android Studio's Run button.

Always rebuild/sync after web changes. `android/app/src/main/assets/public` is generated from `out/`; editing it by hand is overwritten on the next `cap sync`.

## Native TTS behavior

Inside the Capacitor shell, `components/AudioEngine.tsx` routes playback in this order:

1. If a cached Kokoro audio blob exists for the sentence, play it through the audio element.
2. Otherwise, if `Capacitor.isNativePlatform()` is true, speak through the OS TTS engine via `lib/native-tts.ts`.
3. Otherwise use the Web Speech API.

Practical consequences:

- The Android app works offline with device voices without running the Kokoro server.
- Native TTS is the default local engine on mobile and is generally more power-efficient than WASM synthesis.
- Native TTS exposes real-time word boundaries (`onRangeStart`), so word-level highlighting works.
- The selected speed (0.5x–3x) is passed to the native engine and clamped there.
- `QueueStrategy.Flush` means a new utterance replaces the current one; playback changes stop the native engine.
- Browser voice selection and native voices are separate concepts. `lib/native-tts.ts` can enumerate device voices as `native:<index>` URIs; the voice sheet is browser/Kokoro-oriented unless native voices are explicitly surfaced there.

### Native TTS troubleshooting

| Symptom | Check |
| --- | --- |
| No sound | Device media volume, TTS engine installed (Settings → Accessibility → Text-to-speech), and a selected language voice |
| Wrong voice | Change the device TTS engine/voice in Android settings, or extend the voice sheet to expose `getNativeVoices()` |
| Playback stops immediately | Check that `playbackStatus` is `playing`; pausing/stopping calls `stopNative()` |
| Word highlighting missing | Some device engines do not emit `onRangeStart`; sentence highlighting still works |

## Using Kokoro from a phone

`localhost` on the phone means the phone itself. Use the computer's LAN address in the app's Kokoro panel:

```text
http://192.168.1.20:8880
```

Checklist:

1. Start the server on the computer: `cd server && uv run python main.py`. It binds `0.0.0.0:8880`.
2. Verify from the phone's browser: `http://192.168.1.20:8880/health`.
3. Allow inbound TCP 8880 in the computer firewall for the private network.
4. Enter the same URL in **Kokoro Neural → server address** and press **Connect**.
5. From the Android emulator, the host machine is usually `http://10.0.2.2:8880`.

The server has no authentication and permissive CORS. Keep it on a trusted LAN; do not port-forward it to the internet.

### Cleartext HTTP

Android blocks cleartext traffic by default on modern versions. Capacitor's `server.cleartext: true` and `android.allowMixedContent: true` allow the `https`-scheme WebView to fetch an `http` Kokoro server.

If you remove those settings:

- LAN HTTP Kokoro will fail with `CLEARTEXT communication not permitted`.
- Use an HTTPS endpoint (reverse proxy with a trusted certificate) instead.
- Re-run `npm run mobile:sync` and rebuild after any config change.

## Optional on-device Kokoro

`lib/device-kokoro.ts` implements an in-browser Kokoro engine for devices that can run ONNX Runtime WASM:

- model: `onnx-community/Kokoro-82M-v1.0-ONNX`, q8, approximately 80 MB;
- model weights cached in Cache Storage (`transformers-cache`);
- voice embeddings cached separately in `kokoro-voices` (~0.5 MB each);
- `kokoro-js` and the ONNX stack are dynamically imported only when loaded;
- speed is clamped to 0.5–2 for this engine.

Caveats to communicate in the UI and release notes:

- **First run needs network.** The model, tokenizer/config files, and ONNX Runtime WASM assets (jsDelivr by default) must be fetched. Later runs can use the caches.
- **Download cancellation is best-effort.** `kokoro-js`/Transformers.js do not expose an `AbortSignal` for `from_pretrained`; aborting stops the caller waiting, but the underlying fetch may continue and populate the cache.
- **Storage pressure.** A WebView may evict Cache Storage under storage pressure. The UI should re-check availability rather than assume the model is present.
- **Memory.** WASM inference competes with PDF canvases and OCR; close large documents or lower zoom if the device is memory-constrained.
- **Feature surface.** The main `TtsEngine` union is `browser | kokoro | device` (native/browser, server Kokoro, and on-device Kokoro). The voice sheet exposes device voices on Android and the on-device model panel.

## APK signing

The repository is configured for **debug** builds. Debug APKs are signed automatically with the local debug keystore and are not suitable for store distribution.

Release signing is intentionally not committed. To produce a release build:

1. Generate a keystore outside the repository (or in a git-ignored location):

   ```bash
   keytool -genkeypair -v -keystore readaloud-release.jks -alias readaloud -keyalg RSA -keysize 2048 -validity 10000
   ```

2. Add a `signingConfigs` block to `android/app/build.gradle` and reference it from the `release` build type. Keep credentials in a local, git-ignored properties file or environment variables.
3. Build:

   ```bash
   cd android
   gradlew.bat assembleRelease
   ```

4. Verify the output under `android/app/build/outputs/apk/release/`. Without a signing config, Gradle may produce an unsigned APK that cannot be installed normally.

Never commit a keystore, passwords, or `keystore.properties`. Bump `versionCode` and `versionName` in `android/app/build.gradle` for each distributed build.

## Mobile performance tips

- Use **native TTS** for long listening sessions; it avoids WASM/network work and is easier on the battery.
- Keep **fit-to-width** enabled or avoid extreme zoom. Canvas memory grows with scale and DPR.
- The viewer keeps 6–12 rendered pages depending on `navigator.deviceMemory`; on low-memory phones it deliberately keeps fewer.
- Export MP3 in smaller scopes (current page or from-here) on very large books. Export works with the Kokoro server or the on-device Kokoro engine.
- OCR is serial and CPU-heavy; run it on the pages that need it and keep the screen awake for long scans.
- Clear old history and cached audio if storage is low; history is capped at 12 entries but generated audio can accumulate.
- Prefer a text-layer PDF over a scanned image PDF when possible; OCR is the slow path.
- If the WebView is killed while reading a huge book, reopen from local history and use the page navigator to resume near your place.

## Mobile release checklist

- [ ] `npm run mobile:sync` ran after the last web change.
- [ ] `npm run mobile:apk` succeeds with the intended JDK/SDK.
- [ ] Debug APK installs and launches on a physical device.
- [ ] Native TTS speaks, pauses, resumes, and stops correctly.
- [ ] Kokoro works over the LAN (or the UI clearly explains why it is offline).
- [ ] Cleartext/mixed-content settings match the intended distribution model.
- [ ] Storage/history works after killing and relaunching the app.
- [ ] `versionCode`/`versionName` are bumped for a release.
- [ ] Release signing is configured outside version control.
