import { create } from 'zustand';
import { AudioState, TextSegment, TtsEngine } from '../types';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import { audioCacheKey } from '../lib/hash';
import { toSpeechText } from '../lib/math-speech';

/** localStorage can throw in private mode / when storage is disabled. */
function readStorage(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage is optional; keep playback working without it.
  }
}

const KOKORO_DEFAULT_URL = 'http://localhost:8880';

// Requests already in flight, so near-simultaneous prefetches do not duplicate
// network work for the same sentence.
const prefetching = new Set<string>();

// Monotonic token so Stop/Pause or a newer sentence wins over an older async
// synthesis that is still resolving.
let playbackRequestToken = 0;

interface AudioStore extends AudioState {
  audioCache: Map<string, Blob>;
  hydrated: boolean;
  hydrate: () => void;
}

export const useAudioStore = create<AudioStore>((set, get) => ({
  segments: [],
  currentSegmentIndex: 0,
  playbackStatus: 'idle',
  selectedVoice: null,
  audioCache: new Map(),
  file: null,
  documentTitle: null,
  segmentsComplete: true,
  stopAtSegmentIndex: null,
  waitingForMore: false,

  // Speed
  playbackSpeed: 1.0,

  // Speak equations as words.
  mathSpeech: true,

  // Reading & navigation state
  autoScroll: true,
  currentPage: 1,
  totalPages: 1,
  isFitToWidth: false,
  selectionSegmentIndex: null,
  spokenWordRange: null,

  // TTS engine
  ttsEngine: 'browser',
  kokoroVoice: 'af_heart',
  kokoroSpeed: 1.0,
  kokoroServerUrl: KOKORO_DEFAULT_URL,

  // Client-only persisted values (localStorage)
  hydrated: false,
  hydrate: () => {
    if (typeof window === 'undefined' || get().hydrated) return;

    const savedSpeedRaw = readStorage('playbackSpeed');
    let savedSpeed = 1.0;
    if (savedSpeedRaw) {
      const parsed = parseFloat(savedSpeedRaw);
      if (!isNaN(parsed) && parsed >= 0.5 && parsed <= 3.0) savedSpeed = parsed;
    }

    const savedAutoScrollRaw = readStorage('autoScroll');
    const savedAutoScroll = savedAutoScrollRaw !== null ? savedAutoScrollRaw === 'true' : true;

    const savedFontSizeRaw = readStorage('textFontSize');
    let savedFontSize = 16;
    if (savedFontSizeRaw) {
      const parsed = parseInt(savedFontSizeRaw, 10);
      if (!isNaN(parsed) && parsed >= 12 && parsed <= 32) savedFontSize = parsed;
    }

    const savedEngine = readStorage('ttsEngine');
    const ttsEngine: TtsEngine =
      savedEngine === 'kokoro' || savedEngine === 'device' ? savedEngine : 'browser';

    set({
      hydrated: true,
      selectedVoice: readStorage('selectedVoice'),
      playbackSpeed: savedSpeed,
      kokoroSpeed: savedSpeed,
      autoScroll: savedAutoScroll,
      textFontSize: savedFontSize,
      mathSpeech: readStorage('mathSpeech') !== 'false',
      ttsEngine,
      kokoroVoice: readStorage('kokoroVoice') ?? 'af_heart',
      kokoroServerUrl: readStorage('kokoroServerUrl') ?? KOKORO_DEFAULT_URL,
    });
  },

  setFile: (file: File | null) => set({
    file,
    documentTitle: file ? file.name : null,
    currentPage: 1,
    totalPages: 1,
  }),

  setDocumentTitle: (title: string | null) => set({ documentTitle: title }),

  setPlaybackSpeed: (speed: number) => {
    const next = Math.max(0.5, Math.min(3, Math.round(speed * 100) / 100));
    if (typeof window !== 'undefined') {
      try { localStorage.setItem('playbackSpeed', next.toString()); } catch {}
    }
    set({ playbackSpeed: next, kokoroSpeed: next });
  },

  setAutoScroll: (enabled: boolean) => {
    if (typeof window !== 'undefined') {
      try { localStorage.setItem('autoScroll', enabled.toString()); } catch {}
    }
    set({ autoScroll: enabled });
  },

  setCurrentPage: (page: number) => set({ currentPage: Math.max(1, page) }),
  setTotalPages: (pages: number) => set({ totalPages: Math.max(1, pages) }),
  setIsFitToWidth: (fit: boolean) => set({ isFitToWidth: fit }),

  setTtsEngine: (engine: TtsEngine) => {
    if (typeof window !== 'undefined') {
      try { localStorage.setItem('ttsEngine', engine); } catch {}
    }
    set({ ttsEngine: engine });
  },

  setKokoroVoice: (voice: string) => {
    if (typeof window !== 'undefined') {
      try { localStorage.setItem('kokoroVoice', voice); } catch {}
    }
    set({ kokoroVoice: voice });
  },

  setKokoroSpeed: (speed: number) => {
    const next = Math.max(0.5, Math.min(3, Math.round(speed * 100) / 100));
    if (typeof window !== 'undefined') {
      try { localStorage.setItem('playbackSpeed', next.toString()); } catch {}
    }
    set({ kokoroSpeed: next, playbackSpeed: next });
  },

  setKokoroServerUrl: (url: string) => {
    if (typeof window !== 'undefined') {
      try { localStorage.setItem('kokoroServerUrl', url); } catch {}
    }
    set({ kokoroServerUrl: url });
  },

  setSelectedVoice: (voiceURI: string) => {
    if (typeof window !== 'undefined') {
      try { localStorage.setItem('selectedVoice', voiceURI); } catch {}
    }
    set({ selectedVoice: voiceURI });
  },

  setPlaybackStatus: (status) => set({ playbackStatus: status }),

  setSelectionSegmentIndex: (index: number | null) => set({ selectionSegmentIndex: index }),
  setSpokenWordRange: (range) => set({ spokenWordRange: range }),

  setMathSpeech: (enabled: boolean) => {
    writeStorage('mathSpeech', enabled.toString());
    set({ mathSpeech: enabled });
  },

  loadSegments: (segments: TextSegment[]) =>
    set({
      segments,
      currentSegmentIndex: 0,
      playbackStatus: 'idle',
      stopAtSegmentIndex: null,
      waitingForMore: false,
    }),

  appendSegments: (segments: TextSegment[]) => {
    if (segments.length === 0) return;
    const state = get();
    const wasWaiting = state.waitingForMore;
    const firstNewIndex = state.segments.length;
    set({
      segments: state.segments.concat(segments),
      waitingForMore: false,
    });
    // Playback stopped at the end of the already-loaded text. Continue with the
    // first sentence of the newly appended page instead of making the user hit
    // play again.
    if (wasWaiting) {
      void get().playSegment(firstNewIndex);
    }
  },

  setSegmentsComplete: (complete: boolean) => set({ segmentsComplete: complete }),

  replaceSegmentsPreservingCurrent: (segments: TextSegment[]) =>
    set((state) => {
      const currentId = state.segments[state.currentSegmentIndex]?.id;
      const foundIndex = currentId ? segments.findIndex((segment) => segment.id === currentId) : -1;
      return {
        segments,
        currentSegmentIndex:
          foundIndex >= 0
            ? foundIndex
            : Math.min(state.currentSegmentIndex, Math.max(0, segments.length - 1)),
      };
    }),

  updateSegmentsWithoutReset: (segments: TextSegment[]) =>
    set(state => ({
      segments,
      currentSegmentIndex: Math.min(state.currentSegmentIndex, Math.max(0, segments.length - 1)),
    })),

  playSegment: async (index: number, options?: { stopAfter?: boolean }) => {
    const { segments, ttsEngine, audioCache, kokoroVoice, kokoroSpeed, kokoroServerUrl, mathSpeech, playbackSpeed } = get();
    if (index < 0 || index >= segments.length) return;

    set({
      currentSegmentIndex: index,
      playbackStatus: 'loading',
      stopAtSegmentIndex: options?.stopAfter ? index : null,
      waitingForMore: false,
      spokenWordRange: null,
      selectionSegmentIndex: null,
    });
    const requestToken = ++playbackRequestToken;

    const segment = segments[index];
    const speechText = mathSpeech ? toSpeechText(segment.text) : segment.text;
    const hash = audioCacheKey({
      engine: ttsEngine,
      voice: kokoroVoice,
      speed: playbackSpeed,
      serverUrl: ttsEngine === 'kokoro' ? kokoroServerUrl : '',
      text: speechText,
    });

    if (ttsEngine === 'device') {
      let blob = audioCache.get(hash);
      if (!blob) {
        const dbBlob = await idbGet(hash);
        if (dbBlob instanceof Blob) {
          blob = dbBlob;
          get().cacheAudioBlob(hash, blob);
        }
      }

      if (!blob) {
        try {
          const { generateDeviceKokoroAudio } = await import('../lib/device-kokoro');
          blob = await generateDeviceKokoroAudio(speechText, kokoroVoice, playbackSpeed);
          await idbSet(hash, blob);
          get().cacheAudioBlob(hash, blob);
        } catch (error) {
          console.warn('On-device Kokoro unavailable, falling back to device voice:', error);
        }
      }

      // When generation fails, AudioEngine falls back to native/browser TTS.
      if (requestToken !== playbackRequestToken) return;
      set({ playbackStatus: 'playing' });
      get().prefetchSegment(index + 1);
      return;
    }

    if (ttsEngine === 'kokoro') {
      let blob = audioCache.get(hash);

      if (!blob) {
        const dbBlob = await idbGet(hash);
        if (dbBlob && dbBlob instanceof Blob) {
          blob = dbBlob;
          get().cacheAudioBlob(hash, blob);
        }
      }

      if (!blob) {
        try {
          const response = await fetch(`${kokoroServerUrl}/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: speechText,
              voice: kokoroVoice,
              speed: kokoroSpeed,
              lang: 'en-us',
            }),
            signal:
              typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
                ? AbortSignal.timeout(60_000)
                : undefined,
          });

          if (!response.ok) {
            throw new Error(`Kokoro TTS error: ${response.status}`);
          }

          blob = await response.blob();
          await idbSet(hash, blob);
          get().cacheAudioBlob(hash, blob);
        } catch (error) {
          console.error('Kokoro TTS error, falling back to browser TTS:', error);
        }
      }

      get().prefetchSegment(index + 1);
      get().prefetchSegment(index + 2);
    }

    if (requestToken !== playbackRequestToken) return;
    set({ playbackStatus: 'playing' });
  },

  next: () => {
    const { currentSegmentIndex, segments, playSegment, stopAtSegmentIndex, segmentsComplete } = get();
    if (stopAtSegmentIndex !== null && currentSegmentIndex >= stopAtSegmentIndex) {
      set({ playbackStatus: 'idle', stopAtSegmentIndex: null, waitingForMore: false });
      return;
    }
    if (currentSegmentIndex < segments.length - 1) {
      playSegment(currentSegmentIndex + 1);
    } else if (!segmentsComplete) {
      // More pages are still being extracted; wait for appendSegments().
      set({ playbackStatus: 'loading', waitingForMore: true });
    } else {
      set({ playbackStatus: 'idle' });
    }
  },

  play: () => {
    const { currentSegmentIndex, playSegment } = get();
    playSegment(currentSegmentIndex);
  },

  pause: () => {
    playbackRequestToken++;
    set({ playbackStatus: 'paused' });
  },

  resume: () => {
    playbackRequestToken++;
    set({ playbackStatus: 'playing' });
  },

  stop: () => {
    playbackRequestToken++;
    set({
      playbackStatus: 'idle',
      currentSegmentIndex: 0,
      stopAtSegmentIndex: null,
      waitingForMore: false,
      selectionSegmentIndex: null,
      spokenWordRange: null,
    });
  },

  cacheAudioBlob: (hash: string, blob: Blob) => {
    set((state) => {
      const newCache = new Map(state.audioCache);
      newCache.delete(hash);
      newCache.set(hash, blob);
      // Keep memory bounded during long listening sessions.
      while (newCache.size > 120) {
        const oldest = newCache.keys().next().value;
        if (oldest === undefined) break;
        newCache.delete(oldest);
      }
      return { audioCache: newCache };
    });
  },

  seekToSegment: (index: number, autoplay: boolean) => {
    const { segments, playSegment } = get();
    if (index < 0 || index >= segments.length) return;
    if (autoplay) {
      void playSegment(index);
      return;
    }
    playbackRequestToken++;
    set({
      currentSegmentIndex: index,
      playbackStatus: segments.length ? 'paused' : 'idle',
    });
  },

  prefetchSegment: async (index: number) => {
    const { segments, ttsEngine, audioCache, kokoroVoice, kokoroSpeed, kokoroServerUrl, mathSpeech, playbackSpeed } = get();
    if (index < 0 || index >= segments.length) return;
    if (ttsEngine === 'browser') return;

    const segment = segments[index];
    const speechText = mathSpeech ? toSpeechText(segment.text) : segment.text;
    const hash = audioCacheKey({
      engine: ttsEngine,
      voice: kokoroVoice,
      speed: playbackSpeed,
      serverUrl: ttsEngine === 'kokoro' ? kokoroServerUrl : '',
      text: speechText,
    });

    if (audioCache.has(hash) || prefetching.has(hash)) return;
    prefetching.add(hash);

    try {
      const dbBlob = await idbGet(hash);
      if (dbBlob && dbBlob instanceof Blob) {
        get().cacheAudioBlob(hash, dbBlob);
        return;
      }

      if (ttsEngine === 'device') {
        const { generateDeviceKokoroAudio } = await import('../lib/device-kokoro');
        const blob = await generateDeviceKokoroAudio(speechText, kokoroVoice, playbackSpeed);
        await idbSet(hash, blob);
        get().cacheAudioBlob(hash, blob);
        return;
      }

      const response = await fetch(`${kokoroServerUrl}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: speechText,
          voice: kokoroVoice,
          speed: kokoroSpeed,
          lang: 'en-us',
        }),
      });

      if (!response.ok) return;
      const blob = await response.blob();
      await idbSet(hash, blob);
      get().cacheAudioBlob(hash, blob);
    } catch (e) {
      console.warn('Prefetch failed:', e);
    } finally {
      prefetching.delete(hash);
    }
  },

  // PDF zoom state
  scale: 1.5,
  setScale: (s: number) => set({ scale: s, isFitToWidth: false }),
  applyScale: (s: number) => set({ scale: Math.max(0.4, Math.min(3.5, s)) }),
  zoomIn: () => set(state => ({ scale: Math.min(3.5, +(state.scale * 1.2).toFixed(2)), isFitToWidth: false })),
  zoomOut: () => set(state => ({ scale: Math.max(0.4, +(state.scale / 1.2).toFixed(2)), isFitToWidth: false })),
  zoomReset: () => set({ scale: 1.5, isFitToWidth: false }),

  // Text reader font size state (12px to 32px, default 16px)
  textFontSize: 16,
  setTextFontSize: (size: number) => {
    writeStorage('textFontSize', size.toString());
    set({ textFontSize: size });
  },
  increaseFontSize: () =>
    set((state) => {
      const next = Math.min(32, state.textFontSize + 2);
      writeStorage('textFontSize', next.toString());
      return { textFontSize: next };
    }),
  decreaseFontSize: () =>
    set((state) => {
      const next = Math.max(12, state.textFontSize - 2);
      writeStorage('textFontSize', next.toString());
      return { textFontSize: next };
    }),
  resetFontSize: () => {
    writeStorage('textFontSize', '16');
    set({ textFontSize: 16 });
  },
}));

