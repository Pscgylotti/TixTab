import type { Notebook, Page } from './model';
import type { CopiedPage } from './pageTransferEngine';
import { clonePage } from './duplicatePage';
export const PAGE_CLIPBOARD_LIMIT = 64 * 1024 * 1024;
export function pageMemory(page: Page) {
  let size = 0;
  const seen = new WeakSet<object>();
  const visit = (v: unknown): void => {
    if (size > PAGE_CLIPBOARD_LIMIT) return;
    if (typeof v === 'string') size += v.length * 2;
    else if (v && typeof v === 'object' && !seen.has(v)) {
      seen.add(v);
      size += 32;
      for (const k in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        size += k.length * 2 + 16;
        visit((v as Record<string, unknown>)[k]);
        if (size > PAGE_CLIPBOARD_LIMIT) break;
      }
    } else size += 8;
  };
  visit(page);
  return size;
}
function transfer(request: unknown, signal: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(new URL('./pageTransfer.worker.ts', import.meta.url), {
      type: 'module',
    });
    let done = false;
    const finish = (error?: Error, result?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      window.removeEventListener('pagehide', abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      error ? reject(error) : resolve(result);
    };
    const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
    const timeout = setTimeout(() => finish(Error('page-transfer-timeout')), 120000);
    signal.addEventListener('abort', abort, { once: true });
    window.addEventListener('pagehide', abort, { once: true });
    worker.onerror = () => finish(Error('page-transfer'));
    worker.onmessageerror = () => finish(Error('page-transfer'));
    worker.onmessage = ({ data }) =>
      data.ok ? finish(undefined, data.result) : finish(Error(data.error));
    try {
      worker.postMessage(request);
    } catch (e) {
      finish(e instanceof Error ? e : Error('page-transfer'));
    }
  });
}
export async function copyNotebookPage(
  notebook: Notebook,
  index: number,
  signal: AbortSignal,
): Promise<CopiedPage> {
  const page = notebook.pages[index];
  if (!page) throw Error('page-missing');
  if (page.pdfEdits?.length) throw Error('pending-pdf-edits');
  const size = pageMemory(page);
  if (size > PAGE_CLIPBOARD_LIMIT) throw Error('page-clipboard-large');
  const payload =
    page.sourceIndex === null
      ? { page: structuredClone(page), source: null }
      : ((await transfer({ action: 'copy', source: notebook.source, page }, signal)) as CopiedPage);
  signal.throwIfAborted();
  if (size + (payload.source?.byteLength ?? 0) > PAGE_CLIPBOARD_LIMIT)
    throw Error('page-clipboard-large');
  return payload;
}
export async function pasteNotebookPage(
  notebook: Notebook,
  at: number,
  payload: CopiedPage,
  signal: AbortSignal,
): Promise<Notebook> {
  if (!Number.isInteger(at) || at < 0 || at >= notebook.pages.length) throw Error('page-missing');
  const merged = payload.source
    ? ((await transfer(
        { action: 'paste', source: notebook.source, payload: { source: payload.source } },
        signal,
      )) as { source: Uint8Array; indices: number[] })
    : null;
  signal.throwIfAborted();
  const page = clonePage(payload.page, merged ? merged.indices[0] : null);
  return {
    ...notebook,
    source: merged?.source ?? notebook.source,
    pages: [...notebook.pages.slice(0, at + 1), page, ...notebook.pages.slice(at + 1)],
  };
}
