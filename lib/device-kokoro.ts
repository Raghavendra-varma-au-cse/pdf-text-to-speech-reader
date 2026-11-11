/**
 * Optional on-device Kokoro text-to-speech engine.
 *
 * The `kokoro-js` package (and the Transformers.js / ONNX Runtime stack behind it)
 * is only imported with a dynamic `import()` the first time the model is loaded,
 * so it stays out of the main bundle. The loaded instance is cached for the rest
 * of the session.
 *
 * The model is fetched from the Hugging Face Hub and stored in the browser's
 * Cache Storage (`transformers-cache`) by Transformers.js. After the first
 * successful load the weights are read from that cache, so generation works
 * offline. Voice embeddings are cached separately in `kokoro-voices`; the
 * selected voice is pre-downloaded right after the model so the first sentence
 * does not pay the extra fetch.
 *
 * WebGPU is preferred when the browser exposes a working adapter, because the
 * ONNX model runs several times faster there. Any WebGPU failure (missing
 * adapter, unsupported operator, driver crash) falls back to the WASM backend
 * inside the same load. `getDeviceKokoroBackend()` reports which one is active.
 *
 * Caveats (documented, not bugs in this wrapper):
 * - Transformers.js 3.8 / kokoro-js 1.2 do NOT expose an AbortSignal for
 *   `from_pretrained`, so a model download cannot be truly cancelled. Passing a
 *   signal to `loadDeviceKokoro` stops the caller waiting and silences further
 *   progress callbacks, but the underlying fetch continues in the background
 *   and may still populate the cache when it finishes. Voice downloads DO
 *   support cancellation because they are fetched by this module directly.
 * - ONNX Runtime's WASM binaries are loaded from the jsDelivr CDN by default
 *   (Transformers.js sets `env.backends.onnx.wasm.wasmPaths` itself). The very
 *   first generation therefore needs network access for those assets. WebView
 *   HTTP caching usually serves them afterwards, but for a guaranteed offline
 *   first run the ORT wasm/mjs files should be hosted in `public/` and
 *   `env.wasmPaths` pointed at them from the host app.
 * - The quantized q8 weights are used for WebGPU as well as WASM so that one
 *   model file serves both backends. If a GPU rejects an int8 operator the load
 *   automatically retries with WASM.
 */

import type { KokoroTTS } from 'kokoro-js';

export const DEVICE_KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const DEVICE_KOKORO_DEFAULT_VOICE = 'af_heart';
export const DEVICE_KOKORO_APPROX_MODEL_SIZE = '~80 MB';
export const DEVICE_KOKORO_VOICE_APPROX_SIZE = '~0.5 MB';

/**
 * Space we ask the browser to keep free before starting the download. The q8
 * ONNX file plus tokenizer/config overhead is around 90 MB; the margin covers
 * Cache Storage bookkeeping and one voice embedding.
 */
export const DEVICE_KOKORO_REQUIRED_BYTES = 120 * 1024 * 1024;
export const DEVICE_KOKORO_VOICE_APPROX_BYTES = 512 * 1024;

/** Cache names used by Transformers.js and kokoro-js respectively. */
const TRANSFORMERS_CACHE = 'transformers-cache';
const VOICE_CACHE = 'kokoro-voices';

const VOICE_BASE_URL = `https://huggingface.co/${DEVICE_KOKORO_MODEL_ID}/resolve/main/voices`;

export type DeviceKokoroBackend = 'webgpu' | 'wasm';

export interface DeviceKokoroProgress {
  /** Transformers.js status: initiate | download | progress | done | ready, plus voice/fallback/warning. */
  status: string;
  /** Aggregate download progress across all files seen so far, 0-100. */
  progress: number;
  /** File currently being downloaded, when known. */
  file?: string;
  /** Bytes downloaded across all files seen so far. */
  loadedBytes?: number;
  /** Total bytes across all files seen so far (0/undefined while unknown). */
  totalBytes?: number;
  /** Which phase the progress belongs to. Older callers can ignore it. */
  stage?: 'model' | 'voice';
  /** Backend used by the attempt that produced this update. */
  backend?: DeviceKokoroBackend;
  /** Human-readable warning (low storage, WebGPU fallback, voice fetch failed). */
  warning?: string;
}

