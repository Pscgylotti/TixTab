import type { PDFDocumentProxy, PDFDocumentLoadingTask, PDFWorker } from 'pdfjs-dist';
import { drawPdfOriginalImage } from './pdfOriginalImage';
import { abortWait } from './abortWait';
/** OCR owns a short-lived PDF worker, so image caches cannot accumulate in the
 * reader's document. Serialize decode/cleanup, while OCR lanes remain parallel. */
export function bitmapPdfLegacyDecoder(
  source: PDFDocumentProxy,
  signal: AbortSignal,
  maxPixels = 4_000_000,
) {
  let task: PDFDocumentLoadingTask | undefined, owned: PDFDocumentProxy | undefined;
  let worker: PDFWorker | undefined, destroying: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const destroy = () => (destroying ??= task?.destroy().catch(() => {}) ?? Promise.resolve());
  const abort = () => {
    // PDFDocumentLoadingTask.destroy waits for transport acknowledgement. A
    // stuck operator/image task must not keep Stop waiting for that handshake.
    void destroy();
    worker?.destroy();
  };
  signal.addEventListener('abort', abort, { once: true });
  return {
    draw(page: number, image: number, canvas: HTMLCanvasElement): Promise<boolean> {
      const job = queue.then(async () => {
        signal.throwIfAborted();
        if (!owned) {
          const { getDocument, PDFWorker } = await import('pdfjs-dist');
          const bytes = await abortWait(source.getData(), signal);
          signal.throwIfAborted();
          worker = new PDFWorker();
          task = getDocument({
            data: bytes,
            worker,
            isEvalSupported: false,
            disableFontFace: true,
            maxImageSize: 64_000_000,
            canvasMaxAreaInBytes: maxPixels * 4,
          });
          owned = await abortWait(task.promise, signal);
          signal.throwIfAborted();
        }
        try {
          return await abortWait(
            drawPdfOriginalImage(owned, page, image, canvas, signal, maxPixels),
            signal,
          );
        } finally {
          if (!signal.aborted) await abortWait(owned.cleanup(), signal);
        }
      });
      queue = job.catch(() => {});
      return job;
    },
    async close() {
      signal.removeEventListener('abort', abort);
      await queue;
      try {
        // Successful teardown gets a short grace period. Cancellation already
        // terminated our dedicated worker and never waits for its acknowledgement.
        if (signal.aborted) void destroy();
        else {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([destroy(), new Promise<void>((r) => (timer = setTimeout(r, 500)))]);
          } finally {
            clearTimeout(timer);
          }
        }
      } finally {
        worker?.destroy();
        worker = undefined;
        owned = undefined;
        task = undefined;
        destroying = undefined;
        queue = Promise.resolve();
      }
    },
  };
}
