/**
 * In-repo debugging helpers.
 *
 * Enable with `?debug=1`, `localStorage.setItem('readaloud:debug','1')`, or
 * `NEXT_PUBLIC_READALOUD_DEBUG=1`. The debug panel and the console API live in
 * this repository; nothing is written to temp folders.
 */

export interface PdfDebugStats {
  phase?: string;
  totalPages?: number;
  textReady?: number;
  renderedPages?: number;
  textConcurrency?: number;
  renderConcurrency?: number;
  docLoadMs?: number;
  firstTextMs?: number;
  allTextMs?: number;
  ocrPages?: number;
  error?: string;
}

export interface ReadAloudDebugStats {
  pdf?: PdfDebugStats;
  storage?: {
    historyEntries?: number;
    historyBytes?: number;
    quotaBytes?: number;
    usageBytes?: number;
  };
  [key: string]: unknown;
}

export interface DebugEntry {
  time: number;
  scope: string;
  message: string;
  data?: unknown;
}

const MAX_ENTRIES = 250;
const entries: DebugEntry[] = [];
const listeners = new Set<() => void>();
let stats: ReadAloudDebugStats = {};
let version = 0;

export function isDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  if (process.env.NEXT_PUBLIC_READALOUD_DEBUG === '1') return true;

  try {
    if (new URLSearchParams(window.location.search).has('debug')) return true;
    return window.localStorage.getItem('readaloud:debug') === '1';
  } catch {
    return false;
  }
}

function emit(): void {
  version++;
  listeners.forEach((listener) => listener());
}

export function subscribeDebug(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDebugVersion(): number {
  return version;
}

export function getDebugEntries(): DebugEntry[] {
  return entries;
}

export function getDebugStats(): ReadAloudDebugStats {
  return stats;
}

export function clearDebugEntries(): void {
  entries.length = 0;
  emit();
}

export function debugLog(scope: string, message: string, data?: unknown): void {
  if (!isDebugEnabled()) return;

  entries.push({ time: Date.now(), scope, message, data });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);

  console.debug(`[readaloud:${scope}] ${message}`, data ?? '');
  emit();
}

/** Measure a block of work and log the elapsed time. */
export function debugTime(scope: string, label: string): (data?: unknown) => number {
  const start =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

  return (data?: unknown) => {
    const now =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    const elapsed = now - start;
    debugLog(scope, `${label} ${elapsed.toFixed(0)}ms`, data);
    return elapsed;
  };
}

export function setDebugStats(patch: Partial<ReadAloudDebugStats>): void {
  stats = {
    ...stats,
    ...patch,
    pdf: patch.pdf ? { ...stats.pdf, ...patch.pdf } : stats.pdf,
    storage: patch.storage ? { ...stats.storage, ...patch.storage } : stats.storage,
  };
  emit();
}

/** Handy console API: window.__readaloudDebug.snapshot(). */
export function installDebugConsoleApi(): void {
  if (typeof window === 'undefined') return;

  const api = {
    enabled: isDebugEnabled,
    entries: getDebugEntries,
    stats: getDebugStats,
    clear: clearDebugEntries,
    snapshot: () => ({
      stats: getDebugStats(),
      entries: getDebugEntries().slice(-80),
    }),
  };

  (window as unknown as { __readaloudDebug?: unknown }).__readaloudDebug = api;
}
