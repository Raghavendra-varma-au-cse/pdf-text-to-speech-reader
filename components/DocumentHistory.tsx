'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  type DocumentHistoryMeta,
  deleteHistoryEntry,
  clearDocumentHistory,
  formatFileSize,
  getHistoryUsage,
  listDocumentHistory,
} from '../lib/document-history';
import { ClockIcon, FileTextIcon, TrashIcon } from './Icons';

interface DocumentHistoryProps {
  onOpen: (meta: DocumentHistoryMeta) => void;
  /** Bump this after opening a file to refresh timestamps. */
  refreshToken?: number;
  /** Show a friendly empty state instead of rendering nothing. */
  showEmpty?: boolean;
}

function formatRelativeTime(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export const DocumentHistory: React.FC<DocumentHistoryProps> = ({ onOpen, refreshToken = 0, showEmpty = false }) => {
  const [entries, setEntries] = useState<DocumentHistoryMeta[]>([]);
  const [usage, setUsage] = useState({ count: 0, bytes: 0 });
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [list, estimate] = await Promise.all([listDocumentHistory(), getHistoryUsage()]);
    setEntries(list);
    setUsage(estimate);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  const handleDelete = async (event: React.MouseEvent, entry: DocumentHistoryMeta) => {
    event.stopPropagation();
    setBusyId(entry.id);
    setError(null);
    try {
      await deleteHistoryEntry(entry.id);
      await refresh();
    } catch {
      setError('Could not remove this document from local history.');
    } finally {
      setBusyId(null);
    }
  };

  const handleClear = async () => {
    if (!window.confirm('Remove all locally stored documents from history?')) return;
    setBusyId('all');
    setError(null);
    try {
      await clearDocumentHistory();
      await refresh();
    } catch {
      setError('Could not clear local history. Browser storage may be unavailable.');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return showEmpty ? (
      <p role="status" className="py-6 text-center text-sm text-muted">Loading local history…</p>
    ) : null;
  }

  if (entries.length === 0) {
    return showEmpty ? (
      <p className="py-8 text-center text-sm text-muted">
        No documents yet. Open a PDF, DOCX, TXT or Markdown file and it will appear here,
        stored on this device.
      </p>
    ) : null;
  }

  return (
    <section aria-label="Recent documents" className="w-full mt-10">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h2 className="font-heading text-lg font-bold text-foreground">Recent documents</h2>
          <p className="text-xs text-muted mt-0.5">
            Stored on this device in IndexedDB · {usage.count} file{usage.count === 1 ? '' : 's'} ·{' '}
            {formatFileSize(usage.bytes)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleClear()}
          disabled={busyId !== null}
          className="min-h-9 shrink-0 rounded-lg px-2 text-xs font-semibold text-muted hover:text-error transition-colors disabled:opacity-50"
        >
          Clear all
        </button>
      </div>

      <ul className="flex flex-col gap-2">
        {error && (
          <li role="alert" className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-xs text-error">
            {error}
          </li>
        )}
        {entries.map((entry) => (
          <li key={entry.id}>
            <div className="group flex items-center gap-2 rounded-xl border border-border bg-surface px-2.5 py-2.5 transition-colors hover:border-primary/50 sm:gap-3 sm:px-3">
              <button
                type="button"
                onClick={() => onOpen(entry)}
                className="flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent p-0 text-left cursor-pointer sm:gap-3"
                title={`Open ${entry.name}`}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <FileTextIcon size={17} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 break-words text-sm font-semibold text-foreground [overflow-wrap:anywhere]">
                    {entry.name}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                    <span className="uppercase font-semibold text-primary">
                      {entry.kind === 'pdf' ? 'PDF' : 'Document'}
                    </span>
                    <span>{formatFileSize(entry.size)}</span>
                    {entry.pageCount ? <span>{entry.pageCount} pages</span> : null}
                    <span className="inline-flex items-center gap-1">
                      <ClockIcon size={11} />
                      {formatRelativeTime(entry.openedAt)}
                    </span>
                  </span>
                </span>
              </button>

              <button
                type="button"
                onClick={(event) => void handleDelete(event, entry)}
                disabled={busyId !== null}
                aria-label={`Remove ${entry.name} from history`}
                title="Remove from history"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-error/10 hover:text-error disabled:opacity-40"
              >
                {busyId === entry.id ? (
                  <span className="h-3.5 w-3.5 rounded-full border-2 border-error/30 border-t-error animate-spin" />
                ) : (
                  <TrashIcon size={14} />
                )}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
};
