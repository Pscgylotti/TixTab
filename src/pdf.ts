import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { uid, type Notebook } from './model';
export { exportPdf, SignedPdfExportError } from './pdfExportClient';
export type { PdfExportProgress } from './pdfExportClient';
GlobalWorkerOptions.workerSrc = worker;
export async function loadPdf(bytes: Uint8Array) {
  return getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
}
export async function importPdf(
  bytes: Uint8Array,
  name: string,
): Promise<{ notebook: Notebook; pdf: PDFDocumentProxy }> {
  const pdf = await loadPdf(bytes);
  const pages: Notebook['pages'] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i),
      vp = page.getViewport({ scale: 1 });
    pages.push({
      id: uid(),
      sourceIndex: i - 1,
      width: vp.width,
      height: vp.height,
      strokes: [],
      images: [],
      paper: 'plain',
    });
  }
  return { pdf, notebook: { version: 1, name: name.replace(/\.pdf$/i, ''), source: bytes, pages } };
}
