<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# ReadAloud — Agent and Contributor Guide

This file is the operating guide for anyone (human or agent) changing this repository.
Read it before touching code. The generated block above is managed by `next dev` and must
be preserved verbatim.

## 1. Project overview

ReadAloud is a client-side PDF, DOCX, Markdown, and plain-text reader with synchronized
text-to-speech and sentence highlighting. It ships in two forms from one codebase:

- A static Next.js web app (GitHub Pages–compatible export).
- A Capacitor Android shell that loads the same static export.

Goals that drive design decisions:

- **Privacy first.** Documents are parsed in the browser. Uploaded files may be cached
  locally (IndexedDB) for convenience; pasted text is never persisted. No telemetry, no
  document uploads to a third party.
- **Large documents stay usable.** Text extraction, rendering, and playback are streamed
  and bounded so a 1,000-page PDF does not freeze a phone.
- **Playback continuity.** Adding pages while reading must never interrupt the sentence
  being spoken or invalidate sentence indices.
- **Two speech engines.** Browser/native TTS works everywhere; a local Kokoro server (or
  optional on-device Kokoro) provides higher-quality neural voices.
- **Accessible, responsive UI.** Keyboard, screen readers, reduced motion, dark/light
  themes, and narrow phone widths are first-class.

## 2. Architecture map

```
app/            Next.js App Router
  layout.tsx      Metadata, fonts, theme, vendored brand launcher CSS
  page.tsx        The single client page: upload, paste, reader, history, FAQ
  globals.css     Tailwind v4 entry and design tokens

components/     React client components
  AudioEngine.tsx            Audio element / Web Speech / native TTS driver
  PdfViewer.tsx              PDF.js canvas + text layer, paging, OCR, highlights
  TextViewer.tsx             Plain-text reader with per-sentence spans
  FormattedDocumentViewer.tsx Sanitized DOCX/Markdown HTML with highlight mapping
  PlayerBar.tsx              Transport controls, progress, selection actions
  Header.tsx                 Navigation, theme, history trigger, tools launcher
  VoiceSheet.tsx             Browser / Kokoro / on-device voice picker
  SpeedMenu.tsx, PageNavigator.tsx
  DocumentHistory.tsx, HistorySheet.tsx
  DownloadAudioDialog.tsx    MP3 export UI
  KokoroDeviceDownload.tsx   On-device model download UI
  DebugPanel.tsx, Icons.tsx

lib/            Framework-agnostic logic (mostly unit-tested)
  text-normalizer.ts     Sentence segmentation for PDF text and raw text
  pdf-page-scheduler.ts  Ordered bounded-concurrency page pool
  pdf-viewer-utils.ts    Fit scale, DPR cap, page budget, concurrency heuristics
  document-history.ts    IndexedDB file history (metadata + blobs)
  document-import.ts     DOCX (Mammoth) and Markdown (markdown-it) import
  math-speech.ts         Math notation -> spoken words
  audio-export.ts        Kokoro audio -> single MP3 export
  native-tts.ts          Capacitor native speech bridge
  ocr.ts                 Lazy tesseract.js OCR session
  device-kokoro.ts       Optional in-browser Kokoro (kokoro-js)
  text-metrics.ts        Word counting and prefix sums
  segment-hover.ts, hash.ts, debug.ts, cn.ts

store/          Zustand store: playback, segments, TTS settings, zoom, history UI state
server/         Local FastAPI + kokoro-onnx TTS backend (`POST /tts`)
tests/          node:test suites run through jiti
android/        Capacitor Android project (generated; web assets copied by `cap sync`)
src-tauri/      Optional Tauri (Rust) desktop shell; builds the same static export
public/         Static assets, including the PDF worker and the tools launcher
types/          Shared TypeScript interfaces
```

Data flow:

1. `app/page.tsx` accepts a file or pasted text and calls the normalizer
   (`normalizeText` for PDFs, `normalizeRawText` otherwise) to produce ordered
   `TextSegment[]`.
2. Segments go into `useAudioStore` via `loadSegments` / `appendSegments`.
3. `AudioEngine` observes `currentSegmentIndex` and speaks the sentence, then calls
   `next()` to advance.
4. `PdfViewer` / `TextViewer` / `FormattedDocumentViewer` render highlights from the same
   segment index, so playback and display always share one source of truth.

## 3. Critical invariants

Violating any of these is a correctness or data-loss bug, not a style issue.

