'use client';

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import {
  clearDebugEntries,
  getDebugEntries,
  getDebugStats,
  getDebugVersion,
  installDebugConsoleApi,
  isDebugEnabled,
  subscribeDebug,
} from '../lib/debug';
import { CloseIcon, FileTextIcon } from './Icons';

export const DebugPanel: React.FC = () => {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const version = useSyncExternalStore(subscribeDebug, getDebugVersion, () => 0);

  useEffect(() => {
    installDebugConsoleApi();
    const frame = window.requestAnimationFrame(() => setEnabled(isDebugEnabled()));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // `version` is intentionally read so the panel re-renders when logs change.
  void version;

  if (!enabled) return null;

  const stats = getDebugStats();
  const entries = getDebugEntries().slice(-60).reverse();

  const copyDiagnostics = async () => {
    const payload = JSON.stringify(
      { stats: getDebugStats(), entries: getDebugEntries() },
      null,
      2
    );
    try {
      await navigator.clipboard.writeText(payload);
    } catch {
      // Clipboard permissions are optional.
    }
  };

  return (
    <div className="fixed right-3 top-[76px] z-[960] flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1.5 rounded-full border border-navbar-border bg-navbar/95 px-3 py-1.5 text-xs font-semibold text-foreground shadow-md backdrop-blur-md hover:border-primary hover:text-primary transition-colors"
        aria-expanded={open}
        aria-label="Toggle debug panel"
      >
        <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />
        Debug
      </button>

      {open && (
        <div className="w-[min(420px,calc(100vw-1.5rem))] max-h-[70vh] overflow-hidden rounded-2xl border border-navbar-border bg-surface shadow-2xl flex flex-col">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <div className="flex items-center gap-2 text-sm font-bold text-foreground">
              <FileTextIcon size={15} className="text-primary" />
              ReadAloud diagnostics
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-navbar-control hover:text-foreground"
              aria-label="Close debug panel"
            >
              <CloseIcon size={15} />
            </button>
          </div>

          <div className="overflow-y-auto p-3 text-xs">
            <section>
              <h4 className="mb-1 font-semibold uppercase tracking-wide text-muted">PDF</h4>
              <pre className="overflow-x-auto rounded-lg bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground">
                {JSON.stringify(stats.pdf ?? { phase: 'no PDF loaded' }, null, 2)}
              </pre>
            </section>

            <section className="mt-3">
              <div className="mb-1 flex items-center justify-between">
                <h4 className="font-semibold uppercase tracking-wide text-muted">Log</h4>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void copyDiagnostics()}
                    className="text-[11px] font-semibold text-primary hover:underline"
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    onClick={() => clearDebugEntries()}
                    className="text-[11px] font-semibold text-muted hover:text-error"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <ul className="flex flex-col gap-1 font-mono text-[11px]">
                {entries.length === 0 ? (
                  <li className="text-muted">No log entries yet.</li>
                ) : (
                  entries.map((entry, index) => (
                    <li key={`${entry.time}-${index}`} className="rounded-md bg-background px-2 py-1">
                      <span className="text-muted">
                        {new Date(entry.time).toLocaleTimeString()}{' '}
                      </span>
                      <span className="font-semibold text-primary">{entry.scope}</span>{' '}
                      <span className="text-foreground">{entry.message}</span>
                      {entry.data !== undefined ? (
                        <span className="block break-all text-muted">
                          {(() => {
                            try {
                              return JSON.stringify(entry.data);
                            } catch {
                              return String(entry.data);
                            }
                          })()}
                        </span>
                      ) : null}
                    </li>
                  ))
                )}
              </ul>
            </section>
          </div>
        </div>
      )}
    </div>
  );
};
