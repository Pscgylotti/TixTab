import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { renderPolicy, setPowerMode, setMemoryMode } from './appearance';
import {
  getPdfRenderStats,
  invalidatePdfBitmap,
  priorPdfBitmap,
  requestPdfBitmap,
  requestPdfTile,
  requestPdfThumbnail,
  requestPdfHalf,
  setPdfViewCacheKey,
  releasePdfRenderCache,
} from './pdfRenderCache';

afterEach(() => {
  vi.unstubAllGlobals();
  setMemoryMode('normal');
  setPowerMode('auto');
});
function fixture(width = 200, height = 300) {
  vi.stubGlobal('document', {
    createElement: () =>
      Object.assign(new EventTarget(), {
        width: 0,
        height: 0,
        dataset: {},
        getContext: () => ({}),
      }),
  });
  const starts: number[] = [],
    pending: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  const pdf = {
    getPage: async (number: number) => ({
      getViewport: () => ({ width, height }),
      render: () => {
        starts.push(number);
        let resolve!: () => void, reject!: (e: unknown) => void;
        const promise = new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        pending.push({ resolve, reject });
        return { promise, cancel: () => reject(new DOMException('cancel', 'AbortError')) };
      },
    }),
  } as unknown as PDFDocumentProxy;
  return { pdf, starts, pending };
}
describe('PDF 位图共享和绘制调度', () => {
  it('minimal mode retires cached pages immediately and retains only visible rasters', async () => {
    const { pdf, pending } = fixture();
    const a = requestPdfBitmap(pdf, 0, 1);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].resolve();
    const first = await a.promise;
    Object.assign(first, { isConnected: true });
    const b = requestPdfBitmap(pdf, 1, 1);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1].resolve();
    const hidden = await b.promise;
    setMemoryMode('minimal');
    expect(getPdfRenderStats(pdf)).toMatchObject({ bytes: 0, bitmaps: 0, pages: 0 });
    expect(first).toMatchObject({ width: 200, height: 300 });
    expect(hidden).toMatchObject({ width: 1, height: 1 });
    const c = requestPdfBitmap(pdf, 2, 1);
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    pending[2].resolve();
    expect(await c.promise).toMatchObject({ width: 200, height: 300 });
    expect(getPdfRenderStats(pdf)).toMatchObject({ bytes: 0, bitmaps: 0, pages: 0 });
    expect(priorPdfBitmap(pdf, 2)).toBeUndefined();
    expect(renderPolicy()).toMatchObject({
      concurrency: 1,
      cacheBytes: 0,
      extraPageBytes: 0,
      basePixels: 1000000,
    });
    releasePdfRenderCache(pdf);
  });
  it('releases retired document pixels immediately even when its PDF proxy remains reachable', async () => {
    const { pdf, pending } = fixture(200, 300);
    const canvases: HTMLCanvasElement[] = [];
    for (let i = 0; i < 3; i++) {
      const lease = requestPdfBitmap(pdf, i, 1);
      await vi.waitFor(() => expect(pending.length).toBe(i + 1));
      pending[i].resolve();
      canvases.push(await lease.promise);
    }
    expect(getPdfRenderStats(pdf).pageBytes).toBe(720000);
    Object.assign(canvases[0], { isConnected: true });
    releasePdfRenderCache(pdf);
    expect(getPdfRenderStats(pdf)).toMatchObject({ bytes: 0, bitmaps: 0, pages: 0 });
    expect([canvases[0].width, canvases[0].height]).toEqual([200, 300]);
    expect([canvases[1].width, canvases[1].height]).toEqual([1, 1]);
  });
  it('cancels queued and running work when a document retires and never recaches its completion', async () => {
    const { pdf, pending } = fixture();
    const leases = Array.from({ length: 3 }, (_, i) => requestPdfBitmap(pdf, i, 1));
    const done = Promise.allSettled(leases.map((lease) => lease.promise));
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    releasePdfRenderCache(pdf);
    expect((await done).every((item) => item.status === 'rejected')).toBe(true);
    expect(getPdfRenderStats(pdf)).toMatchObject({ bytes: 0, queued: 0, running: 0 });
  });
  it('keeps 150 LRU thumbnails separately from large page rasters and invalidates lost previews', async () => {
    vi.stubGlobal('document', {
      createElement: () =>
        Object.assign(new EventTarget(), {
          width: 0,
          height: 0,
          dataset: {},
          getContext: () => ({}),
        }),
    });
    let renders = 0;
    const pdf = {
      getPage: async () => ({
        getViewport: () => ({ width: 100, height: 140 }),
        render: () => ({
          promise: Promise.resolve().then(() => {
            renders++;
          }),
          cancel: () => {},
        }),
      }),
    } as unknown as PDFDocumentProxy;
    for (let i = 0; i < 150; i++) await requestPdfThumbnail(pdf, i, 595, 842).promise;
    const first = await requestPdfThumbnail(pdf, 0, 595, 842).promise;
    expect(renders).toBe(150);
    await requestPdfThumbnail(pdf, 150, 595, 842).promise;
    expect(getPdfRenderStats(pdf).thumbnails).toBe(150);
    expect(await requestPdfThumbnail(pdf, 0, 595, 842).promise).toBe(first);
    await requestPdfThumbnail(pdf, 1, 595, 842).promise;
    expect(renders).toBe(152);
    first.dispatchEvent(new Event('contextlost'));
    expect(await requestPdfThumbnail(pdf, 0, 595, 842).promise).not.toBe(first);
    expect(renders).toBe(153);
  });
  it.each(['quality', 'eco'] as const)(
    '%s: 按策略限制并行，当前页优先于排队缩略图，重复请求共用绘制',
    async (mode) => {
      setPowerMode(mode);
      const capacity = renderPolicy().concurrency;
      expect([1, 2]).toContain(capacity);
      const order = capacity === 1 ? [1, 4, 2, 3] : [1, 2, 4, 3];
      const { pdf, starts, pending } = fixture();
      const a = requestPdfBitmap(pdf, 0, 1, 2),
        shared = requestPdfBitmap(pdf, 0, 1, 0),
        b = requestPdfBitmap(pdf, 1, 1, 2),
        c = requestPdfBitmap(pdf, 2, 1, 2),
        foreground = requestPdfBitmap(pdf, 3, 1, 0);
      await vi.waitFor(() => expect(starts).toEqual(order.slice(0, capacity)));
      expect(getPdfRenderStats(pdf)).toMatchObject({ running: capacity, queued: 4 - capacity });
      a.cancel();
      pending[0].resolve();
      const [image, image2] = await Promise.all([a.promise, shared.promise]);
      expect(image).toBe(image2);
      await vi.waitFor(() => expect(starts).toEqual(order.slice(0, capacity + 1)));
      for (let i = 1; i < 4; i++) {
        await vi.waitFor(() => expect(pending.length).toBeGreaterThan(i));
        expect(starts).toEqual(order.slice(0, starts.length));
        pending[i].resolve();
      }
      await Promise.all([b.promise, foreground.promise, c.promise]);
      expect(starts).toEqual(order);
      expect(await requestPdfBitmap(pdf, 0, 1).promise).toBe(image);
      expect(getPdfRenderStats(pdf)).toMatchObject({ renders: 4, hits: 1, running: 0 });
    },
  );
  it.each(['quality', 'eco'] as const)(
    '%s: 取消队列任务不会绘制；取消一个订阅不会取消仍在使用的共享任务',
    async (mode) => {
      setPowerMode(mode);
      const capacity = renderPolicy().concurrency;
      const { pdf, starts, pending } = fixture();
      const a = requestPdfBitmap(pdf, 0, 1),
        b = requestPdfBitmap(pdf, 1, 1),
        c = requestPdfBitmap(pdf, 2, 1);
      const rejection = expect(c.promise).rejects.toMatchObject({ name: 'AbortError' });
      c.cancel();
      await rejection;
      await vi.waitFor(() => expect(starts).toEqual([1, 2].slice(0, capacity)));
      pending[0].resolve();
      await vi.waitFor(() => expect(starts).toEqual([1, 2]));
      pending[1].resolve();
      await Promise.all([a.promise, b.promise]);
      expect(getPdfRenderStats(pdf)).toMatchObject({ queued: 0, running: 0 });
    },
  );
  it('整页缓存优先保留至少 15 页，不再受旧 48MiB 总量限制', async () => {
    const { pdf, pending } = fixture(3000, 2000);
    for (let i = 0; i < 3; i++) {
      const lease = requestPdfBitmap(pdf, i, 1);
      await vi.waitFor(() => expect(pending).toHaveLength(i + 1));
      pending[i].resolve();
      await lease.promise;
    }
    expect(getPdfRenderStats(pdf)).toMatchObject({
      bytes: 72_000_000,
      bitmaps: 3,
      pages: 3,
      renders: 3,
    });
  });
  it('高清瓦片只分配局部画布，裁切变换准确；共享缓存不会把瓦片当整页预览', async () => {
    vi.stubGlobal('document', {
      createElement: () =>
        Object.assign(new EventTarget(), {
          width: 0,
          height: 0,
          dataset: {},
          getContext: () => ({}),
        }),
    });
    const render = vi.fn((_args: Record<string, unknown>) => ({
      promise: Promise.resolve(),
      cancel: () => {},
    }));
    const pdf = {
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 595 * scale,
          height: 842 * scale,
        }),
        render,
      }),
    } as unknown as PDFDocumentProxy;
    const region = { x: 512, y: 1024, width: 512, height: 200 };
    const [a, b] = await Promise.all([
      requestPdfTile(pdf, 0, 4, region).promise,
      requestPdfTile(pdf, 0, 4, region).promise,
    ]);
    expect(a).toBe(b);
    expect(render).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ width: 512, height: 200 });
    expect(render.mock.calls[0][0]).toMatchObject({
      viewport: { width: 2380, height: 3368 },
      transform: [1, 0, 0, 1, -512, -1024],
    });
    expect(priorPdfBitmap(pdf, 0)).toBeUndefined();
    const full = await requestPdfBitmap(pdf, 0, 0.7).promise;
    expect(priorPdfBitmap(pdf, 0)).toBe(full);
    await requestPdfTile(pdf, 0, 4, { ...region, x: 1024 }).promise;
    expect(priorPdfBitmap(pdf, 0)).toBe(full);
    expect(getPdfRenderStats(pdf)).toMatchObject({ renders: 3, bitmaps: 3 });
    expect(() => requestPdfTile(pdf, 0, 4, { x: 0, y: 0, width: 10000, height: 10000 })).toThrow(
      RangeError,
    );
  });
});

