# Performance

ReadAloud is optimized for large documents on modest hardware. The main levers are bounded concurrency, lazy page rendering with eviction, a DPR cap, progressive text extraction, and batched audio export. This document explains the defaults and how to profile changes without regressing phones.

## Where the work happens

| Stage | Cost | Main control |
| --- | --- | --- |
| Read file bytes | O(file size) | Browser memory; no streaming parser |
| PDF open | PDF.js worker parse | `getDocument` |
| Text extraction | CPU + memory per page | `getLoadConcurrency().text` |
| Page rendering | Canvas fill + text layer | `getLoadConcurrency().render`, `getRenderedPageBudget` |
| Canvas memory | `width × height × 4 × dpr²` | `capRenderDpr`, page budget |
| Kokoro playback | Network + model inference | 2 prefetched sentences, caches |
| MP3 export | Inference + decode + encode | batch size 16, prefetch 4 |
| OCR | Tesseract CPU | serial pages, 1600 px / 4 MP cap |

## Concurrency knobs

`lib/pdf-viewer-utils.ts` scales defaults from `navigator.hardwareConcurrency`:

```ts
text:   clamp(floor(cores / 2), 2, 6)
render: clamp(floor(cores / 4), 1, 3)
```

| CPU cores | Text workers | Render workers |
| --- | --- | --- |
| 2 | 2 | 1 |
| 4 | 2 | 1 |
| 8 | 4 | 2 |
| 12 | 6 | 3 |
| 16+ | 6 | 3 |

- **Text workers** run `getPage` + `getTextContent` + `normalizeText`. They are independent and can finish out of order; `runOrderedPool` buffers results until the next page in sequence is available.
- **Render workers** are deliberately fewer. Rendering allocates a canvas and runs PDF.js painting on the main thread's canvas APIs; too many concurrent renders cause jank and memory spikes.
- **OCR** is not part of this pool. It is serial by design.

When tuning, measure on a low-end phone or with CPU throttling. Raising render concurrency often makes scrolling *worse* because it competes with the main thread.

## Render budget and eviction

`getRenderedPageBudget(totalPages)`:

```text
totalPages <= 16       → all pages
deviceMemory <= 2 GB   → 6
deviceMemory <= 4 GB   → 8
deviceMemory <= 8 GB   → 10
otherwise              → 12
```

`deviceMemory` is a coarse browser hint; fall back is 8 GB when unavailable. The viewer does not trust it as a precise measurement.

Eviction rules:

- Current page ±1 is protected.
- The active playback segment's page ±1 is protected.
- Other rendered pages are sorted by distance from the current/active anchor; the farthest are invalidated first.
- Eviction cancels the render task/text layer, clears PDF.js text content references, replaces the DOM with a placeholder, and calls `page.cleanup()`.

This is LRU-like (distance-based) rather than strict access-order LRU, because spatial locality around the viewport matters more than recency for a document.

### Canvas memory

A canvas backing store is roughly:

```text
bytes ≈ cssWidth × cssHeight × 4 × dpr²
```

`capRenderDpr` enforces:

- preferred DPR = `clamp(devicePixelRatio, 1, 2)`;
- maximum 12,000,000 backing-store pixels per canvas (`maxPixels`);
- floor of 0.5 so extreme zoom remains visible;
- rounded to two decimals.

Examples:

| CSS size | DPR | Backing store | Approx. bytes |
| --- | --- | --- | --- |
| 612 × 792 | 1 | 612 × 792 | ~1.9 MB |
| 1224 × 1584 | 2 | 1224 × 1584 | ~7.8 MB |
| 1836 × 2376 | 2 | capped by 12 MP | ~48 MB |

At the 12 MP cap, each canvas is ~48 MB. A 10-page budget can therefore approach hundreds of MB in the worst case, which is why the budget is lower on phones and why eviction calls `cleanup()`.

## Fit-to-width and zoom

`computeFitScale(availableWidth, unscaledPageWidth)`:

```text
scale = clamp((availableWidth - 24) / unscaledPageWidth, 0.4, 3.5)
```

- Zoom range is 0.4–3.5.
- On small screens the viewer initially fits the page width.
- `isFitToWidth` tracks container resizes via `ResizeObserver`.
- A zoom change does **not** re-parse the PDF. It increments the render epoch, cancels existing tasks/layers, resets pages to placeholders, and re-enqueues only visible pages.
- Avoid extreme zoom on memory-constrained devices; the DPR cap protects against crashes but not against slow painting.

## Progressive text extraction

- Extraction starts immediately after the document opens and runs for all pages.
- The first page's segments are loaded with `loadSegments`; later pages use `appendSegments`.
- `segmentsComplete` becomes true only after all pages (or OCR) finish.
- If playback reaches the last loaded sentence while pages remain, `waitingForMore` is set and playback resumes automatically when the next page arrives.
- Memory per page includes the raw text array, segment objects, span ids, and fragments. Page records retain segments for rendered pages and for OCR/rebuild bookkeeping.
- `runOrderedPool` stores out-of-order completed pages in a `Map`; the buffer is bounded by the number of workers (2–6), not by the page count.

### Normalizer efficiency

`normalizeText` uses parallel arrays of characters and span ids instead of one object per character, which materially reduces memory for long books. It iterates UTF-16 code units so offsets stay valid for `slice` and for emoji/astral characters.

## Audio and cache behavior

### Playback

- Browser/native TTS speaks one sentence at a time; there is no client-side audio memory cost beyond the utterance.
- Kokoro audio is stored as blobs in `audioCache` (session) and IndexedDB (persistent).
- Playback prefetches the next two sentences, deduplicated by a module-level set.
- The in-memory cache is not size-bounded. A very long Kokoro session can grow it; reloading the page clears it.

