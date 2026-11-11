'use client';

import { useEffect, useRef } from 'react';
import { useAudioStore } from '../store/use-audio-store';
import { audioCacheKey } from '../lib/hash';
import { toSpeechText } from '../lib/math-speech';
import { isNativePlatform, speakNative, stopNative } from '../lib/native-tts';

export const AudioEngine = () => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const lastHashRef = useRef<string | null>(null);
  const lastIndexRef = useRef<number | null>(null);
  const lastUrlRef = useRef<string | null>(null);
  const nativeTokenRef = useRef(0);
  const nativeSpeakingRef = useRef(false);
  const nativeAbortRef = useRef<AbortController | null>(null);

  // Subscribe to store state
  const currentSegmentIndex = useAudioStore(state => state.currentSegmentIndex);
  const playbackStatus = useAudioStore(state => state.playbackStatus);
  const selectedVoice = useAudioStore(state => state.selectedVoice);
  const playbackSpeed = useAudioStore(state => state.playbackSpeed);
  const mathSpeech = useAudioStore(state => state.mathSpeech);
  const ttsEngine = useAudioStore(state => state.ttsEngine);
  const kokoroVoice = useAudioStore(state => state.kokoroVoice);
  const kokoroServerUrl = useAudioStore(state => state.kokoroServerUrl);
  const next = useAudioStore(state => state.next);
  const documentTitle = useAudioStore(state => state.documentTitle);

  // Create audio element once
  useEffect(() => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.onended = () => {
        next();
      };
      audio.onerror = (e) => {
        console.error('Audio playback error', e);
        const state = useAudioStore.getState();
        if (state.playbackStatus === 'playing') {
          // A corrupt cached blob should not leave the UI stuck in "playing".
          state.setPlaybackStatus('idle');
        }
      };
      audioRef.current = audio;
    }
  }, [next]);

  // Main playback effect
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // Stop everything when not in 'playing' state
    if (playbackStatus !== 'playing') {
      try { audio.pause(); } catch { }
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      nativeTokenRef.current++;
      nativeSpeakingRef.current = false;
      nativeAbortRef.current?.abort();
      nativeAbortRef.current = null;
      void stopNative();
      utteranceRef.current = null;
      useAudioStore.getState().setSpokenWordRange(null);
      return;
    }

    // --- Playing ---
    // Read the latest segments/cache imperatively. Adding a page of text or
    // prefetching audio must never restart the sentence that is being spoken.
    const { segments, audioCache } = useAudioStore.getState();
    const segment = segments[currentSegmentIndex];
    if (!segment) {
      // Reached the end or no content
      useAudioStore.getState().setPlaybackStatus('idle');
      return;
    }

    const speechText = mathSpeech ? toSpeechText(segment.text) : segment.text;
    const hash = audioCacheKey({
      engine: ttsEngine,
      voice: kokoroVoice,
      speed: playbackSpeed,
      serverUrl: ttsEngine === 'kokoro' ? kokoroServerUrl : '',
      text: speechText,
    });
    const sameSegment = lastHashRef.current === hash && lastIndexRef.current === currentSegmentIndex;
    const blob = audioCache.get(hash);

    if (blob) {
      // Cancel any browser/native TTS utterance
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      nativeTokenRef.current++;
      nativeSpeakingRef.current = false;
      nativeAbortRef.current?.abort();
      nativeAbortRef.current = null;
      void stopNative();
      utteranceRef.current = null;

      // Resume if this exact segment is already loaded
      if (sameSegment && lastUrlRef.current) {
        (async () => {
          try {
            audio.playbackRate = 1;
            await audio.play();
          } catch (e: unknown) {
            if (e instanceof Error && e.name !== 'AbortError') console.error('Audio play failed', e);
          }
        })();
        return;
      }

      // New segment — clean up old URL
      if (lastUrlRef.current) {
        try { URL.revokeObjectURL(lastUrlRef.current); } catch { }
      }

      const url = URL.createObjectURL(blob);
      lastUrlRef.current = url;
      lastHashRef.current = hash;
      lastIndexRef.current = currentSegmentIndex;
      audio.src = url;
      audio.currentTime = 0;
      audio.playbackRate = 1;

      (async () => {
        try {
          await audio.play();
        } catch (e: unknown) {
          if (e instanceof Error && e.name !== 'AbortError') console.error('Audio play failed', e);
        }
      })();
    } else {
      // Native OS TTS (Android/iOS app) is the default local, power-efficient
      // engine. It works offline and exposes real-time word boundaries.
      if (isNativePlatform()) {
        try { audio.pause(); } catch { }
        if (sameSegment && nativeSpeakingRef.current) return;

        lastHashRef.current = hash;
        lastIndexRef.current = currentSegmentIndex;
        nativeSpeakingRef.current = true;
        const token = ++nativeTokenRef.current;
        nativeAbortRef.current?.abort();
        const controller = new AbortController();
        nativeAbortRef.current = controller;
        const setWordRange = useAudioStore.getState().setSpokenWordRange;

        void speakNative({
          text: speechText,
          rate: playbackSpeed,
          voiceUri: selectedVoice,
          signal: controller.signal,
          onRangeStart: (range) => {
            if (nativeTokenRef.current === token) {
              setWordRange({ start: range.start, end: range.end });
            }
          },
        })
          .then(() => {
            if (nativeTokenRef.current === token) {
              nativeSpeakingRef.current = false;
              nativeAbortRef.current = null;
              setWordRange(null);
              next();
            }
          })
          .catch((error) => {
            if (nativeTokenRef.current === token) {
              nativeSpeakingRef.current = false;
              nativeAbortRef.current = null;
              if ((error as { name?: string })?.name !== 'AbortError') {
                console.warn('Native TTS error:', error);
                next();
              }
            }
          });
        return;
      }

      // Browser Web Speech API fallback
      try { audio.pause(); } catch { }
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

      window.speechSynthesis.cancel();

      // Avoid re-speaking the same sentence when only cache/segments changed.
      if (sameSegment && utteranceRef.current) {
        return;
      }

      lastHashRef.current = hash;
      lastIndexRef.current = currentSegmentIndex;

      const utterance = new SpeechSynthesisUtterance(speechText);
      utterance.rate = playbackSpeed;

      if (selectedVoice) {
        const voices = window.speechSynthesis.getVoices();
        const foundVoice = voices.find(v => v.voiceURI === selectedVoice);
        if (foundVoice) utterance.voice = foundVoice;
      }

      utterance.onend = () => {
        if (utteranceRef.current !== utterance) return;
        utteranceRef.current = null;
        useAudioStore.getState().setSpokenWordRange(null);
        if (useAudioStore.getState().playbackStatus === 'playing') next();
      };

      utterance.onerror = (e) => {
        if (utteranceRef.current !== utterance) return;
        // Ignore user-initiated cancellation errors
        if (e.error === 'canceled' || e.error === 'interrupted') {
          return;
        }
        console.warn('Speech synthesis error:', e);
        utteranceRef.current = null;
        useAudioStore.getState().setSpokenWordRange(null);
        if (useAudioStore.getState().playbackStatus === 'playing') next();
      };

      // Real-time word highlighting from the Web Speech API.
      utterance.onboundary = (event) => {
        if (utteranceRef.current !== utterance) return;
        if (event.name !== 'word') return;
        const start = event.charIndex;
        let end = start + (event.charLength || 0);
        if (end <= start) {
          let cursor = start;
          while (cursor < speechText.length && !/\s/.test(speechText[cursor])) cursor++;
          end = cursor;
        }
        if (end > start) {
          useAudioStore.getState().setSpokenWordRange({ start, end });
        }
      };

      // Hold utterance in ref to protect from Chromium garbage collection
      utteranceRef.current = utterance;
      window.speechSynthesis.speak(utterance);
    }
  }, [currentSegmentIndex, playbackStatus, selectedVoice, playbackSpeed, mathSpeech, ttsEngine, kokoroVoice, kokoroServerUrl, next]);

  // Lock-screen / media-key controls (Android, desktop browsers, Media Session).
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const mediaSession = navigator.mediaSession;

    try {
      mediaSession.setActionHandler('play', () => {
        const state = useAudioStore.getState();
        if (state.playbackStatus === 'paused') state.resume();
        else state.play();
      });
      mediaSession.setActionHandler('pause', () => useAudioStore.getState().pause());
      mediaSession.setActionHandler('stop', () => useAudioStore.getState().stop());
      mediaSession.setActionHandler('nexttrack', () => useAudioStore.getState().next());
      mediaSession.setActionHandler('previoustrack', () => {
        const state = useAudioStore.getState();
        state.playSegment(Math.max(0, state.currentSegmentIndex - 1));
      });
      mediaSession.setActionHandler('seekto', (details) => {
        const state = useAudioStore.getState();
        if (!state.segments.length || details.seekTime == null) return;
        const index = Math.max(
          0,
          Math.min(state.segments.length - 1, Math.round(details.seekTime))
        );
        state.seekToSegment(index, state.playbackStatus === 'playing');
      });
    } catch {
      // Some browsers expose a partial Media Session implementation.
    }

    return () => {
      for (const action of [
        'play',
        'pause',
        'stop',
        'nexttrack',
        'previoustrack',
        'seekto',
      ] as const) {
        try {
          mediaSession.setActionHandler(action, null);
        } catch {
          // Ignore unsupported actions.
        }
      }
    };
  }, []);

  // Keep metadata and position in sync with the spoken sentence.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const segments = useAudioStore.getState().segments;
    const segment = segments[currentSegmentIndex];

    try {
      if (typeof MediaMetadata !== 'undefined') {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: documentTitle ?? 'ReadAloud',
          artist: 'ReadAloud',
          album: segment?.text.slice(0, 80) ?? 'Document reader',
        });
      }
      navigator.mediaSession.playbackState =
        playbackStatus === 'playing'
          ? 'playing'
          : playbackStatus === 'paused'
            ? 'paused'
            : 'none';
    } catch {
      // Metadata is best-effort.
    }
  }, [currentSegmentIndex, playbackStatus, documentTitle]);

  // Keep the screen awake while reading (mobile/desktop browsers that support it).
  useEffect(() => {
    if (playbackStatus !== 'playing' || typeof navigator === 'undefined' || !('wakeLock' in navigator)) {
      return;
    }
    let sentinel: WakeLockSentinel | null = null;
    let disposed = false;

    const request = async () => {
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (disposed) {
          void lock.release();
          return;
        }
        sentinel = lock;
      } catch {
        // Wake lock requires a visible tab and user permission on some platforms.
      }
    };
    void request();

    return () => {
      disposed = true;
      void sentinel?.release();
    };
  }, [playbackStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {      if (lastUrlRef.current) {
        try { URL.revokeObjectURL(lastUrlRef.current); } catch { }
        lastUrlRef.current = null;
        lastHashRef.current = null;
        lastIndexRef.current = null;
      }
      if (audioRef.current) {
        try { audioRef.current.pause(); } catch { }
      }
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      void stopNative();
      nativeAbortRef.current?.abort();
      nativeAbortRef.current = null;
      utteranceRef.current = null;
    };
  }, []);

  return null; // Headless
};
