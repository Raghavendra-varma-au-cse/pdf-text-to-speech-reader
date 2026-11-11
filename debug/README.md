# Debug and performance fixtures

Everything in this folder is a normal part of the repository. No debugging code or
fixture lives in a system temp directory.

## Generate a large test PDF

```bash
npm run debug:pdf                 # 400 pages -> debug/fixtures/large-sample.pdf
node scripts/generate-large-pdf.mjs 1000
node scripts/generate-large-pdf.mjs 250 debug/fixtures/small.pdf
```

The generated PDF contains hundreds of sentences per page, a few separate text runs, and
simple equations so it exercises progressive text extraction, virtualized page rendering,
math speech, and MP3 export.

The generated files are git-ignored; the generator is checked in.

## Enable diagnostics

Open the app with `?debug=1`, or run this once in the browser console and reload:

```js
localStorage.setItem('readaloud:debug', '1');
```

Then use the floating **Debug** panel or the console API:

```js
window.__readaloudDebug.stats()
window.__readaloudDebug.entries()
window.__readaloudDebug.snapshot()
window.__readaloudDebug.clear()
```

Diagnostics are cheap when disabled: `debugLog` returns before touching the ring buffer.

## What to measure on a large PDF

- Time until the first sentence is available (the player bar should appear before the
  whole book is parsed).
- `textReady / totalPages` increasing steadily while `renderedPages` stays bounded.
- Memory after scrolling through many pages; rendered canvases should be evicted beyond
  the page budget.
- Play-through across a page boundary: appending text must not restart the current
  sentence.
- Export speed for a single page vs. the whole book.

## Mobile

```bash
npm run mobile:sync
npm run mobile:apk
```

The debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`.
`adb logcat` shows native WebView/TTS errors; browser-side logs are available through
`chrome://inspect` when the device is connected.
