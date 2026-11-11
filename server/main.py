"""
Kokoro TTS Backend Server

A lightweight FastAPI server that wraps kokoro-onnx for text-to-speech generation.

Setup (using uv):
  1. uv sync
  2. Download model files into this directory:
       wget https://github.com/nazdridoy/kokoro-tts/releases/download/v1.0.0/kokoro-v1.0.onnx
       wget https://github.com/nazdridoy/kokoro-tts/releases/download/v1.0.0/voices-v1.0.bin
  3. uv run python main.py

The ONNX model is loaded in a background thread, so the HTTP server starts
accepting connections immediately. Poll `/health` (or `/warmup`) until
`model_loaded` is true.

Endpoints:
  GET  /health              -> {status, model_loaded, loading, error}
  GET  /voices              -> available voices
  GET  /languages           -> available languages
  POST /tts                 -> single WAV (audio/wav)
  POST /tts/batch           -> many texts concatenated into one WAV
  POST /warmup              -> synthesize a short phrase to warm the model

Useful environment variables:
  KOKORO_MODEL_PATH / KOKORO_VOICES_PATH  model file locations
  KOKORO_CONCURRENCY       parallel inference slots (default 2)
  KOKORO_INTRA_OP_THREADS  ONNX intra-op threads (default min(cpu, 4))
  KOKORO_READY_WAIT        seconds /voices and /tts wait for the model (default 5)
  KOKORO_MAX_BATCH_TEXTS   hard limit for /tts/batch (default 64)
  KOKORO_CACHE_ENTRIES     LRU entry cap (default 200)
  KOKORO_CACHE_MAX_MB      LRU memory cap in MB (default 256)
  ONNX_PROVIDER            override the ONNX execution provider
"""

from __future__ import annotations

import asyncio
import io
import os
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

# ---------------------------------------------------------------------------
# Environment defaults MUST be set before kokoro_onnx (and onnxruntime) is
# imported so the native libraries pick them up.
# ---------------------------------------------------------------------------

_CPU_COUNT = os.cpu_count() or 1


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


# Native math libraries read these once at import time. ``setdefault`` keeps
# any explicit user configuration.
for _thread_var in (
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
):
    os.environ.setdefault(_thread_var, str(_CPU_COUNT))

KOKORO_CONCURRENCY = _env_int("KOKORO_CONCURRENCY", 2)
INTRA_OP_THREADS = _env_int("KOKORO_INTRA_OP_THREADS", max(1, min(_CPU_COUNT, 4)))
READY_WAIT_SECONDS = max(0.0, _env_float("KOKORO_READY_WAIT", 5.0))
MAX_BATCH_TEXTS = _env_int("KOKORO_MAX_BATCH_TEXTS", 64)
CACHE_MAX_ENTRIES = _env_int("KOKORO_CACHE_ENTRIES", 200)
CACHE_MAX_BYTES = _env_int("KOKORO_CACHE_MAX_MB", 256) * 1024 * 1024

# Resolve paths relative to this script's directory so the server works
# regardless of which directory it is launched from.
_HERE = os.path.dirname(os.path.abspath(__file__))

MODEL_PATH = os.environ.get(
    "KOKORO_MODEL_PATH", os.path.join(_HERE, "kokoro-v1.0.onnx")
)
VOICES_PATH = os.environ.get(
    "KOKORO_VOICES_PATH", os.path.join(_HERE, "voices-v1.0.bin")
)

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from kokoro_onnx import Kokoro
from kokoro_onnx.config import SAMPLE_RATE
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Model state
# ---------------------------------------------------------------------------

kokoro: Kokoro | None = None

# ``model_ready`` is set only after a successful load. ``_model_done`` is set
# once loading has finished (success or failure) so waiters do not block for
# the full timeout when the load already failed.
model_ready = threading.Event()
_model_done = threading.Event()
model_error: str | None = None

_state_lock = threading.Lock()
_phonemize_lock = threading.Lock()

# Bounds concurrent native inference across all requests (single + batch).
_exec_sem = threading.BoundedSemaphore(KOKORO_CONCURRENCY)

