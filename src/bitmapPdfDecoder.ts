import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist';
import { drawPdfOriginalImage } from './pdfOriginalImage';
/** OCR owns a short-lived PDF worker, so image caches cannot accumulate in the
 * reader's document. Serialize decode/cleanup, while OCR lanes remain parallel. */
export function bitmapPdfDecoder(source: PDFDocumentProxy, signal: AbortSignal) {
  let task: PDFDocumentLoadingTask | undefined, owned: PDFDocumentProxy | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const abort = () => {
    void task?.destroy().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  return {
    draw(page: number, image: number, canvas: HTMLCanvasElement) {
      const job = queue.then(async () => {
        signal.throwIfAborted();
        if (!owned) {
          const { getDocument } = await import('pdfjs-dist');
          const bytes = await source.getData();
          signal.throwIfAborted();
          task = getDocument({
            data: bytes,
            isEvalSupported: false,
            disableFontFace: true,
            maxImageSize: 64_000_000,
            canvasMaxAreaInBytes: 16_000_000,
          });
          owned = await task.promise;
          signal.throwIfAborted();
        }
        try {
          return await drawPdfOriginalImage(owned, page, image, canvas, signal, 4_000_000);
        } finally {
          if (!signal.aborted) await owned.cleanup();
        }
      });
      queue = job.catch(() => {});
      return job;
    },
    async close() {
      signal.removeEventListener('abort', abort);
      await queue;
      try {
        await task?.destroy();
      } finally {
        owned = undefined;
        task = undefined;
      }
    },
  };
}