### 3.1 PDF worker path and version

`public/pdf.worker.min.mjs` is copied manually and must match the installed
`pdfjs-dist` version in `package.json` (currently `5.4.449`). It is addressed as
`${basePath}/pdf.worker.min.mjs` in `components/PdfViewer.tsx`, so it also works under the
GitHub Pages base path.

- Never hard-code `/pdf.worker.min.mjs`; always prefix the build-time base path.
- When upgrading `pdfjs-dist`, replace the worker file in the same change. A mismatch
  throws "The API version does not match the Worker version".
- Keep `pdfjs-dist` imports client-only (`PdfViewer` is dynamically imported with
  `ssr: false`).

### 3.2 Ordered segment indices

Segment order is the contract between extraction, playback, DOM highlighting, selection,
and caching.

- `runOrderedPool` must emit results in ascending page order even though workers finish
  out of order. Do not replace it with `Promise.all` followed by a sort at the wrong layer.
- Once appended, a segment's index must never change. Appending page text extends the
  array; it must not rebuild or re-sort existing segments.
- DOM markers (`data-na-sen-ind`, `nr-s<index>`, `text-seg-<index>`) are derived from that
  index. If you change one side, update every viewer and the selection handlers.

### 3.3 Lazy rendering + bounded page cache

`PdfViewer` creates placeholders for every page but renders only pages near the viewport.
Rendered canvases are evicted beyond a device-dependent budget
(`getRenderedPageBudget`, 6–12 pages), with the current page and the page of the active
segment (±1) protected.

- Do not eagerly render all pages, remove eviction, or increase the budget without
  measuring memory on a low-end phone.
- Call `page.cleanup()` after eviction so PDF.js releases operator lists and fonts.
- Cancel in-flight `RenderTask` / `TextLayer` work when re-rendering or unmounting, and
  treat `RenderingCancelledException` as expected, not an error.

### 3.4 Playback continuity when segments are appended

- `appendSegments` must preserve `currentSegmentIndex`, `playbackStatus`, and the audio
  cache. It resumes automatically only when playback was waiting at the end of loaded
  text (`waitingForMore`).
- Do not call `loadSegments` when a new page arrives; that resets the reader to sentence 0.
- `replaceSegmentsPreservingCurrent` exists for legitimate rebuilds (for example a zoom or
  OCR pass) and re-finds the current sentence by id.

### 3.5 Selection indices

Text selection should propose "read from here" without starting playback.

- Resolve the selected node to the nearest sentence wrapper, parse its index, and validate
  it against `segments.length`; otherwise store `null`.
- PDF uses `nr-sentence[data-na-sen-ind]`, text mode uses `[id^="text-seg-"]`.
- Selection state lives in `selectionSegmentIndex` and is cleared when playback advances.

### 3.6 Math speech

`toSpeechText` is applied at synthesis time (playback, prefetch, MP3 export), never to
`segment.text` itself. Transforming stored text would break highlighting, word ranges,
and sentence identity. Audio cache keys are hashes of the spoken text, so toggling math
speech correctly produces different keys.

### 3.7 History privacy

- Only uploaded files are stored, in IndexedDB (`readaloud-history`), capped at 12
  entries. Metadata listing must not load blobs.
- Pasted text is ephemeral. Legacy cached paste content is actively deleted on startup;
  do not reintroduce a paste cache, analytics, or any network upload.
- Do not log document contents, file names, or selection text to the console or to a
  remote service.

### 3.8 Local tools launcher

`public/brand/launcher.js` and `public/tools.json` are vendored so the launcher works
offline and stays on this deployment. The current app's tile uses `"url": "./"`.

- Keep that tile local. Do not point it at GitHub Pages or another origin, and do not add
  an automatic redirect to an external site.
- The launcher script is injected after hydration and claims `[data-brand-launcher]`; do
  not move it into a server-rendered tag or duplicate the script.

## 4. Commands

Run from the repository root. Node 20 or 22 is supported.