export type DeviceKokoroProgressCallback = (progress: DeviceKokoroProgress) => void;

export interface DeviceKokoroLoadOptions {
  /** Voice embedding to download after the model so the first sentence is fast. */
  voice?: string;
  /**
   * Set to false to force the WASM backend (used by tests or when a GPU is
   * known to be unstable). Defaults to preferring WebGPU when available.
   */
  preferWebGpu?: boolean;
}

export interface DeviceKokoroStorageEstimate {
  /** False when the browser does not expose `navigator.storage.estimate()`. */
  supported: boolean;
  /** Bytes we would like to have free before downloading. */
  requiredBytes: number;
  usageBytes?: number;
  quotaBytes?: number;
  /** `quota - usage` when both are known. */
  availableBytes?: number;
  /** Whether the origin's storage is marked persistent. */
  persistent: boolean;
  /** False only when the estimate is known and below `requiredBytes`. */
  sufficient: boolean;
  /** Short, human-readable summary suitable for the UI. */
  message: string;
}

/**
 * Voice ids from the Kokoro-82M model card. Used only as a fallback so the UI
 * can offer choices before the model is loaded; once the model is available
 * `listDeviceKokoroVoices()` returns the model's own list.
 */
const FALLBACK_VOICES = [
  'af_heart',
  'af_alloy',
  'af_aoede',
  'af_bella',
  'af_jessica',
  'af_kore',
  'af_nicole',
  'af_nova',
  'af_river',
  'af_sarah',
  'af_sky',
  'am_adam',
  'am_echo',
  'am_eric',
  'am_fenrir',
  'am_liam',
  'am_michael',
  'am_onyx',
  'am_puck',
  'am_santa',
  'bf_alice',
  'bf_emma',
  'bf_isabella',
  'bf_lily',
  'bm_daniel',
  'bm_fable',
  'bm_george',
  'bm_lewis',
] as const;

let cachedTts: KokoroTTS | null = null;
let cachedBackend: DeviceKokoroBackend | null = null;
let loadPromise: Promise<KokoroTTS> | null = null;
let webGpuSupportPromise: Promise<boolean> | null = null;
let persistencePromise: Promise<boolean> | null = null;

/**
 * Progress listeners for the in-flight load. Kept at module level so a caller
 * that joins (or retries after aborting) still receives updates.
 */
const progressSubscribers = new Set<DeviceKokoroProgressCallback>();

function emitProgress(update: DeviceKokoroProgress): void {
  for (const listener of progressSubscribers) {
    try {
      listener(update);
    } catch {
      // A broken UI listener must not break the download.
    }
  }
}

/** True when the current environment can run the WASM build of Kokoro. */
export function isDeviceKokoroSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    typeof WebAssembly === 'object' &&
    WebAssembly !== null &&
    typeof WebAssembly.instantiate === 'function'
  );
}

/**
 * Whether this browser exposes WebGPU and can hand out an adapter. The result
 * is cached for the session because requesting an adapter is not free.
 */
export function isWebGpuAvailable(): Promise<boolean> {
  if (typeof navigator === 'undefined') return Promise.resolve(false);
  if (!webGpuSupportPromise) {
    webGpuSupportPromise = (async () => {
      const gpu = (navigator as Navigator & {
        gpu?: { requestAdapter?: () => Promise<unknown> };
      }).gpu;
      if (!gpu || typeof gpu.requestAdapter !== 'function') return false;
      try {
        return Boolean(await gpu.requestAdapter());
      } catch {
        return false;
      }
    })();
  }
  return webGpuSupportPromise;
}

/** True once a model instance has been loaded in this session. */
export function isDeviceKokoroLoaded(): boolean {
  return cachedTts !== null;
}

/** The cached model instance, or null if it has not been loaded yet. */
export function getDeviceKokoro(): KokoroTTS | null {
  return cachedTts;
}

/** Backend used by the loaded model, or null before the first successful load. */
export function getDeviceKokoroBackend(): DeviceKokoroBackend | null {
  return cachedBackend;
}

