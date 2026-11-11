# Changelog

All notable changes to ReadAloud are recorded here. The project follows a Keep a Changelog-style structure; versions correspond to the `version` field in `package.json`. Changes are also visible in git history.

## [Unreleased]

### Added

- Lazy, virtualized PDF page rendering with placeholders and on-demand canvases.
- Ordered parallel text extraction via `runOrderedPool`, keeping sentence indices stable while pages parse concurrently.
- Device-aware text/render concurrency and rendered-page budgets, plus a canvas DPR/pixel cap.
- Progressive playback: listening can start on the first page and continues automatically when later pages arrive.
- Selection actions: continue from selected text or read only the selected sentence.
- Sentence scrubber, page navigator with jump-to-page, playback speed from 0.5x to 3x, and auto-follow controls.
- Local document history in IndexedDB, including reopen-without-reupload, usage display, delete, clear, and quota fallback.
- MP3 export for the whole book, current page, or from the current sentence, with Kokoro batching, cache reuse, progress, ETA, and cancellation.
- Math-to-speech normalization for common Unicode and LaTeX notation, toggleable at playback/export time.
- Lightweight on-device OCR for scanned PDFs using lazily loaded Tesseract.js.
- Capacitor Android shell with native OS TTS as the automatic local engine and LAN Kokoro support.
- Optional on-device Kokoro module (`lib/device-kokoro.ts`) and model download UI.
- Desktop wrapper (Tauri/Rust) for a standalone Windows/macOS/Linux build.
- Media Session metadata and lock-screen/media-key controls, plus a screen wake lock while reading.
- In-repo debug panel, console API, scoped log buffer, and timing helpers, enabled with `?debug=1`.
- Deterministic large-PDF fixture generator (`npm run debug:pdf`).
- Node test suites for sentence normalization, PDF span mapping, ordered scheduling, math speech, word metrics, PDF utilities, and history fingerprints.
- Project documentation: README, architecture, contributing, debugging, mobile, performance, and changelog.

### Changed

- PDF rendering is decoupled from text extraction; rendering follows the viewport while text extraction runs for the whole document.
- Zoom changes rebuild page geometry and visible bitmaps without re-parsing the document.
- Kokoro settings, speed, theme, auto-follow, math speech, and voice choices persist in `localStorage`; document files persist separately in IndexedDB.
- Markdown and DOCX parsers are loaded on demand instead of at startup.
- PDF.js worker URLs respect the configured base path for subpath hosting.
- Android web assets are generated through `cap sync`; the debug APK build is exposed as `npm run mobile:apk`.
- Mobile and desktop layouts were tightened: the player bar fits 320–360 px, sheets use `dvh` with internal scrolling, readers cap line length, and PDF sentence targets have visible focus rings.
- Android adaptive icons, splash screens, and light/dark chrome colors now match the web brand tokens.

### Fixed

- Sentence segmentation no longer splits decimals, versions, abbreviations, initials, citations, URLs, emails, or mathematical subtraction incorrectly.
- UTF-16 offsets remain aligned for emoji and other astral characters in PDF text.
- Appending a page no longer resets the current sentence, playback state, or audio cache.
- Text-layer alignment is preserved by setting the PDF.js scale factor and exact layer dimensions.
- Render/text-layer tasks are cancelled on zoom, eviction, and unmount, with cancellation treated as expected.
- Far pages release PDF.js page resources through `page.cleanup()` instead of accumulating canvases.
- History writes recover once from quota exhaustion by dropping the oldest entry.
- Kokoro failures fall back to browser/native speech for the affected sentence.
- MP3 export falls back to per-sentence synthesis when `/tts/batch` is unavailable.
- Android cleartext/mixed-content configuration allows LAN Kokoro calls.
- Pasted text is never persisted, and legacy paste cache content is removed on startup.
- PDF text extraction is aborted when the document changes, so a slow first PDF cannot append pages into a newer document.
- Audio cache keys include engine, voice, speed, and server URL; Kokoro/device blobs play at 1x instead of applying speed twice.
- Stale Kokoro/device synthesis results cannot overwrite Stop/Pause or a newer sentence.
- Native TTS range listeners are removed on stop, and browser utterance callbacks ignore cancelled utterances.
- Space no longer hijacks focused buttons/links on the home screen, and export is cancelled when its dialog closes.
- OCR errors remain visible with a retry action; short text pages are no longer treated as scanned.

### Documentation

- Added README quick start, local Kokoro setup, APK build instructions, usage tips, privacy notes, limitations, and troubleshooting.
- Added architecture, contributing, debugging, mobile, performance, and changelog documents.

## [1.0.0]

Initial tracked baseline of the application (package version 1.0.0):

- Static Next.js export for PDF, DOCX, Markdown, TXT, and pasted text.
- Browser/Web Speech playback with sentence-level highlighting.
- Local Kokoro server integration for neural voices.
- Sentence-based navigation and click-to-read behavior.
- Light/dark themes and responsive reader layout.
- IndexedDB audio caching and optional local document history.
