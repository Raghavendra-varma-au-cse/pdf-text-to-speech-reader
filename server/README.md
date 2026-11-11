# Kokoro TTS Server

Local FastAPI wrapper around [`kokoro-onnx`](https://github.com/thewh1teagle/kokoro-onnx).
It is the optional high-quality voice backend for ReadAloud (`npm run dev`, then open
the voice sheet and point it at `http://localhost:8880`).

## Setup

```bash
cd server
uv sync
# model files (about 350 MB total):
curl -L -o kokoro-v1.0.onnx  https://github.com/nazdridoy/kokoro-tts/releases/download/v1.0.0/kokoro-v1.0.onnx
curl -L -o voices-v1.0.bin   https://github.com/nazdridoy/kokoro-tts/releases/download/v1.0.0/voices-v1.0.bin
uv run python main.py
```

Or with an existing virtualenv:

```bash
server/.venv/Scripts/python.exe -m uvicorn main:app --app-dir server --port 8880
```

The server listens on `0.0.0.0:8880` when run directly.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | `{status, model_loaded, loading, error}`. Never blocks. |
| GET | `/voices` | `{voices: string[]}`. Waits briefly for the model. |
| GET | `/languages` | `{languages: string[]}`. |
| POST | `/tts` | `{text, voice="af_heart", speed=1.0, lang="en-us"}` → `audio/wav`. |
| POST | `/tts/batch` | `{texts: string[], voice, speed, lang, gap_ms=120}` → one `audio/wav`. |
| POST | `/warmup` | Synthesizes a short phrase once so the first real request is fast. |

`/tts` and `/tts/batch` return `503` with a clear message while the model is still
loading or if loading failed. They wait up to `KOKORO_READY_WAIT` seconds for the model
first, so the normal startup race is handled automatically.

`/tts/batch`:

- rejects more than `KOKORO_MAX_BATCH_TEXTS` (default 64) texts with `413`;
- ignores empty/whitespace-only strings;
- inserts `gap_ms` of silence between consecutive segments;
- returns `X-TTS-Count` with the number of segments actually synthesized;
- synthesizes with a bounded pool (`KOKORO_CONCURRENCY` workers) while phonemization is
  serialized, because `phonemizer`/espeak-ng is global state and is not thread-safe.
  ONNX Runtime sessions are thread-safe, so inference itself runs in parallel.

Unlike the Web Speech engine, the client is expected to cache audio; the server also
keeps a small in-memory LRU of synthesized segments keyed by
`(text, voice, speed, lang)`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `KOKORO_MODEL_PATH` | `./kokoro-v1.0.onnx` | ONNX model path. |
| `KOKORO_VOICES_PATH` | `./voices-v1.0.bin` | Voices file path. |
| `KOKORO_CONCURRENCY` | `2` | Parallel inference slots; also the batch pool size. |
| `KOKORO_INTRA_OP_THREADS` | `min(cpu_count, 4)` | ONNX Runtime intra-op threads. |
| `KOKORO_READY_WAIT` | `5` | Seconds `/voices` and `/tts` wait for the model. |
| `KOKORO_MAX_BATCH_TEXTS` | `64` | Batch size hard limit. |
| `KOKORO_CACHE_ENTRIES` | `200` | LRU entry cap (≈200 short sentences). |
| `KOKORO_CACHE_MAX_MB` | `256` | Additional memory cap for cached PCM. |
| `ONNX_PROVIDER` | unset | Override the ONNX execution provider. |
| `OMP_NUM_THREADS`, `MKL_NUM_THREADS`, … | CPU count | Set only if not already defined. |

## Performance notes

- The model loads in a background **daemon thread**; uvicorn starts accepting requests
  immediately. Poll `/health` (or call `/warmup`) before the first real request.
- ONNX Runtime is configured with `ORT_ENABLE_ALL` graph optimization via
  `Kokoro.from_session` (the installed `Kokoro(...)` constructor does not accept session
  options). If that fails, the server falls back to the library default.
- ORT worker-thread spinning is disabled (`session.*_op.allow_spinning = 0`). Spinning
  threads otherwise steal CPU from the event loop between requests and make even cache
  hits slow on busy machines.
- Responses set `Content-Length`, and `/tts/batch` writes the already-built WAV as a
  single `StreamingResponse` chunk. Without this, chunked framing plus Windows loopback
  delayed ACKs added roughly a second per response in testing.
- Cached `/tts` requests complete in a few milliseconds; a cold request still costs one
  full inference (several seconds on a laptop-class CPU). Use `/warmup` once after the
  model reports ready.
- `KOKORO_CONCURRENCY` trades memory/latency for throughput. Values above the number of
  physical cores rarely help, and each concurrent run uses intra-op threads too.

## Caveats

- The first cold synthesis after model load is slow; the cache only helps repeated
  segments (the ReadAloud client re-sends prefetched segments, so this matters).
- On a 64-item batch the response is built fully in memory before it is sent; that is
  at most a few tens of MB of PCM at typical sentence lengths.
- `/languages` falls back to the v1.0 language list on older `kokoro-onnx` releases that
  do not implement `get_languages()`.