/**
 * Whether the quantized Kokoro ONNX weights are already present in the
 * Transformers.js cache. This is a best-effort check (Cache Storage may be
 * unavailable or disabled) and does not verify file integrity.
 */
export async function isDeviceKokoroDownloaded(): Promise<boolean> {
  if (cachedTts) return true;
  if (typeof caches === 'undefined') return false;

  try {
    const cache = await caches.open(TRANSFORMERS_CACHE);
    const requests = await cache.keys();
    const modelFilePattern =
      /Kokoro-82M-v1\.0-ONNX\/resolve\/[^/]+\/onnx\/[^/]*model[^/]*\.onnx(?:$|\?)/i;
    return requests.some((request) => modelFilePattern.test(request.url));
  } catch {
    return false;
  }
}

/**
 * Ask the browser to keep this origin's storage when it is not persistent yet.
 * Best effort: browsers may deny the request (especially without engagement or
 * on private windows) and the download still works without it. Concurrent
 * callers share one request.
 */
export function requestDeviceKokoroPersistence(): Promise<boolean> {
  if (persistencePromise) return persistencePromise;

  persistencePromise = (async () => {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
    try {
      if (navigator.storage.persisted && (await navigator.storage.persisted())) {
        return true;
      }
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  })();

  return persistencePromise;
}

/**
 * Estimate whether this device has room for the model. Returns `sufficient:
 * true` when the browser does not expose an estimate, because guessing would
 * block devices that can actually download the model.
 */
export async function estimateDeviceKokoroStorage(
  requiredBytes: number = DEVICE_KOKORO_REQUIRED_BYTES
): Promise<DeviceKokoroStorageEstimate> {
  const required = Math.max(0, requiredBytes);
  let usageBytes: number | undefined;
  let quotaBytes: number | undefined;
  let supported = false;

  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      usageBytes = typeof estimate.usage === 'number' ? estimate.usage : undefined;
      quotaBytes = typeof estimate.quota === 'number' ? estimate.quota : undefined;
      supported = true;
    } catch {
      supported = false;
    }
  }

  let persistent = false;
  try {
    persistent = Boolean(
      typeof navigator !== 'undefined' &&
        navigator.storage?.persisted &&
        (await navigator.storage.persisted())
    );
  } catch {
    persistent = false;
  }

  const availableBytes =
    quotaBytes !== undefined && usageBytes !== undefined
      ? Math.max(0, quotaBytes - usageBytes)
      : quotaBytes;
  const sufficient = availableBytes === undefined ? true : availableBytes >= required;

  let message: string;
  if (!supported) {
    message =
      'This browser cannot report free storage. Make sure the device has at least ~120 MB free.';
  } else if (!sufficient) {
    message = `Only ${formatMegabytes(availableBytes ?? 0)} of storage is available, but Kokoro needs about ${formatMegabytes(required)}. Free up space or clear site data and try again.`;
  } else {
    message = `${formatMegabytes(availableBytes ?? 0)} available · needs about ${formatMegabytes(required)}`;
  }

  return {
    supported,
    requiredBytes: required,
    usageBytes,
    quotaBytes,
    availableBytes,
    persistent,
    sufficient,
    message,
  };
}

function formatMegabytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  return `${Math.max(0, Math.round(bytes / (1024 * 1024)))} MB`;
}

/**
 * Voice ids supported by the on-device model. Falls back to the known Kokoro
 * voice list before the model has been loaded.
 */
export function listDeviceKokoroVoices(): string[] {
  if (cachedTts) {
    try {
      return Object.keys(cachedTts.voices);
    } catch {
      // Fall through to the static list.
    }
  }
  return [...FALLBACK_VOICES];
}

function voiceFileUrl(voice: string): string {
  return `${VOICE_BASE_URL}/${voice}.bin`;
}

/**
 * Download (and cache) one voice embedding so the first `generate()` call does
 * not have to fetch it. Reports byte progress; safe to call concurrently — an
 * already cached voice resolves immediately.
 */
