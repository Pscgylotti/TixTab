import type { PDFDocumentProxy, PDFPageProxy } from './pdfTypes';
import { renderPdfiumPage } from './pdfiumPageRender';
import { PdfViewport } from './pdfViewport';
import { openPdfiumDocument, queryPdfium } from './pdfiumRaster';
import type { PdfiumPageInfo } from './pdfiumProtocol';
import { releasePdfRenderCache } from './pdfRenderCache';
/** PDFium document facade. All public results are application-owned data. */
export async function loadPdfiumDocument(input: Uint8Array): Promise<PDFDocumentProxy> {
  let source: Uint8Array | undefined = input,
    closed = false;
  let metadata: PdfiumPageInfo[] = [];
  const pages = new Map<number, Promise<PDFPageProxy>>();
  const alive = () => {
    if (closed) throw new Error('PDF document closed');
  };
  const document = {
    numPages: 0,
    getImages: async (index: number) => {
      alive();
      const result = await queryPdfium(document, { type: 'images', page: index });
      if (result.type !== 'images') throw new Error('PDF image index unavailable');
      return result.polygons;
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
        getAnnotations: async () => {
          alive();
          const reply = await queryPdfium(document, { type: 'annotations', page: number - 1 });
          if (reply.type !== 'annotations') throw new Error('PDF links unavailable');
          return reply.items;
        },
        cleanup: () => true,
        render: (options: Parameters<PDFPageProxy['render']>[0]) => {
          alive();
          return renderPdfiumPage(document, number - 1, info, options);
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
      alive();
    },
    destroy: async () => {
      if (closed) return;
      closed = true;
      releasePdfRenderCache(document);
      pages.clear();
      metadata = [];
      source = undefined;
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