_warmup_lock = threading.Lock()
_warmup_done = False
WARMUP_TEXT = "Ready."

# ---------------------------------------------------------------------------
# LRU audio cache
# ---------------------------------------------------------------------------

_CacheKey = tuple[str, str, float, str]

_cache: OrderedDict[_CacheKey, np.ndarray] = OrderedDict()
_cache_lock = threading.Lock()
_cache_bytes = 0


def _cache_get(key: _CacheKey) -> np.ndarray | None:
    with _cache_lock:
        samples = _cache.get(key)
        if samples is None:
            return None
        _cache.move_to_end(key)
        return samples


def _cache_put(key: _CacheKey, samples: np.ndarray) -> None:
    global _cache_bytes

    size = samples.nbytes
    if size > CACHE_MAX_BYTES:
        return

    with _cache_lock:
        existing = _cache.get(key)
        if existing is not None:
            _cache_bytes -= existing.nbytes
        _cache[key] = samples
        _cache.move_to_end(key)
        _cache_bytes += size
        while (
            len(_cache) > CACHE_MAX_ENTRIES or _cache_bytes > CACHE_MAX_BYTES
        ) and _cache:
            _, evicted = _cache.popitem(last=False)
            _cache_bytes -= evicted.nbytes


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------


def _build_session():
    """Create an ORT session with graph optimizations and thread limits."""
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.intra_op_num_threads = INTRA_OP_THREADS
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.enable_mem_pattern = True
    options.enable_cpu_mem_arena = True
    options.log_severity_level = 3

    # ORT worker threads spin-wait after a run by default. On a shared machine
    # (and between parallel batch items) that steals cycles from the event
    # loop, making even cache hits slow. Disable spinning.
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    options.add_session_config_entry("session.inter_op.allow_spinning", "0")

    providers: list[str] = ["CPUExecutionProvider"]
    try:
        import importlib.util

        if importlib.util.find_spec("onnxruntime-gpu"):
            providers = list(ort.get_available_providers())
    except (ImportError, ValueError):
        pass

    env_provider = os.environ.get("ONNX_PROVIDER")
    if env_provider:
        providers = [env_provider]

    return ort.InferenceSession(
        MODEL_PATH, sess_options=options, providers=providers
    )


def _load_model() -> None:
    """Load the model. Runs in a background daemon thread."""
    global kokoro, model_error

    try:
        missing = [p for p in (MODEL_PATH, VOICES_PATH) if not os.path.exists(p)]
        if missing:
            print("\n[!] Missing model files:")
            for path in missing:
                print(f"   {path}")
            print("\nDownload them into the server/ directory:")
            print(
                "   curl -L -o server/kokoro-v1.0.onnx  https://github.com/nazdridoy/kokoro-tts/releases/download/v1.0.0/kokoro-v1.0.onnx"
            )
            print(
                "   curl -L -o server/voices-v1.0.bin   https://github.com/nazdridoy/kokoro-tts/releases/download/v1.0.0/voices-v1.0.bin"
            )
            raise FileNotFoundError(
                "Missing model file(s): " + ", ".join(missing)
            )

        print("Loading Kokoro model...")
        started = time.perf_counter()

        try:
            session = _build_session()
            instance = Kokoro.from_session(session, VOICES_PATH)
        except Exception as exc:  # optimised session failed; use the library default
            print(f"[!] Optimized ONNX session failed ({exc}); retrying with defaults")
            instance = Kokoro(MODEL_PATH, VOICES_PATH)

        voices = sorted(instance.get_voices())
        with _state_lock:
            kokoro = instance
        model_ready.set()

        elapsed = time.perf_counter() - started
        print(
            f"[ok] Kokoro model loaded in {elapsed:.2f}s - {len(voices)} voices available"
        )
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"
        with _state_lock:
            model_error = message
        print(f"[!] Failed to load Kokoro model: {message}")
    finally:
        _model_done.set()