export async function preloadDeviceKokoroVoice(
  voice: string = DEVICE_KOKORO_DEFAULT_VOICE,
  onProgress?: DeviceKokoroProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  if (!voice) return;
  if (signal?.aborted) throw createAbortError();

  const url = voiceFileUrl(voice);
  const file = `voices/${voice}.bin`;
  let cache: Cache | null = null;
  try {
    if (typeof caches !== 'undefined') cache = await caches.open(VOICE_CACHE);
  } catch {
    cache = null;
  }

  if (cache) {
    try {
      if (await cache.match(url)) {
        onProgress?.({ status: 'done', progress: 100, file, stage: 'voice' });
        return;
      }
    } catch {
      // A broken cache should not stop the download.
    }
  }

  if (isOffline()) {
    throw new Error(
      `You are offline and the "${voice}" voice is not cached yet. Connect to the internet once to fetch it.`
    );
  }

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(
      `Could not download the "${voice}" voice (HTTP ${response.status}).`
    );
  }

  const headerLength = Number(response.headers.get('content-length'));
  const totalBytes =
    Number.isFinite(headerLength) && headerLength > 0 ? headerLength : undefined;

  let buffer: ArrayBuffer;
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loadedBytes = 0;
    for (;;) {
      if (signal?.aborted) {
        try {
          await reader.cancel();
        } catch {
          // Ignore cancel failures.
        }
        throw createAbortError();
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      loadedBytes += value.byteLength;
      onProgress?.({
        status: 'progress',
        progress:
          totalBytes && totalBytes > 0
            ? Math.min(99, Math.round((loadedBytes / totalBytes) * 100))
            : 0,
        file,
        loadedBytes,
        totalBytes,
        stage: 'voice',
      });
    }
    buffer = concatChunks(chunks, loadedBytes);
  } else {
    buffer = await response.arrayBuffer();
  }

  if (cache) {
    try {
      await cache.put(
        url,
        new Response(buffer, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(buffer.byteLength),
          },
        })
      );
    } catch {
      // Cache put can fail (quota/private mode); generation can still retry.
    }
  }

  onProgress?.({
    status: 'done',
    progress: 100,
    file,
    loadedBytes: buffer.byteLength,
    totalBytes: buffer.byteLength,
    stage: 'voice',
  });
}

