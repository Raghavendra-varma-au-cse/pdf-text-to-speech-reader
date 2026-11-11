# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private
vulnerability reporting for this repository (Security → Advisories → Report a
vulnerability). If that is unavailable, open an issue that describes the affected area
without including exploit details or document contents.

Useful reports include:

- the affected screen or module,
- the browser/Android/desktop platform and version,
- whether a Kokoro server, on-device model, OCR, or MP3 export was involved,
- a minimal reproduction that does not contain private documents.

## Data handling

ReadAloud parses documents in the browser/WebView. Uploaded files and generated audio may
be cached locally in IndexedDB; pasted text is never persisted. No document content is
uploaded by the app.

Optional network features:

- The local Kokoro server address is entered by the user and contacted directly.
- The optional on-device Kokoro download fetches model files from Hugging Face and the ONNX
  Runtime assets from a CDN on first use.
- The optional OCR language model is downloaded by Tesseract.js on first use.

All of these are opt-in. Review the URL and the server before using them on a shared
network. The bundled Kokoro server has no authentication and permissive CORS, so keep it
on a trusted LAN and never expose port 8880 to the public internet.