| Command | Purpose |
| --- | --- |
| `npm ci` | Clean, lockfile-exact install (use this in CI) |
| `npm run dev` | Next dev server at http://localhost:3000 |
| `npm run build` | Static export to `out/` (`output: "export"`) |
| `npm run build:gh` | Export with `NEXT_PUBLIC_BASE_PATH=/pdf-text-to-speech-reader` |
| `npm test` | Run all suites registered in `tests/run.mjs` |
| `npm run lint` | ESLint (Next core-web-vitals + TypeScript) |
| `npx tsc --noEmit` | TypeScript check |
| `npm run debug:pdf` | Generate `debug/fixtures/large-sample.pdf` (400 pages by default) |
| `npm run mobile:sync` | Build, then `cap sync android` |
| `npm run mobile:apk` | Build, sync, then `gradlew.bat assembleDebug` (Windows) |
| `npm run android` | Open the Android project in Android Studio |
| `npm run desktop:dev` | Run the Tauri desktop shell against the dev server |
| `npm run desktop:build` | Build the standalone desktop bundle |

Notes:

- `mobile:apk` uses the Windows wrapper. On macOS/Linux run
  `npm run mobile:sync && cd android && ./gradlew assembleDebug`.
- `debug:pdf` runs the dependency-free `scripts/generate-large-pdf.mjs`; pass a page count
  or output path with `node scripts/generate-large-pdf.mjs [pages] [output]`. Generated
  fixtures live under `debug/` and are not committed.
- Kokoro is optional. Start it with `cd server && uv sync && uv run python main.py`; it
  listens on `http://localhost:8880`.

## 5. How to make changes safely

1. **Read the local Next.js docs first.** This Next.js version differs from public
   training data. Start with `node_modules/next/dist/docs/01-app/02-guides/static-exports.md`,
   `01-getting-started/05-server-and-client-components.md`, `02-guides/lazy-loading.md`,
   and `02-guides/building.md`.
2. **Locate the smallest layer that owns the behavior.** Pure logic belongs in `lib/`;
   React state stays in `store/`; rendering stays in `components/`.
3. **Make the change, then verify locally in this order:**
   - `npx tsc --noEmit`
   - `npm run lint`
   - `npm test`
   - `npm run build` (confirm `out/` is produced)
4. **Add or update tests.** Tests use `node:test` with TypeScript loaded by jiti. New test
   files must be added to the explicit list in `tests/run.mjs`; otherwise they never run.
5. **Test with a large PDF** (hundreds of pages, both text-based and scanned) and watch:
   - first text latency and whether text appears before all pages finish,
   - memory growth while scrolling and after eviction,
   - page order and sentence order,
   - play-through across the boundary where new pages are appended.
6. **Check mobile responsiveness** at 360 px and 390 px widths: upload area, player bar,
   sheets/dialogs, safe-area insets, touch target sizes, and `dvh` behavior.
7. **If web assets change and Android matters**, run `npm run mobile:sync`; never hand-edit
   `android/app/src/main/assets/public` (it is generated from `out/`).
8. **Keep base paths working.** Every `public/` asset referenced from code should use the
   `NEXT_PUBLIC_BASE_PATH` prefix, because CI deploys under a subpath.

## 6. Debugging

Enable debug mode in any of these ways:

- Open the app with `?debug=1`.
- In the console: `localStorage.setItem('readaloud:debug', '1')`, then reload.
- Build/dev with `NEXT_PUBLIC_READALOUD_DEBUG=1`.

With debug enabled:

- `window.__readaloudDebug.stats()` — current PDF and storage counters.
- `window.__readaloudDebug.entries()` — last 250 scoped log entries.
- `window.__readaloudDebug.snapshot()` — stats plus the last 80 entries (safe to copy).
- `window.__readaloudDebug.clear()` — clear buffered entries.
- The in-app `DebugPanel` shows the same data.

PDF stats include `phase`, `totalPages`, `textReady`, `renderedPages`, concurrency,
`docLoadMs`, `firstTextMs`, `allTextMs`, `ocrPages`, and `error`. Use `debugLog` /
`debugTime` with a scope instead of raw `console.log` so output stays filterable and
cheap when debug is off.

For TTS problems, check the browser console for Kokoro fetch failures (the app falls
back to browser TTS), confirm the server URL in the voice sheet, and remember that a
device/emulator cannot reach the host's `localhost` (use the LAN IP, or `10.0.2.2` from
the Android emulator).

## 7. Code style and file conventions

- **TypeScript strict.** Avoid `any`; extend shared interfaces in `types/` instead of
  duplicating shapes.
- **Client components** start with `'use client'`. Browser-only libraries (PDF.js,
  tesseract.js, kokoro-js, markdown-it, Mammoth) must be dynamically imported so they
  never enter the server bundle or the initial chunk.
