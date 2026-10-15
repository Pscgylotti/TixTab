import type { PDFDocumentProxy } from 'pdfjs-dist';
import { abortWait } from './abortWait';

/** Decoding is isolated from the resident reading engine, serialized before
 * parallel OCR lanes, and the entire decoder heap is released on close/stop. */
export function bitmapPdfDecoder(
  source: PDFDocumentProxy,
  signal: AbortSignal,
  maxPixels = 4_000_000,
) {
  type Decoder = {
    draw: (page: number, image: number, canvas: HTMLCanvasElement) => Promise<boolean>;
    close: () => void | Promise<void>;
  };
  let decoder: Decoder | undefined,
    closed = false,
    compatibility = (source as unknown as { tixtabBackend?: string }).tixtabBackend !== 'pdfium';
  let queue: Promise<unknown> = Promise.resolve();
  const abort = () => {
    closed = true;
    void decoder?.close();
  };
  signal.addEventListener('abort', abort, { once: true });
  const create = async () => {
    if (compatibility) {
      const { bitmapPdfLegacyDecoder } = await import('./bitmapPdfLegacyDecoder');
      return bitmapPdfLegacyDecoder(source, signal, maxPixels);
    }
    const { createPdfiumImageDecoder } = await import('./pdfiumRaster');
    return createPdfiumImageDecoder(source, signal, maxPixels);
  };
  return {
    draw(page: number, image: number, canvas: HTMLCanvasElement) {
      const job = queue.then(async () => {
        signal.throwIfAborted();
        if (closed) throw new Error('PDF image decoder closed');
        if (!decoder) {
          const candidate = await create();
          if (closed || signal.aborted) {
            await candidate.close();
            signal.throwIfAborted();
            throw new Error('PDF image decoder closed');
          }
          decoder = candidate;
        }
        try {
          return await abortWait(decoder.draw(page, image, canvas), signal);
        } catch (error) {
          signal.throwIfAborted();
          if (
            compatibility ||
            !(error instanceof Error) ||
            error.message !== 'PDFium image compatibility required'
          )
            throw error;
          await decoder.close();
          decoder = undefined;
          compatibility = true;
          const candidate = await create();
          if (closed || signal.aborted) {
            await candidate.close();
            signal.throwIfAborted();
            throw new Error('PDF image decoder closed');
          }
          decoder = candidate;
          return abortWait(decoder.draw(page, image, canvas), signal);
        }
      });
      queue = job.catch(() => {});
      return job;
    },
    async close() {
      closed = true;
      signal.removeEventListener('abort', abort);
      // Terminating the native worker rejects pending requests immediately.
      await decoder?.close();
      await queue;
      decoder = undefined;
      queue = Promise.resolve();
    },
  };
}
