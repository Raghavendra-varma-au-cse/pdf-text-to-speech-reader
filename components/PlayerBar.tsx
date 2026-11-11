'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useAudioStore } from '../store/use-audio-store';
import { cn } from '../lib/cn';
import { VoiceSheet } from './VoiceSheet';
import { SpeedMenu, formatSpeed } from './SpeedMenu';
import { DownloadAudioDialog } from './DownloadAudioDialog';
import {
  PlayIcon,
  PauseIcon,
  SkipBackIcon,
  SkipForwardIcon,
  StopIcon,
  HeadphonesIcon,
  SpeedIcon,
  AutoScrollIcon,
  ChevronUpIcon,
  SettingsIcon,
  LocateIcon,
  MinimizeIcon,
  SigmaIcon,
  DownloadIcon,
  BookOpenIcon,
} from './Icons';

export const PlayerBar: React.FC = () => {
  const playbackStatus = useAudioStore((s) => s.playbackStatus);
  const play = useAudioStore((s) => s.play);
  const pause = useAudioStore((s) => s.pause);
  const resume = useAudioStore((s) => s.resume);
  const stop = useAudioStore((s) => s.stop);
  const next = useAudioStore((s) => s.next);
  const prev = useAudioStore((s) => s.playSegment);
  const seekToSegment = useAudioStore((s) => s.seekToSegment);
  const currentSegmentIndex = useAudioStore((s) => s.currentSegmentIndex);
  const segments = useAudioStore((s) => s.segments);
  const selectionSegmentIndex = useAudioStore((s) => s.selectionSegmentIndex);
  const setSelectionSegmentIndex = useAudioStore((s) => s.setSelectionSegmentIndex);
  const selectedVoice = useAudioStore((s) => s.selectedVoice);
  const ttsEngine = useAudioStore((s) => s.ttsEngine);
  const kokoroVoice = useAudioStore((s) => s.kokoroVoice);
  const playbackSpeed = useAudioStore((s) => s.playbackSpeed);
  const setPlaybackSpeed = useAudioStore((s) => s.setPlaybackSpeed);
  const autoScroll = useAudioStore((s) => s.autoScroll);
  const setAutoScroll = useAudioStore((s) => s.setAutoScroll);
  const mathSpeech = useAudioStore((s) => s.mathSpeech);
  const setMathSpeech = useAudioStore((s) => s.setMathSpeech);
  const hydrate = useAudioStore((s) => s.hydrate);

  const [isVoiceOpen, setIsVoiceOpen] = useState(false);
  const [isSpeedOpen, setIsSpeedOpen] = useState(false);
  const [isDownloadOpen, setIsDownloadOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);

  const voiceTriggerRef = useRef<HTMLButtonElement>(null);
  const speedTriggerRef = useRef<HTMLButtonElement>(null);
  const downloadTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const settingsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const displayedScrub = isScrubbing ? scrubValue : currentSegmentIndex;

  const commitScrub = () => {
    setIsScrubbing(false);
    seekToSegment(scrubValue, playbackStatus === 'playing');
    setSelectionSegmentIndex(null);
  };

  // Close menus on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setIsSettingsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
        target.isContentEditable ||
        target.closest('button, a, [role="button"], [contenteditable="true"]')
      ) {
        return;
      }

      if (e.code === 'Space') {
        if (segments.length === 0) return;
        e.preventDefault();
        if (playbackStatus === 'playing') pause();
        else if (playbackStatus === 'paused') resume();
        else if (segments.length > 0) play();
      } else if (e.code === 'ArrowRight' && segments.length > 0) {
        e.preventDefault();
        next();
      } else if (e.code === 'ArrowLeft' && segments.length > 0) {
        e.preventDefault();
        prev(Math.max(0, currentSegmentIndex - 1));
      } else if (e.code === 'PageDown' && segments.length > 0) {
        e.preventDefault();
        prev(Math.min(segments.length - 1, currentSegmentIndex + 10));
      } else if (e.code === 'PageUp' && segments.length > 0) {
        e.preventDefault();
        prev(Math.max(0, currentSegmentIndex - 10));
      } else if (e.key === '[' || e.key === '{') {
        e.preventDefault();
        setPlaybackSpeed(Math.max(0.5, playbackSpeed - 0.05));
      } else if (e.key === ']' || e.key === '}') {
        e.preventDefault();
        setPlaybackSpeed(Math.min(3, playbackSpeed + 0.05));
      } else if (e.key === 'h' || e.key === 'H') {
        window.dispatchEvent(new Event('readaloud:open-history'));
      } else if (e.code === 'Escape') {
        setIsVoiceOpen(false);
        setIsSpeedOpen(false);
        setIsDownloadOpen(false);
        setIsSettingsOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [playbackStatus, segments.length, currentSegmentIndex, play, pause, resume, next, prev, playbackSpeed, setPlaybackSpeed]);

  const handleSettingsMouseEnter = () => {
    if (settingsTimeoutRef.current) {
      clearTimeout(settingsTimeoutRef.current);
      settingsTimeoutRef.current = null;
    }
    setIsSettingsOpen(true);
  };

  const handleSettingsMouseLeave = () => {
    settingsTimeoutRef.current = setTimeout(() => {
      setIsSettingsOpen(false);
    }, 250);
  };

  const handleScrollToCurrentSentence = () => {
    // Scroll active sentence into view
    const currentElements = document.querySelectorAll(`.nr-s${currentSegmentIndex}`);
    if (currentElements.length > 0) {
      (currentElements[0] as HTMLElement).scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    } else {
      const el = document.getElementById(`text-seg-${currentSegmentIndex}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  if (segments.length === 0) return null;

  // Active voice display name
  const voiceDisplayName =
    ttsEngine === 'device'
      ? `${kokoroVoice || 'Kokoro'} · on-device`
      : ttsEngine === 'kokoro'
        ? kokoroVoice || 'Kokoro HD'
        : selectedVoice
          ? selectedVoice.startsWith('native:')
            ? 'Device Voice'
            : selectedVoice.replace(/^Microsoft /, '').replace(/ Online \(Natural\)/, '').slice(0, 16)
          : 'System Voice';

  // Minimized Toolbar: Compact floating pill with Play/Pause and Expand trigger
  if (isMinimized) {
    return (
      <nav
        aria-label="Audio playback controls (minimized)"
        className={cn(
          'fixed z-[1000] transition-all duration-300 animate-slide-up',
          'bottom-[max(0.75rem,env(safe-area-inset-bottom))] sm:bottom-4 left-0 right-0 w-full',
          'flex justify-center pointer-events-none'
        )}
      >
        <div
          className={cn(
            'pointer-events-auto flex max-w-[calc(100vw-1.5rem)] items-center gap-1.5',
            'bg-navbar/95 backdrop-blur-xl border border-navbar-border shadow-2xl',
            'rounded-full p-1.5 pl-1.5 pr-2 transition-all duration-200'
          )}
        >
          {/* Main Play / Pause Button */}
          <button
            type="button"
            className={cn(
              'w-11 h-11 rounded-full flex items-center justify-center bg-primary text-white border-0 shadow-md cursor-pointer transition-all duration-150 hover:bg-primary-hover hover:scale-105 active:scale-95 disabled:opacity-40',
              playbackStatus === 'playing' && 'animate-play-pulse'
            )}
            title={playbackStatus === 'playing' ? 'Pause (Space)' : 'Play (Space)'}
            aria-label={playbackStatus === 'playing' ? 'Pause playback' : 'Play document'}
            disabled={playbackStatus === 'loading'}
            onClick={() => {
              if (playbackStatus === 'playing') pause();
              else if (playbackStatus === 'paused') resume();
              else play();
            }}
          >
            {playbackStatus === 'loading' ? (
              <svg className="animate-spin h-5 w-5 text-white" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : playbackStatus === 'playing' ? (
              <PauseIcon size={18} />
            ) : (
              <PlayIcon size={18} className="ml-0.5" />
            )}
          </button>

          {/* Expand Toolbar Button */}
          <button
            type="button"
            onClick={() => setIsMinimized(false)}
            className="w-8 h-8 rounded-full flex items-center justify-center text-muted hover:text-foreground hover:bg-navbar-control transition-colors cursor-pointer"
            title="Expand toolbar"
            aria-label="Expand toolbar"
          >
            <ChevronUpIcon size={16} />
          </button>
        </div>
      </nav>
    );
  }

  // Full Minimalistic Toolbar
  return (
    <nav
      aria-label="Audio playback controls"
      className={cn(
        'fixed z-[1000] transition-all duration-300 animate-slide-up',
        'bottom-0 left-0 right-0 w-full',
        'px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-3 sm:pt-3 sm:pb-4 flex justify-center pointer-events-none'
      )}
    >
      <div
        className={cn(
          'pointer-events-auto w-full max-w-2xl lg:max-w-3xl mx-auto min-w-0',
          'bg-navbar/95 backdrop-blur-xl border border-navbar-border shadow-2xl',
          'rounded-2xl px-2 py-2 sm:rounded-3xl sm:px-4 sm:py-2.5',
          'transition-all duration-200'
        )}
      >
        {segments[currentSegmentIndex]?.text ? (
          <p
            className="mb-1.5 hidden truncate px-2 text-[11px] leading-relaxed text-muted sm:block"
            aria-live="polite"
            title={segments[currentSegmentIndex]?.text}
          >
            {segments[currentSegmentIndex]?.text}
          </p>
        ) : null}
        {segments.length > 1 && (
          <div className="mb-1.5 flex items-center gap-2 px-1 sm:mb-1 sm:px-2">
            <input
              type="range"
              min={0}
              max={segments.length - 1}
              step={1}
              value={Math.min(displayedScrub, segments.length - 1)}
              onChange={(event) => {
                setIsScrubbing(true);
                setScrubValue(Number(event.target.value));
              }}
              onPointerUp={commitScrub}
              onKeyUp={commitScrub}
              className="player-scrubber h-2 min-w-0 flex-1 cursor-pointer accent-[var(--color-primary)]"
              aria-label="Sentence position"
              aria-valuemin={1}
              aria-valuemax={segments.length}
              aria-valuenow={currentSegmentIndex + 1}
              title={`Sentence ${displayedScrub + 1} of ${segments.length}`}
            />
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted">
              {Math.min(displayedScrub, segments.length - 1) + 1}/{segments.length}
            </span>
          </div>
        )}
        {/* Selected-text actions get their own row on phones so the transport
            row never has to squeeze in two extra buttons. */}
        {selectionSegmentIndex !== null && selectionSegmentIndex !== currentSegmentIndex && (
          <div className="mb-1.5 flex items-center gap-2 px-1 sm:hidden">
            <button
              type="button"
              onClick={() => {
                prev(selectionSegmentIndex);
                setSelectionSegmentIndex(null);
              }}
              className="flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl border border-primary bg-primary/10 px-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/15"
              title={`Continue reading from selected text (sentence ${selectionSegmentIndex + 1})`}
              aria-label="Continue reading from selected text"
            >
              <BookOpenIcon size={15} className="shrink-0" />
              <span className="truncate">Continue from here</span>
            </button>
            <button
              type="button"
              onClick={() => {
                prev(selectionSegmentIndex, { stopAfter: true });
                setSelectionSegmentIndex(null);
              }}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-navbar-control-border bg-navbar-control text-foreground transition-colors hover:border-primary hover:text-primary"
              title="Read only the selected sentence"
              aria-label="Read only the selected sentence"
            >
              <StopIcon size={14} />
            </button>
          </div>
        )}
        <div className="flex w-full items-center justify-between gap-1 sm:gap-4">
          {/* Left tools: Settings (Following + Locate on hover) & Voice Picker */}
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            {/* Settings Trigger with Hover Popover */}
            <div
              ref={settingsRef}
              className="relative"
              onMouseEnter={handleSettingsMouseEnter}
              onMouseLeave={handleSettingsMouseLeave}
            >
              <button
                type="button"
                className={cn(
                  'h-9 w-9 rounded-xl sm:rounded-full border flex items-center justify-center cursor-pointer transition-all duration-150',
                  isSettingsOpen
                    ? 'bg-navbar-control-hover border-primary text-primary shadow-xs'
                    : 'bg-navbar-control border-navbar-control-border text-muted hover:text-foreground hover:border-primary/50'
                )}
                title="Settings (Following, Locate)"
                aria-label="Playback Settings"
                aria-expanded={isSettingsOpen}
                onClick={() => setIsSettingsOpen(!isSettingsOpen)}
              >
                <SettingsIcon size={16} />
              </button>

              {/* Settings Hover Menu */}
              {isSettingsOpen && (
                <div
                  className={cn(
                    'absolute bottom-full mb-2 left-0 min-w-[190px] max-w-[calc(100vw-2rem)]',
                    'max-h-[60dvh] overflow-y-auto overscroll-contain',
                    'bg-navbar/95 backdrop-blur-xl border border-navbar-border shadow-2xl rounded-2xl p-1.5 flex flex-col gap-1',
                    'animate-slide-up z-50'
                  )}
                >
                  {/* Locate active sentence button */}
                  <button
                    type="button"
                    onClick={() => {
                      handleScrollToCurrentSentence();
                      setIsSettingsOpen(false);
                    }}
                    className="w-full h-8 px-2.5 rounded-xl flex items-center gap-2 text-xs font-medium text-foreground hover:bg-primary-subtle hover:text-primary transition-colors cursor-pointer text-left"
                    title="Locate and center active sentence on screen"
                  >
                    <LocateIcon size={14} className="text-primary shrink-0" />
                    <span>Locate sentence</span>
                  </button>

                  {/* Following toggle button */}
                  <button
                    type="button"
                    onClick={() => setAutoScroll(!autoScroll)}
                    className={cn(
                      'w-full h-8 px-2.5 rounded-xl flex items-center justify-between gap-2 text-xs font-medium transition-colors cursor-pointer text-left',
                      autoScroll
                        ? 'bg-primary/10 text-primary font-semibold'
                        : 'text-foreground hover:bg-navbar-control'
                    )}
                    title={
                      autoScroll
                        ? 'Auto-follow is ON: Page scrolls with voice (Click to turn off)'
                        : 'Auto-follow is OFF: Free scrolling (Click to turn on)'
                    }
                  >
                    <div className="flex items-center gap-2">
                      <AutoScrollIcon
                        size={14}
                        className={cn('shrink-0', autoScroll ? 'text-primary' : 'text-muted')}
                      />
                      <span>Following</span>
                    </div>
                    <span
                      className={cn(
                        'text-[10px] uppercase font-bold px-1.5 py-0.5 rounded tracking-wide',
                        autoScroll
                          ? 'bg-primary text-white'
                          : 'bg-navbar-control border border-navbar-control-border text-muted'
                      )}
                    >
                      {autoScroll ? 'ON' : 'OFF'}
                    </span>
                  </button>

                  {/* Math speech toggle */}
                  <button
                    type="button"
                    onClick={() => setMathSpeech(!mathSpeech)}
                    className={cn(
                      'w-full h-8 px-2.5 rounded-xl flex items-center justify-between gap-2 text-xs font-medium transition-colors cursor-pointer text-left',
                      mathSpeech
                        ? 'bg-primary/10 text-primary font-semibold'
                        : 'text-foreground hover:bg-navbar-control'
                    )}
                    title={
                      mathSpeech
                        ? 'Equations are spoken as words (x squared, divided by…). Click to read symbols literally.'
                        : 'Equations are read literally. Click to speak them as words.'
                    }
                  >
                    <div className="flex items-center gap-2">
                      <SigmaIcon
                        size={14}
                        className={cn('shrink-0', mathSpeech ? 'text-primary' : 'text-muted')}
                      />
                      <span>Math speech</span>
                    </div>
                    <span
                      className={cn(
                        'text-[10px] uppercase font-bold px-1.5 py-0.5 rounded tracking-wide',
                        mathSpeech
                          ? 'bg-primary text-white'
                          : 'bg-navbar-control border border-navbar-control-border text-muted'
                      )}
                    >
                      {mathSpeech ? 'ON' : 'OFF'}
                    </span>
                  </button>

                  {/* Download is also reachable here on phones, where the
                      dedicated toolbar button is hidden to avoid overflow. */}
                  <button
                    type="button"
                    onClick={() => {
                      setIsDownloadOpen(true);
                      setIsSettingsOpen(false);
                    }}
                    className="w-full h-8 px-2.5 rounded-xl flex items-center gap-2 text-xs font-medium text-foreground hover:bg-primary-subtle hover:text-primary transition-colors cursor-pointer text-left"
                    title="Download the book as one MP3"
                  >
                    <DownloadIcon size={14} className="text-primary shrink-0" />
                    <span>Download MP3</span>
                  </button>
                </div>
              )}
            </div>

            {/* Read from the currently selected text: continue or one shot */}
            {selectionSegmentIndex !== null && selectionSegmentIndex !== currentSegmentIndex && (
              <div className="hidden items-center gap-1 sm:flex">
                <button
                  type="button"
                  onClick={() => {
                    prev(selectionSegmentIndex);
                    setSelectionSegmentIndex(null);
                  }}
                  className="h-9 px-2.5 sm:px-3 rounded-xl sm:rounded-full bg-primary/10 border border-primary text-primary flex items-center gap-1.5 text-xs font-semibold cursor-pointer transition-all duration-150 max-w-[38px] sm:max-w-none"
                  title={`Continue reading from selected text (sentence ${selectionSegmentIndex + 1})`}
                  aria-label="Continue reading from selected text"
                >
                  <BookOpenIcon size={15} className="shrink-0" />
                  <span className="hidden sm:inline">Continue</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    prev(selectionSegmentIndex, { stopAfter: true });
                    setSelectionSegmentIndex(null);
                  }}
                  className="h-9 w-9 rounded-xl sm:rounded-full bg-navbar-control border border-navbar-control-border text-foreground hover:border-primary hover:text-primary flex items-center justify-center cursor-pointer transition-all duration-150"
                  title="Read only the selected sentence"
                  aria-label="Read only the selected sentence"
                >
                  <StopIcon size={14} />
                </button>
              </div>
            )}

            {/* Voice Sheet Trigger */}
            <div className="relative">
              <button
                ref={voiceTriggerRef}
                type="button"
                className="flex h-9 w-9 items-center justify-center gap-1.5 rounded-xl border border-navbar-control-border bg-navbar-control px-0 text-xs font-semibold text-foreground transition-all duration-150 hover:border-primary hover:text-primary sm:w-auto sm:max-w-[170px] sm:justify-start sm:px-3"
                title={`Select voice (current: ${voiceDisplayName})`}
                aria-label={`Select voice, current ${voiceDisplayName}`}
                aria-expanded={isVoiceOpen}
                onClick={() => setIsVoiceOpen(!isVoiceOpen)}
              >
                <HeadphonesIcon size={15} className="shrink-0 text-primary" />
                <span className="hidden truncate sm:inline">{voiceDisplayName}</span>
              </button>

              <VoiceSheet
                isOpen={isVoiceOpen}
                onClose={() => setIsVoiceOpen(false)}
                triggerRef={voiceTriggerRef}
              />
            </div>
          </div>

          {/* Center transport buttons: Prev, Big Play/Pause, Next, Stop */}
          <div className="flex shrink-0 items-center gap-0.5 sm:gap-2.5">
            <button
              type="button"
              className="h-9 w-9 shrink-0 sm:h-10 sm:w-10 rounded-full flex items-center justify-center bg-navbar-control border border-navbar-control-border text-foreground hover:bg-navbar-control-hover hover:text-primary hover:border-primary transition-all active:scale-95 cursor-pointer disabled:opacity-40"
              title="Previous sentence (Left Arrow)"
              aria-label="Previous sentence"
              onClick={() => prev(Math.max(0, currentSegmentIndex - 1))}
            >
              <SkipBackIcon size={16} />
            </button>

            {/* Main Play / Pause Button */}
            <button
              type="button"
              className={cn(
                'h-10 w-10 shrink-0 sm:h-12 sm:w-12 rounded-full flex items-center justify-center bg-primary text-white border-0 shadow-lg cursor-pointer transition-all duration-150 hover:bg-primary-hover hover:scale-105 active:scale-95 disabled:opacity-40',
                playbackStatus === 'playing' && 'animate-play-pulse'
              )}
              title={playbackStatus === 'playing' ? 'Pause (Space)' : 'Play (Space)'}
              aria-label={playbackStatus === 'playing' ? 'Pause playback' : 'Play document'}
              disabled={playbackStatus === 'loading'}
              onClick={() => {
                if (playbackStatus === 'playing') pause();
                else if (playbackStatus === 'paused') resume();
                else play();
              }}
            >
              {playbackStatus === 'loading' ? (
                <svg className="animate-spin h-5 w-5 sm:h-6 sm:w-6 text-white" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : playbackStatus === 'playing' ? (
                <PauseIcon size={19} />
              ) : (
                <PlayIcon size={19} className="ml-0.5" />
              )}
            </button>

            <button
              type="button"
              className="h-9 w-9 shrink-0 sm:h-10 sm:w-10 rounded-full flex items-center justify-center bg-navbar-control border border-navbar-control-border text-foreground hover:bg-navbar-control-hover hover:text-primary hover:border-primary transition-all active:scale-95 cursor-pointer disabled:opacity-40"
              title="Next sentence (Right Arrow)"
              aria-label="Next sentence"
              onClick={() => next()}
            >
              <SkipForwardIcon size={16} />
            </button>

            {(playbackStatus === 'playing' || playbackStatus === 'paused') && (
              <button
                type="button"
                className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full border border-navbar-control-border bg-navbar-control text-error transition-all hover:border-error hover:bg-error/10 active:scale-95 cursor-pointer sm:flex"
                title="Stop playback and reset to start"
                aria-label="Stop playback"
                onClick={stop}
              >
                <StopIcon size={13} />
              </button>
            )}
          </div>

          {/* Right tools: Speed Picker & Minimize */}
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <div className="relative">
              <button
                ref={speedTriggerRef}
                type="button"
                className="flex h-9 min-w-[2.5rem] items-center justify-center gap-1 rounded-xl border border-navbar-control-border bg-navbar-control px-1 font-mono text-xs font-semibold text-foreground transition-all duration-150 hover:border-primary hover:text-primary sm:min-w-0 sm:rounded-full sm:px-3"
                aria-label={`Playback speed ${formatSpeed(playbackSpeed)}`}
                title="Playback Speed"
                aria-expanded={isSpeedOpen}
                onClick={() => setIsSpeedOpen(!isSpeedOpen)}
              >
                <SpeedIcon size={14} className="text-primary hidden sm:inline" />
                <span>{formatSpeed(playbackSpeed)}</span>
              </button>

              <SpeedMenu
                isOpen={isSpeedOpen}
                onClose={() => setIsSpeedOpen(false)}
                triggerRef={speedTriggerRef}
              />
            </div>

            {/* Download the book as one MP3 */}
            <div className="relative">
              <button
                ref={downloadTriggerRef}
                type="button"
                className="hidden sm:flex h-9 w-9 rounded-xl sm:rounded-full bg-navbar-control border border-navbar-control-border text-muted hover:text-primary hover:border-primary items-center justify-center cursor-pointer transition-all duration-150"
                title="Download audio as MP3"
                aria-label="Download audio as MP3"
                aria-expanded={isDownloadOpen}
                onClick={() => setIsDownloadOpen(!isDownloadOpen)}
              >
                <DownloadIcon size={15} />
              </button>
              <DownloadAudioDialog
                isOpen={isDownloadOpen}
                onClose={() => setIsDownloadOpen(false)}
                triggerRef={downloadTriggerRef}
              />
            </div>

            {/* Minimize / Hide toolbar button */}
            <button
              type="button"
              onClick={() => setIsMinimized(true)}
              className="h-9 w-9 rounded-xl sm:rounded-full bg-navbar-control border border-navbar-control-border text-muted hover:text-foreground hover:border-primary/50 flex items-center justify-center cursor-pointer transition-all duration-150"
              title="Minimize toolbar"
              aria-label="Minimize toolbar"
            >
              <MinimizeIcon size={15} />
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
};
