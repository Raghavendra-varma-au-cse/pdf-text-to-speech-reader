'use client';

import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import 'pdfjs-dist/web/pdf_viewer.css';
import { normalizeText } from '../lib/text-normalizer';
import { resolveHoverAction } from '../lib/segment-hover';
import { useAudioStore } from '../store/use-audio-store';
import {
  computeFitScale,
  capRenderDpr,
  getRenderedPageBudget,
  getLoadConcurrency,
} from '../lib/pdf-viewer-utils';
import { runOrderedPool } from '../lib/pdf-page-scheduler';
import { debugLog, debugTime, setDebugStats } from '../lib/debug';
import { OcrSession, looksLikeScannedPage } from '../lib/ocr';
import { updateHistoryPageCount } from '../lib/document-history';
import type { TextSegment } from '../types';

// Set worker src dynamically with support for GitHub Pages subpaths.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
pdfjsLib.GlobalWorkerOptions.workerSrc = `${basePath}/pdf.worker.min.mjs`;

interface PdfViewerProps {
  file: File | null;
}

type LoadPhase = 'idle' | 'reading' | 'extracting' | 'ready' | 'error';

interface PdfProgress {
  phase: LoadPhase;
  totalPages: number;
  textReady: number;
  rendered: number;
  textComplete: boolean;
  hasText: boolean;
  scannedPages: number;
  error: string | null;
}

interface OcrProgress {
  running: boolean;
  page: number;
  total: number;
  status: string;
  progress: number;
  error: string | null;
}

type PdfTextContent = Awaited<ReturnType<pdfjsLib.PDFPageProxy['getTextContent']>>;

interface PageRecord {
  number: number;
  element: HTMLDivElement;
  unscaledWidth: number;
  unscaledHeight: number;
  state: 'placeholder' | 'rendering' | 'rendered';
  segments: TextSegment[] | null;
  textContent: PdfTextContent | null;
  textLayer: pdfjsLib.TextLayer | null;
  textLayerDiv: HTMLDivElement | null;
  renderTask: pdfjsLib.RenderTask | null;
  renderToken: number;
}

const EMPTY_PROGRESS: PdfProgress = {
  phase: 'idle',
  totalPages: 0,
  textReady: 0,
  rendered: 0,
  textComplete: false,
  hasText: false,
  scannedPages: 0,
  error: null,
};

function createPlaceholder(pageNumber: number): HTMLDivElement {
  const placeholder = document.createElement('div');
  placeholder.className = 'pdf-page-placeholder';
  placeholder.setAttribute('aria-hidden', 'true');
  placeholder.textContent = String(pageNumber);
  return placeholder;
}

function isCancelledRender(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name;
  const message = (error as { message?: string }).message ?? '';
  return name === 'RenderingCancelledException' || name === 'AbortException' || /cancel/i.test(message);
}

