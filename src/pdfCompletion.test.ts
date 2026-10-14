import { afterEach, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
const night = vi.hoisted(() => ({ apply: vi.fn(() => Promise.resolve()) }));
vi.mock('./pdfNight', () => ({ applyPdfNight: night.apply }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  night.apply.mockReset();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function fixture() {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === 'tixtab.performance.enabled' ? 'true' : null),
  });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { surfaceDesktop: undefined }));
  vi.stubGlobal(
    'document',
    Object.assign(new EventTarget(), {
      hidden: false,
      documentElement: { dataset: {} },
      createElement: () =>
        Object.assign(new EventTarget(), {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: vi.fn() }),
        }),
    }),
  );
  const scheduler = await import('./pdfRenderCache');
  const { performanceLedger: ledger } = await import('./performanceLedger');
  const raster = deferred<void>(),
    cancel = vi.fn();
  const page = {
    getViewport: () => ({ width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0] }),
    render: vi.fn(() => ({ promise: raster.promise, cancel })),
  };
  const policy = (await import('./appearance')).renderPolicy();
  return { scheduler, ledger: ledger!, raster, cancel, page, policy };
}
it('cancelled getPage work stays pending after its scheduling slot is freed', async () => {
  const f = await fixture(),
    fetched = deferred<typeof f.page>();
  const pdf = { getPage: () => fetched.promise } as unknown as PDFDocumentProxy;
  const lease = f.scheduler.requestPdfBitmap(pdf, 0, 1);
  const rejection = expect(lease.promise).rejects.toMatchObject({ name: 'AbortError' });
  lease.cancel();
  await rejection;
  expect(f.scheduler.getPdfRenderStats(pdf).running).toBe(0);
  expect(f.ledger.snapshot()).toMatchObject({
    pending: 1,
    stages: { 'pdf-job': { cancelled: 1 }, 'pdf-page': { pending: 1 } },
  });
  fetched.resolve(f.page);
  await fetched.promise;
  expect(f.ledger.snapshot().pending).toBe(0);
  expect(f.page.render).not.toHaveBeenCalled();
});
it('timeout does not falsely finish a stalled underlying PDF render', async () => {
  const f = await fixture(),
    pdf = { getPage: async () => f.page } as unknown as PDFDocumentProxy;
  const lease = f.scheduler.requestPdfBitmap(pdf, 0, 1);
  const rejection = expect(lease.promise).rejects.toThrow('PDF 渲染超时');
  await vi.advanceTimersByTimeAsync(45_001);
  await rejection;
  expect(f.ledger.snapshot()).toMatchObject({
    pending: 1,
    stages: { 'pdf-job': { failed: 1 }, 'pdf-raster': { pending: 1 } },
  });
  expect(f.cancel).toHaveBeenCalledOnce();
  f.raster.resolve();
  await f.raster.promise;
  expect(f.ledger.snapshot().pending).toBe(0);
});
it('aborting night conversion still waits for the worker-facing promise', async () => {
  const f = await fixture(),
    conversion = deferred<void>();
  night.apply.mockImplementation(() => conversion.promise);
  const pdf = { getPage: async () => f.page } as unknown as PDFDocumentProxy;
  const lease = f.scheduler.requestPdfBitmap(pdf, 0, 1, 0, true);
  const rejection = expect(lease.promise).rejects.toMatchObject({ name: 'AbortError' });
  f.raster.resolve();
  await vi.advanceTimersByTimeAsync(1);
  expect(night.apply).toHaveBeenCalledOnce();
  lease.cancel();
  await rejection;
  expect(f.ledger.snapshot()).toMatchObject({
    pending: 1,
    stages: { 'pdf-night': { pending: 1 } },
  });
  conversion.resolve();
  await conversion.promise;
  expect(f.ledger.snapshot().pending).toBe(0);
});
it('queued cancellation finishes its ledger entry and never fetches/renders a page', async () => {
  const f = await fixture(),
    fetched = deferred<typeof f.page>(),
    getPage = vi.fn(() => fetched.promise);
  const pdf = { getPage } as unknown as PDFDocumentProxy;
  const a = f.scheduler.requestPdfBitmap(pdf, 0, 1),
    b = f.scheduler.requestPdfBitmap(pdf, 1, 1),
    queued = f.scheduler.requestPdfBitmap(pdf, 2, 1);
  const rejection = expect(queued.promise).rejects.toMatchObject({ name: 'AbortError' });
  queued.cancel();
  await rejection;
  expect(getPage).toHaveBeenCalledTimes(f.policy.concurrency);
  expect(f.ledger.snapshot().stages['pdf-job']).toMatchObject({ pending: 2, cancelled: 1 });
  fetched.resolve(f.page);
  f.raster.resolve();
  await Promise.all([a.promise, b.promise]);
  expect(f.ledger.snapshot().pending).toBe(0);
  const cached = f.scheduler.requestPdfBitmap(pdf, 0, 1);
  await cached.promise;
  expect(f.ledger.snapshot().counters).toMatchObject({ pdfCacheHits: 1, pdfPixels: 20_000 });
});