@asynccontextmanager
async def lifespan(app: FastAPI):
    thread = threading.Thread(target=_load_model, name="kokoro-loader", daemon=True)
    thread.start()
    try:
        yield
    finally:
        # Loader is a daemon thread; nothing to clean up on shutdown.
        pass


app = FastAPI(title="Kokoro TTS Server", lifespan=lifespan)

ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "KOKORO_ALLOWED_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,"
        "https://imranpollob.github.io,http://tauri.localhost,https://tauri.localhost,"
        "capacitor://localhost,http://localhost",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

_executor = ThreadPoolExecutor(
    max_workers=KOKORO_CONCURRENCY, thread_name_prefix="kokoro-tts"
)

# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=20_000)
    voice: str = "af_heart"
    speed: float = Field(default=1.0, ge=0.5, le=3.0)
    lang: str = "en-us"


class BatchTTSRequest(BaseModel):
    texts: list[str]
    voice: str = "af_heart"
    speed: float = 1.0
    lang: str = "en-us"
    gap_ms: int = Field(default=120, ge=0, le=5000)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _require_model() -> Kokoro:
    """Return the loaded model, waiting briefly if it is still loading."""
    model = kokoro
    if model_ready.is_set() and model is not None:
        return model

    if model_error is not None:
        raise HTTPException(
            503, f"Kokoro model failed to load: {model_error}"
        )

    if not _model_done.is_set() and READY_WAIT_SECONDS > 0:
        await asyncio.to_thread(_model_done.wait, READY_WAIT_SECONDS)

    model = kokoro
    if model_ready.is_set() and model is not None:
        return model

    if model_error is not None:
        raise HTTPException(
            503, f"Kokoro model failed to load: {model_error}"
        )

    raise HTTPException(
        503,
        "Kokoro model is still loading. Poll /health and retry shortly.",
    )


def _wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    """Encode PCM samples as a complete WAV file in memory."""
    buffer = io.BytesIO()
    sf.write(
        buffer,
        np.asarray(samples, dtype=np.float32),
        sample_rate,
        format="WAV",
    )
    return buffer.getvalue()


def _synthesize_sync(
    text: str, voice: str, speed: float, lang: str
) -> np.ndarray:
    """Blocking synthesis: phonemize under a lock, infer inside a slot.

    ``phonemizer``/espeak-ng is global state and is not thread-safe, so
    phonemization is serialized. ONNX Runtime sessions are thread-safe, so
    only the inference part runs concurrently.
    """
    key: _CacheKey = (text, voice, float(speed), lang)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    model = kokoro
    if model is None:
        raise RuntimeError("Kokoro model is not loaded")

    with _phonemize_lock:
        phonemes = model.tokenizer.phonemize(text, lang)

    if not phonemes.strip():
        raise ValueError("Text produced no phonemes (empty or unsupported text)")

    with _exec_sem:
        samples, _ = model.create(
            phonemes,
            voice=voice,
            speed=speed,
            lang=lang,
            is_phonemes=True,
        )

    samples = np.ascontiguousarray(samples, dtype=np.float32)
    _cache_put(key, samples)
    return samples


def _synthesize_many(
    texts: list[str], voice: str, speed: float, lang: str
) -> list[np.ndarray]:
    """Synthesize texts with a bounded pool, preserving input order."""
    if len(texts) == 1:
        return [_synthesize_sync(texts[0], voice, speed, lang)]

    futures = []
    try:
        for text in texts:
            futures.append(
                _executor.submit(_synthesize_sync, text, voice, speed, lang)
            )
    except RuntimeError:
        # The pool could not be used (for example during interpreter
        # shutdown); synthesize sequentially rather than fail the request.
        for future in futures:
            future.cancel()
        return [
            _synthesize_sync(text, voice, speed, lang) for text in texts
        ]

    # Preserve input order; the executor itself bounds parallelism.
    return [future.result() for future in futures]


