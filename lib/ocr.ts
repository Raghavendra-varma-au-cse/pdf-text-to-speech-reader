import type { PDFPageProxy } from 'pdfjs-dist';
import { normalizeRawText } from './text-normalizer';
import type { TextSegment } from '../types';

/**
 * Very small, opt-in OCR bridge.
 *
 * tesseract.js (and its worker/core/language data) is dynamically imported only
 * when the reader actually needs OCR, so the normal PDF path stays lean. The
 * language data is downloaded on first use and cached by the browser.
 */

type TesseractWorker = import('tesseract.js').Worker;

export interface OcrProgress {
  status: string;
  progress: number;
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(width));
  canvas.height = Math.max(1, Math.floor(height));
  return canvas;
}

/** A scanned page is one that produced essentially no selectable text. */
export function looksLikeScannedPage(segments: TextSegment[]): boolean {
  // Only pages with no selectable text at all are treated as scanned. Short
  // pages (chapter titles, poems, cover pages) must keep their real text.
  return segments.length === 0;
}

export class OcrSession {
  private workerPromise: Promise<TesseractWorker> | null = null;
  private worker: TesseractWorker | null = null;
  private disposed = false;
  private progressHandler: ((progress: OcrProgress) => void) | null = null;

  private async getWorker(onProgress?: (progress: OcrProgress) => void): Promise<TesseractWorker> {
    if (this.disposed) throw new Error('OCR session was disposed.');
    if (this.worker) return this.worker;
    if (!this.workerPromise) {
      this.progressHandler = onProgress ?? null;
      this.workerPromise = import('tesseract.js').then(async ({ createWorker }) => {
        const worker = await createWorker('eng', 1, {
          logger: (message: { status?: string; progress?: number }) => {
            this.progressHandler?.({
              status: message.status ?? 'working',
              progress: typeof message.progress === 'number' ? message.progress : 0,
            });
          },
        });
        if (this.disposed) {
          try {
            await worker.terminate();
          } catch {
            // Ignore teardown failures.
          }
          throw new Error('OCR session was disposed while starting.');
        }
        this.worker = worker;
        return worker;
      });
    }
    return this.workerPromise;
  }

  async recognizeCanvas(
    canvas: HTMLCanvasElement,
    onProgress?: (progress: OcrProgress) => void
  ): Promise<string> {
    this.progressHandler = onProgress ?? null;
    const worker = await this.getWorker(onProgress);
    const result = await worker.recognize(canvas);
    return result.data.text ?? '';
  }

  /**
   * Render one PDF page at a modest resolution and OCR it. The resolution is
   * capped so OCR stays "light": text in books is still large enough at ~1600px
   * wide, while memory and CPU remain predictable on phones.
   */
  async recognizePage(
    page: PDFPageProxy,
    pageNumber: number,
    onProgress?: (progress: OcrProgress) => void
  ): Promise<TextSegment[]> {
    const baseViewport = page.getViewport({ scale: 1 });
    const targetWidth = 1600;
    const maxPixels = 4_000_000;
    let scale = Math.min(2, targetWidth / Math.max(1, baseViewport.width));
    const area = baseViewport.width * scale * baseViewport.height * scale;
    if (area > maxPixels) {
      scale *= Math.sqrt(maxPixels / area);
    }

    const viewport = page.getViewport({ scale });
    const canvas = makeCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Could not create an OCR canvas context.');

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, canvas }).promise;

    const text = await this.recognizeCanvas(canvas, onProgress);
    return normalizeRawText(text, pageNumber);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.progressHandler = null;
    const worker = this.worker;
    this.worker = null;
    this.workerPromise = null;
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        // Ignore teardown failures.
      }
    }
  }
}
