'use client';

import React from 'react';
import { DocumentHistory } from './DocumentHistory';
import { CloseIcon } from './Icons';
import type { DocumentHistoryMeta } from '../lib/document-history';

interface HistorySheetProps {
  isOpen: boolean;
  onClose: () => void;
  onOpen: (meta: DocumentHistoryMeta) => void;
  refreshToken: number;
}

export const HistorySheet: React.FC<HistorySheetProps> = ({
  isOpen,
  onClose,
  onOpen,
  refreshToken,
}) => {
  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-[1300] bg-black/45 backdrop-blur-xs animate-fade-in-fast"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Recent documents"
        className="fixed inset-x-0 bottom-0 z-[1400] max-h-[85dvh] w-full overflow-y-auto overscroll-contain rounded-t-3xl border border-border bg-surface p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-2xl animate-slide-up sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-24 sm:w-[min(560px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:rounded-3xl sm:p-6"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="font-heading text-xl font-bold text-foreground">Local history</h2>
            <p className="text-xs text-muted">Stored on this device — no upload needed.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-navbar-control hover:text-foreground"
            aria-label="Close history"
          >
            <CloseIcon size={18} />
          </button>
        </div>
        <DocumentHistory onOpen={onOpen} refreshToken={refreshToken} showEmpty />
      </div>
    </>
  );
};
