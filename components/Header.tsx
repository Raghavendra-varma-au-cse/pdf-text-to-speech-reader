'use client';

import React, { useEffect, useState, useMemo } from 'react';
import Image from 'next/image';
import { useAudioStore } from '../store/use-audio-store';
import { cn } from '../lib/cn';
import { buildWordPrefix } from '../lib/text-metrics';
import {
  ArrowLeftIcon,
  ZoomInIcon,
  ZoomOutIcon,
  FitWidthIcon,
  SunIcon,
  MoonIcon,
  ClockIcon,
} from './Icons';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

export default function Header() {
  const file = useAudioStore((s) => s.file);
  const setFile = useAudioStore((s) => s.setFile);
  const documentTitle = useAudioStore((s) => s.documentTitle);
  const segments = useAudioStore((s) => s.segments);
  const loadSegments = useAudioStore((s) => s.loadSegments);
  const currentSegmentIndex = useAudioStore((s) => s.currentSegmentIndex);
  const playbackSpeed = useAudioStore((s) => s.playbackSpeed);
  const scale = useAudioStore((s) => s.scale);
  const zoomIn = useAudioStore((s) => s.zoomIn);
  const zoomOut = useAudioStore((s) => s.zoomOut);
  const zoomReset = useAudioStore((s) => s.zoomReset);
  const isFitToWidth = useAudioStore((s) => s.isFitToWidth);
  const setIsFitToWidth = useAudioStore((s) => s.setIsFitToWidth);
  const textFontSize = useAudioStore((s) => s.textFontSize);
  const increaseFontSize = useAudioStore((s) => s.increaseFontSize);
  const decreaseFontSize = useAudioStore((s) => s.decreaseFontSize);
  const resetFontSize = useAudioStore((s) => s.resetFontSize);

  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  const hasContent = segments.length > 0 || file !== null;

  // Initialize theme
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem('theme');
    } catch {
      saved = null;
    }
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const initial = saved === 'dark' || (!saved && prefersDark) ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', initial);
    queueMicrotask(() => {
      setTheme(initial);
    });
  }, []);

  // Load the local brand launcher only after hydration; it replaces
  // [data-brand-launcher] in the DOM. The local tools.json points the reader
  // tile at this deployment instead of the public GitHub Pages copy.
  useEffect(() => {
    const src = `${basePath}/brand/launcher.js`;
    if (document.querySelector(`script[src="${src}"]`)) return;
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.tools = `${basePath}/tools.json`;
    document.body.append(script);
  }, []);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem('theme', next);
      } catch {
        // Storage is optional.
      }
      document.documentElement.setAttribute('data-theme', next);
    }
  };

  const currentZoomPercent = Math.round((scale / 1.5) * 100);

  const handleGoHome = () => {
    setFile(null);
    loadSegments([]);
  };

  // Word counts are precomputed as a prefix sum when segments change, so
  // playback updates only do O(1) work instead of rescanning a 10k-segment book
  // on every sentence.
  const wordStats = useMemo(() => buildWordPrefix(segments), [segments]);

  const timeMetrics = useMemo(() => {
    if (!segments.length) return null;

    const wordsPerMinute = 150 * playbackSpeed;

    const formatTime = (words: number) => {
      if (words === 0) return '0m';
      const minutes = words / wordsPerMinute;
      if (minutes < 1) return '<1m';
      return `${Math.round(minutes)}m`;
    };

    const index = Math.min(Math.max(0, currentSegmentIndex), segments.length);
    const listenedWords = wordStats.prefix[index];
    const totalWords = wordStats.total;
    const remainingWords = Math.max(0, totalWords - listenedWords);

    return {
      listened: formatTime(listenedWords),
      total: formatTime(totalWords),
      remaining: formatTime(remainingWords),
    };
  }, [segments.length, currentSegmentIndex, playbackSpeed, wordStats]);

  return (
    <>
      <header
        className="fixed top-0 left-0 right-0 h-16 z-[1000] bg-navbar/95 backdrop-blur-md border-b border-navbar-border shadow-xs transition-[background-color,border-color] duration-200"
        role="banner"
      >
        <div className="flex h-full w-full items-center justify-between gap-2 px-3 sm:gap-3 sm:px-6">
          {/* Brand & Document identification */}
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={handleGoHome}
              className="group flex shrink-0 items-center gap-2.5 border-0 bg-transparent p-0 text-foreground cursor-pointer"
              title="ReadAloud — return to home"
              aria-label="ReadAloud — return to home"
            >
              <div className="w-8 h-8 rounded-lg overflow-hidden border-[1.5px] border-primary flex items-center justify-center bg-navbar-control shadow-[0_2px_6px_color-mix(in_srgb,var(--color-primary)_20%,transparent)] transition-transform duration-200 group-hover:scale-105">
                <Image
                  src="./brand-logo.png"
                  alt="ReadAloud logo"
                  width={28}
                  height={28}
                  className="w-full h-full object-cover"
                  priority
                />
              </div>
              <span className="hidden whitespace-nowrap font-heading text-base font-bold tracking-tight text-foreground sm:inline">
                <span>ReadAloud</span>
              </span>
            </button>

            {/* Active Document Badge. Phones show the compact Back control only;
                the title and sentence counter return at sm and up. */}
            {hasContent && (
              <div
                className="flex max-w-[150px] min-w-0 items-center gap-2 rounded-full border border-navbar-control-border bg-navbar-control px-1.5 py-1 animate-fade-in sm:max-w-xs sm:px-2.5"
                title={documentTitle || 'Active Document'}
              >
                <button
                  type="button"
                  className="inline-flex shrink-0 items-center gap-1 rounded-full border-0 bg-primary-subtle px-1.5 py-0.5 text-xs font-semibold text-primary cursor-pointer transition-colors hover:bg-primary hover:text-white sm:px-2"
                  title="Close document and return to upload"
                  aria-label="Close document and return to upload"
                  onClick={handleGoHome}
                >
                  <ArrowLeftIcon size={12} />
                  <span className="hidden sm:inline">Back</span>
                </button>

                <div className="hidden min-w-0 items-baseline gap-1 overflow-hidden text-xs sm:flex">
                  <span className="max-w-[100px] truncate font-semibold text-foreground sm:max-w-[140px]">
                    {documentTitle || (file ? file.name : 'Pasted Text')}
                  </span>
                  {segments.length > 0 && (
                    <span className="hidden whitespace-nowrap font-mono text-[11px] text-muted sm:inline">
                      ({currentSegmentIndex + 1}/{segments.length})
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Right Header Tools */}
          <div className="header-actions flex shrink-0 items-center gap-1.5 sm:gap-2">
            {/* Reading Time Metrics (Compact Listened / Total Duration) */}
            {hasContent && timeMetrics && (
              <div
                className="hidden sm:inline-flex items-center gap-1 px-2.5 sm:px-3 py-1 rounded-full bg-navbar-control border border-navbar-control-border text-xs font-mono text-muted shadow-2xs animate-fade-in select-none"
                title={`Reading Progress: ${timeMetrics.listened} listened of ${timeMetrics.total} total (~${timeMetrics.remaining} remaining)`}
              >
                <ClockIcon size={13} className="text-primary shrink-0" />
                <span className="text-foreground/90 font-medium">{timeMetrics.listened}</span>
                <span className="text-muted/50 font-normal">/</span>
                <span>{timeMetrics.total}</span>
              </div>
            )}

            {/* Zoom Controls (Visible when PDF is loaded on screens >= 640px) */}
            {file ? (
              <div
                className="hidden sm:inline-flex items-center bg-navbar-control border border-navbar-control-border rounded-xl overflow-hidden h-[34px] shadow-xs"
                role="group"
                aria-label="PDF zoom controls"
              >
                <button
                  type="button"
                  className="w-8 h-full flex items-center justify-center text-foreground hover:text-primary hover:bg-navbar-control-hover transition-colors border-0 bg-transparent cursor-pointer"
                  title="Zoom out (-)"
                  onClick={zoomOut}
                >
                  <ZoomOutIcon size={15} />
                </button>

                <button
                  type="button"
                  className="px-2 font-mono text-xs font-semibold text-foreground hover:text-primary hover:bg-navbar-control-hover border-y-0 border-x border-navbar-control-border h-full flex items-center justify-center transition-colors bg-transparent cursor-pointer"
                  title="Reset zoom to 100%"
                  onClick={zoomReset}
                >
                  {currentZoomPercent}%
                </button>

                <button
                  type="button"
                  className="w-8 h-full flex items-center justify-center text-foreground hover:text-primary hover:bg-navbar-control-hover transition-colors border-0 bg-transparent cursor-pointer"
                  title="Zoom in (+)"
                  onClick={zoomIn}
                >
                  <ZoomInIcon size={15} />
                </button>

                <button
                  type="button"
                  className={cn(
                    'px-2.5 h-full flex items-center gap-1 border-l border-navbar-control-border text-xs font-medium cursor-pointer transition-colors',
                    isFitToWidth
                      ? 'bg-primary text-white font-semibold'
                      : 'bg-transparent text-foreground hover:text-primary hover:bg-navbar-control-hover'
                  )}
                  title="Fit document to screen width"
                  onClick={() => setIsFitToWidth(!isFitToWidth)}
                >
                  <FitWidthIcon size={14} />
                  <span className="hidden lg:inline text-[11px]">Fit</span>
                </button>
              </div>
            ) : hasContent ? (
              /* Font Size Controls (Visible when Pasted Text is active on screens >= 640px) */
              <div
                className="hidden sm:inline-flex items-center bg-navbar-control border border-navbar-control-border rounded-xl overflow-hidden h-[34px] shadow-xs"
                role="group"
                aria-label="Text reader font size controls"
              >
                <button
                  type="button"
                  className="w-8 h-full flex items-center justify-center text-foreground hover:text-primary hover:bg-navbar-control-hover transition-colors border-0 bg-transparent cursor-pointer disabled:opacity-40"
                  title="Decrease font size"
                  disabled={textFontSize <= 12}
                  onClick={decreaseFontSize}
                >
                  <ZoomOutIcon size={15} />
                </button>

                <button
                  type="button"
                  className="px-2.5 font-mono text-xs font-semibold text-foreground hover:text-primary hover:bg-navbar-control-hover border-y-0 border-x border-navbar-control-border h-full flex items-center justify-center transition-colors bg-transparent cursor-pointer"
                  title="Reset font size to default (16px)"
                  onClick={resetFontSize}
                >
                  {textFontSize}px
                </button>

                <button
                  type="button"
                  className="w-8 h-full flex items-center justify-center text-foreground hover:text-primary hover:bg-navbar-control-hover transition-colors border-0 bg-transparent cursor-pointer disabled:opacity-40"
                  title="Increase font size"
                  disabled={textFontSize >= 32}
                  onClick={increaseFontSize}
                >
                  <ZoomInIcon size={15} />
                </button>
              </div>
            ) : null}
            {/* Local history */}
            <button
              type="button"
              className="w-9 h-9 rounded-[10px] border border-navbar-control-border bg-navbar-control text-foreground hover:text-primary hover:border-primary inline-flex items-center justify-center cursor-pointer shrink-0 p-0 transition-colors duration-200"
              aria-label="Open recent documents"
              title="Recent documents (stored on this device)"
              onClick={() => window.dispatchEvent(new Event('readaloud:open-history'))}
            >
              <ClockIcon size={17} />
            </button>

            {/* Theme Toggle Button */}
            <button
              className="theme-switch w-9 h-9 rounded-[10px] border border-navbar-control-border bg-navbar-control text-foreground hover:text-primary hover:border-primary inline-flex items-center justify-center cursor-pointer shrink-0 p-0 transition-colors duration-200"
              id="themeSwitch"
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              type="button"
              onClick={toggleTheme}
            >
              {theme === 'dark' ? <MoonIcon size={17} /> : <SunIcon size={17} />}
            </button>

            {/* Brand tools launcher mount (replaced by the waffle button from launcher.js, which is
                injected after hydration so React never sees the swapped DOM) */}
            <div className="contents" suppressHydrationWarning>
              <span data-brand-launcher></span>
            </div>
          </div>
        </div>
      </header>
    </>
  );
}

