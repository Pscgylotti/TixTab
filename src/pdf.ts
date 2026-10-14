import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import worker from '../.cache/pdf-index-worker.mjs?url';
import { uid, type Notebook } from './model';
import { trackPerformance } from './performanceLedger';
import { releasePdfRenderCache } from './pdfRenderCache';
export { exportPdf, SignedPdfExportError } from './pdfExportClient';
export type { PdfExportProgress } from './pdfExportClient';
GlobalWorkerOptions.workerSrc = worker;
export function destroyPdf(pdf: PDFDocumentProxy | null | undefined) {
  if (!pdf) return Promise.resolve();
  releasePdfRenderCache(pdf);
  return pdf.destroy();
}
export async function loadPdf(bytes: Uint8Array) {
  return trackPerformance(
    'pdf-document',
    () => getDocument({ data: bytes.slice(), isEvalSupported: false }).promise,
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
