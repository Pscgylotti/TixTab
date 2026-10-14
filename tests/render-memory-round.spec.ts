import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
const { PDFDocument, rgb } = createRequire(import.meta.url)('pdf-lib');

test('half-page pre-render releases scratch buffers while preserving full-page pixels and cache', async ({
  page,
}) => {
  const doc = await PDFDocument.create(),
    p = doc.addPage([600, 800]);
  p.drawRectangle({ x: 0, y: 0, width: 600, height: 800, color: rgb(1, 0, 0) });
  p.drawRectangle({ x: 33.3, y: 390.1, width: 250.5, height: 42.7, color: rgb(0, 0, 1) });
  await page.goto('/');
  const result = await page.evaluate(
    async (bytes) => {
      const { loadPdf, destroyPdf } = await import('/src/pdf.ts' as string),
        cache = await import('/src/pdfRenderCache.ts' as string);
      const pdf = await loadPdf(new Uint8Array(bytes)),
        reference = await loadPdf(new Uint8Array(bytes));
      const created: HTMLCanvasElement[] = [];
      const create = document.createElement.bind(document);
      document.createElement = ((...args: Parameters<typeof create>) => {
        const element = create(...args);
        if (element instanceof HTMLCanvasElement) created.push(element);
        return element;
      }) as typeof document.createElement;
      const leases: { promise: Promise<HTMLCanvasElement>; cancel: () => void }[] = [];
      try {
        leases.push(cache.requestPdfHalf(pdf, 0, 2, 600, 800, 'top'));
        const top = await leases[0].promise;
        const retainedScratch = created
          .filter((c) => c !== top && c.width >= 1000 && c.height >= 800)
          .reduce((sum, c) => sum + c.width * c.height * 4, 0);
        leases.push(cache.requestPdfBitmap(pdf, 0, 2, 0, false));
        const full = await leases[1].promise;
        leases.push(cache.requestPdfBitmap(reference, 0, 2, 0, false));
        const expected = await leases[2].promise;
        const hash = async (canvas: HTMLCanvasElement) =>
          Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                'SHA-256',
                canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data,
              ),
            ),
          )
            .map((n) => n.toString(16).padStart(2, '0'))
            .join('');
        const actualHash = await hash(full),
          referenceHash = await hash(expected);
        return {
          retainedScratch,
          actualHash,
          referenceHash,
          stats: cache.getPdfRenderStats(pdf),
          size: [full.width, full.height],
        };
      } finally {
        document.createElement = create;
        leases.forEach((lease) => lease.cancel());
        await destroyPdf(pdf);
        await destroyPdf(reference);
      }
    },
    Array.from(await doc.save()),
  );
  expect(result.actualHash).toBe(result.referenceHash);
  expect(result.size).toEqual([1200, 1600]);
  expect(result.stats.pages).toBe(1);
  if (process.env.TIXTAB_MEMORY_ROUND !== 'before') expect(result.retainedScratch).toBe(0);
  await writeFile(
    `.cache/render-memory-round-${process.env.TIXTAB_MEMORY_ROUND || 'after'}.json`,
    JSON.stringify(result, null, 2),
  );
});
