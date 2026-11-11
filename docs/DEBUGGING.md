# Debugging

This guide covers the in-repo diagnostics, the browser console API, and the failure modes most likely to affect PDF loading, speech, storage, and the Android shell.

## Enabling debug mode

Any one of these enables diagnostics:

| Method | How |
| --- | --- |
| URL flag | Open the app with `?debug=1` |
| Persistent flag | In the console: `localStorage.setItem('readaloud:debug', '1')`, then reload |
| Build-time flag | `NEXT_PUBLIC_READALOUD_DEBUG=1` when running `npm run dev` or `npm run build` |

With debug enabled, a **Debug** button appears in the top-right of the app. The panel shows:

- **PDF** — phase, total pages, text-ready pages, rendered pages, text/render concurrency, OCR pages, and errors.
- **Log** — the latest entries (time, scope, message, optional data), with **Copy** and **Clear**.
- **Copy** — writes a JSON snapshot of stats and the full buffered log to the clipboard.

The log buffer is capped at 250 entries. Debug logging is compiled in but disabled at runtime when the flag is off; it does not write to temp folders or a remote service.

## Console API

`lib/debug.ts` installs `window.__readaloudDebug` after the panel mounts (and only in the browser):

```js
window.__readaloudDebug.enabled()   // boolean
window.__readaloudDebug.stats()     // current stats object
window.__readaloudDebug.entries()   // buffered entries (max 250)
window.__readaloudDebug.clear()     // clear log entries
window.__readaloudDebug.snapshot()  // { stats, entries: last 80 } — safe to copy
```

Use `snapshot()` when reporting an issue. Review it before sharing: it contains page counts, timings, URLs, and error messages, but the app does not intentionally log document text, filenames, or selection contents.

## Log scopes

`debugLog(scope, message, data?)` prints `[readaloud:<scope>] <message>` and stores the entry. Common scopes:

| Scope | Source | Examples |
| --- | --- | --- |
| `pdf` | `PdfViewer.tsx` | read file bytes, open document, first page text, viewer ready, extraction complete, render failure |
| `ocr` | `PdfViewer.tsx` / `ocr.ts` | OCR failure, page status |

`debugTime(scope, label)` measures elapsed time with `performance.now()` and logs it, returning the duration. Timings are emitted as log entries such as `first page text 412ms`.

Expected messages during a healthy load:

```text
[readaloud:pdf] read file bytes 18ms {bytes: 2458112}
[readaloud:pdf] open document 320ms {pages: 240}
[readaloud:pdf] viewer ready 344ms {pages: 240, scale: 1.5}
[readaloud:pdf] first page text 390ms {page: 1, segments: 34}
[readaloud:pdf] text extraction complete 2140ms {pages: 240, textReady: 240, scannedPages: 0}
```

## Debug statistics

The PDF stats object can include:

| Field | Meaning |
| --- | --- |
| `phase` | `reading`, `extracting`, `ready`, or `error` |
| `totalPages` | PDF page count |
| `textReady` | Pages whose text has been appended |
| `renderedPages` | Pages currently holding a canvas |
| `textConcurrency` | Text workers in use |
| `renderConcurrency` | Maximum simultaneous renders |
| `ocrPages` | Pages classified as scanned |
| `error` | Last PDF/open error |
| `docLoadMs`, `firstTextMs`, `allTextMs` | Timing fields when recorded |

A healthy large book shows `textReady` rising steadily while `renderedPages` stays within the device budget (roughly 6–12).

## Common issues

### “The API version does not match the Worker version”

**Cause:** `public/pdf.worker.min.mjs` is from a different `pdfjs-dist` release than the installed package.

**Fix:**

```bash
cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs public/pdf.worker.min.mjs
```

On Windows PowerShell:

```powershell
Copy-Item node_modules/pdfjs-dist/build/pdf.worker.min.mjs public/pdf.worker.min.mjs -Force
```

Rebuild afterwards. Keep the worker and `pdfjs-dist` version in the same change. If the app is hosted under a subpath, `NEXT_PUBLIC_BASE_PATH` must be set at build time; the worker URL is `${basePath}/pdf.worker.min.mjs`.

### CORS or mixed-content errors when calling Kokoro

**Symptoms:** the voice sheet stays empty or shows “server offline”; console reports `blocked by CORS policy` or `Mixed Content`.

**Checks:**

1. The server is running and ready:

   ```bash
   curl http://localhost:8880/health
   ```

2. The URL in the Kokoro panel matches the server, including scheme and port. `localhost` and `127.0.0.1` are different origins to the browser.
3. The server enables CORS. `server/main.py` uses `allow_origins=["*"]`; if you changed it, add the app's origin.
4. An `https://` page cannot fetch `http://localhost` in most browsers. Use an `http://` development page, or put the server behind HTTPS.
5. For a phone, use the computer's LAN IP (for example `http://192.168.1.20:8880`), ensure the server binds `0.0.0.0` (it does), and allow port 8880 through the host firewall.

### Kokoro reports model loading or offline