- **Imports:** local modules use relative paths as elsewhere in the repo. The `@/*` alias
  exists in `tsconfig.json`; stay consistent with the surrounding file rather than mixing
  styles within one module.
- **Formatting:** two spaces, single quotes, semicolons, trailing commas. Match the
  existing file rather than reformatting unrelated lines.
- **Styling:** Tailwind v4 utilities plus theme tokens (`bg-surface`, `text-muted`,
  `border-border`); compose conditional classes with `cn()`.
- **State:** use narrow Zustand selectors. Returning a fresh object from a selector causes
  re-render loops; use `useShallow` or select one field at a time.
- **Purity:** time-, randomness-, and DOM-dependent helpers belong at the edges so `lib/`
  stays testable in Node.
- **Comments:** explain *why* (constraints, trade-offs, workarounds), not *what* the next
  line does. Reference the relevant invariant when code is subtle.
- **No stray logging.** Route diagnostics through `lib/debug.ts`.

## 8. Known traps in this stack

**Next.js 16**

- `next export` no longer exists; static output is `output: "export"` and lands in `out/`.
- `trailingSlash: true` and `images.unoptimized: true` are deliberate for static/Pages
  hosting. Do not "fix" them.
- `NEXT_PUBLIC_*` values are inlined at build time. Changing the base path requires a
  rebuild, not just a restart.
- This app has no server runtime. Route handlers, cookies, headers, and dynamic server
  APIs are not available in the exported build.

**React 19**

- Strict Mode runs effects twice in development. Any subscription, timer, PDF render, or
  fetch must clean up properly and tolerate a second mount.
- Do not call `setState` during render. Derive values with `useMemo` instead.
- `dynamic(..., { ssr: false })` is only valid from a Client Component; keep the page's
  `'use client'` boundary intact.

**PDF.js 5**

- Worker and API versions must match exactly (see 3.1).
- `getDocument` is asynchronous and cancellable; destroy the previous document when the
  file changes to release workers.
- `renderTask.cancel()` rejects with `RenderingCancelledException`; ignore it explicitly.
- Text layer and canvas lifecycles are separate; cancel both on zoom changes and eviction.
- Rendering at high zoom on high-DPR screens can exhaust memory — always use
  `capRenderDpr`.

**Zustand 5**

- Selectors must return stable references. `audioCache` updates create a new `Map`
  intentionally so subscribers see the change.
- Read transient state with `useAudioStore.getState()` inside async callbacks instead of
  capturing a stale render value.

**Capacitor**

- `cleartext` / mixed content are enabled to reach a local Kokoro server over HTTP.
  Removing them breaks LAN TTS on Android.
- `cap sync` overwrites the Android web assets and plugin configuration; regenerate
  rather than editing generated files.
- Android builds need JDK 21 and the Android SDK; CI uses a manual workflow for this.

**Storage and tests**

- `localStorage` can throw in private mode; guard every access.
- IndexedDB writes can exceed quota. History handles this best-effort and drops the
  oldest entry once.
- Tests run in Node via jiti, not a browser: do not import components or DOM APIs there.
- A test file that is not listed in `tests/run.mjs` silently does not run.

## 9. Pull request checklist

- [ ] The generated `nextjs-agent-rules` block above is unchanged.
- [ ] `npx tsc --noEmit`, `npm run lint`, `npm test`, and `npm run build` pass.
- [ ] New or changed logic has tests, and new test files are registered in
      `tests/run.mjs`.
- [ ] Segment indices remain stable; append preserves current playback and cache.
- [ ] PDF worker version and `pdfjs-dist` version still match.
- [ ] Page eviction and lazy rendering still work; no unbounded canvas growth.
- [ ] Selection still maps to the correct sentence in PDF, text, and formatted views.
- [ ] Math speech is applied only at synthesis/export, not to stored text.
- [ ] Privacy holds: no pasted-text persistence, no document upload, no new telemetry.
- [ ] The tools launcher's local tile still points at this deployment.
- [ ] Large PDF (hundreds of pages) and 360 px mobile width were tested when relevant.
- [ ] Android assets were regenerated with `cap sync`, not edited by hand.
- [ ] UI changes include a before/after screenshot or clear description.

## 10. Attribution

Do not add personal details, contributor names, email addresses, or GitHub handles to
source files, documentation, or templates. Attribution lives in the existing package
metadata and in git history. This guide intentionally contains no contributor roster.
