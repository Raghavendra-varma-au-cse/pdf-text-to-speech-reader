'use client';

import React, { useEffect, useState } from 'react';
import { useAudioStore } from '../store/use-audio-store';
import { ChevronLeftIcon, ChevronRightIcon, FileTextIcon } from './Icons';

export const PageNavigator: React.FC = () => {
  const file = useAudioStore((s) => s.file);
  const currentPage = useAudioStore((s) => s.currentPage);
  const totalPages = useAudioStore((s) => s.totalPages);
  const setCurrentPage = useAudioStore((s) => s.setCurrentPage);
  const [pageInput, setPageInput] = useState(String(currentPage));

  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  if (!file || totalPages <= 1) return null;

  const handlePageJump = (page: number) => {
    if (page < 1 || page > totalPages) return;
    setCurrentPage(page);
    const pageEl = document.getElementById(`pdf-page-${page}`);
    if (pageEl) {
      pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const commitPageInput = () => {
    const page = parseInt(pageInput, 10);
    if (!Number.isFinite(page)) {
      setPageInput(String(currentPage));
      return;
    }
    handlePageJump(Math.max(1, Math.min(totalPages, page)));
  };

  return (
    <div
      className="fixed bottom-[calc(6.5rem+env(safe-area-inset-bottom))] left-3 z-[900] pointer-events-auto animate-fade-in sm:bottom-[8.5rem] sm:left-4"
      role="navigation"
      aria-label="PDF page navigation"
    >
      <div className="flex items-center gap-1 rounded-full border border-navbar-border bg-navbar/95 px-2 py-1.5 text-xs font-semibold text-foreground shadow-lg backdrop-blur-md sm:gap-1.5 sm:px-2.5">
        <button
          type="button"
          disabled={currentPage <= 1}
          onClick={() => handlePageJump(currentPage - 1)}
          className="flex h-8 w-8 items-center justify-center rounded-full border-0 bg-transparent text-muted transition-colors hover:bg-navbar-control hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 cursor-pointer"
          title="Previous Page"
          aria-label="Previous Page"
        >
          <ChevronLeftIcon size={14} />
        </button>

        <div className="flex items-center gap-1 px-1 font-mono">
          <FileTextIcon size={13} className="text-primary" />
          <label htmlFor="page-jump-input" className="sr-only">Go to page</label>
          <input
            id="page-jump-input"
            type="text"
            inputMode="numeric"
            value={pageInput}
            onChange={(event) => setPageInput(event.target.value.replace(/[^\d]/g, ''))}
            onBlur={commitPageInput}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitPageInput();
                (event.currentTarget as HTMLInputElement).blur();
              }
              if (event.key === 'Escape') {
                setPageInput(String(currentPage));
                (event.currentTarget as HTMLInputElement).blur();
              }
            }}
            className="h-8 w-10 rounded border border-transparent bg-transparent px-1 text-center text-xs font-mono font-semibold text-foreground outline-none focus:border-primary focus:bg-background"
            aria-label="Current page, type a page number and press Enter"
            title="Type a page number and press Enter"
          />
          <span className="text-muted">/ {totalPages}</span>
        </div>

        <button
          type="button"
          disabled={currentPage >= totalPages}
          onClick={() => handlePageJump(currentPage + 1)}
          className="flex h-8 w-8 items-center justify-center rounded-full border-0 bg-transparent text-muted transition-colors hover:bg-navbar-control hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 cursor-pointer"
          title="Next Page"
          aria-label="Next Page"
        >
          <ChevronRightIcon size={14} />
        </button>
      </div>
    </div>
  );
};