def _warmup_sync() -> bool:
    """Synthesize the warmup phrase once. Returns True if it ran now."""
    global _warmup_done

    if _warmup_done:
        return False

    with _warmup_lock:
        if _warmup_done:
            return False
        _synthesize_sync(WARMUP_TEXT, "af_heart", 1.0, "en-us")
        _warmup_done = True
        return True


def _error_detail(exc: Exception) -> str:
    return str(exc) or type(exc).__name__


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
async def health():
    loaded = model_ready.is_set() and kokoro is not None
    if loaded:
        status = "ok"
    elif model_error is not None:
        status = "error"
    else:
        status = "loading"

    return {
        "status": status,
        "model_loaded": loaded,
        "loading": not loaded and model_error is None,
        "error": model_error,
    }


@app.get("/voices")
async def get_voices():
    model = await _require_model()
    return {"voices": sorted(model.get_voices())}


@app.get("/languages")
async def get_languages():
    model = await _require_model()
    getter = getattr(model, "get_languages", None)
    if callable(getter):
        return {"languages": sorted(getter())}

    # Older kokoro-onnx releases do not expose languages; fall back to the
    # languages supported by the v1.0 voices.
    return {
        "languages": [
            "en-us",
            "en-gb",
            "es",
            "fr-fr",
            "hi",
            "it",
            "ja",
            "pt-br",
            "zh",
        ]
    }


@app.post("/tts")
async def text_to_speech(req: TTSRequest):
    await _require_model()

    if not req.text or not req.text.strip():
        raise HTTPException(400, "text must not be empty")

    try:
        samples = await asyncio.to_thread(
            _synthesize_sync, req.text, req.voice, req.speed, req.lang
        )
    except AssertionError as exc:
        raise HTTPException(400, _error_detail(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, _error_detail(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, f"TTS generation failed: {_error_detail(exc)}") from exc

    wav = _wav_bytes(samples, SAMPLE_RATE)
    # A one-shot Response is faster than a StreamingResponse here: it is sent
    # as a single body write with a known Content-Length instead of chunked
    # framing, which adds noticeable latency on Windows loopback.
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.post("/tts/batch")
async def text_to_speech_batch(req: BatchTTSRequest):
    if len(req.texts) > MAX_BATCH_TEXTS:
        raise HTTPException(
            413,
            f"Too many texts: {len(req.texts)} (maximum {MAX_BATCH_TEXTS})",
        )

    texts = [text for text in req.texts if text and text.strip()]
    if not texts:
        raise HTTPException(400, "texts must contain at least one non-empty string")

    await _require_model()

    try:
        parts = await asyncio.to_thread(
            _synthesize_many, texts, req.voice, req.speed, req.lang
        )
    except AssertionError as exc:
        raise HTTPException(400, _error_detail(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, _error_detail(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, f"TTS generation failed: {_error_detail(exc)}") from exc

    gap_samples = int(SAMPLE_RATE * (req.gap_ms / 1000.0))
    pieces: list[np.ndarray] = []
    for index, part in enumerate(parts):
        if index and gap_samples > 0:
            pieces.append(np.zeros(gap_samples, dtype=np.float32))
        pieces.append(part)

    pcm = (
        np.concatenate(pieces)
        if pieces
        else np.zeros(0, dtype=np.float32)
    )

    wav = _wav_bytes(pcm, SAMPLE_RATE)
    # The WAV is already fully built in memory (needed for Content-Length and
    # the gap concatenation), so hand StreamingResponse a single chunk. Sending
    # many small chunks stalls on Windows loopback.
    return StreamingResponse(
        iter((wav,)),
        media_type="audio/wav",
        headers={
            "Content-Length": str(len(wav)),
            "Cache-Control": "no-store",
            "X-TTS-Count": str(len(parts)),
        },
    )


@app.post("/warmup")
async def warmup():
    await _require_model()

    started = time.perf_counter()
    try:
        ran = await asyncio.to_thread(_warmup_sync)
    except Exception as exc:
        raise HTTPException(500, f"Warmup failed: {_error_detail(exc)}") from exc

    return {
        "ok": True,
        "warmed": _warmup_done,
        "ran_now": ran,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8880)
