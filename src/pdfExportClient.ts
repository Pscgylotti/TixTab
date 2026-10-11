import type { Notebook } from './model';
import { getLocale, t } from './i18n';
import { packPdfExport } from './pdfExportSnapshot';
import {
  cancelledPdfExport,
  SignedPdfExportError,
  type PdfExportProgress,
  type PdfExportReply,
} from './pdfExportProtocol';
export { SignedPdfExportError } from './pdfExportProtocol';
export type { PdfExportProgress } from './pdfExportProtocol';
let active: object | null = null;

/** One short-lived worker per export/window. Cancellation preempts synchronous
 * parsing/path generation/save, then termination releases its document heap.
 * Never fall back to main-thread PDF processing if the worker fails. */
export async function exportPdf(
  notebook: Notebook,
  options: {
    allowSignatureInvalidation?: boolean;
    signal?: AbortSignal;
    onProgress?: (progress: PdfExportProgress) => void;
  } = {},
) {
  if (options.signal?.aborted) throw cancelledPdfExport();
  if (active) throw new Error(t('已有 PDF 正在导出，请稍后重试。'));
  const owner = {},
    controller = new AbortController(),
    cancel = () => controller.abort();
  active = owner;
  let worker: Worker | undefined;
  options.signal?.addEventListener('abort', cancel, { once: true });
  window.addEventListener('pagehide', cancel, { once: true });
  try {
    options.onProgress?.({ stage: 'preparing' });
    // Commit/paint the cancellable overlay before preparing a large snapshot.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const packed = await packPdfExport(notebook, controller.signal);
    if (controller.signal.aborted) throw cancelledPdfExport();
    try {
      worker = new Worker(new URL('./pdfExport.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      throw new Error(t('后台 PDF 导出不可用，请重试或重启应用。'));
    }
    const owned = worker;
    return await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        controller.signal.removeEventListener('abort', abort);
        owned.onmessage = null;
        owned.onerror = null;
        owned.onmessageerror = null;
        owned.terminate();
        worker = undefined;
      };
      const finish = (error: Error | null, bytes?: ArrayBuffer) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(new Uint8Array(bytes!));
      };
      const abort = () => finish(cancelledPdfExport());
      controller.signal.addEventListener('abort', abort, { once: true });
      owned.onerror = (event) => {
        event.preventDefault();
        finish(new Error(t('后台 PDF 导出不可用，请重试或重启应用。')));
      };
      owned.onmessageerror = () => finish(new Error(t('后台 PDF 导出数据无法读取，请重试。')));
      owned.onmessage = ({ data }: MessageEvent<PdfExportReply>) => {
        if (settled || controller.signal.aborted) return;
        if (data.type === 'progress') {
          try {
            options.onProgress?.(data.progress);
          } catch (error) {
            finish(
              error instanceof Error ? error : new Error(t('后台 PDF 导出数据无法读取，请重试。')),
            );
          }
          return;
        }
        if (data.type === 'complete' && data.bytes instanceof ArrayBuffer) {
          finish(null, data.bytes);
          return;
        }
        if (data.type === 'error')
          finish(data.signed ? new SignedPdfExportError() : new Error(data.message.slice(0, 500)));
      };
      if (controller.signal.aborted) {
        abort();
        return;
      }
      try {
        owned.postMessage(
          {
            notebook: packed.notebook,
            locale: getLocale(),
            allowSignatureInvalidation: !!options.allowSignatureInvalidation,
          },
          packed.transfers,
        );
      } catch {
        finish(new Error(t('后台 PDF 导出数据无法读取，请重试。')));
      }
    });
  } finally {
    worker?.terminate();
    options.signal?.removeEventListener('abort', cancel);
    window.removeEventListener('pagehide', cancel);
    if (active === owner) active = null;
  }
}
