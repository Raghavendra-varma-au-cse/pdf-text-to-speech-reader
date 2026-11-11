import { get as idbGet, set as idbSet } from 'idb-keyval';
import { audioCacheKey } from './hash';
import { toSpeechText } from './math-speech';
import { useAudioStore } from '../store/use-audio-store';

/**
 * Export the document as a single MP3.
 *
 * Audio comes from either the Kokoro server or the on-device model; both emit
 * 24 kHz mono WAV that is decoded and encoded with LAME. Sentences already in
 * the IndexedDB cache are reused, so exporting a book you have listened to is
 * much faster than the first pass. The on-device path synthesises one sentence
 * at a time (WASM inference is CPU-bound) while the previous one is encoded.
 */

export interface Mp3ExportProgress {
  phase: 'starting' | 'synthesizing' | 'encoding' | 'done' | 'cancelled';
  current: number;
  total: number;
  message: string;
  /** Estimated time remaining in milliseconds, when known. */
  etaMs?: number;
}

export type ProgressHandler = (progress: Mp3ExportProgress) => void;

export interface Mp3ExportOptions {
  serverUrl: string;
  voice: string;
  speed: number;
  /** 'device' uses the on-device Kokoro model instead of the HTTP server. */
  engine?: 'kokoro' | 'device';
  startIndex?: number;
  endIndex?: number;
  mathSpeech: boolean;
  onProgress?: ProgressHandler;
  signal?: AbortSignal;
}

class CancelledError extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'CancelledError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}

/** 200 ms of silence between sentences keeps the narration natural. */
function silence(sampleRate: number, seconds = 0.2): Float32Array {
  return new Float32Array(Math.floor(sampleRate * seconds));
}

interface DecodedAudio {
  sampleRate: number;
  samples: Float32Array;
}

/**
 * Decode synthesized audio to mono float samples.
 *
 * `decodeAudioData` handles WAV on every browser we target, but Android WebView
 * builds occasionally reject it (or have no usable AudioContext). Falling back
 * to a tiny RIFF/PCM parser keeps export working without native decoders.
 */
async function decodeAudio(
  context: AudioContext | null,
  blob: Blob
): Promise<DecodedAudio> {
  const buffer = await blob.arrayBuffer();

  if (context) {
    try {
      const decoded = await context.decodeAudioData(buffer.slice(0));
      return { sampleRate: decoded.sampleRate, samples: mixDown(decoded) };
    } catch {
      // Fall through to the local WAV parser.
    }
  }

  const parsed = parseWav(buffer);
  if (!parsed) {
    throw new Error('Could not decode the synthesized audio.');
  }
  return parsed;
}

/** Minimal RIFF/WAVE parser for uncompressed PCM and IEEE float data. */
function parseWav(buffer: ArrayBuffer): DecodedAudio | null {
  if (buffer.byteLength < 44) return null;
  const view = new DataView(buffer);
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    return null;
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (chunkId === 'fmt ' && body + 16 <= view.byteLength) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE stores the real format at the end of fmt.
      if (format === 0xfffe && chunkSize >= 26 && body + 26 <= view.byteLength) {
        format = view.getUint16(body + 24, true);
      }
    } else if (chunkId === 'data') {
      dataOffset = body;
      dataLength = Math.min(chunkSize, view.byteLength - body);
      break;
    }

    offset = body + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || channels <= 0 || sampleRate <= 0) return null;
  const bytesPerSample = bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample <= 0) return null;

  const frameCount = Math.floor(dataLength / (bytesPerSample * channels));
  if (frameCount <= 0) return null;

  const samples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      const pointer =
        dataOffset + (frame * channels + channel) * bytesPerSample;
      sum += readPcmSample(view, pointer, format, bitsPerSample);
    }
    samples[frame] = sum / channels;
  }

  return { sampleRate, samples };
}

function readAscii(view: DataView, offset: number, length: number): string {
  let text = '';
  for (let i = 0; i < length; i++) {
    text += String.fromCharCode(view.getUint8(offset + i));
  }
  return text;
}

function readPcmSample(
  view: DataView,
  offset: number,
  format: number,
  bitsPerSample: number
): number {
  if (format === 3) {
    // IEEE float.
    if (bitsPerSample === 32) return view.getFloat32(offset, true);
    if (bitsPerSample === 64) return view.getFloat64(offset, true);
    return 0;
  }

  // Linear PCM. Transformers.js writes float32 WAV; this branch keeps PCM
  // fallbacks working for other servers and older cached files.
  if (bitsPerSample === 8) return (view.getUint8(offset) - 128) / 128;
  if (bitsPerSample === 16) return view.getInt16(offset, true) / 0x8000;
  if (bitsPerSample === 24) {
    const value =
      view.getUint8(offset) |
      (view.getUint8(offset + 1) << 8) |
      (view.getInt8(offset + 2) << 16);
    return value / 0x800000;
  }
  if (bitsPerSample === 32) return view.getInt32(offset, true) / 0x80000000;
  return 0;
}

