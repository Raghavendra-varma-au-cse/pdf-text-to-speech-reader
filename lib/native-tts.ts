import { Capacitor } from '@capacitor/core';

/** True inside the Capacitor Android/iOS shell. */
export function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export interface NativeVoice {
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
  voiceURI: string;
}

/** Device voices from the native Android/iOS TTS engine (offline by default). */
export async function getNativeVoices(): Promise<NativeVoice[]> {
  if (!isNativePlatform()) return [];
  try {
    const { TextToSpeech } = await import('@capacitor-community/text-to-speech');
    const { voices } = await TextToSpeech.getSupportedVoices();
    return voices.map((voice, index) => ({
      ...voice,
      voiceURI: `native:${index}`,
    }));
  } catch {
    return [];
  }
}

export interface NativeSpeakOptions {
  text: string;
  rate: number;
  lang?: string;
  /** `selectedVoice` may be "native:3"; otherwise the device default is used. */
  voiceUri?: string | null;
  onRangeStart?: (range: { start: number; end: number; word: string }) => void;
  /** Abort resolves the wrapper and removes the range listener. */
  signal?: AbortSignal;
}

/** Speak through the OS TTS engine. Resolves when the utterance finishes. */
export async function speakNative({
  text,
  rate,
  lang = 'en-US',
  voiceUri,
  onRangeStart,
  signal,
}: NativeSpeakOptions): Promise<void> {
  if (!isNativePlatform()) throw new Error('Native TTS is only available in the mobile app.');

  const { TextToSpeech, QueueStrategy } = await import('@capacitor-community/text-to-speech');
  const voiceMatch = /^native:(\d+)$/.exec(voiceUri ?? '');
  const voice = voiceMatch ? Number(voiceMatch[1]) : undefined;

  const listener = onRangeStart
    ? await TextToSpeech.addListener('onRangeStart', (info) => {
        onRangeStart({ start: info.start, end: info.end, word: info.spokenWord });
      })
    : null;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      try {
        void listener?.remove();
      } catch {
        // Listener removal is best-effort.
      }
    };
    const onAbort = () => {
      cleanup();
      reject(
        typeof DOMException !== 'undefined'
          ? new DOMException('Native speech cancelled.', 'AbortError')
          : Object.assign(new Error('Native speech cancelled.'), { name: 'AbortError' })
      );
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    TextToSpeech.speak({
      text,
      lang,
      rate: Math.max(0.5, Math.min(3, rate)),
      pitch: 1,
      volume: 1,
      voice,
      queueStrategy: QueueStrategy.Flush,
    })
      .then(() => {
        cleanup();
        resolve();
      })
      .catch((error) => {
        cleanup();
        reject(error);
      });
  });
}

export async function stopNative(): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const { TextToSpeech } = await import('@capacitor-community/text-to-speech');
    await TextToSpeech.stop();
  } catch {
    // Ignore stop failures.
  }
}
