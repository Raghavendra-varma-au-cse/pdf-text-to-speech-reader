'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAudioStore } from '../store/use-audio-store';
import { cn } from '../lib/cn';
import {
  downloadBlob,
  exportDocumentToMp3,
  suggestMp3FileName,
  type Mp3ExportProgress,
} from '../lib/audio-export';
import { CloseIcon, DownloadIcon } from './Icons';

interface DownloadAudioDialogProps {
  isOpen: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

type Scope = 'all' | 'from-current' | 'current-page';

function formatEta(ms?: number): string {
  if (!ms || ms <= 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `~${seconds}s left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes}m left`;
  return `~${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
}

export const DownloadAudioDialog: React.FC<DownloadAudioDialogProps> = ({
  isOpen,
  onClose,
  triggerRef,
}) => {
  const segments = useAudioStore((state) => state.segments);
  const currentSegmentIndex = useAudioStore((state) => state.currentSegmentIndex);
  const currentPage = useAudioStore((state) => state.currentPage);
  const ttsEngine = useAudioStore((state) => state.ttsEngine);
  const kokoroVoice = useAudioStore((state) => state.kokoroVoice);
  const kokoroServerUrl = useAudioStore((state) => state.kokoroServerUrl);
  const playbackSpeed = useAudioStore((state) => state.playbackSpeed);
  const mathSpeech = useAudioStore((state) => state.mathSpeech);
  const documentTitle = useAudioStore((state) => state.documentTitle);

  const [scope, setScope] = useState<Scope>('all');
  const [progress, setProgress] = useState<Mp3ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        dialogRef.current &&
        !dialogRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        onClose();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isOpen, onClose, triggerRef]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!isOpen) abortRef.current?.abort();
  }, [isOpen]);

  const pageRange = useMemo(() => {
    let first = -1;
    let last = -1;
    for (let index = 0; index < segments.length; index++) {
      if (segments[index].pageNumber !== currentPage) continue;
      if (first < 0) first = index;
      last = index;
    }
    return { first, last };
  }, [segments, currentPage]);

  if (!isOpen) return null;

  const canExport = (ttsEngine === 'kokoro' || ttsEngine === 'device') && segments.length > 0;
  const firstOnCurrentPage = pageRange.first;
  const lastOnCurrentPage = pageRange.last;
  const startIndex =
    scope === 'from-current'
      ? currentSegmentIndex
      : scope === 'current-page' && firstOnCurrentPage >= 0
        ? firstOnCurrentPage
        : 0;
  const endIndex =
    scope === 'current-page' && lastOnCurrentPage >= 0 ? lastOnCurrentPage : segments.length - 1;
  const totalSentences = Math.max(0, endIndex - startIndex + 1);

  const handleExport = async () => {
    if (!canExport || isExporting) return;
    setError(null);
    setIsExporting(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const blob = await exportDocumentToMp3(segments, {
        serverUrl: kokoroServerUrl,
        voice: kokoroVoice,
        speed: playbackSpeed,
        engine: ttsEngine === 'device' ? 'device' : 'kokoro',
        mathSpeech,
        startIndex,
        endIndex,
        signal: controller.signal,
        onProgress: setProgress,
      });
      downloadBlob(blob, suggestMp3FileName(documentTitle));
      setProgress({
        phase: 'done',
        current: totalSentences,
        total: totalSentences,
        message: 'MP3 downloaded',
      });
    } catch (exportError) {
      if (exportError instanceof Error && exportError.name !== 'CancelledError') {
        setError(exportError.message);
      }
    } finally {
      setIsExporting(false);
      abortRef.current = null;
    }
  };

  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : 0;

  return (
    <>
      <div
        className="fixed inset-0 bg-black/40 z-[1100] md:hidden backdrop-blur-xs animate-fade-in-fast"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        ref={dialogRef}
        className={cn(
          'z-[1200] bg-surface border border-border shadow-2xl flex min-h-0 flex-col',
          'max-h-[85dvh] overflow-y-auto overscroll-contain',
          'max-md:fixed max-md:bottom-0 max-md:left-0 max-md:right-0 max-md:rounded-t-3xl max-md:p-5 max-md:pb-[max(1.25rem,env(safe-area-inset-bottom))] max-md:animate-slide-up',
          'md:absolute md:bottom-[calc(100%+12px)] md:right-0 md:w-[360px] md:rounded-2xl md:p-4 md:animate-fade-in-fast'
        )}
        role="dialog"
        aria-modal="true"
        aria-label="Download audio"
      >
        <div className="flex items-center justify-between pb-3 border-b border-border/60">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-subtle text-primary">
              <DownloadIcon size={16} />
            </span>
            <div>
              <h3 className="font-heading text-base font-bold leading-tight text-foreground">
                Download MP3
              </h3>
              <p className="text-xs text-muted">One audio file for the whole book</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-border/40 hover:text-foreground"
            aria-label="Close download dialog"
          >
            <CloseIcon size={18} />
          </button>
        </div>

        {!canExport ? (
          <div className="mt-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
            <p className="font-semibold">A Kokoro voice is required for MP3 export.</p>
            <p className="mt-1 text-muted">
              Browser voices cannot be captured. Start the local Kokoro server, then pick a
              Kokoro voice in the voice menu.
            </p>
            <code className="mt-2 block rounded border border-border bg-background px-2 py-1.5 font-mono text-xs text-primary">
              cd server &amp;&amp; uv run python main.py
            </code>
          </div>
        ) : (
          <>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => setScope('all')}
                disabled={isExporting}
                className={cn(
                  'min-h-[2.5rem] flex-1 rounded-lg border px-2 py-2 text-xs font-semibold transition-colors disabled:opacity-50',
                  scope === 'all'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-foreground hover:border-primary/50'
                )}
              >
                Whole book
              </button>
              <button
                type="button"
                onClick={() => setScope('current-page')}
                disabled={isExporting || firstOnCurrentPage < 0}
                className={cn(
                  'min-h-[2.5rem] flex-1 rounded-lg border px-2 py-2 text-xs font-semibold transition-colors disabled:opacity-50',
                  scope === 'current-page'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-foreground hover:border-primary/50'
                )}
              >
                Page {currentPage}
              </button>
              <button
                type="button"
                onClick={() => setScope('from-current')}
                disabled={isExporting}
                className={cn(
                  'min-h-[2.5rem] flex-1 rounded-lg border px-2 py-2 text-xs font-semibold transition-colors disabled:opacity-50',
                  scope === 'from-current'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-foreground hover:border-primary/50'
                )}
              >
                From here
              </button>
            </div>

            <p className="mt-2 text-xs text-muted">
              {totalSentences} sentence{totalSentences === 1 ? '' : 's'} · {kokoroVoice} ·{' '}
              {playbackSpeed}x
            </p>

            {progress && (
              <div className="mt-3">
                <div className="h-2 overflow-hidden rounded-full bg-border/60">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-200"
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted">
                  <span className="truncate">{progress.message}</span>
                  {progress.etaMs ? (
                    <span className="shrink-0 font-mono">{formatEta(progress.etaMs)}</span>
                  ) : null}
                </div>
              </div>
            )}

            {error && (
              <p role="alert" className="mt-2 text-xs text-error">
                {error}
              </p>
            )}

            <div className="mt-3 flex gap-2">
              {isExporting ? (
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="min-h-[2.75rem] flex-1 rounded-lg border border-error/40 px-3 py-2 text-sm font-semibold text-error hover:bg-error/10 transition-colors"
                >
                  Cancel export
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleExport()}
                  className="flex min-h-[2.75rem] flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-hover transition-colors"
                >
                  <DownloadIcon size={15} />
                  Download MP3
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
};
