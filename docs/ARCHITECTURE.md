# Architecture

ReadAloud is a client-side document reader with three cooperating pipelines: PDF rendering, progressive text extraction, and speech synthesis. The app uses the Next.js App Router but exports to static files, so every feature must work without a server runtime.

## Design goals

1. **Local-first privacy** — documents are parsed in the browser; the only network calls are to assets, an optional user-configured TTS server, or optional OCR/model downloads.
2. **Large documents stay usable** — page bitmaps are virtualized and evicted; text is extracted with bounded concurrency; sentence appends never reset playback.
3. **One source of truth** — `TextSegment[]` in the Zustand store drives playback, highlighting, selection, history, and export.
4. **Stable identities** — a sentence's index, once appended, never changes. This keeps DOM markers, audio cache keys, and the current playback position coherent.

## Module map

| Path | Responsibility |
| --- | --- |
| `app/layout.tsx` | Metadata, fonts, viewport, persistent header, global CSS |
| `app/page.tsx` | Upload/paste flow, reader selection, history sheet, FAQ, debug panel |
| `app/globals.css` | Tailwind v4 entry, design tokens, component-level styles |
| `components/PdfViewer.tsx` | PDF.js document lifecycle, placeholder pages, observers, render queue, text layer, OCR, selection |
| `components/AudioEngine.tsx` | Headless playback router: cached audio, native TTS, Web Speech |
| `components/PlayerBar.tsx` | Transport controls, sentence scrubber, selection actions, menus |
| `components/TextViewer.tsx` | Sentence-spanned plain text with word highlighting |
| `components/FormattedDocumentViewer.tsx` | Sanitized Markdown/DOCX HTML with sentence mapping |
| `components/DocumentHistory.tsx`, `HistorySheet.tsx` | History list, usage, delete/clear, mobile sheet |
| `components/DownloadAudioDialog.tsx` | MP3 scope, progress, ETA, cancel |
| `components/VoiceSheet.tsx` | Browser/Kokoro voice selection and server URL |
| `components/KokoroDeviceDownload.tsx` | Optional on-device Kokoro download/progress UI |
| `components/DebugPanel.tsx` | In-app diagnostics view |
| `store/use-audio-store.ts` | Zustand state, settings, cache, Kokoro fetch/prefetch, zoom |
| `lib/text-normalizer.ts` | PDF text items and raw text → sentence segments |
| `lib/pdf-page-scheduler.ts` | `runOrderedPool`: bounded concurrency with ordered emission |
| `lib/pdf-viewer-utils.ts` | Fit scale, DPR cap, page budget, concurrency heuristics |
| `lib/document-import.ts` | TXT/Markdown/DOCX reading; lazy Markdown and Mammoth imports |
| `lib/document-history.ts` | IndexedDB history schema and quota handling |
| `lib/audio-export.ts` | Kokoro synthesis/cache/decode/MP3 encode pipeline |
| `lib/math-speech.ts` | Notation normalization at synthesis time |
| `lib/ocr.ts` | Lazy Tesseract session and page rasterization |
| `lib/native-tts.ts` | Capacitor native TTS bridge |
| `lib/device-kokoro.ts` | Optional WASM Kokoro engine (lazy `kokoro-js`) |
| `lib/debug.ts` | Debug flag, bounded log buffer, timing, console API |
| `server/main.py` | FastAPI Kokoro server (`/tts`, `/tts/batch`, health, warmup) |
| `types/index.ts` | `TextSegment`, `AudioState`, `TtsEngine` |
| `tests/` | Node test suites registered in `tests/run.mjs` |

## Runtime data flow

