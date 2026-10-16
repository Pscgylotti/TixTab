import type { PDFDocumentProxy } from './pdfTypes';
import { uid, type Notebook } from './model';
import { trackPerformance } from './performanceLedger';
import { releasePdfRenderCache } from './pdfRenderCache';
export { exportPdf, SignedPdfExportError } from './pdfExportClient';
export type { PdfExportProgress } from './pdfExportClient';
const retained = new WeakMap<PDFDocumentProxy, { count: number; retire: boolean }>();
export function retainPdf(pdf: PDFDocumentProxy | null) {
  if (!pdf) return () => {};
  const hold = retained.get(pdf) ?? { count: 0, retire: false };
  hold.count++;
  retained.set(pdf, hold);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--hold.count === 0) {
      retained.delete(pdf);
      if (hold.retire) void pdf.destroy();
    }
  };
}
export function destroyPdf(pdf: PDFDocumentProxy | null | undefined) {
  if (!pdf) return Promise.resolve();
  releasePdfRenderCache(pdf);
  const hold = retained.get(pdf);
  if (hold) {
    hold.retire = true;
    return Promise.resolve();
  }
  return pdf.destroy();
}
export async function loadPdf(bytes: Uint8Array) {
  return trackPerformance('pdf-document', async () =>
    (await import('./pdfiumDocument')).loadPdfiumDocument(bytes),
  );
}
export async function importPdf(
  bytes: Uint8Array,
  name: string,
): Promise<{ notebook: Notebook; pdf: PDFDocumentProxy }> {
  const pdf = await loadPdf(bytes);
  const pages: Notebook['pages'] = [];
  // Ask the worker for a batch of pages at a time instead of one round trip each.
  for (let first = 1; first <= pdf.numPages; first += 32) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(32, pdf.numPages - first + 1) }, (_, n) =>
        trackPerformance('pdf-page', () => pdf.getPage(first + n)),
      ),
    );
    batch.forEach((page, n) => {
      const vp = page.getViewport({ scale: 1 });
      pages.push({
        id: uid(),
        sourceIndex: first + n - 1,
        width: vp.width,
        height: vp.height,
        strokes: [],
        images: [],
        paper: 'plain',
      });
    });
  }
  return { pdf, notebook: { version: 1, name: name.replace(/\.pdf$/i, ''), source: bytes, pages } };
}