function concatChunks(chunks: Uint8Array[], totalLength: number): ArrayBuffer {
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

/**
 * Load the on-device Kokoro model (quantized q8; WebGPU when available, WASM
 * otherwise).
 *
 * Concurrent calls share one load. Progress is reported as aggregate bytes
 * across all files downloaded so far. When `options.voice` is set, that voice
 * embedding is downloaded after the model, with its own progress events.
 *
 * @param onProgress Optional progress callback.
 * @param signal Optional abort signal. Because kokoro-js does not support
 *   model-download cancellation, aborting only stops this caller waiting; the
 *   model download keeps running in the background. Voice downloads are
 *   cancelled for real.
 * @param options Optional voice pre-download and backend preference.
 */
export async function loadDeviceKokoro(
  onProgress?: DeviceKokoroProgressCallback,
  signal?: AbortSignal,
  options: DeviceKokoroLoadOptions = {}
): Promise<KokoroTTS> {
  if (cachedTts) {
    onProgress?.({
      status: 'ready',
      progress: 100,
      backend: cachedBackend ?? undefined,
    });
    if (options.voice) {
      try {
        await preloadDeviceKokoroVoice(options.voice, onProgress, signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
        onProgress?.({
          status: 'warning',
          progress: 100,
          stage: 'voice',
          backend: cachedBackend ?? undefined,
          warning: describeVoiceError(error, options.voice),
        });
      }
    }
    return cachedTts;
  }

  if (!isDeviceKokoroSupported()) {
    throw new Error(
      'On-device Kokoro is not supported in this browser (WebAssembly is unavailable).'
    );
  }

  // Offline is only fatal when the weights are not already cached. The cache
  // check is best-effort, so a false negative simply falls through to a clear
  // download error.
  if (isOffline() && !(await isDeviceKokoroDownloaded())) {
    throw new Error(
      'You are offline. Connect to the internet once to download the Kokoro model; afterwards it can run offline.'
    );
  }

  if (signal?.aborted) {
    throw createAbortError();
  }

  if (!loadPromise) {
    const fileProgress = new Map<string, { loaded: number; total: number }>();
    let activeBackend: DeviceKokoroBackend | null = null;

    const report = (
      info: {
        status: string;
        file?: string;
        loaded?: number;
        total?: number;
      }
    ) => {
      if (info.file && info.status === 'progress') {
        fileProgress.set(info.file, {
          loaded: typeof info.loaded === 'number' ? info.loaded : 0,
          total: typeof info.total === 'number' ? info.total : 0,
        });
      }

      let loaded = 0;
      let total = 0;
      for (const entry of fileProgress.values()) {
        loaded += entry.loaded;
        total += entry.total;
      }

      // Keep 100 reserved for the "ready" event: the session is still being
      // initialised after the last byte arrives.
      const progress =
        info.status === 'ready'
          ? 100
          : total > 0
            ? Math.max(0, Math.min(99, Math.round((loaded / total) * 100)))
            : 0;

      emitProgress({
        status: info.status,
        progress,
        file: info.file,
        loadedBytes: loaded || undefined,
        totalBytes: total || undefined,
        stage: 'model',
        backend: activeBackend ?? undefined,
      });
    };

    const promise = (async (): Promise<KokoroTTS> => {
      let KokoroTTSClass: typeof import('kokoro-js').KokoroTTS;
      try {
        ({ KokoroTTS: KokoroTTSClass } = await import('kokoro-js'));
      } catch (error) {
        throw new Error(
          `Could not load the on-device Kokoro engine. ${
            error instanceof Error ? error.message : ''
          }`.trim()
        );
      }

      // Persistence and the storage warning only matter before the first
      // download; both are best-effort and never block the load.
      await requestDeviceKokoroPersistence();

      if (!(await isDeviceKokoroDownloaded())) {
        const estimate = await estimateDeviceKokoroStorage();
        if (!estimate.sufficient) {
          emitProgress({
            status: 'warning',
            progress: 0,
            stage: 'model',
            warning: estimate.message,
          });
        }
      }

      const preferWebGpu =
        options.preferWebGpu !== false && (await isWebGpuAvailable());

      const loadWith = async (backend: DeviceKokoroBackend): Promise<KokoroTTS> => {
        activeBackend = backend;
        fileProgress.clear();
        report({ status: 'initiate' });
        return KokoroTTSClass.from_pretrained(DEVICE_KOKORO_MODEL_ID, {
          dtype: 'q8',
          device: backend,
          progress_callback: report,
        });
      };

      let tts: KokoroTTS | null = null;
      let backend: DeviceKokoroBackend = 'wasm';

      if (preferWebGpu) {
        try {
          tts = await loadWith('webgpu');
          backend = 'webgpu';
        } catch (error) {
          if (isAbortError(error)) throw error;
          tts = null;
          emitProgress({
            status: 'fallback',
            progress: 0,
            stage: 'model',
            backend: 'wasm',
            warning: `WebGPU could not start (${errorMessage(error)}). Continuing with the WASM backend.`,
          });
        }
      }

      if (!tts) {
        try {
          tts = await loadWith('wasm');
          backend = 'wasm';
        } catch (error) {
          throw describeLoadError(error);
        }
      }

      cachedTts = tts;
      cachedBackend = backend;
      report({ status: 'ready' });

      if (options.voice) {
        try {
          await preloadDeviceKokoroVoice(options.voice, emitProgress, signal);
        } catch (error) {
          // A missing voice is reported when generation actually needs it; a
          // failed pre-download must not throw away a working model.
          if (isAbortError(error)) throw error;
          emitProgress({
            status: 'warning',
            progress: 100,
            stage: 'voice',
            backend,
            warning: describeVoiceError(error, options.voice),
          });
        }
      }

      return tts;
    })();

    loadPromise = promise;
    // Allow a retry after a failed load.
    promise.catch(() => {
      if (loadPromise === promise) loadPromise = null;
    });
  }

  if (!onProgress) {
    return raceWithAbort(loadPromise, signal);
  }

  const listener: DeviceKokoroProgressCallback = (update) => {
    if (!signal?.aborted) onProgress(update);
  };
  progressSubscribers.add(listener);
  try {
    return await raceWithAbort(loadPromise, signal);
  } finally {
    progressSubscribers.delete(listener);
  }
}

/**
 * Generate speech with the on-device model and return a WAV blob.
 *
 * @param text Text to speak. Must not be empty.
 * @param voice Kokoro voice id (see `listDeviceKokoroVoices`).
 * @param speed Speaking speed, clamped to 0.5-2.
 */
export async function generateDeviceKokoroAudio(
  text: string,
  voice: string = DEVICE_KOKORO_DEFAULT_VOICE,
  speed: number = 1
): Promise<Blob> {
  const input = text.trim();
  if (!input) {
    throw new Error('Cannot generate speech from empty text.');
  }

  const tts = cachedTts ?? (await loadDeviceKokoro());

  const availableVoices = listDeviceKokoroVoices();
  if (!availableVoices.includes(voice)) {
    throw new Error(
      `Unknown Kokoro voice "${voice}". Available voices: ${availableVoices.join(', ')}.`
    );
  }

  // Make sure the embedding is on disk before generation so a cold voice does
  // not fail inside `generate()` with an opaque network error.
  if (!(await isDeviceKokoroVoiceCached(voice))) {
    await preloadDeviceKokoroVoice(voice);
  }

  const safeSpeed = Number.isFinite(speed)
    ? Math.min(2, Math.max(0.5, speed))
    : 1;

  try {
    const audio = await tts.generate(input, {
      voice,
      speed: safeSpeed,
    } as Parameters<KokoroTTS['generate']>[1]);

    const blob = audio.toBlob();
    // `toBlob()` already returns `audio/wav`; normalise just in case.
    return blob.type ? blob : new Blob([blob], { type: 'audio/wav' });
  } catch (error) {
    const message = errorMessage(error);
    if (isOffline() || /fetch|network|load failed|failed to fetch/i.test(message)) {
      throw new Error(
        `Could not generate Kokoro speech. This voice may not be downloaded yet — connect to the internet once to fetch "${voice}", then try again.`
      );
    }
    throw new Error(`Could not generate Kokoro speech: ${message}`);
  }
}

/**
 * Best-effort check that a voice embedding is already in the kokoro-ts cache.
 * Voice files are small (~0.5 MB) and are downloaded the first time a voice
 * is used.
 */
export async function isDeviceKokoroVoiceCached(voice: string): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  try {
    const cache = await caches.open(VOICE_CACHE);
    const requests = await cache.keys();
    const suffix = `/voices/${voice}.bin`;
    return requests.some((request) =>
      request.url.replace(/[?#].*$/, '').endsWith(suffix)
    );
  } catch {
    return false;
  }
}

function isOffline(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.onLine === 'boolean' &&
    navigator.onLine === false
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeVoiceError(error: unknown, voice?: string): string {
  const label = voice ? `the "${voice}" voice` : 'the selected voice';
  const message = errorMessage(error);
  if (isOffline() || /fetch|network|load failed|failed to fetch/i.test(message)) {
    return `Could not download ${label}. Connect to the internet once, then retry.`;
  }
  return `Could not download ${label}. ${message}`;
}

function describeLoadError(error: unknown): Error {
  if (isAbortError(error)) return error instanceof Error ? error : createAbortError();

  const message = errorMessage(error);

  if (
    isOffline() ||
    /fetch|network|load failed|failed to fetch|ENOTFOUND|ECONN|timeout/i.test(message)
  ) {
    return new Error(
      `Kokoro model download failed. Check your internet connection and try again. (${message})`
    );
  }

  if (/quota|storage|space/i.test(message)) {
    return new Error(
      `Kokoro could not be stored on this device — there may not be enough free space. (${message})`
    );
  }

  if (/wasm|webassembly|onnxruntime|failed to create (an )?inference session/i.test(message)) {
    return new Error(
      `This device could not start the Kokoro WASM engine. (${message})`
    );
  }

  return new Error(`Kokoro model download failed: ${message}`);
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Kokoro model download was cancelled.', 'AbortError');
  }
  const error = new Error('Kokoro model download was cancelled.');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'AbortError'
  );
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}
