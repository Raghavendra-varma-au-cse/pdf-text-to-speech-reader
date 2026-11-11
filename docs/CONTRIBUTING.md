# Contributing

ReadAloud welcomes focused bug fixes, documentation improvements, tests, and well-scoped features. Changes are tracked in git history and through this repository's GitHub issues and pull requests.

- Repository: <https://github.com/imranpollob/pdf-text-to-speech-reader>
- Issues: <https://github.com/imranpollob/pdf-text-to-speech-reader/issues>
- Pull requests: <https://github.com/imranpollob/pdf-text-to-speech-reader/pulls>

Do not add personal details, contributor names, email addresses, or social handles to source files or documentation. If a release note needs to credit a contributor, use their GitHub handle explicitly, for example `<your-github-handle>`.

## Setup

### Web app

Requirements: Node.js 20 or 22, npm, and a modern browser.

```bash
git clone <repository-url>
cd pdf-text-to-speech-reader
npm ci          # lockfile-exact install
npm run dev     # http://localhost:3000
```

`npm install` is fine for local work; use `npm ci` for reproducible installs and CI.

### Optional Kokoro server

```bash
cd server
uv sync
# place kokoro-v1.0.onnx and voices-v1.0.bin in this directory
uv run python main.py
```

The server is optional. The web app is fully usable with browser voices, and most UI work does not require it.

### Optional Android shell

Open `android/` in Android Studio once so it can create `local.properties`, or set `JAVA_HOME` and `ANDROID_HOME`. See [MOBILE.md](MOBILE.md) for the exact APK commands.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Next.js dev server |
| `npm run build` | Static export to `out/` |
| `npm run build:gh` | Static export with the GitHub Pages base path |
| `npm run lint` | ESLint (Next core-web-vitals + TypeScript) |
| `npx tsc --noEmit` | TypeScript check |
| `npm test` | Node test runner suites |
| `npm run debug:pdf` | Generate `debug/fixtures/large-sample.pdf` (400 pages by default) |
| `npm run mobile:sync` | Build and sync web assets into `android/` |
| `npm run mobile:apk` | Build, sync, and assemble the debug APK |
| `npm run android` | Open the Android project in Android Studio |

> `debug:pdf` runs the dependency-free `scripts/generate-large-pdf.mjs`. For a different fixture, run `node scripts/generate-large-pdf.mjs [pages] [output]`. Generated files under `debug/` are not committed.

## Coding conventions

### TypeScript and React

- TypeScript is `strict`. Avoid `any`; extend shared types in `types/index.ts` instead of duplicating shapes.
- Client components begin with `'use client'`.
- Browser-only libraries (PDF.js, Tesseract, kokoro-js, markdown-it, Mammoth) must be dynamically imported so they stay out of the server/initial bundle.
- Use narrow Zustand selectors. Returning a fresh object from a selector causes re-render loops; select fields individually.
- Read transient state with `useAudioStore.getState()` inside async callbacks instead of capturing a stale render value.
- Effects must clean up timers, observers, render tasks, text layers, workers, and event listeners. React 19 Strict Mode double-mounts effects in development.

### Formatting and comments

- Two spaces, single quotes, semicolons, trailing commas.
- Match the surrounding file; do not reformat unrelated lines.
- Prefer Tailwind theme tokens (`bg-surface`, `text-muted`, `border-border`) and `cn()` for conditional classes.
- Comments should explain *why* (constraints, trade-offs, workarounds), not restate the code.
- Route diagnostics through `lib/debug.ts` (`debugLog`, `debugTime`), not raw `console.log`.

### Architecture boundaries

| Layer | Belongs there |
| --- | --- |
| `lib/` | Pure, testable logic; no React or DOM-dependent globals at module scope |
| `store/` | Playback, settings, cache, and cross-component state |
| `components/` | Rendering, event wiring, DOM lifecycles |
| `app/` | Routing entry, import flow, page composition |
| `server/` | Kokoro HTTP API only |

New logic that can be tested without a browser should live in `lib/` and be covered by a Node test.

## Invariants to preserve

These are correctness requirements, not style preferences. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full explanation.

1. **PDF worker version matches `pdfjs-dist`.** Replace `public/pdf.worker.min.mjs` in the same change as a PDF.js upgrade.
2. **Segment indices are stable.** Appending a page must never reset `currentSegmentIndex`, `playbackStatus`, or the audio cache.
3. **Ordered extraction.** `runOrderedPool` must emit pages in ascending order even when workers finish out of order.
4. **Bounded page rendering.** Keep lazy placeholders and eviction; call `page.cleanup()` after eviction; cancel tasks/layers on zoom and unmount.
5. **Selection resolves safely.** A selected node maps to the nearest sentence wrapper, and the parsed index is validated against `segments.length`.
6. **Math speech is applied at synthesis/export time only**, never written into `segment.text`.
7. **Privacy.** Uploaded files may be cached in IndexedDB; pasted text must stay ephemeral; no document contents in logs or network calls.

## Adding a TTS engine

The store's `TtsEngine` union currently contains `browser` and `kokoro`. Adding an engine touches several seams:

1. **Type and persistence**
   - Extend `TtsEngine` in `types/index.ts`.
   - Update `hydrate()` and `setTtsEngine()` in `store/use-audio-store.ts` to validate and persist the new value.
2. **Audio production**
   - Add a generation branch in `playSegment` (and `prefetchSegment` if the engine benefits from lookahead).
   - Cache generated audio with `hashString(speechText)` and reuse the existing `audioCache` / IndexedDB path when possible.
   - Keep `mathSpeech` applied consistently at synthesis time.
3. **Playback**
   - Add the engine branch in `components/AudioEngine.tsx`.
   - Handle cancellation/stop on pause, seek, unmount, and engine switch.
   - If the engine exposes word boundaries, set `spokenWordRange`; otherwise sentence-level highlighting is sufficient.
4. **UI**
   - Add the engine to `components/VoiceSheet.tsx` (tab/list and voice enumeration).
   - Update the display name in `components/PlayerBar.tsx`.
   - Decide whether MP3 export is supported; `components/DownloadAudioDialog.tsx` currently enables export only for Kokoro.
5. **Mobile**
   - Gate native-only APIs behind `Capacitor.isNativePlatform()`.
   - Ensure the browser build still compiles and falls back cleanly.
6. **Tests and docs**
   - Unit-test text preparation, cache keys, and error mapping.
   - Update README, ARCHITECTURE, and MOBILE where behavior differs.

For an on-device engine, follow the pattern in `lib/device-kokoro.ts`: lazy import, cache the loaded instance, report download progress, and make errors actionable.

## Adding a document format

1. **Accept the file** — update the `accept` attribute and import branch in `app/page.tsx`.
2. **Parse lazily** — add a branch in `lib/document-import.ts`. Dynamically import heavy parsers and return `{ text, html }`; use `html: null` when there is no formatted view.
3. **Normalize** — run the extracted text through `normalizeRawText` so sentence segmentation and paragraph metadata stay consistent.
4. **Render** — if the parser returns HTML, sanitize it with DOMPurify before `FormattedDocumentViewer`; otherwise use `TextViewer`.
5. **History** — choose `kind: 'document'` when saving to history; PDFs use `'pdf'`.
6. **Tests** — add parser/segmentation tests when the format has non-trivial structure (tables, footnotes, code blocks, headings).
7. **Docs** — update the supported-format list and limitations.

Do not send the file to a server. Parsing must remain local.

## Tests

```bash
npm test
```

Tests use `node:test` and `node:assert/strict`, with TypeScript loaded by `jiti`. They run in Node, not a browser.

- Add a new file under `tests/` and register it in the explicit list in `tests/run.mjs`; an unregistered file never runs.
- Do not import React components or browser-only modules in tests.
- Prefer deterministic tests: avoid timers where possible, and use small synthetic inputs for segmentation.
- Cover the failure mode, not only the happy path (abort, concurrency limit, malformed input, prose that should not change).

Suggested verification order:

```bash
npx tsc --noEmit
npm run lint
npm test
npm run build
```

## Manual verification

Before opening a PR, verify what the automated tests cannot:

- Open a text-based PDF of at least 100 pages. Confirm text appears before all pages render, sentence order is correct, and playback crosses the append boundary without restarting.
- Zoom in/out repeatedly. Confirm pages rebuild, far pages become placeholders, and memory does not grow without bound.
- Select text in PDF, text, and formatted views. Confirm **Continue** and one-shot actions target the right sentence.
- Toggle math speech and confirm `x²` is spoken as words while prose and URLs are unchanged.
- Run OCR on a scanned PDF and confirm the rebuilt segments preserve the current position.
- Export MP3 for whole book, current page, and from-here; cancel mid-export and confirm the UI recovers.
- Test at 360 px and 390 px widths: upload area, player bar, sheets, safe-area insets, and touch targets.
- If Android assets changed, run `npm run mobile:sync` and smoke-test native TTS.

## Pull request checklist

- [ ] The generated `nextjs-agent-rules` block in `AGENTS.md` is unchanged.
- [ ] `npx tsc --noEmit`, `npm run lint`, `npm test`, and `npm run build` pass.
- [ ] New logic has tests; new test files are listed in `tests/run.mjs`.
- [ ] Segment indices remain stable when pages are appended.
- [ ] PDF worker and `pdfjs-dist` versions still match.
- [ ] Lazy rendering, eviction, and cancellation still behave correctly.
- [ ] Selection maps to the correct sentence in all viewers.
- [ ] Math speech is applied only at synthesis/export.
- [ ] No pasted text is persisted; no document content is uploaded or logged.
- [ ] The local tools launcher tile still points at this deployment.
- [ ] UI changes were checked at phone width; mobile changes were smoke-tested in the shell.
- [ ] `android/app/src/main/assets/public` was regenerated with `cap sync`, not hand-edited.
- [ ] Documentation was updated for user-visible behavior changes.

## Commit and review guidance

- Keep commits scoped to one behavior or documentation change where practical.
- Use an imperative summary (for example, `fix: preserve sentence index when appending pages`).
- In the PR description, state the problem, the approach, automated checks, and manual verification.
- Call out deliberate trade-offs (memory, concurrency, privacy, mobile behavior) so reviewers can evaluate them.