```text
User picks a file / pastes text
        │
        ├── PDF ───────────────► app/page.tsx sets store.file
        │                              │
        │                              ▼
        │                       PdfViewer mounts
        │                         ├─ pdfjsLib.getDocument()
        │                         ├─ placeholders + IntersectionObservers
        │                         ├─ render queue (near viewport)
        │                         └─ startExtraction() (all pages, ordered)
        │                              │
        │                              ▼
        │                       normalizeText() → TextSegment[]
        │                              │
        │                       loadSegments() then appendSegments()
        │
        └── DOCX/TXT/MD/paste ─► readDocumentFile() / raw text
                                   normalizeRawText() → TextSegment[]
                                   loadSegments()

TextSegment[] ──► AudioEngine (speak current index, then next())
       │
       ├──► PdfViewer / TextViewer / FormattedDocumentViewer (highlight)
       ├──► PlayerBar (scrubber, transport, selection actions)
       ├──► Header (progress, word metrics)
       └──► DownloadAudioDialog (MP3 export)
```

## PDF loading pipeline

`components/PdfViewer.tsx` owns the full document lifecycle inside one effect keyed by `file`.

1. **Read bytes** — `file.arrayBuffer()` → `Uint8Array`.
2. **Open with PDF.js** — `pdfjsLib.getDocument({ data })`. The worker URL is `${basePath}/pdf.worker.min.mjs`; the worker version must match `pdfjs-dist`.
3. **Initialize page skeleton** — one `<div id="pdf-page-N">` per page, sized from the first page's viewport and the current scale. Each starts with a numbered placeholder, so the scrollbar and page navigator are correct immediately.
4. **Attach observers**
   - A **render observer** with `rootMargin: '700px 0px 900px 0px'` enqueues pages near the viewport.
   - A **page observer** tracks the most visible page and updates `currentPage`.
5. **Render on demand** — `renderPage` obtains the page, computes the viewport at `scaleRef.current`, creates a canvas at a capped DPR, renders the page, builds a PDF.js `TextLayer`, tags sentence spans, swaps the placeholder for the canvas/text layer, and reports progress.
6. **Zoom** — `rebuildForScale` increments a render epoch, cancels every render task/text layer, resets all pages to placeholders, and lets the observers re-enqueue visible pages. Page geometry updates immediately without re-parsing the PDF.
7. **Teardown** — `destroyDocument` sets `cancelled`, disconnects observers, cancels tasks/layers, clears records and DOM, disposes OCR, and destroys the PDF loading task.

### Render queue

The render queue is ordered by distance from `currentPageRef.current`. At most `getLoadConcurrency().render` renders run at once. Each page record has a monotonically increasing `renderToken` and the document has a `renderEpochRef`; a result is discarded if either changed, which prevents stale renders from painting after zoom or file changes. Cancellation errors (`RenderingCancelledException`, `AbortException`) are expected and not logged as failures.

## Progressive text extraction

Text extraction is independent of rendering and runs for all pages immediately after the document opens.

```text
runOrderedPool({
  total: numPages,
  concurrency: textConcurrency,   // 2–6 depending on CPU
  worker: getPage → getTextContent({ disableNormalization: true }) → normalizeText,
  onResult: buffer by page, append contiguous pages
})
```

### Why ordered emission matters

Workers may finish out of order. `runOrderedPool` stores completed results in a `Map` and only emits page `N` once pages `1..N-1` have been emitted. `appendReady()` then:

1. assigns `pageOffsets.set(pageNumber, currentSegments.length)`;
2. stores page segments for OCR/rebuild;
3. calls `loadSegments()` for the first non-empty batch, or `appendSegments()` afterwards;
4. updates `textReady`, `hasText`, `scannedPages`, progress, and debug stats.

Because appends only add to the end, existing segment indices remain valid. `AudioEngine` keeps speaking the current sentence; if playback reached the end while `segmentsComplete` was false, `next()` sets `waitingForMore`, and `appendSegments()` automatically starts the first newly appended sentence.

### Sentence segmentation

`normalizeText` (PDF) and `normalizeRawText` (text/DOCX/Markdown) produce `TextSegment[]`:

| Field | Meaning |
| --- | --- |
| `id` | Stable UUID (with a non-secure-context fallback) |
| `text` | Sentence text after whitespace/hyphen cleanup |
| `pageNumber` | Source PDF page (1 for non-paginated text) |
| `spanIds` | PDF.js text span ids touched by the sentence |
| `spanFragments` | Per-span text fragments, enabling multiple sentences per span |
| `paragraphIndex` | Text-reader paragraph grouping |
| `trailingNewlines` | Paragraph/line breaks for text rendering |

