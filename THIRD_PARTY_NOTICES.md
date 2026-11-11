# Third-party notices

ReadAloud bundles open-source dependencies. This file is a summary, not a replacement for
each package's license text; the authoritative license is in the corresponding package
under `node_modules/` after installation.

| Dependency | License | Used for |
| --- | --- | --- |
| Next.js, React, React DOM | MIT | Web application and UI |
| Tailwind CSS | MIT | Styling |
| Zustand | MIT | Client state |
| pdfjs-dist | Apache-2.0 | PDF rendering and text extraction |
| idb-keyval | Apache-2.0 | IndexedDB history and audio cache |
| DOMPurify | MPL-2.0 OR Apache-2.0 | Sanitizing imported DOCX/Markdown HTML |
| Mammoth | BSD-2-Clause | DOCX import |
| markdown-it | MIT | Markdown rendering |
| Tesseract.js | Apache-2.0 | Optional on-device OCR |
| kokoro-js | Apache-2.0 | Optional on-device Kokoro TTS |
| Transformers.js / ONNX Runtime Web | Apache-2.0 / MIT | Model runtime for on-device Kokoro |
| @breezystack/lamejs | LGPL-3.0 | MP3 encoding for audio export |
| @capacitor/core, @capacitor/android, @capacitor/cli | MIT | Android application shell |
| @capacitor-community/text-to-speech | MIT | Native Android TTS |
| Tauri (Rust) | MIT OR Apache-2.0 | Optional desktop shell |
| FastAPI, Uvicorn | MIT / BSD-3-Clause | Optional local Kokoro server |
| kokoro-onnx | Apache-2.0 | Optional local Kokoro model runtime |

The Kokoro model weights and Tesseract language data are downloaded separately by the
user and are not redistributed by this repository. Check their upstream licenses before
redistributing model files.
