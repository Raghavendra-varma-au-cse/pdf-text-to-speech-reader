/** Minimum / maximum CSS zoom used by the viewer. */
export const MIN_SCALE = 0.4;
export const MAX_SCALE = 3.5;

/**
 * Compute the zoom that fits a page's unscaled width into the available
 * viewport width. `padding` is the horizontal breathing room in CSS pixels.
 */
export function computeFitScale(
  availableWidth: number,
  unscaledPageWidth: number,
  padding = 24,
  min = MIN_SCALE,
  max = MAX_SCALE
): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return 1.2;
  if (!Number.isFinite(unscaledPageWidth) || unscaledPageWidth <= 0) return 1.2;

  const raw = (availableWidth - padding) / unscaledPageWidth;
  return Number(Math.max(min, Math.min(max, raw)).toFixed(2));
}

/**
 * Canvas backing-store resolution. Very large zoom levels or DPR 3 screens can
 * otherwise allocate hundreds of megabytes per page. We keep a hard cap on the
 * total pixels in one canvas and allow a sub-1 DPR for extreme zooms so that a
 * large PDF stays usable instead of crashing the tab.
 */
export function capRenderDpr(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxPixels = 12_000_000
): number {
  const area = Math.max(1, cssWidth * cssHeight);
  const preferred = Math.max(1, Math.min(devicePixelRatio || 1, 2));
  const maxByArea = Math.sqrt(maxPixels / area);
  return Number(Math.max(0.5, Math.min(preferred, maxByArea)).toFixed(2));
}

/** How many rendered page bitmaps we keep alive before evicting far pages. */
export function getRenderedPageBudget(totalPages: number): number {
  if (totalPages <= 16) return totalPages;

  const memory =
    typeof navigator !== 'undefined' && 'deviceMemory' in navigator
      ? Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory)
      : 8;

  // Low-memory phones keep fewer canvases; desktop readers keep more.
  if (!Number.isFinite(memory) || memory <= 2) return 6;
  if (memory <= 4) return 8;
  if (memory <= 8) return 10;
  return 12;
}

/** Concurrency defaults that scale with the device without exhausting it. */
export function getLoadConcurrency(): { text: number; render: number } {
  const cores =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;

  return {
    text: Math.max(2, Math.min(6, Math.floor(cores / 2))),
    render: Math.max(1, Math.min(3, Math.floor(cores / 4))),
  };
}