- `/health` returning `{"status":"loading"}` means the background model load is still running. Wait and poll again.
- `{"status":"error"}` includes the loader error. Common causes: missing `kokoro-v1.0.onnx` or `voices-v1.0.bin`, a path typo, or insufficient memory.
- Check `/voices`; it waits briefly for the model and returns 503 with a useful message if loading failed.
- The app falls back to browser/native TTS when a Kokoro request fails. A single failed sentence does not stop playback.
- If only MP3 export fails, confirm the server is current enough to support `/tts/batch`; older servers return 404/405 and the exporter falls back to per-sentence requests automatically.

### IndexedDB quota or history failures

**Symptoms:** history entry disappears, “could not store” message, or `QuotaExceededError` in the console.

**Causes:** browser storage pressure, private/incognito mode, a very large PDF, or accumulated generated audio.

**Fix:**

1. Open **Recent documents** and delete old entries or choose **Clear all**.
2. Clear generated audio cache via the browser's site-data settings (the Kokoro audio cache is separate from history).
3. Free disk space; browsers enforce per-origin quotas that include IndexedDB and Cache Storage.
4. Check `<browser>://settings/siteData` for the app origin.
5. In private mode, expect storage to be unavailable; the app should continue without history.

The history saver drops the oldest other entry and retries once when a write exceeds quota. If even that fails, the error is surfaced to the caller.

### Android cannot reach the Kokoro server (cleartext blocked)

**Symptoms:** the web version works, but the APK cannot fetch voices or audio; logcat/browser console mentions `CLEARTEXT communication not permitted`.

**Checks:**

1. `capacitor.config.ts` has:

   ```ts
   server: { androidScheme: 'https', cleartext: true },
   android: { allowMixedContent: true },
   ```

2. The URL uses the host's LAN IP, not `localhost` (the device's localhost is the phone itself).
3. The server is reachable from the phone's browser first: `http://<host-ip>:8880/health`.
4. Windows Firewall allows inbound TCP 8880 on the private network.
5. After changing Capacitor config, run `npm run mobile:sync` and rebuild the APK. Config changes are not hot-reloaded.

If you ship a production build, prefer an HTTPS Kokoro endpoint and remove cleartext/mixed-content allowances.

### Audio never starts

- Browser autoplay policies require a user gesture. Click a sentence or the play button.
- Check that the document has segments (`window.__readaloudDebug` does not expose them; use the player bar count).
- For Kokoro, check `/health` and `/voices`; inspect the network panel for the `/tts` request and response.
- For browser voices, run `speechSynthesis.getVoices()` in the console. An empty list usually means the OS has no voices installed or the page is not allowed to use them.

### PDF renders but highlighting is misaligned

- The text layer depends on the `--total-scale-factor` CSS variable and exact viewport dimensions. Do not override the text layer's width/height independently of the canvas.
- A worker/API version mismatch can produce incorrect text items.
- After zoom changes, the viewer cancels and rebuilds the text layer; if you see stale highlights, check that `rebuildForScale` ran (debug log shows a new render epoch behavior).
- Text-layer span indices must match `textContent.items` order. Empty items are not appended to the DOM and are skipped.

### OCR never finishes or fails

- Tesseract downloads its worker/core/language assets on first use. Check network access and storage.
- OCR is serial and CPU-heavy; large scanned books can take minutes. Watch the progress pill and debug log.
- Only the English model is configured (`createWorker('eng', 1)`).
- If OCR fails, extracted text from non-scanned pages is preserved.

### Native TTS does not work in the browser

`lib/native-tts.ts` is gated by `Capacitor.isNativePlatform()`. In a normal browser it returns no voices and `speakNative` throws by design. Test native TTS in the Android shell.

### APK build cannot find the SDK or JDK

- Set `JAVA_HOME` to a JDK 21 installation (Android Studio's bundled JBR works).
- Set `ANDROID_HOME`/`ANDROID_SDK_ROOT`, or open `android/` in Android Studio once to create `local.properties`.
- Ensure platform/build tools for API 36 are installed.
- Re-run `npm run mobile:apk`; the command rebuilds `out/` and syncs before Gradle.

## Generating a large PDF fixture

```bash
npm run debug:pdf
# or choose page count/output
node scripts/generate-large-pdf.mjs 800 debug/fixtures/eight-hundred.pdf
```

The dependency-free generator writes `debug/fixtures/large-sample.pdf` (400 pages by default, maximum 2000). Generated fixtures are git-ignored. Use it to check first-text latency, scrolling/eviction, sentence order, playback across append boundaries, and MP3 export batching.

## Reproduction checklist

When filing an issue, include:

- App version/commit, browser and OS, and whether the web app or Android shell is used.
- Input type and approximate size/page count; do not attach confidential documents. A synthetic fixture is ideal.
- Whether Kokoro, browser TTS, or native TTS was selected; the server URL host/port (redact private network details if needed).
- `window.__readaloudDebug.snapshot()` from `?debug=1`, after reproducing the issue.
- Console errors and the Network panel status for `/health`, `/voices`, and `/tts`.
- Whether the problem reproduces after clearing site data and rebuilding.

## Verifying a fix

```bash
npx tsc --noEmit
npm run lint
npm test
npm run build
```

For PDF changes, also test a large fixture and confirm:

- text appears before all pages finish;
- page order and sentence indices stay stable;
- `renderedPages` stays bounded while scrolling;
- playback continues across a page-append boundary;
- zoom rebuilds do not leak canvases or workers.
