'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BotIcon,
  CheckIcon,
  CloseIcon,
  DownloadIcon,
} from './Icons';
import {
  DEVICE_KOKORO_APPROX_MODEL_SIZE,
  DEVICE_KOKORO_DEFAULT_VOICE,
  DEVICE_KOKORO_VOICE_APPROX_SIZE,
  estimateDeviceKokoroStorage,
  getDeviceKokoroBackend,
  isDeviceKokoroDownloaded,
  isDeviceKokoroLoaded,
  isDeviceKokoroSupported,
  isDeviceKokoroVoiceCached,
  listDeviceKokoroVoices,
  loadDeviceKokoro,
  preloadDeviceKokoroVoice,
  requestDeviceKokoroPersistence,
  type DeviceKokoroBackend,
  type DeviceKokoroProgress,
  type DeviceKokoroStorageEstimate,
} from '../lib/device-kokoro';

type Phase = 'checking' | 'unsupported' | 'idle' | 'downloading' | 'ready';

interface KokoroDeviceDownloadProps {
  /**
   * Called when the user chooses to switch to the on-device Kokoro engine.
   * The selected voice is passed when known; existing callers that take no
   * arguments keep working.
   */
  onReady: (voice?: string) => void;
  /** Optional close handler; renders a close button when provided. */
  onClose?: () => void;
  className?: string;
}

const INITIAL_PROGRESS: DeviceKokoroProgress = { status: 'initiate', progress: 0 };

function formatMegabytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  return `${Math.max(0, Math.round(bytes / (1024 * 1024)))} MB`;
}

function describeFile(file?: string): string {
  if (!file) return 'the model';
  if (file.endsWith('.onnx')) return 'the Kokoro model';
  if (file.includes('tokenizer')) return 'the tokenizer';
  if (file.endsWith('.json')) return 'model config';
  if (file.endsWith('.bin')) return 'the voice';
  return file;
}

function backendLabel(backend: DeviceKokoroBackend | null): string | null {
  if (backend === 'webgpu') return 'WebGPU';
  if (backend === 'wasm') return 'WASM';
  return null;
}