export const PdfViewer = ({ file }: PdfViewerProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const recordsRef = useRef<Map<number, PageRecord>>(new Map());
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const scaleRef = useRef(1.5);
  const renderEpochRef = useRef(0);
  const currentPageRef = useRef(1);
  const pendingScrollRef = useRef<{
    index: number;
    pageNumber: number;
    behavior: ScrollBehavior;
  } | null>(null);
  const lastScrolledIndexRef = useRef(-1);

  const rebuildRef = useRef<(newScale: number) => void>(() => {});
  const ensurePageRef = useRef<(pageNumber: number) => void>(() => {});
  const scrollToSegmentRef = useRef<(index: number, behavior: ScrollBehavior) => void>(() => {});
  const startOcrRef = useRef<() => void>(() => {});

  const [pdfDocument, setPdfDocument] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [progress, setProgress] = useState<PdfProgress>(EMPTY_PROGRESS);
  const [ocr, setOcr] = useState<OcrProgress>({
    running: false,
    page: 0,
    total: 0,
    status: '',
    progress: 0,
    error: null,
  });

  // Store state
  const scale = useAudioStore((state) => state.scale);
  const isFitToWidth = useAudioStore((state) => state.isFitToWidth);
  const autoScroll = useAudioStore((state) => state.autoScroll);
  const setTotalPages = useAudioStore((state) => state.setTotalPages);
  const setCurrentPage = useAudioStore((state) => state.setCurrentPage);
  const playSegment = useAudioStore((state) => state.playSegment);
  const currentSegmentIndex = useAudioStore((state) => state.currentSegmentIndex);
  const storeSegments = useAudioStore((state) => state.segments);
  const playbackStatus = useAudioStore((state) => state.playbackStatus);

  /**
   * Main document effect. Everything that owns DOM nodes is created here and
   * torn down by the returned cleanup, so changing files cannot leak a worker,
   * an observer, a render task or a canvas.
   */
  useEffect(() => {
    if (!file) {
      recordsRef.current.clear();
      recordsRef.current = new Map();
      pdfRef.current = null;
      setPdfDocument(null);
      setProgress(EMPTY_PROGRESS);
      setOcr({ running: false, page: 0, total: 0, status: '', progress: 0, error: null });
      useAudioStore.getState().setSegmentsComplete(true);
      if (containerRef.current) containerRef.current.innerHTML = '';
      return;
    }

    let cancelled = false;
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
    let pdf: pdfjsLib.PDFDocumentProxy | null = null;
    let renderObserver: IntersectionObserver | null = null;
    let pageObserver: IntersectionObserver | null = null;
    let ocrSession: OcrSession | null = null;
    let ocrRunning = false;
    const textAbort = new AbortController();

    const records = new Map<number, PageRecord>();
    recordsRef.current = records;
    currentPageRef.current = 1;
    pendingScrollRef.current = null;
    lastScrolledIndexRef.current = -1;
    useAudioStore.getState().setSegmentsComplete(false);

    const pageOffsets = new Map<number, number>();
    const pageSegments = new Map<number, TextSegment[]>();
    const renderQueue: number[] = [];
    const queuedPages = new Set<number>();
    let activeRenders = 0;
    let renderedCount = 0;
    let textReady = 0;
    let scannedPages = 0;
    let textComplete = false;
    let hasText = false;
    let progressRaf = 0;
    let defaultUnscaledWidth = 612;
    let defaultUnscaledHeight = 792;

    const concurrency = getLoadConcurrency();
    let pageBudget = 8;

    scaleRef.current = useAudioStore.getState().scale;

    const reportProgress = () => {
      if (progressRaf) return;
      progressRaf = window.requestAnimationFrame(() => {
        progressRaf = 0;
        if (cancelled) return;
        setProgress({
          phase: textComplete ? 'ready' : textReady > 0 || pdf ? 'extracting' : 'reading',
          totalPages: pdf?.numPages ?? 0,
          textReady,
          rendered: renderedCount,
          textComplete,
          hasText,
          scannedPages,
          error: null,
        });
        setDebugStats({
          pdf: {
            phase: textComplete ? 'ready' : 'extracting',
            totalPages: pdf?.numPages ?? 0,
            textReady,
            renderedPages: renderedCount,
            textConcurrency: concurrency.text,
            renderConcurrency: concurrency.render,
            ocrPages: scannedPages,
          },
        });
      });
    };

    const applyHighlight = () => {
      const root = containerRef.current;
      if (!root) return;
      root.querySelectorAll('nr-sentence.playing').forEach((element) => element.classList.remove('playing'));
      const { currentSegmentIndex: index, playbackStatus: status } = useAudioStore.getState();
      if (status === 'idle') return;
      root.querySelectorAll(`.nr-s${index}`).forEach((element) => element.classList.add('playing'));
    };

    /** Wrap sentence fragments inside the spans produced by PDF.js. */
    const tagPage = (record: PageRecord) => {
      const { textContent, textLayer, segments } = record;
      if (!textContent || !textLayer || !segments) return;

      const offset = pageOffsets.get(record.number);
      if (offset === undefined) return;

      const spanToFragments = new Map<string, { index: number; text: string }[]>();
      segments.forEach((segment, localIndex) => {
        const globalIndex = offset + localIndex;
        (segment.spanFragments ?? []).forEach((fragment) => {
          const bucket = spanToFragments.get(fragment.spanId) ?? [];
          bucket.push({ index: globalIndex, text: fragment.text });
          spanToFragments.set(fragment.spanId, bucket);
        });
      });

      const divs = textLayer.textDivs;
      const items = textContent.items as Array<{ str?: string } | null>;

      for (let i = 0; i < divs.length; i++) {
        const span = divs[i] as HTMLElement | undefined;
        const item = items[i];
        if (!span || !item || typeof item.str !== 'string' || item.str.length === 0) continue;
        if (!span.parentNode) continue; // empty text runs are not appended to the DOM

        const spanId = `page-${record.number}-span-${i}`;
        span.id = spanId;
        span.classList.add('segment-span', 'pdf-span');

        const fragments = spanToFragments.get(spanId);
        if (!fragments || fragments.length === 0) continue;

        span.textContent = '';
        fragments.forEach((fragment) => {
          if (fragment.text.trim().length === 0) {
            span.appendChild(document.createTextNode(fragment.text));
            return;
          }

          const sentenceWrapper = document.createElement('nr-sentence');
          sentenceWrapper.className = `nr-sentence nr-s${fragment.index} pdf-nr-sentence`;
          sentenceWrapper.dataset.naSenInd = String(fragment.index);
          sentenceWrapper.dataset.naPageInd = String(record.number);
          sentenceWrapper.textContent = fragment.text;
          span.appendChild(sentenceWrapper);
        });
      }
    };

    const tagEveryRenderedPage = () => {
      records.forEach((record) => {
        if (record.state === 'rendered') tagPage(record);
      });
      applyHighlight();
    };

    const setRecordSize = (record: PageRecord, newScale: number) => {
      record.element.style.width = `${Math.round(record.unscaledWidth * newScale)}px`;
      record.element.style.height = `${Math.round(record.unscaledHeight * newScale)}px`;
    };

    const resetRecord = (record: PageRecord) => {
      try { record.renderTask?.cancel(); } catch { }
      try { record.textLayer?.cancel(); } catch { }
      record.renderTask = null;
      record.textLayer = null;
      record.textContent = null;
      record.textLayerDiv = null;
      record.renderToken++;
      record.state = 'placeholder';
      record.element.classList.remove('is-rendering');
      record.element.replaceChildren(createPlaceholder(record.number));
      setRecordSize(record, scaleRef.current);
      if (renderedCount > 0) renderedCount--;
    };

    const evictRecord = (record: PageRecord) => {
      resetRecord(record);
      // Let PDF.js release fonts/operator lists for pages far from the view.
      pdf?.getPage(record.number).then((page) => page.cleanup()).catch(() => {});
    };

    const evictIfNeeded = (activePage?: number) => {
      const rendered = [...records.values()].filter((record) => record.state === 'rendered');
      if (rendered.length <= pageBudget) return;

      const state = useAudioStore.getState();
      const activeSegmentPage = state.segments[state.currentSegmentIndex]?.pageNumber;
      const protectedPages = new Set<number>([
        currentPageRef.current - 1,
        currentPageRef.current,
        currentPageRef.current + 1,
      ]);
      if (activeSegmentPage) {
        protectedPages.add(activeSegmentPage - 1);
        protectedPages.add(activeSegmentPage);
        protectedPages.add(activeSegmentPage + 1);
      }

      const anchor = activePage ?? currentPageRef.current;
      if (activePage !== undefined) protectedPages.add(activePage);
      const victims = rendered
        .filter((record) => !protectedPages.has(record.number))
        .sort((a, b) => Math.abs(b.number - anchor) - Math.abs(a.number - anchor));

      let live = rendered.length;
      for (const victim of victims) {
        if (live <= pageBudget) break;
        evictRecord(victim);
        live--;
      }
    };

    const pumpRenderQueue = () => {
      if (cancelled) return;
      renderQueue.sort(
        (a, b) => Math.abs(a - currentPageRef.current) - Math.abs(b - currentPageRef.current)
      );

      while (activeRenders < concurrency.render && renderQueue.length > 0) {
        const pageNumber = renderQueue.shift() as number;
        queuedPages.delete(pageNumber);
        const record = records.get(pageNumber);
        if (!record || record.state !== 'placeholder') continue;
        void renderPage(record);
      }
    };

    const enqueuePage = (pageNumber: number) => {
      const record = records.get(pageNumber);
      if (!record || record.state !== 'placeholder' || queuedPages.has(pageNumber)) return;
      queuedPages.add(pageNumber);
      renderQueue.push(pageNumber);
      pumpRenderQueue();
    };

    const scrollToSegment = (index: number, behavior: ScrollBehavior) => {
      const segment = useAudioStore.getState().segments[index];
      if (!segment) return;

      const record = records.get(segment.pageNumber);
      if (record && record.state === 'rendered') {
        const target =
          (record.element.querySelector(`.nr-s${index}`) as HTMLElement | null) ?? record.element;
        target.scrollIntoView({ behavior, block: 'center', inline: 'nearest' });
      } else {
        pendingScrollRef.current = {
          index,
          pageNumber: segment.pageNumber,
          behavior: 'auto',
        };
        record?.element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
        enqueuePage(segment.pageNumber);
      }
    };

    const maybeScrollPending = (record: PageRecord) => {
      const pending = pendingScrollRef.current;
      if (!pending || pending.pageNumber !== record.number) return;
      pendingScrollRef.current = null;
      const target =
        (record.element.querySelector(`.nr-s${pending.index}`) as HTMLElement | null) ?? record.element;
      target.scrollIntoView({ behavior: pending.behavior, block: 'center', inline: 'nearest' });
    };

    const renderPage = async (record: PageRecord) => {
      const pdfDoc = pdfRef.current;
      if (!pdfDoc) return;

      const epoch = renderEpochRef.current;
      const token = ++record.renderToken;
      record.state = 'rendering';
      record.element.classList.add('is-rendering');
      activeRenders++;

      try {
        const page = await pdfDoc.getPage(record.number);
        if (cancelled || epoch !== renderEpochRef.current) return;

        const viewport = page.getViewport({ scale: scaleRef.current });
        record.unscaledWidth = viewport.width / viewport.scale;
        record.unscaledHeight = viewport.height / viewport.scale;
        setRecordSize(record, viewport.scale);

        const dpr = capRenderDpr(viewport.width, viewport.height, window.devicePixelRatio || 1);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        canvas.className = 'pdf-canvas block';

        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Canvas 2D context is unavailable.');
        context.setTransform(dpr, 0, 0, dpr, 0, 0);

        const renderTask = page.render({
          canvasContext: context,
          viewport,
          canvas,
        });
        record.renderTask = renderTask;
        await renderTask.promise;

        if (cancelled || epoch !== renderEpochRef.current || token !== record.renderToken) return;

        const textContent = await page.getTextContent({ disableNormalization: true });
        if (cancelled || epoch !== renderEpochRef.current || token !== record.renderToken) return;

        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'textLayer pdf-textLayer';
        textLayerDiv.style.width = `${viewport.width}px`;
        textLayerDiv.style.height = `${viewport.height}px`;
        // PDF.js lays out span font sizes with this custom property. Without it
        // the browser discards the calc() value and the text layer misaligns.
        textLayerDiv.style.setProperty('--total-scale-factor', String(viewport.scale));

        const textLayer = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport,
        });
        record.textLayer = textLayer;
        record.textContent = textContent;
        record.textLayerDiv = textLayerDiv;

        await textLayer.render();
        if (cancelled || epoch !== renderEpochRef.current || token !== record.renderToken) return;

        // setLayerDimensions writes calc(var(--total-scale-factor) * ...), but we
        // want exact CSS pixels for the layer container.
        textLayerDiv.style.width = `${viewport.width}px`;
        textLayerDiv.style.height = `${viewport.height}px`;

        tagPage(record);

        record.element.replaceChildren(canvas, textLayerDiv);
        record.element.classList.remove('is-rendering');
        record.element.style.width = `${viewport.width}px`;
        record.element.style.height = `${viewport.height}px`;
        record.state = 'rendered';

        renderedCount++;
        applyHighlight();
        maybeScrollPending(record);
        reportProgress();
        evictIfNeeded(record.number);
      } catch (error) {
        if (!isCancelledRender(error) && epoch === renderEpochRef.current) {
          debugLog('pdf', `Page ${record.number} failed to render`, error);
        }
        if (epoch === renderEpochRef.current) {
          record.state = 'placeholder';
          record.element.classList.remove('is-rendering');
        }
      } finally {
        record.renderTask = null;
        if (epoch === renderEpochRef.current) {
          activeRenders = Math.max(0, activeRenders - 1);
          pumpRenderQueue();
        }
      }
    };

    /**
     * Rebuild every page bitmap after a zoom change. Only pages near the
     * viewport are actually re-rendered; the rest stay as cheap placeholders.
     */
    const rebuildForScale = (newScale: number) => {
      if (!pdfRef.current || records.size === 0) return;
      if (Math.abs(newScale - scaleRef.current) < 0.001) return;

      renderEpochRef.current++;
      renderQueue.length = 0;
      queuedPages.clear();
      activeRenders = 0;
      renderedCount = 0;
      scaleRef.current = newScale;

      records.forEach((record) => {
        try { record.renderTask?.cancel(); } catch { }
        try { record.textLayer?.cancel(); } catch { }
        record.renderTask = null;
        record.textLayer = null;
        record.textContent = null;
        record.textLayerDiv = null;
        record.renderToken++;
        record.state = 'placeholder';
        record.element.classList.remove('is-rendering');
        record.element.replaceChildren(createPlaceholder(record.number));
        setRecordSize(record, newScale);
      });

      const pdfDoc = pdfRef.current;
      if (pdfDoc) {
        const page1 = records.get(1);
        if (page1) {
          page1.unscaledWidth ||= defaultUnscaledWidth;
        }
      }

      renderObserver?.disconnect();
      pageObserver?.disconnect();
      if (renderObserver) records.forEach((record) => renderObserver?.observe(record.element));
      if (pageObserver) records.forEach((record) => pageObserver?.observe(record.element));
      reportProgress();
    };

    rebuildRef.current = rebuildForScale;
    ensurePageRef.current = enqueuePage;
    scrollToSegmentRef.current = scrollToSegment;

    const destroyDocument = () => {
      cancelled = true;
      textAbort.abort();
      if (progressRaf) window.cancelAnimationFrame(progressRaf);
      renderObserver?.disconnect();
      pageObserver?.disconnect();
      records.forEach((record) => {
        try { record.renderTask?.cancel(); } catch { }
        try { record.textLayer?.cancel(); } catch { }
      });
      records.clear();
      recordsRef.current = new Map();
      if (containerRef.current) containerRef.current.innerHTML = '';
      pdfRef.current = null;
      void ocrSession?.dispose();
      ocrSession = null;
      setOcr({ running: false, page: 0, total: 0, status: '', progress: 0, error: null });
      if (loadingTask) {
        void loadingTask.destroy().catch(() => {});
      } else if (pdf) {
        void pdf.destroy().catch(() => {});
      }
      setPdfDocument(null);
    };

    const startExtraction = async (pdfDoc: pdfjsLib.PDFDocumentProxy) => {
      const pending = new Map<number, TextSegment[]>();
      let nextToAppend = 1;
      let firstTextSegmentBatch = true;
      const firstTextTimer = debugTime('pdf', 'first page text');

      const appendReady = () => {
        if (cancelled || textAbort.signal.aborted) return;
        while (pending.has(nextToAppend)) {
          const segments = pending.get(nextToAppend) as TextSegment[];
          pending.delete(nextToAppend);

          const offset = useAudioStore.getState().segments.length;
          pageOffsets.set(nextToAppend, offset);
          pageSegments.set(nextToAppend, segments);

          const record = records.get(nextToAppend);
          if (record) {
            record.segments = segments;
            if (record.state === 'rendered') tagPage(record);
          }

          if (firstTextSegmentBatch) {
            useAudioStore.getState().loadSegments(segments);
            firstTextSegmentBatch = false;
            firstTextTimer({ page: nextToAppend, segments: segments.length });
          } else if (segments.length > 0) {
            useAudioStore.getState().appendSegments(segments);
          }

          if (segments.length > 0) hasText = true;
          if (looksLikeScannedPage(segments)) scannedPages++;
          textReady++;
          nextToAppend++;
          reportProgress();
        }
      };

      const worker = async (pageNumber: number) => {
        if (cancelled || textAbort.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        const page = await pdfDoc.getPage(pageNumber);
        const textContent = await page.getTextContent({ disableNormalization: true });
        const segments = normalizeText(textContent.items, pageNumber);

        const record = records.get(pageNumber);
        if (record) {
          const viewport = page.getViewport({ scale: 1 });
          record.unscaledWidth = viewport.width;
          record.unscaledHeight = viewport.height;
          if (record.state === 'placeholder') setRecordSize(record, scaleRef.current);
        }

        return segments;
      };

      try {
        await runOrderedPool({
          total: pdfDoc.numPages,
          concurrency: concurrency.text,
          worker,
          signal: textAbort.signal,
          onResult: (index, segments) => {
            if (cancelled || textAbort.signal.aborted) return;
            pending.set(index, segments);
            appendReady();
          },
        });
        textComplete = true;
        useAudioStore.getState().setSegmentsComplete(true);
        reportProgress();
        debugLog('pdf', 'text extraction complete', {
          pages: pdfDoc.numPages,
          textReady,
          scannedPages,
        });
      } catch (error) {
        if (!cancelled) {
          debugLog('pdf', 'text extraction failed', error);
          useAudioStore.getState().setSegmentsComplete(true);
          setProgress((previous) => ({
            ...previous,
            phase: 'error',
            error: error instanceof Error ? error.message : 'Could not read text from this PDF.',
          }));
        }
      }
    };

    const rebuildSegmentsFromPages = () => {
      const all: TextSegment[] = [];
      pageOffsets.clear();
      for (let pageNumber = 1; pageNumber <= (pdf?.numPages ?? 0); pageNumber++) {
        const segments = pageSegments.get(pageNumber);
        if (!segments || segments.length === 0) continue;
        pageOffsets.set(pageNumber, all.length);
        all.push(...segments);
      }
      hasText = all.length > 0;
      useAudioStore.getState().replaceSegmentsPreservingCurrent(all);
      tagEveryRenderedPage();
      records.forEach((record) => {
        const segments = pageSegments.get(record.number);
        if (segments) record.segments = segments;
      });
      reportProgress();
    };

    const startOcr = async () => {
      if (ocrRunning || !pdf) return;
      ocrRunning = true;
      const pdfDoc = pdf;
      setOcr({ running: true, page: 0, total: pdfDoc.numPages, status: 'Starting OCR…', progress: 0, error: null });
      const session = new OcrSession();
      ocrSession = session;

      try {
        for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber++) {
          if (cancelled) break;

          const existing = pageSegments.get(pageNumber);
          if (existing && !looksLikeScannedPage(existing)) continue;

          setOcr((previous) => ({
            ...previous,
            page: pageNumber,
            status: `Recognizing page ${pageNumber}`,
            progress: 0,
          }));

          const page = await pdfDoc.getPage(pageNumber);
          const segments = await session.recognizePage(page, pageNumber, (update) => {
            setOcr((previous) => ({
              ...previous,
              status: update.status || previous.status,
              progress: update.progress ?? previous.progress,
            }));
          });

          if (cancelled) break;
          pageSegments.set(pageNumber, segments);
          rebuildSegmentsFromPages();
        }

        if (!cancelled) {
          textComplete = true;
          textReady = pdfDoc.numPages;
          useAudioStore.getState().setSegmentsComplete(true);
          setOcr((previous) => ({
            ...previous,
            running: false,
            status: hasText ? 'OCR complete' : 'No text was recognized',
            progress: 1,
          }));
          reportProgress();
        }
      } catch (error) {
        if (!cancelled) {
          debugLog('ocr', 'OCR failed', error);
          setOcr((previous) => ({
            ...previous,
            running: false,
            error: error instanceof Error ? error.message : 'OCR failed.',
          }));
        }
      } finally {
        ocrRunning = false;
        const session = ocrSession;
        ocrSession = null;
        void session?.dispose();
      }
    };

    startOcrRef.current = () => {
      void startOcr();
    };

    const boot = async () => {
      setProgress({ ...EMPTY_PROGRESS, phase: 'reading' });
      setDebugStats({ pdf: { phase: 'reading' } });

      try {
        const fileTimer = debugTime('pdf', 'read file bytes');
        const buffer = await file.arrayBuffer();
        fileTimer({ bytes: buffer.byteLength });
        if (cancelled) return;

        loadingTask = pdfjsLib.getDocument({
          data: new Uint8Array(buffer),
        });

        const docTimer = debugTime('pdf', 'open document');
        const loadedPdf = await loadingTask.promise;
        if (cancelled) {
          void loadedPdf.destroy();
          return;
        }
        pdf = loadedPdf;
        pdfRef.current = loadedPdf;
        setPdfDocument(loadedPdf);
        setTotalPages(loadedPdf.numPages);
        pageBudget = getRenderedPageBudget(loadedPdf.numPages);
        docTimer({ pages: loadedPdf.numPages });
        void updateHistoryPageCount(file, loadedPdf.numPages);

        const firstPage = await loadedPdf.getPage(1);
        const firstViewport = firstPage.getViewport({ scale: 1 });
        defaultUnscaledWidth = firstViewport.width;
        defaultUnscaledHeight = firstViewport.height;
        if (cancelled) return;

        const store = useAudioStore.getState();
        const availableWidth = containerRef.current?.clientWidth || window.innerWidth - 32;
        let initialScale = store.scale;

        if (store.isFitToWidth) {
          initialScale = computeFitScale(availableWidth, defaultUnscaledWidth);
          store.applyScale(initialScale);
        } else if (window.innerWidth < 768) {
          initialScale = computeFitScale(availableWidth, defaultUnscaledWidth);
          store.setScale(initialScale);
        }
        scaleRef.current = initialScale;

        const container = containerRef.current;
        if (!container) return;
        container.innerHTML = '';
        const wrapper = document.createElement('div');
        wrapper.className = 'pdf-pages w-max min-w-full flex flex-col items-center px-1';
        container.appendChild(wrapper);

        for (let pageNumber = 1; pageNumber <= loadedPdf.numPages; pageNumber++) {
          const element = document.createElement('div');
          element.id = `pdf-page-${pageNumber}`;
          element.dataset.pageNumber = String(pageNumber);
          element.className =
            'pdf-page relative mb-6 shadow-[0_4px_20px_rgba(0,0,0,0.1)] bg-white rounded-xl overflow-hidden shrink-0';
          element.style.width = `${Math.round(defaultUnscaledWidth * initialScale)}px`;
          element.style.height = `${Math.round(defaultUnscaledHeight * initialScale)}px`;
          element.appendChild(createPlaceholder(pageNumber));

          wrapper.appendChild(element);
          records.set(pageNumber, {
            number: pageNumber,
            element,
            unscaledWidth: defaultUnscaledWidth,
            unscaledHeight: defaultUnscaledHeight,
            state: 'placeholder',
            segments: null,
            textContent: null,
            textLayer: null,
            textLayerDiv: null,
            renderTask: null,
            renderToken: 0,
          });
        }

        renderObserver = new IntersectionObserver(
          (entries) => {
            entries.forEach((entry) => {
              if (entry.isIntersecting) {
                enqueuePage(Number((entry.target as HTMLElement).dataset.pageNumber));
              }
            });
          },
          { root: null, rootMargin: '700px 0px 900px 0px', threshold: 0.01 }
        );

        pageObserver = new IntersectionObserver(
          (entries) => {
            let best: { page: number; ratio: number } | null = null;
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const page = Number((entry.target as HTMLElement).dataset.pageNumber);
              if (!best || entry.intersectionRatio > best.ratio) {
                best = { page, ratio: entry.intersectionRatio };
              }
            }
            if (best !== null) {
              const nextBest = best as { page: number; ratio: number };
              if (nextBest.page !== currentPageRef.current) {
                currentPageRef.current = nextBest.page;
                setCurrentPage(nextBest.page);
              }
            }
          },
          { threshold: [0.05, 0.2, 0.45, 0.7] }
        );

        records.forEach((record) => {
          renderObserver?.observe(record.element);
          pageObserver?.observe(record.element);
        });

        reportProgress();
        debugLog('pdf', 'viewer ready', { pages: loadedPdf.numPages, scale: initialScale });

        // Start OCR later only if the user asks; text extraction runs now.
        void startExtraction(loadedPdf);
      } catch (error) {
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : 'This PDF could not be opened.';
        debugLog('pdf', 'document load failed', error);
        setProgress({
          ...EMPTY_PROGRESS,
          phase: 'error',
          error: message,
        });
        setDebugStats({ pdf: { phase: 'error', error: message } });
      }
    };

    void boot();

    return destroyDocument;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // React to zoom changes without reloading or re-parsing the PDF.
  useEffect(() => {
    rebuildRef.current(scale);
  }, [scale]);

  // Fit-to-width keeps tracking the container size.
  useEffect(() => {
    if (!isFitToWidth || !pdfDocument) return;
    const container = containerRef.current;
    if (!container) return;

    let raf = 0;
    const recompute = () => {
      if (raf) window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        const record = recordsRef.current.get(1);
        const pageWidth = record?.unscaledWidth || 612;
        const available = container.clientWidth || window.innerWidth - 32;
        const fit = computeFitScale(available, pageWidth);
        if (Math.abs(useAudioStore.getState().scale - fit) > 0.01) {
          useAudioStore.getState().applyScale(fit);
        }
      });
    };

    recompute();
    const resizeObserver = new ResizeObserver(recompute);
    resizeObserver.observe(container);
    window.addEventListener('resize', recompute);

    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      window.removeEventListener('resize', recompute);
    };
  }, [isFitToWidth, pdfDocument]);

  // Hover and click delegation. Scoped to the viewer instead of the document so
  // pointer moves elsewhere in the app do not run PDF queries.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let hoveredSegmentIndex: string | null = null;

    const setHoveredSegment = (index: string | null) => {
      container.querySelectorAll('nr-sentence.hovered').forEach((element) => element.classList.remove('hovered'));
      if (index === null) {
        hoveredSegmentIndex = null;
        return;
      }
      container.querySelectorAll(`.nr-s${index}`).forEach((element) => element.classList.add('hovered'));
      hoveredSegmentIndex = index;
    };

    const handlePointerOver = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const sentence = target.closest('nr-sentence');
      const foundIndex = sentence?.getAttribute('data-na-sen-ind') || null;
      const action = resolveHoverAction(foundIndex, hoveredSegmentIndex);
      if (action.type === 'clear') setHoveredSegment(null);
      else if (action.type === 'switch') setHoveredSegment(action.index);
    };

    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const sentence = target.closest('nr-sentence');
      if (!sentence) return;
      const segmentIndex = parseInt(sentence.getAttribute('data-na-sen-ind') || '-1', 10);
      if (segmentIndex >= 0) void playSegment(segmentIndex, { stopAfter: event.shiftKey });
    };

    const handlePointerOut = (event: PointerEvent) => {
      if (!container.contains(event.relatedTarget as Node)) setHoveredSegment(null);
    };

    container.addEventListener('pointerover', handlePointerOver);
    container.addEventListener('click', handleClick);
    container.addEventListener('pointerout', handlePointerOut);

    return () => {
      container.removeEventListener('pointerover', handlePointerOver);
      container.removeEventListener('click', handleClick);
      container.removeEventListener('pointerout', handlePointerOut);
    };
  }, [playSegment]);

  // Picking text anywhere in a sentence offers a "From selection" action in the
  // player bar without auto-starting playback.
  const setSelectionSegmentIndex = useAudioStore((state) => state.setSelectionSegmentIndex);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frame = 0;
    const handleSelectionChange = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const selection = document.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
          setSelectionSegmentIndex(null);
          return;
        }

        const anchor = selection.getRangeAt(0).startContainer;
        const element =
          anchor.nodeType === Node.ELEMENT_NODE
            ? (anchor as HTMLElement)
            : anchor.parentElement;
        if (!element || !container.contains(element)) {
          setSelectionSegmentIndex(null);
          return;
        }

        const sentence = element.closest('nr-sentence');
        const index = sentence
          ? parseInt(sentence.getAttribute('data-na-sen-ind') || '-1', 10)
          : -1;
        setSelectionSegmentIndex(index >= 0 ? index : null);
      });
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [setSelectionSegmentIndex]);

  // Follow the spoken sentence, and highlight pages that render later.
  useEffect(() => {
    const root = containerRef.current;
    if (root) {
      root.querySelectorAll('nr-sentence.playing').forEach((element) => element.classList.remove('playing'));
      if (playbackStatus !== 'idle') {
        root.querySelectorAll(`.nr-s${currentSegmentIndex}`).forEach((element) => element.classList.add('playing'));
      }
    }

    if (playbackStatus === 'idle' || !autoScroll) return;
    if (lastScrolledIndexRef.current === currentSegmentIndex) return;
    lastScrolledIndexRef.current = currentSegmentIndex;
    scrollToSegmentRef.current(currentSegmentIndex, 'smooth');
  }, [currentSegmentIndex, storeSegments.length, playbackStatus, autoScroll]);

  // Leaving the document resets the follow anchor.
  useEffect(() => {
    if (!file) lastScrolledIndexRef.current = -1;
  }, [file]);

  const showLoading = progress.phase === 'reading' || (progress.phase === 'extracting' && !progress.textComplete);
  const showScannedNotice =
    progress.textComplete && !progress.hasText && !ocr.running && ocr.page === 0 && progress.totalPages > 0;
  const showPartialScannedNotice =
    progress.textComplete && progress.hasText && progress.scannedPages > 0 && !ocr.running && ocr.page === 0;

  return (
    <div className="w-full relative">
      {(showLoading || ocr.running || progress.error) && (
        <div className="sticky top-[68px] z-30 flex justify-center px-2 pointer-events-none">
          <div
            role="status"
            className="pointer-events-auto flex max-w-[calc(100vw-2rem)] items-center gap-2.5 rounded-full border border-navbar-border bg-navbar/95 px-3.5 py-2 text-xs font-medium text-muted shadow-md backdrop-blur-md"
          >
            {progress.error ? (
              <span role="alert" className="text-error">{progress.error}</span>
            ) : (
              <>
                <span className="w-4 h-4 shrink-0 rounded-full border-2 border-primary/25 border-t-primary animate-spin" />
                <span className="truncate">
                  {ocr.running
                    ? `${ocr.status}${ocr.page ? ` (${ocr.page}/${ocr.total})` : ''}`
                    : progress.phase === 'reading'
                      ? 'Opening PDF…'
                      : progress.textReady === 0
                        ? 'Reading text from the PDF…'
                        : `Text ready ${progress.textReady}/${progress.totalPages} · pages render on demand`}
                </span>
                {progress.textReady > 0 && (
                  <span className="hidden sm:inline text-primary font-semibold shrink-0">
                    You can listen now
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {ocr.error && !ocr.running && (
        <div role="alert" className="mx-auto mb-4 max-w-2xl rounded-xl border border-error/40 bg-error/10 p-3 text-sm text-error">
          OCR failed: {ocr.error}
          <button
            type="button"
            onClick={() => startOcrRef.current()}
            className="ml-2 font-semibold underline"
          >
            Retry
          </button>
        </div>
      )}

      {showScannedNotice && (
        <div className="mx-auto mb-4 max-w-2xl rounded-2xl border border-warning/40 bg-warning/10 p-4 text-sm text-foreground">
          <p className="font-semibold">This PDF looks like a scanned book.</p>
          <p className="mt-1 text-muted">
            No selectable text was found. Run lightweight, on-device OCR to read it aloud.
            The English language model downloads once on first use.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => startOcrRef.current()}
              className="px-3 py-2 rounded-lg bg-primary text-white text-sm font-semibold hover:bg-primary-hover transition-colors"
            >
              Run OCR
            </button>
          </div>
          {ocr.error && <p role="alert" className="mt-2 text-error">{ocr.error}</p>}
        </div>
      )}

      {showPartialScannedNotice && (
        <div className="mx-auto mb-4 max-w-2xl rounded-2xl border border-border bg-surface p-3 text-sm text-muted flex flex-wrap items-center gap-3">
          <span>{progress.scannedPages} page(s) have no selectable text.</span>
          <button
            type="button"
            onClick={() => startOcrRef.current()}
            className="px-3 py-1.5 rounded-lg bg-navbar-control border border-navbar-control-border text-xs font-semibold text-foreground hover:border-primary hover:text-primary transition-colors"
          >
            OCR scanned pages
          </button>
        </div>
      )}

      <div ref={containerRef} className="w-full overflow-x-auto" />
    </div>
  );
};