PDF segmentation preserves UTF-16 offsets (so emoji work), avoids false sentence breaks on decimals, versions, abbreviations, initials, citations, URLs, and emails, and keeps mathematical subtraction intact. Sentence fragments are mapped back to text-layer spans so a single PDF span can be split into multiple `nr-sentence` elements.

### Scanned pages and OCR

`looksLikeScannedPage` treats a page as scanned when it yields no segments or fewer than 24 characters. The viewer shows a scanned-book notice and can run OCR:

1. `OcrSession` lazily imports `tesseract.js` and creates an English worker.
2. Each page is rendered at up to 1600 px wide and ≤4 MP.
3. Tesseract returns raw text; `normalizeRawText` creates segments.
4. `rebuildSegmentsFromPages` rebuilds the full ordered array and calls `replaceSegmentsPreservingCurrent`, which re-finds the current sentence by id.
5. OCR is serial by design to keep CPU and memory predictable on phones.

## Virtualization and LRU-style eviction

The viewer keeps a `Map<number, PageRecord>`. A record transitions `placeholder → rendering → rendered`.

- **Budget** — `getRenderedPageBudget(totalPages)`:
  - ≤16 pages: all pages
  - `deviceMemory ≤ 2`: 6
  - `≤ 4`: 8
  - `≤ 8`: 10
  - otherwise: 12
- **Protection** — current page ±1 and the active segment's page ±1 are never evicted.
- **Victim choice** — rendered pages outside the protected set are sorted by distance from the anchor (current page or page just rendered); the farthest are reset first.
- **Eviction** — cancel tasks/layers, drop text content and text layer references, replace the DOM with a placeholder, decrement the rendered count, and call `page.cleanup()` so PDF.js can release fonts/operator lists.
- **DPR cap** — `capRenderDpr` limits the canvas backing store to 12 MP and caps DPR at 2 (minimum 0.5 for extreme zoom). CSS size remains the viewport size.
- **Remount behavior** — changing the file destroys the old document/worker; Strict Mode double-mounts are handled by the effect cleanup.

## State model

`store/use-audio-store.ts` is a single Zustand store.

### Playback and document state

| Field | Purpose |
| --- | --- |
| `segments` | Ordered sentence array; source of truth |
| `currentSegmentIndex` | Sentence being spoken/selected |
| `playbackStatus` | `idle \| loading \| playing \| paused` |
| `segmentsComplete` | All pages extracted or OCR'd |
| `stopAtSegmentIndex` | One-shot playback stop |
| `waitingForMore` | Playback reached loaded text while pages remain |
| `selectionSegmentIndex` | Sentence proposed by text selection |
| `spokenWordRange` | Word boundary range for browser/native highlighting |
| `file`, `documentTitle` | Active document |
| `currentPage`, `totalPages`, `scale`, `isFitToWidth` | PDF navigation/zoom |
| `autoScroll`, `textFontSize` | Reading preferences |
| `playbackSpeed`, `kokoroSpeed` | Shared rate (0.5–3) |

### Engine and cache state

| Field | Purpose |
| --- | --- |
| `ttsEngine` | `browser` (Web Speech), `kokoro` (server), or `device` (on-device Kokoro) |
| `selectedVoice` | Browser voice URI; `native:<index>` is also supported by the adapter |
| `kokoroVoice`, `kokoroServerUrl` | Kokoro selection and endpoint |
| `audioCache` | In-memory `Map<hash, Blob>` for generated audio |
| `mathSpeech` | Expand notation at synthesis time |

### Actions that matter for invariants

- `loadSegments` replaces the array and resets playback to 0. Use only for a new document or a deliberate rebuild.
- `appendSegments` extends the array, preserves the current index/status/cache, and resumes when `waitingForMore` was set.
- `replaceSegmentsPreservingCurrent` rebuilds the array but keeps the same sentence id when possible.
- `playSegment(index, { stopAfter })` sets `stopAtSegmentIndex` for one-shot playback and resolves cached audio before the engine plays.
- `next()` respects `stopAtSegmentIndex`, waits for more pages, or stops at the true end.