/** Convert float samples to the Int16 PCM that LAME expects. */
function toInt16(samples: Float32Array): Int16Array {
  const output = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    output[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return output;
}

function sanitizeFileName(name: string): string {  return (
    name
      .replace(/\.(pdf|docx|md|markdown|txt)$/i, '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'readaloud'
  );
}

export function suggestMp3FileName(title: string | null): string {
  return `${sanitizeFileName(title ?? 'readaloud')}.mp3`;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser time to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function getAudioBlob(
  text: string,
  options: Mp3ExportOptions,
  signal?: AbortSignal
): Promise<Blob> {
  const speechText = options.mathSpeech ? toSpeechText(text) : text;
  const engine = options.engine === 'device' ? 'device' : 'kokoro';
  const hash = audioCacheKey({
    engine,
    voice: options.voice,
    speed: options.speed,
    serverUrl: engine === 'kokoro' ? options.serverUrl : '',
    text: speechText,
  });
  const store = useAudioStore.getState();
  const cached = store.audioCache.get(hash);
  if (cached) return cached;

  const stored = await idbGet<Blob>(hash);
  if (stored instanceof Blob) {
    store.cacheAudioBlob(hash, stored);
    return stored;
  }

  throwIfAborted(signal);

  if (options.engine === 'device') {
    const { generateDeviceKokoroAudio } = await import('./device-kokoro');
    const blob = await generateDeviceKokoroAudio(speechText, options.voice, options.speed);
    await idbSet(hash, blob);
    store.cacheAudioBlob(hash, blob);
    return blob;
  }

  const response = await fetch(`${options.serverUrl}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: speechText,
      voice: options.voice,
      speed: options.speed,
      lang: 'en-us',
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Kokoro TTS error ${response.status}. Is the local server running?`);
  }

  const blob = await response.blob();
  await idbSet(hash, blob);
  store.cacheAudioBlob(hash, blob);
  return blob;
}

function mixDown(decoded: AudioBuffer): Float32Array {
  const channelCount = decoded.numberOfChannels;
  if (channelCount === 1) return decoded.getChannelData(0);
  const mono = new Float32Array(decoded.length);
  for (let channel = 0; channel < channelCount; channel++) {
    const data = decoded.getChannelData(channel);
    for (let i = 0; i < data.length; i++) {
      mono[i] += data[i] / channelCount;
    }
  }
  return mono;
}

/** Linear resample used only when a chunk's rate differs from the encoder's. */
function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = toRate / fromRate;
  const length = Math.max(1, Math.round(samples.length * ratio));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i / ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const fraction = position - left;
    output[i] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return output;
}

/**
 * Synthesize `segments` and encode them into one MP3 blob.
 * Throws CancelledError when the signal is aborted.
 */
export async function exportDocumentToMp3(
  segments: { text: string }[],
  options: Mp3ExportOptions
): Promise<Blob> {
  const start = Math.max(0, options.startIndex ?? 0);
  const end = Math.min(segments.length - 1, options.endIndex ?? segments.length - 1);
  const total = Math.max(0, end - start + 1);
  if (total === 0) throw new Error('There is no text to export.');

  const { onProgress, signal } = options;
  onProgress?.({ phase: 'starting', current: 0, total, message: 'Preparing audio…' });

  // Created lazily: export must keep working in WebViews where constructing an
  // AudioContext throws, because the WAV fallback parser needs no decoder.
  let audioContext: AudioContext | null = null;
  const getAudioContext = (): AudioContext | null => {
    if (audioContext) return audioContext;
    try {
      audioContext = new AudioContext();
    } catch {
      audioContext = null;
    }
    return audioContext;
  };

  const { Mp3Encoder } = await import('@breezystack/lamejs');

  type Encoder = {
    encodeBuffer(left: Int16Array, right?: Int16Array): Uint8Array;
    flush(): Uint8Array;
  };

  let sampleRate = 24_000;
  const encoderState: { encoder: Encoder | null } = { encoder: null };
  const chunks: Uint8Array[] = [];

  const ensureEncoder = (rate: number): number => {
    if (!encoderState.encoder) {
      sampleRate = rate;
      encoderState.encoder = new Mp3Encoder(1, sampleRate, 128);
    }
    return sampleRate;
  };

  const encode = (samples: Float32Array) => {
    if (samples.length === 0) return;
    const activeEncoder = encoderState.encoder;
    if (!activeEncoder) return;
    const pcm = toInt16(samples);
    const blockSize = 1152;
    for (let offset = 0; offset < pcm.length; offset += blockSize) {
      const block = pcm.subarray(offset, Math.min(offset + blockSize, pcm.length));
      const encoded = activeEncoder.encodeBuffer(block);
      if (encoded.length > 0) chunks.push(encoded);
    }
  };

  const startedAt = Date.now();
  const report = (
    current: number,
    message: string,
    phase: Mp3ExportProgress['phase'] = 'synthesizing'
  ) => {
    const elapsed = Date.now() - startedAt;
    const etaMs =
      current > 1 && current < total
        ? Math.round((elapsed / Math.max(1, current - 1)) * (total - current + 1))
        : undefined;
    onProgress?.({ phase, current, total, message, etaMs });
  };

  // LAME is initialised with the first sample rate seen. Kokoro always returns
  // 24 kHz mono; resampling here only guards against a mixed batch response.
  const encodeDecoded = (decoded: DecodedAudio) => {
    const rate = ensureEncoder(decoded.sampleRate);
    const samples =
      decoded.sampleRate === rate
        ? decoded.samples
        : resampleLinear(decoded.samples, decoded.sampleRate, rate);
    encode(samples);
    encode(silence(rate));
  };

  /** New servers can synthesize a batch in one request (much faster). */
  const BATCH_SIZE = 16;
  const tryBatch = async (firstIndex: number): Promise<number> => {
    if (options.engine === 'device') return -1;
    const lastIndex = Math.min(end, firstIndex + BATCH_SIZE - 1);
    const texts: string[] = [];
    for (let index = firstIndex; index <= lastIndex; index++) {
      const text = segments[index].text;
      texts.push(options.mathSpeech ? toSpeechText(text) : text);
    }

    const response = await fetch(`${options.serverUrl}/tts/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        texts,
        voice: options.voice,
        speed: options.speed,
        lang: 'en-us',
        gap_ms: 140,
      }),
      signal,
    });

    if (response.status === 404 || response.status === 405) return -1;
    if (!response.ok) {
      throw new Error(`Kokoro batch TTS error ${response.status}.`);
    }

    const decoded = await decodeAudio(getAudioContext(), await response.blob());
    encodeDecoded(decoded);
    return lastIndex;
  };

  const isDevice = options.engine === 'device';

  try {
    let index = start;
    // The HTTP server can synthesize 16 sentences per request; the on-device
    // model cannot, so its path never touches /tts/batch.
    let useBatch = !isDevice;

    // Per-sentence prefetch keeps network/model latency hidden behind MP3
    // encoding. The server tolerates four in-flight requests; the on-device
    // model is CPU-bound, so only one sentence is generated ahead.
    const prefetchLimit = isDevice ? 1 : 4;
    const pending = new Map<number, Promise<Blob>>();
    let nextPrefetch = start;

    const fillPrefetch = () => {
      while (nextPrefetch <= end && pending.size < prefetchLimit) {
        const indexToFetch = nextPrefetch;
        nextPrefetch++;
        pending.set(indexToFetch, getAudioBlob(segments[indexToFetch].text, options, signal));
      }
    };

    while (index <= end) {
      throwIfAborted(signal);
      const current = index - start + 1;

      if (useBatch) {
        report(current, `Synthesizing ${Math.min(BATCH_SIZE, end - index + 1)} sentences in one batch…`);
        try {
          const lastBatchIndex = await tryBatch(index);
          if (lastBatchIndex === -1) {
            useBatch = false;
          } else {
            index = lastBatchIndex + 1;
            report(index - start, `Synthesized ${index - start} of ${total}…`);
            continue;
          }
        } catch {
          if (signal?.aborted) throw new CancelledError();
          // Older servers do not have /tts/batch; fall back to sentence mode.
          useBatch = false;
          nextPrefetch = index;
          pending.clear();
        }
      }

      report(
        current,
        isDevice
          ? `Synthesizing sentence ${current} of ${total} on this device…`
          : `Synthesizing sentence ${current} of ${total}…`
      );
      fillPrefetch();
      const blobPromise = pending.get(index);
      pending.delete(index);
      if (!blobPromise) {
        throw new Error(`Missing audio for sentence ${current}.`);
      }

      const blob = await blobPromise;
      // Cancellation is checked between sentences, so an aborted export stops
      // before paying for the next on-device inference or encode.
      throwIfAborted(signal);
      // Keep one sentence generating while the current one is decoded/encoded.
      fillPrefetch();
      const decoded = await decodeAudio(getAudioContext(), blob);
      encodeDecoded(decoded);
      index++;
      report(index - start, `Synthesized ${index - start} of ${total}…`);
    }

    report(total, 'Finalizing MP3…', 'encoding');

    const finalEncoder = encoderState.encoder;
    if (finalEncoder) {
      const tail = finalEncoder.flush();
      if (tail.length > 0) chunks.push(tail);
    }

    onProgress?.({ phase: 'done', current: total, total, message: 'MP3 ready' });
    return new Blob(chunks as BlobPart[], { type: 'audio/mpeg' });
  } catch (error) {
    if (error instanceof CancelledError) {
      onProgress?.({ phase: 'cancelled', current: 0, total, message: 'Export cancelled' });
    }
    throw error;
  } finally {
    closeAudioContext();
  }

  function closeAudioContext() {
    if (audioContext) void audioContext.close();
  }
}
