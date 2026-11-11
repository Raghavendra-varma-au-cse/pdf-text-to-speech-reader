import { createStore, get, set, del, keys } from 'idb-keyval';
import { hashString } from './hash';

/**
 * Local document history.
 *
 * Files live in IndexedDB (not localStorage) so large PDFs are stored as blobs
 * and never re-uploaded. Only uploaded files are kept; pasted text stays
 * ephemeral, matching the app's privacy promise.
 */

const DB_NAME = 'readaloud-history';
const metaStore = createStore(DB_NAME, 'meta');
const fileStore = createStore(DB_NAME, 'files');

const MAX_ENTRIES = 12;

export type HistoryKind = 'pdf' | 'document';

export interface DocumentHistoryMeta {
  id: string;
  fingerprint: string;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  kind: HistoryKind;
  openedAt: number;
  pageCount?: number;
}

export interface HistoryUsage {
  count: number;
  bytes: number;
}

export function fingerprintFile(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}\u0000${file.type}`;
}

function idForFingerprint(fingerprint: string): string {
  return hashString(fingerprint);
}

async function readAllMeta(): Promise<DocumentHistoryMeta[]> {
  const ids = await keys<string>(metaStore);
  const metas = await Promise.all(ids.map((id) => get<DocumentHistoryMeta>(id, metaStore)));
  return metas
    .filter((meta): meta is DocumentHistoryMeta => Boolean(meta))
    .sort((a, b) => b.openedAt - a.openedAt);
}

/** Metadata only — listing never loads the stored blobs into memory. */
export async function listDocumentHistory(): Promise<DocumentHistoryMeta[]> {
  try {
    return await readAllMeta();
  } catch {
    return [];
  }
}

export async function getHistoryUsage(): Promise<HistoryUsage> {
  try {
    const metas = await readAllMeta();
    return {
      count: metas.length,
      bytes: metas.reduce((total, meta) => total + (meta.size || 0), 0),
    };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

/**
 * Save (or refresh) an uploaded document. The file blob is written only once
 * per fingerprint; re-opening the same file just bumps its timestamp.
 */
export async function saveDocumentToHistory(
  file: File,
  kind: HistoryKind,
  pageCount?: number
): Promise<DocumentHistoryMeta> {
  // Ask the browser to keep this origin's storage when the quota manager allows
  // it. Best-effort: the app works even when persistence is denied.
  try {
    await navigator.storage?.persist?.();
  } catch {
    // Persistence is optional.
  }

  const fingerprint = fingerprintFile(file);
  const id = idForFingerprint(fingerprint);
  const existing = await get<DocumentHistoryMeta>(id, metaStore);
  const now = Date.now();

  const meta: DocumentHistoryMeta = {
    id,
    fingerprint,
    name: file.name,
    type: file.type,
    size: file.size,
    lastModified: file.lastModified,
    kind,
    openedAt: now,
    pageCount: pageCount ?? existing?.pageCount,
  };

  // Keep the list bounded. Delete the oldest entries that are not this one.
  const all = await readAllMeta();
  if (!existing && all.length >= MAX_ENTRIES) {
    const victims = all.slice(MAX_ENTRIES - 1);
    await Promise.all(victims.map((victim) => deleteHistoryEntry(victim.id)));
  }

  const alreadyStored = existing ? await get<Blob>(id, fileStore) : undefined;

  try {
    if (!alreadyStored) {
      await set(id, file, fileStore);
    }
    await set(id, meta, metaStore);
  } catch (error) {
    const isQuota =
      typeof DOMException !== 'undefined' &&
      error instanceof DOMException &&
      (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    if (!isQuota) throw error;

    // Quota exceeded: drop the oldest document and retry once.
    const oldest = (await readAllMeta()).filter((entry) => entry.id !== id).at(-1);
    if (oldest) {
      await deleteHistoryEntry(oldest.id);
      await set(id, file, fileStore);
      await set(id, meta, metaStore);
    } else {
      throw error;
    }
  }

  return meta;
}

export async function updateHistoryMeta(
  id: string,
  patch: Partial<Pick<DocumentHistoryMeta, 'pageCount' | 'openedAt'>>
): Promise<void> {
  try {
    const meta = await get<DocumentHistoryMeta>(id, metaStore);
    if (!meta) return;
    await set(id, { ...meta, ...patch }, metaStore);
  } catch {
    // History is best-effort.
  }
}

export async function touchHistoryEntry(id: string): Promise<void> {
  await updateHistoryMeta(id, { openedAt: Date.now() });
}

/** Store the page count once the PDF parser knows it. */
export async function updateHistoryPageCount(file: File, pageCount: number): Promise<void> {
  const id = idForFingerprint(fingerprintFile(file));
  await updateHistoryMeta(id, { pageCount });
}

/** Load a stored file and rebuild a File so the normal import path can run. */
export async function loadHistoryFile(meta: DocumentHistoryMeta): Promise<File | null> {
  try {
    const blob = await get<Blob>(meta.id, fileStore);
    if (!blob) return null;
    return new File([blob], meta.name, {
      type: meta.type || blob.type,
      lastModified: meta.lastModified || Date.now(),
    });
  } catch {
    return null;
  }
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  try {
    await del(id, metaStore);
    await del(id, fileStore);
  } catch {
    // Best-effort cleanup.
  }
}

export async function clearDocumentHistory(): Promise<void> {
  try {
    const metas = await readAllMeta();
    await Promise.all(metas.map((meta) => deleteHistoryEntry(meta.id)));
  } catch {
    // Best-effort cleanup.
  }
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