### Persistence

`localStorage` (guarded; failures are ignored):

| Key | Value |
| --- | --- |
| `playbackSpeed` | number (also used for `kokoroSpeed`) |
| `autoScroll` | `"true"` / `"false"` |
| `textFontSize` | 12–32 |
| `mathSpeech` | `"true"` / `"false"` |
| `ttsEngine` | `browser` / `kokoro` / `device` |
| `kokoroVoice` | voice id |
| `kokoroServerUrl` | server base URL |
| `selectedVoice` | browser voice URI |
| `theme` | `light` / `dark` |

`IndexedDB` (via `idb-keyval`) stores history and generated Kokoro audio. Pasted text is deliberately not stored.

## TTS engine selection

`components/AudioEngine.tsx` is headless and reacts to `currentSegmentIndex`, `playbackStatus`, voice, speed, and math speech.

```text
playbackStatus !== 'playing'
  └─ pause audio, cancel Web Speech, stop native TTS

playing:
  speechText = mathSpeech ? toSpeechText(segment.text) : segment.text
  hash = hashString(speechText)

  audioCache has hash?
    ├─ yes → play the cached Blob through an <audio> element
    └─ no
        ├─ Capacitor native platform? → native TTS (offline, word boundaries)
        └─ else → Web Speech API utterance
```

### Kokoro path

Kokoro generation is triggered in the store, not in `AudioEngine`:

- `playSegment` with `ttsEngine === 'kokoro'` checks the in-memory cache, then IndexedDB, then `POST {serverUrl}/tts` with `{ text, voice, speed, lang: 'en-us' }`.
- A successful response is written to IndexedDB and the in-memory cache, then `AudioEngine` sees the blob and plays it.
- On failure it logs and falls back to browser/native playback for that sentence.
- `prefetchSegment(index + 1)` and `prefetchSegment(index + 2)` warm the next two sentences, deduplicated by a module-level `prefetching` set.

### Native path

`lib/native-tts.ts` wraps `@capacitor-community/text-to-speech`:

- `isNativePlatform()` gates all calls.
- `getNativeVoices()` enumerates device voices and maps them to `native:<index>` URIs.
- `speakNative()` uses `QueueStrategy.Flush`, clamps rate to 0.5–3, and subscribes to `onRangeStart` for word highlighting.
- `stopNative()` is best-effort and is called whenever playback leaves `playing` or the engine unmounts.
- Native TTS is chosen automatically when there is no cached audio blob, so the Android app works offline without Kokoro.

### Optional on-device Kokoro

`lib/device-kokoro.ts` provides a separate WASM engine:

- lazy `import('kokoro-js')`, model `onnx-community/Kokoro-82M-v1.0-ONNX`, q8/WASM;
- model weights cached in `transformers-cache`, voices in `kokoro-voices`;
- `loadDeviceKokoro` shares one load, reports aggregate progress, and supports a caller-side abort that does **not** cancel the underlying download;
- `generateDeviceKokoroAudio` returns a WAV blob and clamps speed to 0.5–2.

`components/KokoroDeviceDownload.tsx` provides the download/progress UI. The main `TtsEngine` union is `browser | kokoro | device`; `device` uses the on-device Kokoro model and falls back to native/browser TTS if the model is unavailable.

### Word-level highlighting

- Web Speech: `utterance.onboundary` (`name === 'word'`) sets `spokenWordRange`.
- Native: `onRangeStart` sets the same state.
- Kokoro/cached audio: no word boundaries are available; only sentence-level highlighting is shown.

## History storage schema

Database `readaloud-history` uses two object stores created with `idb-keyval`:

```text
readaloud-history
├── meta   key = hash(fingerprint)   value = DocumentHistoryMeta
└── files  key = hash(fingerprint)   value = File/Blob
```

