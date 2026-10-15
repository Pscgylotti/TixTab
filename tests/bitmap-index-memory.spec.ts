import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts, degrees } = createRequire(import.meta.url)('pdf-lib');
test('whole-document indexing sends no decoded images/fonts, agrees with the render index and releases OCR page pixels', async ({
  page,
}) => {
  const d = await PDFDocument.create(),
    font = await d.embedFont(StandardFonts.Helvetica);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const image = await d.embedPng(png);
  for (let i = 0; i < 12; i++) {
    const p = d.addPage([400, 600]);
    p.drawText('Index only', { x: 30, y: 560, font, size: 16 });
    p.drawImage(image, { x: 40, y: 100, width: 80, height: 60 });
    p.drawImage(image, { x: 200, y: 200, width: 90, height: 70, rotate: degrees(20) });
  }
  await page.goto('/');
  const result = await page.evaluate(
    async (bytes) => {
      const NativeWorker = window.Worker;
      let created = 0,
        terminated = 0;
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          created++;
        }
        terminate() {
          terminated++;
          super.terminate();
        }
      };
      const { loadPdf, destroyPdf } = await import('/src/pdf.ts' as string);
      const { getPdfImages } = await import('/src/pdfNight.ts' as string);
      const { scanBitmapPages } = await import('/src/bitmapOcr.ts' as string);
      const { getPdfiumStats } = await import('/src/pdfiumRaster.ts' as string);
      const pdf = await loadPdf(new Uint8Array(bytes));
      const beforeStats = getPdfiumStats();
      try {
        const indexed = [];
        for (let i = 0; i < 12; i++) indexed.push(await getPdfImages(pdf, i));
        const before = getPdfiumStats();
        const pages = Array.from({ length: 12 }, (_, i) => ({
          id: String(i),
          sourceIndex: i,
          width: 400,
          height: 600,
          images: [],
          strokes: [],
          paper: 'plain',
        }));
        let completed = 0;
        await scanBitmapPages(pages, pdf, {
          signal: new AbortController().signal,
          replace: false,
          concurrency: 2,
          inventory: {
            total: 24,
            parsed: 0,
            pdfImages: new Map(indexed.map((p, i) => [String(i), p])),
          },
          recognize: async () => ({ text: 'index word', engine: 'test' }),
          onPage: () => {},
          onImage: () => {
            completed++;
          },
        });
        const afterScan = getPdfiumStats(),
          ownership = { created, terminated };
        return {
          before,
          beforeStats,
          afterScan,
          ownership,
          completed,
          counts: indexed.map((a) => a.length),
          indexed: indexed[0],
        };
      } finally {
        await destroyPdf(pdf);
        window.Worker = NativeWorker;
      }
    },
    Array.from(await d.save()),
  );
  expect(result.before.decoderWorkers).toBe(0);
  expect(result.before.renders).toBe(result.beforeStats.renders);
  expect(result.counts).toEqual(Array(12).fill(2));
  expect(result.afterScan.decoderWorkers).toBe(0);
  expect(result.afterScan.renders).toBe(result.beforeStats.renders);
  expect(result.completed).toBe(24);
  expect(result.ownership).toEqual({ created: 2, terminated: 1 });
  expect(result.indexed[0]).toEqual([40, 100, 120, 100, 120, 160, 40, 160]);
});
