import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { getPdfRenderBackend } from './appearance';
import { PdfViewport } from './pdfViewport';
import { openPdfiumDocument, queryPdfium, renderPdfium, type PdfRasterTask } from './pdfiumRaster';
import type { PdfiumPageInfo } from './pdfiumProtocol';
import { releasePdfRenderCache } from './pdfRenderCache';
/** Temporary compatibility boundary. Only remaining image operations open
 * PDF.js; native document/page/navigation/raster operations never need its worker. */
export async function loadPdfiumDocument(input: Uint8Array): Promise<PDFDocumentProxy> {
  let source: Uint8Array | undefined = input,
    closed = false;
  let legacy: Promise<PDFDocumentProxy> | undefined;
  let metadata: PdfiumPageInfo[] = [];
  const pages = new Map<number, Promise<PDFPageProxy>>();
  const alive = () => {
    if (closed) throw new Error('PDF document closed');
  };
  const fallback = () => {
    alive();
    const bytes = source!;
    return (legacy ??= import('./pdfLegacy').then(({ loadLegacyPdf }) => {
      alive();
      return loadLegacyPdf(bytes);
    }));
  };
  const document = {
    numPages: 0,
    tixtabBackend: 'pdfium',
    // Keep the custom metadata-only index until native image enumeration has
    // proven identical occurrence/mask ordering for saved OCR annotations.
    tixtabImageIndex: async (index: number) => {
      const legacyDocument = await fallback();
      const { getPdfImages } = await import('./pdfNight');
      return getPdfImages(legacyDocument, index);
    },
    getData: async () => {
      alive();
      return source!.slice();
    },
    getPage: async (number: number) => {
      alive();
      if (!Number.isInteger(number) || number < 1 || number > metadata.length)
        throw new Error('Invalid PDF page number');
      const previous = pages.get(number);
      if (previous) {
        pages.delete(number);
        pages.set(number, previous);
        return previous;
      }
      const info = metadata[number - 1];
      let legacyPage: PDFPageProxy | undefined;
      const compatibility = async () => (legacyPage ??= await (await fallback()).getPage(number));
      const page = {
        pageNumber: number,
        view: [...info.view],
        rotate: info.rotation,
        userUnit: info.userUnit,
        getViewport: (options: Parameters<PDFPageProxy['getViewport']>[0] = { scale: 1 }) =>
          new PdfViewport(info, options),
        getTextContent: async () => {
          alive();
          const reply = await queryPdfium(document, { type: 'text', page: number - 1 });
          if (reply.type !== 'text') throw new Error('PDF text unavailable');
          return reply.content;
        },
        getOperatorList: async () => (await compatibility()).getOperatorList(),
        getAnnotations: async () => {
          alive();
          const reply = await queryPdfium(document, { type: 'annotations', page: number - 1 });
          if (reply.type !== 'annotations') throw new Error('PDF links unavailable');
          return reply.items;
        },
        get objs() {
          if (!legacyPage) throw new Error('PDF image data not loaded');
          return legacyPage.objs;
        },
        get commonObjs() {
          if (!legacyPage) throw new Error('PDF font data not loaded');
          return legacyPage.commonObjs;
        },
        get recordedBBoxes() {
          return legacyPage?.recordedBBoxes ?? null;
        },
        set recordedBBoxes(value: unknown) {
          if (legacyPage) legacyPage.recordedBBoxes = value;
        },
        cleanup: () => legacyPage?.cleanup() ?? true,
        render: (options: Parameters<PDFPageProxy['render']>[0]): PdfRasterTask => {
          let inner: PdfRasterTask | undefined,
            cancelled = false;
          const task: PdfRasterTask = {
            promise: Promise.resolve(),
            cancel: () => {
              cancelled = true;
              inner?.cancel();
            },
          };
          task.promise = (async () => {
            alive();
            const canvas = options.canvas ?? options.canvasContext?.canvas;
            if (!canvas) throw new Error('PDF render canvas unavailable');
            const t = options.transform;
            if (
              getPdfRenderBackend() !== 'pdfium' ||
              (t && (t[0] !== 1 || t[1] !== 0 || t[2] !== 0 || t[3] !== 1 || t[4] > 0 || t[5] > 0))
            ) {
              inner = (await compatibility()).render(options);
            } else {
              inner = renderPdfium(
                document,
                number - 1,
                canvas,
                Math.ceil(options.viewport.width),
                Math.ceil(options.viewport.height),
                {
                  x: Math.round(-(t?.[4] ?? 0)),
                  y: Math.round(-(t?.[5] ?? 0)),
                  width: canvas.width,
                  height: canvas.height,
                },
              );
            }
            inner.onContinue = (resume: () => void) =>
              task.onContinue ? task.onContinue(resume) : resume();
            if (cancelled) inner.cancel();
            await inner.promise;
          })();
          return task;
        },
      } as unknown as PDFPageProxy;
      const ready = Promise.resolve(page);
      pages.set(number, ready);
      if (pages.size > 64) pages.delete(pages.keys().next().value!);
      return ready;
    },
    getOutline: async () => {
      alive();
      const reply = await queryPdfium(document, { type: 'outline' });
      if (reply.type !== 'outline') throw new Error('PDF outline unavailable');
      return reply.items;
    },
    getDestination: async (name: string) => {
      alive();
      const reply = await queryPdfium(document, { type: 'destination', name });
      if (reply.type !== 'destination') throw new Error('PDF destination unavailable');
      return reply.dest;
    },
    getPageIndex: async (ref: { num: number; gen: number }) => {
      alive();
      const index = metadata.findIndex((p) => p.objectNumber === ref.num);
      if (index < 0) throw new Error('PDF page reference unavailable');
      return index;
    },
    cleanup: async () => {
      if (legacy) await (await legacy).cleanup();
    },
    destroy: async () => {
      if (closed) return;
      closed = true;
      releasePdfRenderCache(document);
      pages.clear();
      metadata = [];
      source = undefined;
      if (legacy) {
        try {
          await (await legacy).destroy();
        } catch {}
      }
      legacy = undefined;
    },
  } as unknown as PDFDocumentProxy;
  try {
    metadata = await openPdfiumDocument(document, input);
    Object.defineProperty(document, 'numPages', { value: metadata.length, enumerable: true });
    return document;
  } catch (error) {
    await document.destroy();
    throw error;
  }
}