export const KokoroDeviceDownload: React.FC<KokoroDeviceDownloadProps> = ({
  onReady,
  onClose,
  className = '',
}) => {
  const [phase, setPhase] = useState<Phase>('checking');
  const [progress, setProgress] = useState<DeviceKokoroProgress>(INITIAL_PROGRESS);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [backend, setBackend] = useState<DeviceKokoroBackend | null>(null);
  const [storage, setStorage] = useState<DeviceKokoroStorageEstimate | null>(null);
  const [voices, setVoices] = useState<string[]>(() => listDeviceKokoroVoices());
  const [selectedVoice, setSelectedVoice] = useState(DEVICE_KOKORO_DEFAULT_VOICE);
  const [voiceReady, setVoiceReady] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceProgress, setVoiceProgress] = useState<DeviceKokoroProgress | null>(null);

  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const voiceAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      voiceAbortRef.current?.abort();
    };
  }, []);

  // Figure out whether the engine can run, whether the weights are cached and
  // how much storage is left.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!isDeviceKokoroSupported()) {
        if (!cancelled) setPhase('unsupported');
        return;
      }

      setVoices(listDeviceKokoroVoices());
      setBackend(getDeviceKokoroBackend());

      const [cached, estimate] = await Promise.all([
        isDeviceKokoroDownloaded(),
        estimateDeviceKokoroStorage(),
      ]);
      if (cancelled) return;

      setStorage(estimate);
      const loaded = isDeviceKokoroLoaded();
      setPhase(loaded || cached ? 'ready' : 'idle');

      if (loaded || cached) {
        const voiceCached = await isDeviceKokoroVoiceCached(DEVICE_KOKORO_DEFAULT_VOICE);
        if (!cancelled) setVoiceReady(voiceCached);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleDownload = useCallback(async () => {
    if (phase === 'downloading') return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setWarning(null);
    setProgress(INITIAL_PROGRESS);
    setVoiceProgress(null);
    setPhase('downloading');

    try {
      // Best effort; the engine also requests this before the large download.
      await requestDeviceKokoroPersistence();

      await loadDeviceKokoro(
        (next) => {
          if (!mountedRef.current || controller.signal.aborted) return;
          setProgress(next);
          if (next.backend) setBackend(next.backend);
          if (next.warning) setWarning(next.warning);
          if (next.stage === 'voice') {
            setVoiceProgress(next);
            if (next.status === 'done' || next.progress >= 100) setVoiceReady(true);
          }
        },
        controller.signal,
        { voice: selectedVoice }
      );

      if (!mountedRef.current) return;
      setBackend(getDeviceKokoroBackend());
      setProgress({ status: 'ready', progress: 100 });
      setVoices(listDeviceKokoroVoices());
      setPhase('ready');

      const voiceCached = await isDeviceKokoroVoiceCached(selectedVoice);
      if (mountedRef.current) setVoiceReady(voiceCached);
    } catch (err) {
      if (!mountedRef.current) return;

      if (controller.signal.aborted) {
        setPhase('idle');
        setProgress(INITIAL_PROGRESS);
        setError(
          'Stopped waiting for the download. It may keep running in the background — reopen this panel to check again.'
        );
      } else {
        setPhase('idle');
        setError(
          err instanceof Error ? err.message : 'Kokoro could not be downloaded.'
        );
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [phase, selectedVoice]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    voiceAbortRef.current?.abort();
  }, []);

  const handleVoiceChange = useCallback(async (voice: string) => {
    setSelectedVoice(voice);
    setVoiceProgress(null);
    voiceAbortRef.current?.abort();

    if (!isDeviceKokoroSupported()) return;

    const controller = new AbortController();
    voiceAbortRef.current = controller;

    try {
      if (await isDeviceKokoroVoiceCached(voice)) {
        if (mountedRef.current && !controller.signal.aborted) setVoiceReady(true);
        return;
      }

      if (!mountedRef.current) return;
      setVoiceReady(false);
      setVoiceBusy(true);

      await preloadDeviceKokoroVoice(
        voice,
        (next) => {
          if (!mountedRef.current || controller.signal.aborted) return;
          setVoiceProgress(next);
          if (next.warning) setWarning(next.warning);
          if (next.status === 'done' || next.progress >= 100) setVoiceReady(true);
        },
        controller.signal
      );

      if (mountedRef.current && !controller.signal.aborted) setVoiceReady(true);
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted) return;
      setWarning(
        err instanceof Error
          ? err.message
          : `Could not download the "${voice}" voice.`
      );
    } finally {
      if (voiceAbortRef.current === controller) voiceAbortRef.current = null;
      if (mountedRef.current && !controller.signal.aborted) setVoiceBusy(false);
    }
  }, []);

  const percent = Math.max(0, Math.min(100, Math.round(progress.progress)));
  const isLoading = phase === 'downloading';
  const activeBackend = backendLabel(backend);
  const storageInsufficient = storage !== null && !storage.sufficient;

  const voiceOptions = voices.includes(selectedVoice)
    ? voices
    : [selectedVoice, ...voices];

  return (
    <section
      className={`w-full rounded-2xl border border-border bg-surface p-3 text-left shadow-xs ${className}`.trim()}
      aria-labelledby="kokoro-device-title"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-full bg-primary-subtle text-primary flex items-center justify-center shrink-0">
            <BotIcon size={16} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h3
                id="kokoro-device-title"
                className="font-heading font-bold text-sm leading-tight text-foreground"
              >
                On-device Kokoro
              </h3>
              {activeBackend && (
                <span className="rounded-full bg-primary-subtle px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-primary">
                  {activeBackend}
                </span>
              )}
            </div>
            <p className="text-[11px] text-muted leading-snug mt-0.5">
              Optional neural voice that runs privately on this device.
            </p>
          </div>
        </div>

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 -mr-1 -mt-1 rounded-full flex items-center justify-center text-muted hover:text-foreground hover:bg-border/40 transition-colors cursor-pointer border-0 bg-transparent shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            aria-label="Close on-device Kokoro panel"
          >
            <CloseIcon size={16} />
          </button>
        )}
      </div>

      {phase === 'checking' && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted">
          <span className="w-4 h-4 rounded-full border-2 border-primary/20 border-t-primary animate-spin" />
          Checking this device…
        </div>
      )}

      {phase === 'unsupported' && (
        <div className="mt-3 rounded-xl border border-border bg-surface-hover p-2.5">
          <p className="text-xs text-foreground font-medium">
            On-device Kokoro isn&apos;t available on this device.
          </p>
          <p className="text-[11px] text-muted leading-relaxed mt-1">
            This browser doesn&apos;t expose WebAssembly. The built-in browser voices
            still work normally.
          </p>
        </div>
      )}

      {(phase === 'idle' || phase === 'downloading' || phase === 'ready') && (
        <div className="mt-2.5 flex flex-col gap-2.5">
          {storage && (
            <p
              className={`text-[11px] leading-snug ${
                storageInsufficient ? 'text-warning' : 'text-muted'
              }`}
            >
              {storage.message}
              {storage.persistent ? ' · storage kept on this device' : ''}
            </p>
          )}

          {phase === 'ready' ? (
            <>
              <div className="flex items-center gap-2 rounded-xl border border-primary/25 bg-primary-subtle px-2.5 py-2">
                <span className="w-5 h-5 rounded-full bg-primary text-white flex items-center justify-center shrink-0">
                  <CheckIcon size={12} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-primary leading-tight">
                    Ready offline
                  </p>
                  <p className="text-[10px] text-muted leading-snug">
                    {activeBackend
                      ? `Running on ${activeBackend} · no audio leaves this device.`
                      : 'Model cached · no audio leaves this device.'}
                  </p>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor="kokoro-device-voice"
                  className="text-[11px] font-semibold text-foreground"
                >
                  Voice
                </label>
                <div className="flex items-center gap-1.5">
                  <select
                    id="kokoro-device-voice"
                    value={selectedVoice}
                    onChange={(event) => void handleVoiceChange(event.target.value)}
                    disabled={voiceBusy || isLoading}
                    className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-70"
                  >
                    {voiceOptions.map((voice) => (
                      <option key={voice} value={voice}>
                        {voice}
                      </option>
                    ))}
                  </select>
                  {voiceBusy ? (
                    <span
                      className="w-3.5 h-3.5 rounded-full border-2 border-primary/20 border-t-primary animate-spin shrink-0"
                      aria-label="Downloading voice"
                    />
                  ) : voiceReady ? (
                    <span className="text-[10px] font-semibold text-primary shrink-0">
                      cached
                    </span>
                  ) : (
                    <span className="text-[10px] text-muted shrink-0">not cached</span>
                  )}
                </div>
                {voiceProgress && voiceBusy && (
                  <p className="text-[10px] text-muted leading-snug" aria-live="polite">
                    {voiceProgress.totalBytes
                      ? `${formatMegabytes(voiceProgress.loadedBytes ?? 0)} / ${formatMegabytes(
                          voiceProgress.totalBytes
                        )}`
                      : 'Downloading voice…'}
                  </p>
                )}
              </div>

              <button
                type="button"
                onClick={() => onReady(selectedVoice)}
                className="w-full min-h-10 flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-primary text-white font-semibold text-[13px] cursor-pointer border-0 transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              >
                <BotIcon size={15} />
                Use on-device Kokoro
              </button>

              <p className="text-[10px] text-muted leading-snug text-center">
                Each voice is fetched once ({DEVICE_KOKORO_VOICE_APPROX_SIZE}) and then
                cached for offline use.
              </p>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="kokoro-device-voice"
                  className="text-[11px] font-semibold text-foreground"
                >
                  Voice to prepare
                </label>
                <select
                  id="kokoro-device-voice"
                  value={selectedVoice}
                  onChange={(event) => setSelectedVoice(event.target.value)}
                  disabled={isLoading}
                  className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-70"
                >
                  {voiceOptions.map((voice) => (
                    <option key={voice} value={voice}>
                      {voice}
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="button"
                onClick={handleDownload}
                disabled={isLoading}
                aria-describedby="kokoro-device-details"
                className="w-full min-h-10 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-primary text-white font-semibold text-[13px] leading-snug text-center cursor-pointer border-0 transition-colors hover:bg-primary-hover disabled:opacity-70 disabled:cursor-wait focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              >
                {isLoading ? (
                  <>
                    <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin shrink-0" />
                    Downloading…
                  </>
                ) : (
                  <>
                    <DownloadIcon size={16} className="shrink-0" />
                    <span>
                      {error ? 'Retry Kokoro download' : 'Download Kokoro model'} (
                      {DEVICE_KOKORO_APPROX_MODEL_SIZE})
                    </span>
                  </>
                )}
              </button>

              <p
                id="kokoro-device-details"
                className="text-[10px] text-muted leading-snug text-center"
              >
                One-time download. After that, Kokoro works offline — no audio leaves your
                device.
              </p>
            </>
          )}

          {isLoading && (
            <div className="flex flex-col gap-1.5">
              <div
                className="h-2 w-full overflow-hidden rounded-full bg-border/60"
                role="progressbar"
                aria-label="Kokoro model download progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                  style={{ width: `${percent}%` }}
                />
              </div>

              <div
                className="flex items-center justify-between gap-3 text-[10px] text-muted"
                aria-live="polite"
              >
                <span className="truncate">
                  {progress.stage === 'voice'
                    ? `Preparing ${describeFile(progress.file)}…`
                    : `${percent}% · downloading ${describeFile(progress.file)}`}
                </span>
                {!!progress.totalBytes && progress.totalBytes > 0 && (
                  <span className="shrink-0 tabular-nums">
                    {formatMegabytes(progress.loadedBytes ?? 0)} /{' '}
                    {formatMegabytes(progress.totalBytes)}
                  </span>
                )}
              </div>

              {progress.stage === 'voice' && (
                <div
                  className="h-1.5 w-full overflow-hidden rounded-full bg-border/60"
                  role="progressbar"
                  aria-label="Kokoro voice download progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                >
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              )}

              <div className="flex items-start justify-between gap-3">
                <p className="text-[10px] text-muted leading-snug">
                  The model download itself can&apos;t be paused by the library; stopping
                  only hides progress.
                </p>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="text-[11px] font-semibold text-muted hover:text-foreground underline underline-offset-2 bg-transparent border-0 cursor-pointer shrink-0 px-1 py-0.5"
                >
                  Stop
                </button>
              </div>
            </div>
          )}

          {warning && (
            <p className="text-[10px] leading-snug text-warning" role="status">
              {warning}
            </p>
          )}

          {error && (
            <div
              role="alert"
              className="rounded-xl border border-warning/40 bg-warning/10 px-2.5 py-2 text-[11px] text-foreground leading-relaxed"
            >
              {error}
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export default KokoroDeviceDownload;
