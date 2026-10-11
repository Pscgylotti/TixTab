import { exportPdf } from './pdfExport';
import { setLocale } from './i18n';
import { unpackPdfExport } from './pdfExportSnapshot';
import {
  SignedPdfExportError,
  type PdfExportRequest,
  type PdfExportReply,
  type PdfExportProgress,
} from './pdfExportProtocol';
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PdfExportRequest>) => void) | null;
  postMessage: (value: PdfExportReply, transfer?: Transferable[]) => void;
};
scope.onmessage = async ({ data }) => {
  try {
    setLocale(data.locale);
    const notebook = unpackPdfExport(data.notebook);
    data.notebook.pages = [];
    let previous: PdfExportProgress['stage'] | undefined,
      last = 0;
    const onProgress = (progress: PdfExportProgress) => {
      const now = performance.now();
      if (
        progress.stage !== previous ||
        progress.completed === progress.total ||
        now - last >= 50
      ) {
        previous = progress.stage;
        last = now;
        scope.postMessage({ type: 'progress', progress });
      }
    };
    const bytes = await exportPdf(notebook, {
      allowSignatureInvalidation: data.allowSignatureInvalidation,
      onProgress,
    });
    const buffer =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? (bytes.buffer as ArrayBuffer)
        : (bytes.slice().buffer as ArrayBuffer);
    scope.postMessage({ type: 'complete', bytes: buffer }, [buffer]);
  } catch (error) {
    scope.postMessage({
      type: 'error',
      signed: error instanceof SignedPdfExportError,
      message: error instanceof Error ? error.message : 'PDF export failed',
    });
  }
};
