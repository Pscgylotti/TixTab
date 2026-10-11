import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  getPdfRenderStats,
  priorPdfBitmap,
  requestPdfBitmap,
  requestPdfTile,
} from './pdfRenderCache';

afterEach(() => vi.unstubAllGlobals());
function fixture(width = 200, height = 300) {
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }),
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
  it('两路并行，当前页优先于排队缩略图，重复请求共用绘制', async () => {
    const { pdf, starts, pending } = fixture();
    const a = requestPdfBitmap(pdf, 0, 1, 2),
      shared = requestPdfBitmap(pdf, 0, 1, 0),
      b = requestPdfBitmap(pdf, 1, 1, 2),
      c = requestPdfBitmap(pdf, 2, 1, 2),
      foreground = requestPdfBitmap(pdf, 3, 1, 0);
    await Promise.resolve();
    expect(starts).toEqual([1, 2]);
    expect(getPdfRenderStats(pdf)).toMatchObject({ running: 2, queued: 2 });
    a.cancel();
    pending[0].resolve();
    const [image, image2] = await Promise.all([a.promise, shared.promise]);
    expect(image).toBe(image2);
    await Promise.resolve();
    expect(starts).toEqual([1, 2, 4]);
    pending[1].resolve();
    await b.promise;
    await Promise.resolve();
    expect(starts).toEqual([1, 2, 4, 3]);
    pending[2].resolve();
    pending[3].resolve();
    await Promise.all([foreground.promise, c.promise]);
    expect(await requestPdfBitmap(pdf, 0, 1).promise).toBe(image);
    expect(getPdfRenderStats(pdf)).toMatchObject({ renders: 4, hits: 1, running: 0 });
  });
  it('取消队列任务不会绘制；取消一个订阅不会取消仍在使用的共享任务', async () => {
    const { pdf, starts, pending } = fixture();
    const a = requestPdfBitmap(pdf, 0, 1),
      b = requestPdfBitmap(pdf, 1, 1),
      c = requestPdfBitmap(pdf, 2, 1);
    const rejection = expect(c.promise).rejects.toMatchObject({ name: 'AbortError' });
    c.cancel();
    await rejection;
    await Promise.resolve();
    expect(starts).toEqual([1, 2]);
    pending[0].resolve();
    pending[1].resolve();
    await Promise.all([a.promise, b.promise]);
    expect(getPdfRenderStats(pdf)).toMatchObject({ queued: 0, running: 0 });
  });
  it('缓存按实际像素字节回收，保持 48MiB 上限', async () => {
    const { pdf, pending } = fixture(3000, 2000);
    for (let i = 0; i < 3; i++) {
      const lease = requestPdfBitmap(pdf, i, 1);
      await Promise.resolve();
      pending[i].resolve();
      await lease.promise;
    }
    expect(getPdfRenderStats(pdf)).toMatchObject({ bytes: 48_000_000, bitmaps: 2, renders: 3 });
  });
  it('高清瓦片只分配局部画布，裁切变换准确；共享缓存不会把瓦片当整页预览', async () => {
    vi.stubGlobal('document', {
      createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }),
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