### Server

`server/main.py` has its own LRU and concurrency controls:

| Variable | Default | Effect |
| --- | --- | --- |
| `KOKORO_CONCURRENCY` | 2 | Parallel inference slots and executor workers |
| `KOKORO_INTRA_OP_THREADS` | `min(cpu, 4)` | ONNX intra-op threads |
| `KOKORO_CACHE_ENTRIES` | 200 | Server-side audio LRU entries |
| `KOKORO_CACHE_MAX_MB` | 256 | Server-side LRU memory cap |
| `KOKORO_MAX_BATCH_TEXTS` | 64 | Hard limit for `/tts/batch` |
| `KOKORO_READY_WAIT` | 5 s | How long requests wait for model load |

Phonemization is serialized because `phonemizer`/espeak-ng is global state; ONNX inference runs concurrently within the semaphore. Raising concurrency beyond available cores usually increases latency.

## Large-book MP3 export

`lib/audio-export.ts` is designed to avoid holding the whole book in decoded audio.

- **Batch mode:** requests up to 16 sentences at a time from `/tts/batch`; the server synthesizes with bounded concurrency and returns one WAV with `gap_ms` (140 ms by default) between sentences.
- **Fallback:** on 404/405 or batch failure, the exporter switches to per-sentence requests permanently for that export.
- **Per-sentence prefetch:** up to 4 requests in flight, decoded and encoded in order.
- **Encoding:** mono, 128 kbps, 1152-sample blocks; a 200 ms silence follows each decoded segment in per-sentence mode, and batch mode appends 200 ms after each decoded batch in addition to the server's 140 ms inter-sentence gap.
- **Memory:** one decoded `AudioBuffer` at a time, plus the growing MP3 chunk list. The final blob is held in memory before download.
- **Cancellation:** an `AbortController` aborts fetches and the loop; partial chunks are discarded.
- **Cache reuse:** previously played/exported sentences come from `audioCache`/IndexedDB, making a second export much faster.

Practical guidance for large books:

- Export **current page** or **from here** instead of the whole book when memory or time is constrained.
- Keep the Kokoro server on a machine with enough RAM; 2 inference slots is a sensible default.
- Do not raise batch size above the server's `KOKORO_MAX_BATCH_TEXTS`.
- Expect export time to scale with sentence count, not page count; dense pages have more sentences.

## OCR performance

- Tesseract is imported only when OCR is requested.
- Each page is rendered at `min(2, 1600 / pageWidth)` scale, then reduced if the area exceeds 4 MP.
- Pages are processed serially, which keeps peak memory to one OCR canvas plus the Tesseract worker.
- The English model downloads once and is cached by the browser.
- OCR competes with page rendering and PDF text extraction; let a book finish extracting before starting OCR when possible.

## Profiling guidance

### Built-in timings

Enable `?debug=1`, open a document, and read the log:

- `read file bytes` — I/O and `arrayBuffer` cost.
- `open document` — PDF.js parse/worker startup.
- `first page text` — time to first readable segments.
- `text extraction complete` — full text pass.
- Debug stats show `textReady`, `renderedPages`, and both concurrency values.

Use `npm run debug:pdf` to generate a deterministic fixture (400 pages by default):

```bash
npm run debug:pdf
node scripts/generate-large-pdf.mjs 800 debug/fixtures/eight-hundred.pdf
node scripts/generate-large-pdf.mjs 2000 debug/fixtures/two-thousand.pdf
```

### Browser tools

1. **Performance panel** — record scrolling, zooming, and playback. Look for long tasks during render bursts and layout thrash from the text layer.
2. **Memory panel** — take heap snapshots before/after scrolling through a large PDF. Check that detached canvases and `TextLayer` objects are released.
3. **Network panel** — confirm text extraction does not trigger per-page network requests (all bytes come from the initial file) and that Kokoro requests are batched/prefetched as expected.
4. **Lighthouse** — useful for initial load, bundle size, and accessibility; less useful for large-document runtime behavior.
5. **CPU throttling** — test at 4x–6x slowdown to approximate low-end phones.

### What to measure

| Metric | Target/interpretation |
| --- | --- |
| First text latency | Should be roughly one page's text extraction, not the whole book |
| Time to first rendered page | One page render after document open |
| `renderedPages` while scrolling | Stays at or below the device budget |
| Long tasks during scroll | Avoid repeated >50 ms tasks from too many concurrent renders |
| Heap growth over repeated zoom | Should plateau after eviction, not climb monotonically |
| Playback append boundary | No gap beyond one sentence; no index reset |
| Export throughput | Batch mode should be much faster than per-sentence on a warm server |

## Tuning safely

| Knob | Location | Guidance |
| --- | --- | --- |
| Text concurrency | `getLoadConcurrency` | Raising it speeds first text on many-core machines but increases peak memory and worker contention |
| Render concurrency | `getLoadConcurrency` | Keep at 1–2 on phones; more causes jank |
| Page budget | `getRenderedPageBudget` | Do not raise without measuring low-end Android memory |
| DPR cap | `capRenderDpr` | Lower `maxPixels` if crashes occur at high zoom |
| Cache sizes | `server/main.py` env vars | Bound by server RAM; the client also stores blobs |
| Batch size | `BATCH_SIZE` in `audio-export.ts` | Keep ≤ server `KOKORO_MAX_BATCH_TEXTS` |
| Prefetch depth | `prefetchSegment` calls | Two sentences balances latency and duplicate work |

After any performance change, run:

```bash
npx tsc --noEmit
npm run lint
npm test
npm run build
```

Then repeat the large-PDF scroll/zoom/playback test on a phone-sized viewport and, ideally, a physical Android device.
