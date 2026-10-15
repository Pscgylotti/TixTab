import { useSyncExternalStore } from 'react';
import { uid, type Notebook, type Page } from './model';
import type { NativePdfEdit, NativePdfRequest, NativePdfReply } from './pdfNativeTypes';
import { abortWait } from './abortWait';
let queue: Promise<unknown> = Promise.resolve();
export function runPdfEditor(
  request: NativePdfRequest,
  signal?: AbortSignal,
): Promise<NativePdfReply> {
  const run = queue.then(async () => {
    signal?.throwIfAborted();
    const bridge = window.surfaceDesktop?.pdfEditor;
    if (!bridge) return { ok: false, error: 'runtime-missing' };
    const cancel = () => {
      void bridge.run({ action: 'cancel', id: request.id });
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      return await (signal ? abortWait(bridge.run(request), signal) : bridge.run(request));
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  });
  queue = run.catch(() => {});
  return run;
}
const live = new Map<string, NativePdfEdit>();
const listeners = new Set<() => void>();
export function setLiveNativeEdit(pageId: string, edit: NativePdfEdit | null) {
  if (edit) live.set(pageId, edit);
  else live.delete(pageId);
  listeners.forEach((listener) => listener());
}
export function useLiveNativeEdit(pageId: string) {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => live.get(pageId),
  );
}
export function pageNativeEdits(page: Page, edit?: NativePdfEdit) {
  const edits = page.pdfEdits ?? [];
  return edit ? [...edits.filter((d) => d.element.id !== edit.element.id), edit] : edits;
}
export const nativeRequests = (page: Page, edits: NativePdfEdit[]) =>
  edits.map((edit) => ({
    page: page.sourceIndex!,
    elementId: edit.element.id,
    rect: edit.rect,
    text: edit.text,
    fontSize: edit.fontSize,
    color: edit.color,
    replacement: edit.replacement,
    delete: edit.delete,
    overflow: true,
  }));
/** Returns a new source only after a whole-document transaction succeeds. */
export async function applyNativeDrafts(
  notebook: Notebook,
  signal?: AbortSignal,
): Promise<Notebook> {
  const pages = notebook.pages.filter((page) => page.pdfEdits?.length);
  if (!pages.length) return notebook;
  if (!notebook.source) throw Error('pdf-edit');
  const indices = new Set(pages.map((page) => page.sourceIndex));
  const counts = new Map<number | null, number>();
  for (const page of notebook.pages)
    counts.set(page.sourceIndex, (counts.get(page.sourceIndex) ?? 0) + 1);
  if ([...indices].some((index) => index === null || (counts.get(index) ?? 0) > 1))
    throw Error('shared-page');
  const result = await runPdfEditor(
    {
      action: 'batch',
      id: uid(),
      source: notebook.source,
      page: pages[0].sourceIndex!,
      edits: pages.flatMap((page) => nativeRequests(page, page.pdfEdits!)),
    },
    signal,
  );
  signal?.throwIfAborted();
  if (!result.ok || !result.data?.source) throw Error(result.error || 'pdf-edit');
  return {
    ...notebook,
    source: new Uint8Array(result.data.source),
    pages: notebook.pages.map((page) =>
      page.pdfEdits?.length
        ? { ...page, pdfEdits: undefined, nativeRevision: uid(), bitmapOcr: undefined }
        : page,
    ),
  };
}
