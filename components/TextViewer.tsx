'use client';

import React, { useEffect, useRef, useMemo, Fragment } from 'react';
import { useAudioStore } from '../store/use-audio-store';
import { cn } from '../lib/cn';
import { ZoomInIcon, ZoomOutIcon } from './Icons';

export const TextViewer = () => {
  const segments = useAudioStore((state) => state.segments);
  const currentSegmentIndex = useAudioStore((state) => state.currentSegmentIndex);
  const playbackStatus = useAudioStore((state) => state.playbackStatus);
  const autoScroll = useAudioStore((state) => state.autoScroll);
  const playSegment = useAudioStore((state) => state.playSegment);
  const textFontSize = useAudioStore((state) => state.textFontSize);
  const increaseFontSize = useAudioStore((state) => state.increaseFontSize);
  const decreaseFontSize = useAudioStore((state) => state.decreaseFontSize);
  const resetFontSize = useAudioStore((state) => state.resetFontSize);
  const setSelectionSegmentIndex = useAudioStore((state) => state.setSelectionSegmentIndex);
  const spokenWordRange = useAudioStore((state) => state.spokenWordRange);
  const mathSpeech = useAudioStore((state) => state.mathSpeech);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleSelection = () => {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setSelectionSegmentIndex(null);
      return;
    }
    const anchor = selection.getRangeAt(0).startContainer;
    const element =
      anchor.nodeType === Node.ELEMENT_NODE ? (anchor as HTMLElement) : anchor.parentElement;
    const sentence = element?.closest<HTMLElement>('[id^="text-seg-"]');
    const index = sentence ? parseInt(sentence.id.replace('text-seg-', ''), 10) : -1;
    setSelectionSegmentIndex(index >= 0 ? index : null);
  };

  // Line-tracking: Auto-scroll to current sentence during playback ONLY if autoScroll is enabled
  useEffect(() => {
    if (playbackStatus === 'idle' || !autoScroll) return;
    const el = document.getElementById(`text-seg-${currentSegmentIndex}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentSegmentIndex, playbackStatus, autoScroll]);

  // Group sentences into paragraphs to preserve the original document organization
  const paragraphs = useMemo(() => {
    const list: { paraIndex: number; items: { segment: (typeof segments)[0]; globalIndex: number }[] }[] = [];
    let current: { paraIndex: number; items: { segment: (typeof segments)[0]; globalIndex: number }[] } | null = null;

    segments.forEach((segment, globalIndex) => {
      const pIdx = segment.paragraphIndex ?? 0;
      if (!current || current.paraIndex !== pIdx) {
        current = { paraIndex: pIdx, items: [] };
        list.push(current);
      }
      current.items.push({ segment, globalIndex });
    });

    return list;
  }, [segments]);

  if (!segments.length) return null;

  return (
    <div className="mx-auto w-full max-w-3xl">
      {/* Phone-sized font control: the header toolbar is desktop-only so the
          mobile header can stay compact. */}
      <div className="mb-3 flex items-center justify-between gap-2 px-1 sm:hidden">
        <span className="text-xs font-semibold text-muted">Reading size</span>
        <div
          className="flex items-center overflow-hidden rounded-xl border border-navbar-control-border bg-navbar-control"
          role="group"
          aria-label="Text reader font size controls"
        >
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center border-0 bg-transparent text-foreground transition-colors hover:bg-navbar-control-hover hover:text-primary disabled:opacity-40 cursor-pointer"
            title="Decrease font size"
            aria-label="Decrease font size"
            disabled={textFontSize <= 12}
            onClick={decreaseFontSize}
          >
            <ZoomOutIcon size={15} />
          </button>
          <button
            type="button"
            className="h-9 border-x border-navbar-control-border bg-transparent px-2.5 font-mono text-xs font-semibold text-foreground transition-colors hover:text-primary cursor-pointer"
            title="Reset font size to default (16px)"
            aria-label={`Reset font size, currently ${textFontSize} pixels`}
            onClick={resetFontSize}
          >
            {textFontSize}px
          </button>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center border-0 bg-transparent text-foreground transition-colors hover:bg-navbar-control-hover hover:text-primary disabled:opacity-40 cursor-pointer"
            title="Increase font size"
            aria-label="Increase font size"
            disabled={textFontSize >= 32}
            onClick={increaseFontSize}
          >
            <ZoomInIcon size={15} />
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className={cn(
          'w-full bg-surface border border-border rounded-2xl md:rounded-3xl',
          'p-5 sm:p-10 md:p-12 leading-relaxed md:leading-[1.75] text-foreground shadow-md',
          'break-words [overflow-wrap:anywhere] text-pretty',
          'transition-all duration-200'
        )}
        style={{ fontSize: `${textFontSize}px` }}
        tabIndex={0}
        aria-label="Text document reader content"
        onMouseUp={handleSelection}
        onKeyUp={handleSelection}
      >
        <div className="space-y-4 sm:space-y-5">
        {paragraphs.map((para) => (
          <p key={para.paraIndex} className="m-0 leading-relaxed md:leading-[1.75]">
            {para.items.map(({ segment, globalIndex }) => {
              const isPlaying = playbackStatus !== 'idle' && currentSegmentIndex === globalIndex;
              const wordRange =
                !mathSpeech &&
                isPlaying &&
                spokenWordRange &&
                spokenWordRange.start >= 0 &&
                spokenWordRange.end <= segment.text.length &&
                spokenWordRange.end > spokenWordRange.start
                  ? spokenWordRange
                  : null;
              return (
                <Fragment key={segment.id}>
                  <span
                    id={`text-seg-${globalIndex}`}
                    role="button"
                    tabIndex={0}
                    title="Click to read aloud from here (Shift+click: only this sentence)"
                    className={cn(
                      'cursor-pointer transition-colors duration-150 rounded-xs',
                      'hover:bg-primary-subtle hover:text-primary',
                      isPlaying
                        ? 'bg-highlight-bg text-highlight-text font-medium px-1 py-0.5 -mx-1 shadow-[0_0_0_1px_color-mix(in_srgb,var(--highlight-border)_35%,transparent)] [box-decoration-break:clone]'
                        : 'text-foreground/90'
                    )}
                    onClick={(e) => playSegment(globalIndex, { stopAfter: e.shiftKey })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        playSegment(globalIndex, { stopAfter: e.shiftKey });
                      }
                    }}
                  >
                    {wordRange ? (
                      <>
                        {segment.text.slice(0, wordRange.start)}
                        <mark className="rounded-sm bg-primary/40 px-0.5 font-semibold text-highlight-text [box-decoration-break:clone]">
                          {segment.text.slice(wordRange.start, wordRange.end)}
                        </mark>
                        {segment.text.slice(wordRange.end)}
                      </>
                    ) : (
                      segment.text
                    )}
                  </span>{segment.trailingNewlines === 1 ? <br /> : ' '}
                </Fragment>
              );
            })}
          </p>
        ))}
        </div>
      </div>
    </div>
  );
};


