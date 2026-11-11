# ReadAloud desktop (Tauri v2)

ReadAloud can be built as a standalone desktop application with Tauri v2. The app
is the same static Next.js export used by the web build; Tauri serves `out/` from
its built-in custom protocol inside a native window. No Kokoro server is required:
browser/OS voices work out of the box, and the optional on-device Kokoro engine
runs inside the WebView.

## Prerequisites

Common:

- Node.js 20 or 22 and npm.
- Rust stable, version 1.77.2 or newer (validated here with 1.99.1), plus Cargo.
  Install from <https://rustup.rs/>.
- The Tauri CLI is installed as a dev dependency (`@tauri-apps/cli`), so use the
  npm scripts below; no global `cargo install tauri-cli` is needed.

Windows:

- Microsoft Visual Studio Build Tools with the **Desktop development with C++**
  workload (MSVC linker and Windows SDK).
- WebView2 Runtime. It ships with Windows 11 and current Windows 10 builds; if it
  is missing, install the Evergreen Runtime from Microsoft.
- NSIS and WiX are downloaded automatically by the bundler on the first
  `desktop:build`. An internet connection is needed for that first run.

macOS:

- Xcode Command Line Tools (`xcode-select --install`). WKWebView is provided by
  the OS.

Linux:

- WebKitGTK 4.1 and the usual Tauri build dependencies. On Debian/Ubuntu:

  ```bash
  sudo apt update
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

Install JavaScript dependencies once:

```bash
npm ci
```

The first Rust build downloads and compiles the Tauri crates, so it takes several
minutes; later builds are incremental.

## Commands

| Command | What it does |
| --- | --- |
| `npm run desktop:dev` | Starts `next dev` on port 3000 and opens the app in a Tauri window pointed at `http://localhost:3000`. |
| `npm run desktop:build` | Runs `npm run build` (static export to `out/`), compiles the Rust app, and creates installers for the host OS. |
| `npm run desktop:info` | Prints the detected Rust/Node/WebView2 toolchain, Tauri crate versions, and app configuration. |
| `npm run build` | Static web export only (`out/`), useful before a manual `cargo run`. |
| `npm run desktop:build -- --no-bundle` | Compiles the release binary without creating installers (faster smoke test). |

Useful Tauri CLI variants:

```bash
npx tauri dev                 # same as desktop:dev
npx tauri build               # same as desktop:build
npx tauri build --no-bundle   # release binary only
npx tauri icon public/icon-512.png  # regenerate src-tauri/icons/*
```

`src-tauri/tauri.conf.json` sets `beforeDevCommand` to `npm run dev` and
`beforeBuildCommand` to `npm run build`, so both commands produce the frontend
automatically. Do not use `npm run build:gh` for the desktop build: the GitHub
Pages base path would not match the desktop origin.

## Build output

Outputs are under `src-tauri/target/release/`:

- Windows executable: `src-tauri/target/release/readaloud.exe`.
- Windows installers:
  - `src-tauri/target/release/bundle/msi/ReadAloud_<version>_x64_en-US.msi`
  - `src-tauri/target/release/bundle/nsis/ReadAloud_<version>_x64-setup.exe`
- macOS: `.app` under `bundle/macos/`, `.dmg` under `bundle/dmg/`.
- Linux: `.deb` under `bundle/deb/`, `.AppImage` under `bundle/appimage/`.

`targets: "all"` is configured in `tauri.conf.json`, but Tauri only bundles for
the host operating system. Build Windows packages on Windows, macOS packages on
macOS, and Linux packages on Linux. Cross-compilation is not configured.

## How the static export is served

- `frontendDist` is `../out`. Next.js is configured with `output: "export"` and
  `trailingSlash: true`; there is no server runtime.
- Tauri serves the export over its internal protocol: `http://tauri.localhost` on
  Windows and `tauri://localhost` on macOS/Linux. Because these are origin roots,
  the root-absolute `/_next/...` URLs Next.js emits resolve correctly. No
  `assetPrefix`, custom HTTP server, or `file://` workaround is needed.
- `public/pdf.worker.min.mjs` is served from the same protocol with the MIME type
  inferred from the extension (`.mjs` is JavaScript), so the PDF.js module worker
  loads normally. Keep the worker version matched to `pdfjs-dist` as described in
  `AGENTS.md`.
- Tauri's content security policy is intentionally unset (`"csp": null`). The app
  uses inline bootstrap scripts, module workers, WASM, blob URLs, and HTTPS
  downloads, and enforcing a CSP would require a carefully maintained allowlist.
  Navigation is instead restricted in Rust.
- Window drag-and-drop is disabled in `tauri.conf.json`
  (`"dragDropEnabled": false`) so the web app's own drop zone receives dropped
  files on Windows. Turning it back on would intercept file drops at the native
  layer.

### Window and links

`src-tauri/tauri.conf.json` defines the main window:

- Title: `ReadAloud`
- Default size: 1100 x 800
- Minimum size: 360 x 600
- Resizable, centered, not fullscreen

`src-tauri/src/lib.rs` registers a small navigation plugin. It allows only the
bundled app origin (or `http://localhost:3000` in development) to load in the
window. Other `http`, `https`, `mailto`, and `tel` links are handed to the system
browser, and the in-app navigation is cancelled. The opener plugin also handles
`target="_blank"` links, using the `opener:default` capability in
`src-tauri/capabilities/default.json`.

## Voices and offline use

There are two speech paths, and neither needs a Kokoro server:

1. **Browser/OS voices.** The WebView exposes the system speech synthesizer
   (`speechSynthesis`). On Windows these are the installed Windows voices; on
   macOS the system voices; on Linux, WebKitGTK uses speech-dispatcher when it is
   installed. This is the zero-setup default.
2. **On-device Kokoro.** `lib/device-kokoro.ts` lazily loads `kokoro-js` and runs
   the quantized Kokoro-82M ONNX model on WebAssembly inside the WebView. The
   first model use downloads `onnx-community/Kokoro-82M-v1.0-ONNX` from Hugging
   Face and stores it in Cache Storage (`transformers-cache`). Individual voice
   embeddings are cached in `kokoro-voices`. The ONNX Runtime WASM files are
   fetched from the jsDelivr CDN on the first generation and normally come from
   the WebView HTTP cache afterwards.

Practical consequences:

- The very first on-device Kokoro load/generation needs internet access. After
  the model and the chosen voice are cached, the app can synthesize offline.
- The cache lives in the WebView profile inside the app's user-data directory.
  Clearing site data, resetting the WebView profile, or uninstalling the app
  removes it, and the next use needs a download again.
- `~80 MB` of model weights are written to Cache Storage; the platform WebView
  must be allowed to use that much space.
- If the on-device engine fails, the app falls back to the system/device voice;
  the optional Kokoro **server** mode still accepts a local server URL but is
  never required.
- A fully offline first run would require vendoring the model and the ORT WASM
  binaries into the bundle and changing the app code; that is not part of this
  wrapper.

### Where app data lives

Tauri uses the identifier `app.readaloud.reader` for application data and the
WebView profile. Uploaded-file history (IndexedDB) and downloaded Kokoro model
data stay on the machine. Pasted text is still ephemeral, exactly as in the web
build. Removing the app's data directory also removes history and cached voices.

## Packaging notes

- Product name: `ReadAloud`; identifier: `app.readaloud.reader`.
- Icons were generated from `public/icon-512.png` with `npx tauri icon` and live
  in `src-tauri/icons/` (`icon.ico`, `icon.icns`, PNG sizes, plus mobile sizes that
  the desktop build ignores). Re-run that command after changing the source icon.
- Bundles are unsigned. Windows SmartScreen and macOS Gatekeeper will warn about
  unsigned builds. Production distribution needs code-signing/notarization
  credentials, which are not configured in this repository.
- No auto-updater is configured. Distributing updates means shipping a new
  installer.
- The `src-tauri/target/` directory and generated ACL schemas are ignored by
  `src-tauri/.gitignore`.

## Known limitations

- Tauri builds only for the host OS; there are no CI workflows or cross-compile
  targets for desktop packages here.
- System voice availability and quality depend on the OS WebView. Minimal Linux
  installs may have no speech-dispatcher voices until one is installed.
- On-device Kokoro needs a one-time network download and uses WASM on the CPU; the
  first generation is slower than later ones, and very old/low-memory machines
  may struggle with the model.
- The app relies on Cache Storage and IndexedDB. Private/incognito-style WebView
  profiles or aggressive cleanup tools can discard cached model data.
- Tauri's custom-protocol origin differs between Windows (`http://tauri.localhost`)
  and macOS/Linux (`tauri://localhost`). Code that hard-codes an origin would
  break; the existing app uses relative URLs and works on both.
- Large PDFs still follow the web app's lazy rendering and page-eviction rules;
  test with a several-hundred-page file on low-end hardware.
- Native menus, tray icons, file associations, and deep links are not configured.
- The desktop wrapper does not add telemetry or network uploads. Document parsing
  remains local, and the only network traffic is the optional Kokoro model/CDN
  download.

## Verification checklist

```bash
npx tsc --noEmit
npm run build
npm run desktop:info
npm run desktop:build -- --no-bundle   # optional, first Rust build is slow
```

Then launch the release binary and check:

- A PDF, DOCX, TXT, and Markdown file all open and read with a system voice.
- Dragging a file onto the drop zone works.
- The PDF worker loads (no "API version does not match the Worker version").
- An external footer link opens in the system browser, not inside the app window.
- Optional: select the on-device Kokoro engine, let the model download, then
  disable networking and confirm playback still works with the cached model.