`DocumentHistoryMeta`:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | hash of the fingerprint |
| `fingerprint` | string | `name \0 size \0 lastModified \0 type` |
| `name` | string | original filename |
| `type` | string | MIME type |
| `size` | number | bytes |
| `lastModified` | number | source timestamp |
| `kind` | `'pdf' \| 'document'` | import path |
| `openedAt` | number | sort key / “last opened” |
| `pageCount` | number? | filled after PDF parsing |

Behavior:

- Listing reads only `meta`, never blobs.
- Reopening the same fingerprint bumps `openedAt`; the blob is written once.
- Maximum 12 entries; adding a 13th deletes the oldest.
- Quota failure drops the oldest other entry and retries once.
- `loadHistoryFile` reconstructs a `File` so the normal import path runs again.
- `clearDocumentHistory` deletes both stores; `updateHistoryPageCount` fills `pageCount` after PDF load.

Generated Kokoro audio is stored separately in the default `idb-keyval` store, keyed by `hashString(speechText)`. Cache keys therefore change when math speech changes the spoken text.

## MP3 export pipeline

`lib/audio-export.ts` turns segments into one mono MP3.

```text
segments[start..end]
   │
   ├─ try POST /tts/batch (16 texts, gap_ms 140)
   │     ├─ 200 → decode WAV → mix to mono → encode
   │     └─ 404/405/error → disable batching, fall back to per-sentence
   │
   └─ per sentence:
         in-memory cache → IndexedDB → POST /tts
         decode WAV with AudioContext
         mix channels to mono
         append 200 ms silence
         encode 1152-sample blocks with lamejs (MP3, 128 kbps)
   │
   └─ flush encoder → Blob('audio/mpeg') → <a download>
```

Details:

- Only Kokoro audio can be exported; the dialog requires `ttsEngine === 'kokoro'`.
- Scopes: whole book, current page (derived from `segment.pageNumber`), or from current sentence.
- Per-sentence mode keeps 4 prefetch requests in flight to hide network/model latency.
- Batch mode is a server-side optimization: the server synthesizes with bounded concurrency, concatenates PCM with a gap, and returns one WAV.
- Progress reports phase, current/total, message, and ETA; an `AbortController` cancels fetches and the loop.
- The encoder is initialized from the first decoded sample rate (Kokoro is typically 24 kHz) and reused.
- `sanitizeFileName` strips known extensions and illegal filename characters.
- Memory grows with the final MP3 plus one decoded buffer at a time; very large books should be exported in page/range chunks.

## Security and privacy

- **No document upload** — PDFs and text never leave the device. The static export has no server routes.
- **Local history** — only uploaded files, in IndexedDB, bounded to 12. Pasted text is never persisted; legacy cached paste content is actively removed.
- **HTML sanitization** — Markdown/DOCX HTML is rendered only after `DOMPurify.sanitize(..., { USE_PROFILES: { html: true } })`.
- **Speech network calls** — only to the user-configured Kokoro URL, plus optional on-device model/voice downloads.
- **CORS** — the local FastAPI server allows all origins because it is a localhost/LAN tool with no authentication. Do not expose it to an untrusted network.
- **Cleartext Android** — `capacitor.config.ts` enables `cleartext` and mixed content so the WebView can reach an HTTP Kokoro server on the LAN. This is a development/LAN trade-off; production distributions should prefer HTTPS.
- **No telemetry** — the repository contains no analytics or remote logging. Debug logs stay in memory and are user-copyable.

## Failure and recovery behavior

| Failure | Behavior |
| --- | --- |
| PDF open/render error | Page resets to placeholder; error shown in the status pill; debug log records it |
| Text extraction error | `segmentsComplete` is set, phase becomes `error`, message shown |
| Kokoro request failure | Falls back to browser/native speech for that sentence |
| Prefetch failure | Silently ignored; the sentence is fetched on demand |
| OCR failure | OCR stops, error shown, existing text remains |
| IndexedDB quota | History drops the oldest entry and retries once; other writes are best-effort |
| History blob missing | User sees “no longer available in local storage” |
| MP3 batch unsupported | Automatically falls back to per-sentence synthesis |
| Export cancel | `CancelledError`; UI returns to idle and the partial blob is discarded |
