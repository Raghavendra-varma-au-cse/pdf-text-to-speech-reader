'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useAudioStore } from '../store/use-audio-store';
import { cn } from '../lib/cn';
import { SpeedIcon, CheckIcon } from './Icons';

interface SpeedMenuProps {
  isOpen: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

const PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0.5, Math.min(3, Math.round(value * 100) / 100));
}

export function formatSpeed(value: number): string {
  return `${Number(clampSpeed(value).toFixed(2))}x`;
}

export const SpeedMenu: React.FC<SpeedMenuProps> = ({ isOpen, onClose, triggerRef }) => {
  const playbackSpeed = useAudioStore((s) => s.playbackSpeed);
  const setPlaybackSpeed = useAudioStore((s) => s.setPlaybackSpeed);
  const menuRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(clampSpeed(playbackSpeed));

  useEffect(() => {
    if (!isOpen) return;
    const frame = window.requestAnimationFrame(() => setDraft(clampSpeed(playbackSpeed)));
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, playbackSpeed]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
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

  const commit = (value: number) => {
    const next = clampSpeed(value);
    setDraft(next);
    setPlaybackSpeed(next);
  };

  return (
    <>
      {/* Mobile Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-[1100] md:hidden backdrop-blur-xs animate-fade-in-fast"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Menu Container: Floating popover on desktop, bottom sheet on mobile */}
      <div
        ref={menuRef}
        className={cn(
          'z-[1200] bg-surface border border-border shadow-lg p-3 rounded-2xl flex flex-col gap-2',
          'max-h-[85dvh] overflow-y-auto overscroll-contain',
          'max-md:fixed max-md:bottom-0 max-md:left-0 max-md:right-0 max-md:rounded-b-none max-md:p-4 max-md:pb-[max(1rem,env(safe-area-inset-bottom))] max-md:animate-slide-up',
          'md:absolute md:bottom-[calc(100%+10px)] md:right-0 md:w-[280px] md:animate-fade-in-fast md:rounded-xl'
        )}
        role="dialog"
        aria-modal="true"
        aria-label="Playback speed selector"
      >
        <div className="md:hidden flex flex-col items-center mb-1">
          <div className="w-10 h-1 rounded-full bg-border mb-3" />
        </div>

        <div className="flex items-center justify-between gap-2 px-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
            <SpeedIcon size={14} className="text-primary" />
            <span>Speech Speed</span>
          </div>
          <span className="font-mono text-lg font-bold text-primary">{formatSpeed(draft)}</span>
        </div>

        <div className="flex items-center gap-2 px-1">
          <button
            type="button"
            onClick={() => commit(draft - 0.05)}
            disabled={draft <= 0.5}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-lg font-bold text-foreground hover:border-primary hover:text-primary disabled:opacity-40"
            aria-label="Decrease speed by 0.05"
          >
            −
          </button>
          <input
            type="range"
            min={0.5}
            max={3}
            step={0.05}
            value={draft}
            onChange={(event) => setDraft(clampSpeed(Number(event.target.value)))}
            onPointerUp={() => commit(draft)}
            onKeyUp={() => commit(draft)}
            onTouchEnd={() => commit(draft)}
            className="h-2 min-w-0 flex-1 cursor-pointer accent-[var(--color-primary)]"
            aria-label="Playback speed"
            aria-valuemin={0.5}
            aria-valuemax={3}
            aria-valuenow={draft}
          />
          <button
            type="button"
            onClick={() => commit(draft + 0.05)}
            disabled={draft >= 3}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-lg font-bold text-foreground hover:border-primary hover:text-primary disabled:opacity-40"
            aria-label="Increase speed by 0.05"
          >
            +
          </button>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          {PRESETS.map((speed) => {
            const isSelected = Math.abs(draft - speed) < 0.001;
            return (
              <button
                key={speed}
                type="button"
                className={cn(
                  'flex min-h-[2.5rem] items-center justify-center gap-1 rounded-lg border-0 px-2 py-2 text-xs font-semibold transition-all duration-100 cursor-pointer',
                  isSelected
                    ? 'bg-primary text-white shadow-sm'
                    : 'bg-navbar-control text-foreground hover:bg-primary-subtle hover:text-primary'
                )}
                onClick={() => commit(speed)}
              >
                <span className="font-mono">{formatSpeed(speed)}</span>
                {isSelected && <CheckIcon size={12} />}
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between px-1 pt-1">
          <span className="text-[11px] text-muted">Fine steps of 0.05x · 0.5x–3x</span>
          <button
            type="button"
            onClick={() => commit(1)}
            className="text-[11px] font-semibold text-primary hover:underline"
          >
            Reset
          </button>
        </div>
      </div>
    </>
  );
};