it('lost cached canvases are invalidated, and stale loss cannot remove a replacement', async () => {
  const { pdf, pending } = fixture();
  const first = requestPdfBitmap(pdf, 0, 1);
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  pending[0].resolve();
  const old = await first.promise;
  expect(getPdfRenderStats(pdf).bytes).toBe(240000);
  old.dispatchEvent(new Event('contextlost'));
  expect(priorPdfBitmap(pdf, 0)).toBeUndefined();
  expect(getPdfRenderStats(pdf)).toMatchObject({ bytes: 0, bitmaps: 0 });
  const next = requestPdfBitmap(pdf, 0, 1);
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending[1].resolve();
  const restored = await next.promise;
  expect(restored).not.toBe(old);
  invalidatePdfBitmap(old);
  old.dispatchEvent(new Event('contextlost'));
  expect(priorPdfBitmap(pdf, 0)).toBe(restored);
  expect(getPdfRenderStats(pdf)).toMatchObject({ bytes: 240000, bitmaps: 1, renders: 2 });
});

it('invalidating an evicted surface never changes the current cache accounting', async () => {
  const { pdf, pending } = fixture(3000, 2000);
  const canvases: HTMLCanvasElement[] = [];
  for (let i = 0; i < 26; i++) {
    const lease = requestPdfBitmap(pdf, i, 1);
    await vi.waitFor(() => expect(pending).toHaveLength(i + 1));
    pending[i].resolve();
    canvases.push(await lease.promise);
  }
  const before = getPdfRenderStats(pdf);
  invalidatePdfBitmap(canvases[0]);
  canvases[0].dispatchEvent(new Event('contextlost'));
  expect(getPdfRenderStats(pdf)).toEqual(before);
  expect(canvases[0]).toMatchObject({ width: 3000, height: 2000 });
});
it.each(['quality', 'eco'] as const)(
  '%s retains at least 15 pages and bounds older pages separately',
  async (mode) => {
    setPowerMode(mode);
    vi.stubGlobal('document', {
      createElement: () =>
        Object.assign(new EventTarget(), {
          width: 0,
          height: 0,
          dataset: {},
          getContext: () => ({ drawImage: () => {} }),
        }),
    });
    const pdf = {
      getPage: async () => ({
        getViewport: () => ({ width: 2000, height: 2000 }),
        render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
      }),
    } as unknown as PDFDocumentProxy;
    for (let i = 0; i < 30; i++) await requestPdfBitmap(pdf, i, 1).promise;
    const stats = getPdfRenderStats(pdf);
    expect(stats.pages).toBeGreaterThanOrEqual(15);
    expect(stats.pageBytes - 15 * 16_000_000).toBeLessThanOrEqual(renderPolicy().extraPageBytes);
    const renders = stats.renders;
    await requestPdfBitmap(pdf, 29, 1).promise;
    expect(getPdfRenderStats(pdf).renders).toBe(renders);
    setPdfViewCacheKey(pdf, 'new-zoom:dual');
    expect(getPdfRenderStats(pdf)).toMatchObject({ pages: 0, pageBytes: 0 });
  },
);
it('uses a pre-rendered half and renders only its missing half at the same scale', async () => {
  const clips: number[][] = [];
  vi.stubGlobal('document', {
    createElement: () =>
      Object.assign(new EventTarget(), {
        width: 0,
        height: 0,
        dataset: {},
        getContext: () => ({
          drawImage: () => {},
          save: () => {},
          restore: () => {},
          beginPath: () => {},
          rect: (...args: number[]) => clips.push(args),
          clip: () => {},
        }),
      }),
  });
  const calls: { height: number; transform?: number[] }[] = [];
  const pdf = {
    getPage: async () => ({
      getViewport: () => ({ width: 600, height: 801 }),
      render: (args: any) => {
        calls.push({ height: args.canvas.height, transform: args.transform });
        return { promise: Promise.resolve(), cancel: () => {} };
      },
    }),
  } as unknown as PDFDocumentProxy;
  await requestPdfHalf(pdf, 0, 1, 600, 801, 'top').promise;
  const full = await requestPdfBitmap(pdf, 0, 1).promise;
  expect(full.height).toBe(801);
  expect(calls).toEqual([
    { height: 801, transform: undefined },
    { height: 801, transform: undefined },
  ]);
  expect(clips).toEqual([
    [0, 0, 600, 402],
    [0, 398, 600, 403],
  ]);
});
