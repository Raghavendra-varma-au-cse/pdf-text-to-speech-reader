'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useAudioStore } from '../store/use-audio-store';
import { cn } from '../lib/cn';
import { getNativeVoices, isNativePlatform } from '../lib/native-tts';
import { KokoroDeviceDownload } from './KokoroDeviceDownload';
import {
  VoiceIcon,
  HeadphonesIcon,
  BotIcon,
  SearchIcon,
  CheckIcon,
  CloseIcon,
  SparklesIcon,
} from './Icons';

interface VoiceSheetProps {
  isOpen: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

export const VoiceSheet: React.FC<VoiceSheetProps> = ({ isOpen, onClose, triggerRef }) => {
  const ttsEngine = useAudioStore((s) => s.ttsEngine);
  const setTtsEngine = useAudioStore((s) => s.setTtsEngine);
  const selectedVoice = useAudioStore((s) => s.selectedVoice);
  const setSelectedVoice = useAudioStore((s) => s.setSelectedVoice);
  const kokoroVoice = useAudioStore((s) => s.kokoroVoice);
  const setKokoroVoice = useAudioStore((s) => s.setKokoroVoice);
  const kokoroServerUrl = useAudioStore((s) => s.kokoroServerUrl);
  const setKokoroServerUrl = useAudioStore((s) => s.setKokoroServerUrl);

  const [activeTab, setActiveTab] = useState<'browser' | 'kokoro'>(
    ttsEngine === 'browser' ? 'browser' : 'kokoro'
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [kokoroVoices, setKokoroVoices] = useState<string[]>([]);
  const [kokoroVoicesUrl, setKokoroVoicesUrl] = useState('');
  const [serverUrlDraft, setServerUrlDraft] = useState(kokoroServerUrl);
  const [isLoadingKokoro, setIsLoadingKokoro] = useState(false);
  const [kokoroMessage, setKokoroMessage] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [isNative, setIsNative] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Sync tab with engine when opened
  useEffect(() => {
    if (isOpen) {
      queueMicrotask(() => {
        setActiveTab(ttsEngine === 'browser' ? 'browser' : 'kokoro');
        setSearchQuery('');
        setServerUrlDraft(kokoroServerUrl);
        searchInputRef.current?.focus();
      });
    }
  }, [isOpen, ttsEngine, kokoroServerUrl]);

  // Load browser voices (or the OS voices inside the Android/iOS app).
  useEffect(() => {
    const native = isNativePlatform();
    queueMicrotask(() => setIsNative(native));

    const loadVoices = async () => {
      if (native) {
        const deviceVoices = await getNativeVoices();
        const mapped = deviceVoices.map((voice) => ({
          name: voice.name,
          lang: voice.lang,
          voiceURI: voice.voiceURI,
          default: voice.default,
          localService: voice.localService,
        })) as SpeechSynthesisVoice[];
        setBrowserVoices(mapped);
        if (!selectedVoice && mapped.length > 0) {
          const en = mapped.find((voice) => voice.lang.startsWith('en')) || mapped[0];
          if (en) setSelectedVoice(en.voiceURI);
        }
        return;
      }

      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
      const vs = window.speechSynthesis.getVoices();
      setBrowserVoices(vs);
      if (!selectedVoice && vs.length > 0) {
        const en = vs.find((v) => v.lang.startsWith('en')) || vs[0];
        if (en) setSelectedVoice(en.voiceURI);
      }
    };

    void loadVoices();
    if (!native && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.onvoiceschanged = () => void loadVoices();
    }
    return () => {
      if (!native && typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.onvoiceschanged = null;
      }
    };
  }, [selectedVoice, setSelectedVoice]);

  // Fetch Kokoro voices when open. Cache per server URL and time out quickly so
  // an offline server never leaves the sheet spinning forever.
  useEffect(() => {
    if (!isOpen) return;
    if (kokoroVoices.length > 0 && kokoroVoicesUrl === kokoroServerUrl) return;

    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 6000);
    queueMicrotask(() => {
      if (active) {
        setIsLoadingKokoro(true);
        setKokoroMessage(null);
      }
    });

    fetch(`${kokoroServerUrl}/voices`, { signal: controller.signal })
      .then(async (r) => {
        if (r.status === 503) {
          const detail = await r.json().catch(() => null);
          const message =
            typeof detail?.detail === 'string' ? detail.detail : 'Kokoro model is loading…';
          throw Object.assign(new Error(message), { retry: true });
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (active) {
          setKokoroVoices(Array.isArray(data.voices) ? data.voices : []);
          setKokoroVoicesUrl(kokoroServerUrl);
          setKokoroMessage(null);
          // Warm the model in the background so the first sentence is fast.
          void fetch(`${kokoroServerUrl}/warmup`, { method: 'POST' }).catch(() => {});
        }
      })
      .catch((error) => {
        if (active) {
          setKokoroVoices([]);
          setKokoroVoicesUrl(kokoroServerUrl);
          if ((error as { retry?: boolean }).retry) {
            setKokoroMessage('Kokoro is loading the model. This can take a minute on first run…');
            window.setTimeout(() => {
              if (active) setRetryTick((value) => value + 1);
            }, 5000);
          } else {
            setKokoroMessage(null);
          }
        }
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (active) setIsLoadingKokoro(false);
      });

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [isOpen, kokoroServerUrl, kokoroVoices.length, kokoroVoicesUrl, retryTick]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        sheetRef.current &&
        !sheetRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        onClose();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isOpen, onClose, triggerRef]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const filteredBrowser = browserVoices.filter(
    (v) =>
      v.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      v.lang.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredKokoro = kokoroVoices.filter((v) =>
    v.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <>
      {/* Dimmed backdrop (especially on mobile) */}
      <div
        className="fixed inset-0 bg-black/45 z-[1100] backdrop-blur-xs animate-fade-in-fast"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet Container: Centered bottom drawer on mobile, floating popover on desktop */}
      <div
        ref={sheetRef}
        className={cn(
          'z-[1200] bg-surface border border-border shadow-2xl flex min-h-0 flex-col',
          'max-md:fixed max-md:bottom-0 max-md:left-0 max-md:right-0 max-md:max-h-[85dvh] max-md:rounded-t-3xl max-md:p-5 max-md:pb-[max(1.25rem,env(safe-area-inset-bottom))] max-md:animate-slide-up',
          'md:absolute md:bottom-[calc(100%+12px)] md:right-0 md:w-[380px] md:max-h-[min(520px,calc(100dvh-8rem))] md:rounded-2xl md:p-4 md:animate-fade-in-fast'
        )}
        role="dialog"
        aria-modal="true"
        aria-label="Select voice"
      >
        {/* Header with drag indicator & close button */}
        <div className="flex shrink-0 items-center justify-between border-b border-border/60 pb-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-primary-subtle text-primary flex items-center justify-center">
              <HeadphonesIcon size={18} />
            </div>
            <div>
              <h3 className="font-heading font-bold text-foreground text-base leading-tight">
                Speech Voice
              </h3>
              <p className="text-xs text-muted">Select neural or browser voice</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-muted hover:text-foreground hover:bg-border/40 transition-colors cursor-pointer border-0 bg-transparent"
            aria-label="Close voice menu"
          >
            <CloseIcon size={18} />
          </button>
        </div>

        {/* Tab switch */}
        <div className="my-3 flex shrink-0 gap-1.5 rounded-xl border border-navbar-control-border bg-navbar-control p-1">
          <button
            type="button"
            className={cn(
              'flex min-h-[2.5rem] min-w-0 flex-1 items-center justify-center gap-1.5 px-2 py-2 text-xs font-semibold border-0 rounded-lg cursor-pointer transition-all duration-150 sm:px-3',
              activeTab === 'browser'
                ? 'bg-surface text-primary shadow-xs font-bold'
                : 'bg-transparent text-muted hover:text-foreground'
            )}
            onClick={() => {
              setActiveTab('browser');
              setSearchQuery('');
            }}
          >
            <VoiceIcon size={14} />
            <span className="truncate">
              {isNative ? 'Device Voices' : 'Browser Voices'} ({browserVoices.length})
            </span>
          </button>

          <button
            type="button"
            className={cn(
              'flex min-h-[2.5rem] min-w-0 flex-1 items-center justify-center gap-1.5 px-2 py-2 text-xs font-semibold border-0 rounded-lg cursor-pointer transition-all duration-150 sm:px-3',
              activeTab === 'kokoro'
                ? 'bg-surface text-primary shadow-xs font-bold'
                : 'bg-transparent text-muted hover:text-foreground'
            )}
            onClick={() => {
              setActiveTab('kokoro');
              setSearchQuery('');
            }}
          >
            <BotIcon size={14} />
            <span className="truncate">Kokoro Neural</span>
            <span className="shrink-0 rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-bold text-primary">
              HD
            </span>
          </button>
        </div>

        {/* Optional on-device Kokoro model */}
        {activeTab === 'kokoro' && (
          <details className="mb-2.5 shrink-0 rounded-xl border border-border bg-background/60">
            <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-foreground">
              On-device Kokoro (offline, optional)
            </summary>
            <div className="border-t border-border/60 p-2">
              <KokoroDeviceDownload
                onReady={() => {
                  setTtsEngine('device');
                  setActiveTab('kokoro');
                  onClose();
                }}
              />
            </div>
          </details>
        )}

        {/* Search input */}
        {activeTab === 'kokoro' && (
          <div className="mb-2.5 shrink-0">
            <div className="flex gap-1.5">
              <label htmlFor="kokoro-server-url" className="sr-only">Kokoro server address</label>
              <input
                id="kokoro-server-url"
                type="url"
                inputMode="url"
                value={serverUrlDraft}
                onChange={(event) => setServerUrlDraft(event.target.value)}
                onBlur={() => {
                  const next = serverUrlDraft.trim().replace(/\/+$/, '') || 'http://localhost:8880';
                  setServerUrlDraft(next);
                  if (next !== kokoroServerUrl) {
                    setKokoroVoices([]);
                    setKokoroVoicesUrl('');
                    setKokoroServerUrl(next);
                  }
                }}
                placeholder="http://localhost:8880"
                className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-2 text-xs font-mono text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
              <button
                type="button"
                onClick={() => {
                  const next = serverUrlDraft.trim().replace(/\/+$/, '') || 'http://localhost:8880';
                  setServerUrlDraft(next);
                  setKokoroVoices([]);
                  setKokoroVoicesUrl('');
                  setKokoroServerUrl(next);
                }}
                className="shrink-0 rounded-lg bg-navbar-control border border-navbar-control-border px-2.5 py-2 text-xs font-semibold text-foreground hover:border-primary hover:text-primary"
              >
                Connect
              </button>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-muted">
              On a phone, use your computer&apos;s LAN address, e.g. http://192.168.1.20:8880
            </p>
          </div>
        )}

        <div className="relative mb-2.5 shrink-0">
          <SearchIcon
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
          />
          <input
            ref={searchInputRef}
            type="text"
            className="w-full pl-9 pr-8 py-2 text-sm rounded-lg border border-border bg-background text-foreground outline-none transition-all focus:border-primary focus:ring-2 focus:ring-primary/20"
            placeholder={
              activeTab === 'browser' ? 'Search by name or language…' : 'Search Kokoro neural voices…'
            }
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground bg-transparent border-0 cursor-pointer p-0.5"
            >
              <CloseIcon size={14} />
            </button>
          )}
        </div>

        {/* Voice list */}
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain pr-1 pb-1 [scrollbar-width:thin]">
          {activeTab === 'browser' ? (
            filteredBrowser.length > 0 ? (
              filteredBrowser.map((v) => {
                const isSelected = ttsEngine === 'browser' && selectedVoice === v.voiceURI;
                return (
                  <button
                    key={v.voiceURI}
                    type="button"
                    className={cn(
                      'flex items-center justify-between p-2.5 rounded-xl text-left border cursor-pointer transition-all duration-150',
                      isSelected
                        ? 'bg-primary/10 border-primary text-primary font-semibold shadow-xs'
                        : 'bg-transparent border-transparent hover:bg-surface-hover hover:border-border text-foreground'
                    )}
                    onClick={() => {
                      setSelectedVoice(v.voiceURI);
                      setTtsEngine('browser');
                      onClose();
                    }}
                  >
                    <div className="flex flex-col min-w-0 pr-2">
                      <span className="text-sm truncate font-medium">{v.name}</span>
                      <span className="text-xs text-muted truncate">{v.lang}</span>
                    </div>
                    {isSelected && (
                      <span className="w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center shrink-0">
                        <CheckIcon size={14} />
                      </span>
                    )}
                  </button>
                );
              })
            ) : (
              <div className="py-8 text-center text-muted text-sm flex flex-col items-center gap-1">
                <span>No voices found matching &ldquo;{searchQuery}&rdquo;</span>
              </div>
            )
          ) : (
            // Kokoro Tab
            isLoadingKokoro ? (
              <div className="py-10 flex flex-col items-center justify-center text-muted gap-2">
                <div className="w-7 h-7 rounded-full border-2 border-primary/20 border-t-primary animate-spin" />
                <span className="text-xs">Connecting to Kokoro Neural Server…</span>
              </div>
            ) : kokoroVoices.length === 0 ? (
              <div className="py-6 px-3 bg-surface-hover border border-border rounded-xl text-center flex flex-col items-center gap-2">
                <div className="w-10 h-10 rounded-full bg-warning/15 text-warning flex items-center justify-center">
                  <BotIcon size={20} />
                </div>
                <div className="text-sm font-semibold text-foreground">
                  {kokoroMessage ? 'Kokoro is starting' : 'Kokoro Neural Server Offline'}
                </div>
                <p className="text-xs text-muted leading-relaxed max-w-[280px]">
                  {kokoroMessage ??
                    'Local Python server is not currently running. Run in terminal:'}
                </p>
                <code className="text-xs bg-background px-2.5 py-1.5 rounded border border-border font-mono text-primary select-all">
                  uv run python main.py
                </code>
                <p className="text-xs text-muted mt-1">
                  Browser voices are active and work out of the box!
                </p>
              </div>
            ) : filteredKokoro.length > 0 ? (
              filteredKokoro.map((v) => {
                const isSelected = ttsEngine === 'kokoro' && kokoroVoice === v;
                return (
                  <button
                    key={v}
                    type="button"
                    className={cn(
                      'flex items-center justify-between p-2.5 rounded-xl text-left border cursor-pointer transition-all duration-150',
                      isSelected
                        ? 'bg-primary/10 border-primary text-primary font-semibold shadow-xs'
                        : 'bg-transparent border-transparent hover:bg-surface-hover hover:border-border text-foreground'
                    )}
                    onClick={() => {
                      setKokoroVoice(v);
                      setTtsEngine('kokoro');
                      onClose();
                    }}
                  >
                    <div className="flex items-center gap-2 min-w-0 pr-2">
                      <SparklesIcon size={14} className="text-primary shrink-0" />
                      <span className="text-sm truncate font-medium">{v}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-primary-subtle text-primary font-medium">
                        neural
                      </span>
                      {isSelected && (
                        <span className="w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center shrink-0">
                          <CheckIcon size={14} />
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            ) : (
              <div className="py-8 text-center text-muted text-sm">
                No Kokoro voice matches &ldquo;{searchQuery}&rdquo;
              </div>
            )
          )}
        </div>
      </div>
    </>
  );
};
