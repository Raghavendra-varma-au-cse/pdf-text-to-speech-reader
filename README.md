# ReadAloud

ReadAloud is a local-first PDF and text-to-speech reader. Open a PDF, DOCX, TXT, or Markdown file (or paste text), then listen sentence by sentence with synchronized highlighting, adjustable speed, and local document history.

The web app is a Next.js static export: there is no application backend and documents are parsed in the browser. Speech can come from the browser/OS voice engine, a local Kokoro server, or the native Android TTS engine when the app runs in its Capacitor shell.

![ReadAloud screenshot](screenshot.png)

## Overview

| Area | What it does |
| --- | --- |
| Input | PDF, DOCX, TXT, Markdown, and pasted text |
| Reading | Sentence-level segments, click-to-play, selection actions, scrubber, page jump, auto-follow |
| Speech | Browser/Web Speech, local Kokoro server, Capacitor native TTS, optional on-device Kokoro module |
| Export | One MP3 for the whole book, the current page, or from the current sentence (Kokoro only) |
| Storage | Documents in IndexedDB; settings in `localStorage`; generated Kokoro audio cached in IndexedDB |
| Accessibility | Keyboard playback controls, ARIA labels, light/dark themes, large-text reader mode |

ReadAloud is free and does not require an account. The original author is credited in the UI and in `package.json` as **Imran Pollob**.

## Features

- **Progressive PDF loading** — the first page appears quickly while remaining pages render on demand.
- **Lazy, virtualized pages** — off-screen pages stay as lightweight placeholders; only a bounded number of page bitmaps are kept alive.
- **Ordered parallel text extraction** — pages are parsed concurrently, but sentence order and list indices always follow page order.
- **Listen before the whole file is ready** — playback starts as soon as the first page has text; it waits for the next page at the end of loaded text.
- **Selection-based reading** — click any sentence to continue from there, or Shift-click to read only that sentence. Selecting text exposes **Continue** and one-shot buttons in the player bar.
- **Playback controls** — play/pause, previous/next sentence, stop, sentence scrubber, and a page navigator with jump-to-page.
- **Speed control** — 0.5x to 3x, with presets and fine 0.05x steps; the setting is shared by browser, native, and Kokoro playback.
- **Local history** — recently opened uploaded files can be reopened without uploading again.
- **Math-to-speech** — expands common Unicode and LaTeX notation (`x²`, `H₂O`, `\frac{1}{2}`, Greek letters) into spoken words when math speech is enabled.
- **MP3 export** — synthesize a Kokoro voice into a single MP3, with batching, progress, ETA, cancellation, and cache reuse.
- **Lightweight OCR** — opt-in, on-device Tesseract OCR for scanned PDF pages, using the English model.
- **Debug panel** — open `?debug=1` to inspect PDF phases, timings, page counts, and an in-app log.
- **Mobile shell** — Capacitor Android project with native TTS as the automatic local engine.

## Quick start

Requirements: Node.js 20+ and npm. Python is only needed for the optional Kokoro server.

```bash
git clone <repository-url>
cd pdf-text-to-speech-reader
npm install
npm run dev
```

Open <http://localhost:3000>. The app works immediately with the browser's built-in voices.

Other useful commands:

```bash
npm run build      # static export; output is written to out/
npm test           # Node test runner suite
npm run lint       # ESLint
npm run debug:pdf  # generate a 400-page PDF at debug/fixtures/large-sample.pdf
```

> `npm run debug:pdf` runs the dependency-free `scripts/generate-large-pdf.mjs`. Pass a page count or output path directly for a different fixture:
>
> ```bash
> node scripts/generate-large-pdf.mjs 800 debug/fixtures/eight-hundred.pdf
> ```
>
> Generated fixtures are git-ignored.

### Static hosting

`npm run build` produces a fully static site in `out/`. For a GitHub Pages-style subpath build:

```bash
# Git Bash / macOS / Linux
NEXT_PUBLIC_BASE_PATH=/pdf-text-to-speech-reader npm run build

# PowerShell
$env:NEXT_PUBLIC_BASE_PATH = "/pdf-text-to-speech-reader"
npm run build
```

The base path is also used to resolve the PDF.js worker (`pdf.worker.min.mjs`) and other public assets.

## Local Kokoro server

Kokoro is optional but recommended for high-quality neural voices and MP3 export. Prerequisites: Python 3.10+ and [uv](https://docs.astral.sh/uv/getting-started/installation/).

```bash
cd server
uv sync

# Download the model and voice pack (about 335 MB total)
curl -L -o kokoro-v1.0.onnx https://github.com/nazdridoy/kokoro-tts/releases/download/v1.0.0/kokoro-v1.0.onnx
curl -L -o voices-v1.0.bin  https://github.com/nazdridoy/kokoro-tts/releases/download/v1.0.0/voices-v1.0.bin

uv run python main.py
```

On Windows PowerShell, download the two files with:

```powershell
Invoke-WebRequest -Uri https://github.com/nazdridoy/kokoro-tts/releases/download/v1.0.0/kokoro-v1.0.onnx -OutFile kokoro-v1.0.onnx
Invoke-WebRequest -Uri https://github.com/nazdridoy/kokoro-tts/releases/download/v1.0.0/voices-v1.0.bin -OutFile voices-v1.0.bin
```

The server listens on `http://localhost:8880` and loads the model in a background thread. Check readiness with:

```bash
curl http://localhost:8880/health
```

In the app, open the voice menu, switch to **Kokoro Neural**, and pick a voice. The default server URL is `http://localhost:8880`; change it in the same panel if needed (for phones, use the computer's LAN address).

Server endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Model load status and errors |
| `GET` | `/voices` | Available Kokoro voices |
| `GET` | `/languages` | Languages exposed by the model |
| `POST` | `/tts` | One text string, returns `audio/wav` |
| `POST` | `/tts/batch` | Many strings concatenated into one WAV |
| `POST` | `/warmup` | Run one short synthesis to warm the model |

Useful environment variables: `KOKORO_MODEL_PATH`, `KOKORO_VOICES_PATH`, `KOKORO_CONCURRENCY` (default 2), `KOKORO_INTRA_OP_THREADS`, `KOKORO_READY_WAIT`, `KOKORO_MAX_BATCH_TEXTS` (default 64), `KOKORO_CACHE_ENTRIES`, `KOKORO_CACHE_MAX_MB`, and `ONNX_PROVIDER`.

## Mobile APK build (Capacitor Android)

The Android project lives in `android/`; `capacitor.config.ts` uses `webDir: "out"` and app id `app.readaloud.reader`.

Prerequisites:

- Android Studio or the Android SDK with API 36 platform/build tools installed.
- JDK 21 recommended (the Android Studio bundled JBR is fine). Gradle 8.14.3 and Android Gradle Plugin 8.13 are used.
- `JAVA_HOME` and `ANDROID_HOME` set, or `android/local.properties` created with `sdk.dir=...` (Android Studio creates this when you open the project).

PowerShell:

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
java -version

npm install
npm run mobile:apk
```

Command Prompt:

```bat
set JAVA_HOME=C:\Program Files\Android\Android Studio\jbr
set PATH=%JAVA_HOME%\bin;%PATH%
set ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk

npm install
npm run mobile:apk
```

`npm run mobile:apk` runs `npm run mobile:sync` (static build + `npx cap sync android`) and then `gradlew.bat assembleDebug` inside `android/`.

Output:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Other mobile commands:

```bash
npm run mobile:sync   # next build + cap sync android
npm run android       # cap open android (Android Studio)
npx cap sync android  # sync web assets after a build
```

If Gradle cannot find the SDK, open `android/` once in Android Studio and let it create `android/local.properties`, or set `ANDROID_HOME`/`ANDROID_SDK_ROOT`.

## Usage tips

### Reading

- **Click a sentence** in the PDF or text view to start playback from that sentence.
- **Shift-click a sentence** to read only that sentence and stop.
- **Select text** to reveal two buttons in the player bar: **Continue** reads from the selected sentence onward, while the stop-style button reads only the selected sentence.
- **Scrubber** — drag the sentence slider to jump; playback continues if it was already playing.
- **Page jump** — use the floating page navigator to type a page number or step one page at a time.
- **Following** — the settings menu toggles auto-scroll. **Locate sentence** scrolls the active sentence to the center.
- **Keyboard** — Space plays/pauses, Left/Right moves one sentence, Escape closes open menus.

### Voices and speed

- Browser/OS voices work without setup. Kokoro voices require the local server.
- The speed menu covers 0.5x–3x with presets and 0.05x fine adjustment. The value persists across sessions.
- In the Android app, native TTS is used automatically when no cached Kokoro audio exists, so playback works offline.

### History

- Uploaded files are saved locally in IndexedDB and appear under **Recent documents** or the header clock button.
- Reopening a history entry does not re-upload the file.
- History is bounded (12 entries) and can be cleared from the history list. Pasted text is never saved.

### MP3 export

1. Start the Kokoro server and select a Kokoro voice.
2. Open **Download MP3** from the player bar (on phones, it is under the settings menu).
3. Choose **Whole book**, **Page N**, or **From here**.
4. Watch progress/ETA, or cancel the export at any time.

Browser and native voices cannot be captured, so MP3 export is disabled unless a Kokoro voice is active. Sentences already cached in IndexedDB are reused.

### OCR for scanned PDFs

If no selectable text is found, the viewer offers **Run OCR**. OCR is on-device via `tesseract.js`, uses the English model (downloaded once and cached by the browser), and processes pages serially. Pages with very little extracted text are treated as scanned.

### Math speech

With **Math speech** enabled in the settings menu, notation is expanded for the speech engine:

| Input | Spoken as |
| --- | --- |
| `x²` | x squared |
| `H₂O` | H sub 2 O |
| `\frac{1}{2}` | 1 over 2 |
| `\sqrt{9} = 3` | square root of 9 equals 3 |
| `α + β` | alpha plus beta |

The conversion is heuristic and deliberately leaves URLs, email addresses, hyphenated prose, and file paths alone.

## Project structure

```text
app/
  layout.tsx                 # metadata, fonts, header, global styles
  page.tsx                   # home, import, reader mode, dialogs
  globals.css                # Tailwind v4 theme and component styles
components/
  PdfViewer.tsx              # lazy PDF rendering, text layer, OCR, selection
  TextViewer.tsx             # sentence-segmented text reader
  FormattedDocumentViewer.tsx# sanitized Markdown/DOCX HTML view
  PlayerBar.tsx              # transport, scrubber, speed, selection actions
  VoiceSheet.tsx             # browser/Kokoro voice picker and server URL
  DownloadAudioDialog.tsx    # MP3 export scopes and progress
  HistorySheet.tsx           # local history bottom sheet
  DocumentHistory.tsx        # history list, usage, delete/clear
  PageNavigator.tsx          # page jump control
  SpeedMenu.tsx              # 0.5x–3x speed picker
  AudioEngine.tsx            # headless playback router
  DebugPanel.tsx             # in-app diagnostics panel
  KokoroDeviceDownload.tsx   # optional on-device Kokoro download UI
  Header.tsx, Icons.tsx      # chrome and icon set
store/
  use-audio-store.ts         # Zustand playback, settings, cache, prefetch
lib/
  text-normalizer.ts         # PDF/text → sentence segments
  pdf-page-scheduler.ts      # ordered parallel work pool
  pdf-viewer-utils.ts        # fit scale, DPR cap, budgets, concurrency
  document-import.ts         # TXT/Markdown/DOCX import
  document-history.ts        # IndexedDB history
  audio-export.ts            # Kokoro → WAV → MP3 pipeline
  math-speech.ts             # notation → spoken words
  ocr.ts                     # tesseract.js OCR session
  native-tts.ts              # Capacitor native TTS adapter
  device-kokoro.ts           # optional on-device Kokoro engine module
  debug.ts                   # debug flag, log buffer, console API
  text-metrics.ts, hash.ts, segment-hover.ts, cn.ts
types/
  index.ts                   # shared store and segment types
server/
  main.py                    # FastAPI Kokoro server
  pyproject.toml
android/                     # Capacitor Android project
tests/                       # Node test runner suites
scripts/                     # debug fixture generator
public/                      # static assets, PDF.js worker, manifest
```

## Testing

```bash
npm test
```

The suite uses Node's built-in test runner through `jiti` and covers:

- sentence segmentation for prose, abbreviations, citations, versions, URLs, decimals, and math;
- PDF text normalization and span-fragment mapping;
- ordered parallel scheduling (ordering, concurrency limit, abort);
- math speech expansion and prose preservation;
- fit-scale, DPR cap, page budget, history fingerprints, and word metrics.

Run `npm run lint` before opening a pull request. There is no browser end-to-end harness in the repository; verify UI changes manually in a browser and, for mobile changes, in the Android shell.

## Debugging

Open the app with `?debug=1` to show the Debug panel in the top-right corner. You can also enable it with `localStorage.setItem('readaloud:debug', '1')` or `NEXT_PUBLIC_READALOUD_DEBUG=1` at build time.

The panel shows PDF phase, page counts, text/render concurrency, OCR pages, and the latest log entries. It can copy diagnostics to the clipboard. In the console:

```js
window.__readaloudDebug.snapshot()  // stats + recent entries
window.__readaloudDebug.stats()
window.__readaloudDebug.entries()
window.__readaloudDebug.clear()
```

See [docs/DEBUGGING.md](docs/DEBUGGING.md) for logs, common failure modes, and a reproduction checklist. Performance tuning is covered in [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## Privacy

- Documents are parsed locally in the browser. There is no upload endpoint in this repository and no account system.
- Uploaded files are stored only in the browser's IndexedDB for local history. Pasted text is not stored.
- Generated Kokoro audio is cached in IndexedDB on the device.
- Network requests come from: same-origin static assets (including the PDF.js worker), the Kokoro server URL you configure, Tesseract OCR assets on first use, and—only if you use the optional on-device Kokoro module—model/voice downloads from the Hugging Face CDN and ONNX Runtime WASM assets from jsDelivr.
- The local Kokoro server enables permissive CORS so the browser can call it. Run it on a trusted network; it has no authentication.
- The Android shell enables cleartext HTTP for LAN Kokoro servers. Use HTTPS or remove that setting for production distributions.

## Limitations

- Scanned PDFs need OCR first; OCR is English-only and CPU-intensive on large books.
- MP3 export uses a Kokoro voice (server or on-device). Browser and native OS voices cannot be recorded.
- Word-level highlighting is available for browser/native TTS; Kokoro audio highlights at the sentence level.
- Paragraph reflow is heuristic, especially for multi-column PDFs and complex layouts.
- Very large PDFs and high zoom levels are memory-bound; the viewer evicts far pages but cannot make a huge book free.
- On-device Kokoro is optional and needs a one-time model/voice download (~80 MB model). Its first load needs a network connection; model download cancellation is best-effort because `kokoro-js` does not expose an abort signal.
- The Android project is configured for debug builds. Release signing is not set up in the repository.
- No cloud sync, user accounts, or server-side document storage.
- Math speech is heuristic; ambiguous notation may be read literally or expanded unexpectedly.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Blank PDF / worker error | PDF.js worker version mismatch. Copy the matching `node_modules/pdfjs-dist/build/pdf.worker.min.mjs` to `public/pdf.worker.min.mjs`, then rebuild. Check `NEXT_PUBLIC_BASE_PATH` when hosting under a subpath. |
| Kokoro tab shows “server offline” | Start `uv run python main.py`, check `curl http://localhost:8880/health`, and confirm the URL in the voice panel. From a phone, use the computer's LAN IP, not `localhost`. |
| Kokoro requests fail with CORS/mixed content | Ensure the server is running (it enables CORS), use `http://` from an `http://` page, and open the firewall for port 8880 on LAN. |
| MP3 export button disabled | Select a Kokoro voice first; browser/native voices cannot be exported. |
| No text found in a PDF | The PDF is scanned. Run OCR, or check that the PDF has a real text layer. |
| OCR fails to start | The English Tesseract model downloads on first use; check network access and browser storage. |
| History is missing after reopening | Browser storage was cleared, private mode is active, or the 12-entry limit evicted the file. |
| Where is history stored? | In IndexedDB, the browser's built-in local database. There is no MySQL or application server; this keeps the app standalone and private. |
| IndexedDB quota errors | Clear old history and cached audio, or free disk space. The history saver retries once after dropping the oldest entry. |
| Audio does not start | Browser autoplay policies may require a click. Click a sentence or the play button. |
| Android app cannot reach Kokoro | Use the LAN URL, keep `cleartext: true` and `allowMixedContent: true` in `capacitor.config.ts`, and allow port 8880 through the firewall. |
| Android build fails on SDK/JDK | Set `JAVA_HOME` (JDK 21 recommended) and `ANDROID_HOME`, or open `android/` in Android Studio to create `local.properties`. |
| APK is stale after web changes | Run `npm run mobile:sync` (or `npm run mobile:apk`) so `out/` is rebuilt and synced into `android/`. |

## Contributing

Changes are tracked in git history and through this repository's GitHub issues and pull requests. Please keep pull requests focused, include tests for logic changes, and describe manual verification for UI or mobile changes.

- Open issues and PRs at <https://github.com/imranpollob/pdf-text-to-speech-reader>.
- If a workflow needs a direct contact, use the repository issue tracker rather than adding personal contact details to the docs.
- When referencing a contributor in release notes, use their GitHub handle, for example `<your-github-handle>`.

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for setup, conventions, extension points, and the PR checklist.

## Next features

The next round of work is intentionally scoped so a new contributor can pick up a
self-contained item:

- **Bookmarks, notes, and resume points** stored locally per document.
- **Word-level highlighting in the PDF text layer** (text mode already highlights the
  spoken word in real time; PDFs currently highlight the sentence).
- **EPUB and HTML import** through the same segment/highlight pipeline.
- **Chapter-aware MP3 export** (one file per chapter, plus a single merged book).
- **OCR queue with resume** for scanned books, including non-English language packs.
- **Reader themes and typography presets** (sepia, high contrast, dyslexia-friendly).
- **Media Session / lock-screen controls** so playback continues from the notification
  shade on Android and the desktop media keys.
- **On-device model manager** for multiple Kokoro voices and storage usage.
- **Optional encrypted sync** of reading progress (off by default, privacy-first).
- **More math coverage**: matrices, integrals with limits, and MathML from DOCX.

See the issue tracker for the current priority list and good-first-issue labels.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Downloads](docs/DOWNLOADS.md)
- [Contributing](docs/CONTRIBUTING.md)
- [Debugging](docs/DEBUGGING.md)
- [Mobile](docs/MOBILE.md)
- [Desktop](docs/DESKTOP.md)
- [Performance](docs/PERFORMANCE.md)
- [Changelog](CHANGELOG.md)
- [Contributors](CONTRIBUTORS.md)
- [Security policy](SECURITY.md)

## License

MIT. See [LICENSE](LICENSE) for the full text. Bundled dependencies and their licenses are
summarized in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
