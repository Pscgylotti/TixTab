import worker from '../.cache/pdf-index-worker.mjs?url';
import { releasePdfRenderCache } from './pdfRenderCache';
let opens = 0;
export const getLegacyPdfStats = () => ({ opens });
/** Compatibility implementation, loaded only when a remaining feature needs it. */
export async function loadLegacyPdf(bytes: Uint8Array) {
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist');
  GlobalWorkerOptions.workerSrc = worker;
  const pdf = await getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  opens++;
  const destroy = pdf.destroy.bind(pdf);
  pdf.destroy = () => {
    releasePdfRenderCache(pdf);
    return destroy();
  };
  return pdf;
}
