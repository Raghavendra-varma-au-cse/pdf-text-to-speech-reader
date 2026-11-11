# Downloads

Prebuilt packages are published as GitHub release assets. The contributor build
currently available is:

**https://github.com/Raghavendra-varma-au-cse/pdf-text-to-speech-reader/releases/tag/v1.0.0-readaloud**

| Platform | File | Notes |
| --- | --- | --- |
| Android | `ReadAloud-debug.apk` | Install directly; allow installation from unknown sources. Debug-signed. |
| Windows | `ReadAloud_1.0.0_x64-setup.exe` | NSIS installer (recommended). |
| Windows | `ReadAloud_1.0.0_x64_en-US.msi` | MSI for managed deployment. |
| Windows | `ReadAloud-portable.exe` | Run without installing; WebView2 is required and is present on current Windows. |

Linux `.deb`/`.AppImage` and macOS `.dmg`/`.app` are built on their native
runners by the `Release Packages` workflow. Trigger it with **Actions → Release
Packages → Run workflow**, or push a tag such as `v1.0.0`.

## Build packages yourself

```bash
npm ci

# Android APK
npm run mobile:apk
# -> android/app/build/outputs/apk/debug/app-debug.apk

# Windows / Linux / macOS desktop
npm run desktop:build
# -> src-tauri/target/release/bundle/
#    msi/ReadAloud_*.msi
#    nsis/ReadAloud_*_setup.exe
#    deb/ReadAloud_*.deb          (Linux host)
#    appimage/ReadAloud_*.AppImage (Linux host)
#    dmg/ReadAloud_*.dmg          (macOS host)
```

Prerequisites:

- Android: JDK 21+ and Android SDK with build-tools/platform 36.
- Desktop: Rust stable plus the platform webview toolchain
  (WebView2 on Windows, `libwebkit2gtk-4.1-dev` on Linux, Xcode on macOS).

The APK is debug-signed for direct installation. For Play Store distribution,
configure a release keystore in `android/app/build.gradle` and build
`bundleRelease`; never commit the keystore.
