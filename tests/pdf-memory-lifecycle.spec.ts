import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, rgb } = createRequire(import.meta.url)('pdf-lib');
test('document cache retirement releases actual canvas buffers without clearing visible pixels', async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 15; i++) {
    const p = doc.addPage([200, 300]);
    p.drawRectangle({ x: 0, y: 0, width: 200, height: 300, color: rgb(1, 0, 0) });
  }
  await page.goto('/');
  const result = await page.evaluate(
    async (bytes) => {
      const { loadPdf } = await import('/src/pdf.ts' as string),
        c = await import('/src/pdfRenderCache.ts' as string),
        { PdfBitmapDisplay } = await import('/src/pdfBitmapDisplay.ts' as string);
      const pdf = await loadPdf(new Uint8Array(bytes)),
        canvases: HTMLCanvasElement[] = [];
      for (let i = 0; i < 15; i++)
        canvases.push(await c.requestPdfBitmap(pdf, i, 1, 0, false).promise);
      const host = document.createElement('div'),
        copyHost = document.createElement('div');
      document.body.append(host, copyHost);
      const display = new PdfBitmapDisplay(host, 'memory-test', () => {}),
        copy = new PdfBitmapDisplay(copyHost, 'memory-copy', () => {});
      display.show(canvases[0], false);
      copy.show(canvases[0], false);
      const copied = copyHost.firstChild as HTMLCanvasElement,
        before = c.getPdfRenderStats(pdf),
        pixel = () => Array.from(canvases[0].getContext('2d')!.getImageData(10, 10, 1, 1).data);
      const originalPixel = pixel();
      c.releasePdfRenderCache(pdf);
      const after = c.getPdfRenderStats(pdf),
        visiblePixel = pixel(),
        detached = canvases.slice(1).map((c) => [c.width, c.height]);
      copy.dispose();
      const copySize = [copied.width, copied.height];
      display.dispose();
      const sizes = canvases.map((c) => [c.width, c.height]);
      host.remove();
      copyHost.remove();
      await pdf.destroy();
      return { before, after, originalPixel, visiblePixel, detached, copySize, sizes };
    },
    Array.from(await doc.save()),
  );
  expect(result.before.pages).toBe(15);
  expect(result.before.bytes).toBe(15 * 200 * 300 * 4);
  expect(result.after.bytes).toBe(0);
  expect(result.after.pages).toBe(0);
  expect(result.originalPixel).toEqual([255, 0, 0, 255]);
  expect(result.visiblePixel).toEqual(result.originalPixel);
  expect(result.detached.every((s: number[]) => s[0] === 1 && s[1] === 1)).toBe(true);
  expect(result.copySize).toEqual([1, 1]);
  expect(result.sizes.every((s: number[]) => s[0] === 1 && s[1] === 1)).toBe(true);
});
