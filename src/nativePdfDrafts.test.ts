import { expect, it, vi } from 'vitest';
import { runPdfEditor } from './nativePdfDrafts';
it('cancels a stalled preview and lets later edits proceed without waiting for IPC acknowledgement', async () => {
  const run = vi.fn((request: any) =>
    request.action === 'preview' ? new Promise<any>(() => {}) : Promise.resolve({ ok: true }),
  );
  vi.stubGlobal('window', { surfaceDesktop: { pdfEditor: { run } } });
  try {
    const abort = new AbortController();
    const pending = runPdfEditor(
      { action: 'preview', id: 'preview-1', source: new Uint8Array([1]), page: 0, edits: [] },
      abort.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    abort.abort();
    await rejected;
    expect(run).toHaveBeenCalledWith({ action: 'cancel', id: 'preview-1' });
    await expect(
      runPdfEditor({ action: 'inspect', id: 'next', source: new Uint8Array([1]), page: 0 }),
    ).resolves.toEqual({ ok: true });
  } finally {
    vi.unstubAllGlobals();
  }
});
