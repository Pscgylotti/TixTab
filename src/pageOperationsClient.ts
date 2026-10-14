import type { Notebook } from './model';
import type { PageOperation } from './pageOperations';
export function editPages(
  notebook: Notebook,
  indices: number[],
  operation: PageOperation,
  signal: AbortSignal,
): Promise<Notebook> {
  if (notebook.pages.some((p) => p.pdfEdits?.length))
    return Promise.reject(Error('pending-pdf-edits'));
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
    const worker = new Worker(new URL('./pageOperations.worker.ts', import.meta.url), {
      type: 'module',
    });
    const finish = (error?: Error, next?: Notebook) => {
      worker.terminate();
      signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve(next!);
    };
    const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = () => finish(Error('page-edit'));
    worker.onmessage = ({ data }) => {
      if (!data.ok) {
        finish(Error(data.error));
        return;
      }
      const selected = new Set(indices);
      finish(undefined, {
        ...notebook,
        source: data.notebook.source,
        pages: notebook.pages.map((p, i) => (selected.has(i) ? data.notebook.pages[i] : p)),
      });
    };
    // Structured cloning shares repeated immutable strings and does not detach notebook history.
    const selected = new Set(indices);
    worker.postMessage({
      notebook: {
        ...notebook,
        scene: undefined,
        pages: notebook.pages.map((p, i) =>
          selected.has(i)
            ? p
            : { ...p, strokes: [], images: [], reviews: undefined, bitmapOcr: undefined },
        ),
      },
      indices,
      operation,
    });
  });
}
