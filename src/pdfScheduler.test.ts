import { afterEach, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function fixture() {
  vi.resetModules();
  vi.useFakeTimers();
  const doc = Object.assign(new EventTarget(), {
    hidden: false,
    documentElement: { dataset: {} },
    createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }),
  });
  let visibility!: (visible: boolean) => void;
  let snapshot!: (visible: boolean) => void;
  const win = Object.assign(new EventTarget(), {
    surfaceDesktop: {
      getWindowVisible: () =>
        new Promise<boolean>((resolve) => {
          snapshot = resolve;
        }),
      onWindowVisibility: (callback: typeof visibility) => {
        visibility = callback;
      },
    },
  });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const pdf = {
    getPage: async () => ({
      getViewport: () => ({ width: 100, height: 100 }),
      render,
    }),
  } as unknown as PDFDocumentProxy;
  const scheduler = await import('./pdfRenderCache');
  scheduler.initializeRenderScheduler();
  return {
    doc,
    win,
    render,
    pdf,
    scheduler,
    snapshot,
    visibility,
    pointer: (type: string, id = 1, buttons = 1) =>
      doc.dispatchEvent(Object.assign(new Event(type), { pointerId: id, buttons })),
  };
}
it('recovers rendering when Windows loses a pointer release, without needing another click', async () => {
  const f = await fixture();
  f.pointer('pointerdown');
  const lease = f.scheduler.requestPdfBitmap(f.pdf, 0, 1);
  await vi.advanceTimersByTimeAsync(250);
  expect(f.render).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  await lease.promise;
  expect(f.render).toHaveBeenCalledTimes(1);
});
it('an old initial native visibility response cannot override a newer window event', async () => {
  const f = await fixture();
  f.visibility(true);
  f.snapshot(false);
  await Promise.resolve();
  const lease = f.scheduler.requestPdfBitmap(f.pdf, 0, 1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.render).toHaveBeenCalledTimes(1);
  await lease.promise;
});
it('keeps hidden windows paused and resumes them when restored', async () => {
  const f = await fixture();
  f.visibility(false);
  const lease = f.scheduler.requestPdfBitmap(f.pdf, 0, 1);
  await vi.advanceTimersByTimeAsync(2500);
  expect(f.render).not.toHaveBeenCalled();
  f.visibility(true);
  await lease.promise;
  expect(f.render).toHaveBeenCalledTimes(1);
});
it('ongoing pen movement postpones work, but normal release resumes it', async () => {
  const f = await fixture();
  f.pointer('pointerdown');
  const lease = f.scheduler.requestPdfBitmap(f.pdf, 0, 1);
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    f.pointer('pointermove');
  }
  expect(f.render).not.toHaveBeenCalled();
  f.pointer('pointerup', 1, 0);
  await vi.advanceTimersByTimeAsync(350);
  await lease.promise;
  expect(f.render).toHaveBeenCalledTimes(1);
});
it('a stuck document worker releases global slots so other PDFs can still render', async () => {
  const f = await fixture();
  const stuck = { getPage: () => new Promise(() => {}) } as unknown as PDFDocumentProxy;
  const a = f.scheduler.requestPdfBitmap(stuck, 0, 1);
  const b = f.scheduler.requestPdfBitmap(stuck, 1, 1);
  const failures = Promise.allSettled([a.promise, b.promise]);
  const healthy = f.scheduler.requestPdfBitmap(f.pdf, 0, 1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.render).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(45_000);
  expect((await failures).every((r) => r.status === 'rejected')).toBe(true);
  await healthy.promise;
  expect(f.render).toHaveBeenCalledTimes(1);
  expect(f.scheduler.getPdfRenderStats(stuck)).toMatchObject({ running: 0, queued: 0 });
});
it('cancel during page loading releases the lane immediately instead of waiting for its worker', async () => {
  const f = await fixture();
  const stuck = { getPage: () => new Promise(() => {}) } as unknown as PDFDocumentProxy;
  const a = f.scheduler.requestPdfBitmap(stuck, 0, 1);
  const b = f.scheduler.requestPdfBitmap(stuck, 1, 1);
  const failures = Promise.allSettled([a.promise, b.promise]);
  const healthy = f.scheduler.requestPdfBitmap(f.pdf, 0, 1);
  a.cancel();
  b.cancel();
  await vi.advanceTimersByTimeAsync(1);
  await failures;
  await healthy.promise;
  expect(f.render).toHaveBeenCalledTimes(1);
});
