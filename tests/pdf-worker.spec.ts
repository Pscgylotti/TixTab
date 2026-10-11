import { test, expect } from '@playwright/test';
import { verifyPdfWorkerUi } from '../scripts/verify-pdf-worker-ui.mjs';
import { verifyPdfUi } from '../scripts/verify-pdf-ui.mjs';
import { preservationFixture } from '../scripts/pdf-preservation-fixture.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

test('PDF export worker UI cancellation, recovery and portrait theme', async ({ page }) => {
  await page.goto('/');
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await verifyPdfUi(page);
  await verifyPdfWorkerUi(page);
});

test('real PDF worker script load failure releases export lane for retry', async ({ page }) => {
  await page.goto('/');
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.route('**/pdfExport.worker.ts*', (route) => route.abort());
  const failed = await page.evaluate(async () => {
    const { exportPdf } = await import('/src/pdfExportClient.ts' as string),
      { newNotebook } = await import('/src/model.ts' as string);
    try {
      await exportPdf(newNotebook());
      return '';
    } catch (error) {
      return (error as Error).message;
    }
  });
  expect(failed).toContain('后台 PDF 导出不可用');
  await page.unroute('**/pdfExport.worker.ts*');
  expect(
    await page.evaluate(async () => {
      const { exportPdf } = await import('/src/pdfExportClient.ts' as string),
        { newNotebook } = await import('/src/model.ts' as string);
      return (await exportPdf(newNotebook())).byteLength;
    }),
  ).toBeGreaterThan(100);
});

test('dense PDF export keeps the UI responsive and transfers source safely', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await page.goto('/');
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  const result = await page.evaluate(
    async (bytes) => {
      const { importPdf, loadPdf } = await import('/src/pdf.ts' as string),
        { exportPdf: background } = await import('/src/pdfExportClient.ts' as string),
        { exportPdf: foreground } = await import('/src/pdfExport.ts' as string);
      const { finalInkPath } = await import('/src/ink.ts' as string);
      const { notebook, pdf } = await importPdf(new Uint8Array(bytes), 'dense-worker.pdf');
      // Identical uncached pressure strokes for the baseline and worker. The source
      // fixture also contains ordinary fields, annotations and rotated/cropped pages.
      notebook.pages = notebook.pages.slice(0, 4);
      notebook.pages.forEach((p: any, k: number) => {
        p.strokes = Array.from({ length: 350 }, (_, j) => ({
          id: `${k}-${j}`,
          tool: j % 3 ? 'pen' : 'pencil',
          color: '#224488',
          size: 2,
          points: Array.from({ length: 96 }, (_, i) => [
            20 + ((i * 2 + j) % 240),
            70 + (j % 300) + Math.sin(i * 0.2) * 8,
            0.2 + (i % 7) / 10,
          ]),
        }));
      });
      const baseline = structuredClone(notebook);
      async function timed(run: () => Promise<Uint8Array>) {
        const gaps: number[] = [];
        let last = performance.now(),
          frame = 0;
        const tick = () => {
          const now = performance.now();
          gaps.push(now - last);
          last = now;
          frame = requestAnimationFrame(tick);
        };
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => {
            last = performance.now();
            frame = requestAnimationFrame(tick);
            resolve();
          }),
        );
        const start = performance.now(),
          output = await run(),
          ms = performance.now() - start;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        cancelAnimationFrame(frame);
        return { output, ms, frames: gaps.length, maxFrameGapMs: Math.max(0, ...gaps) };
      }
      const main = await timed(() => foreground(baseline)),
        stages: string[] = [];
      const worker = await timed(() =>
        background(notebook, { onProgress: (p: any) => stages.push(p.stage) }),
      );
      const same =
        main.output.length === worker.output.length &&
        main.output.every((v, i) => v === worker.output[i]);
      const output = await loadPdf(worker.output),
        text = await (await output.getPage(1)).getTextContent(),
        fields = await output.getFieldObjects();
      const controller = new AbortController();
      let cancelled = '';
      try {
        await background(notebook, {
          signal: controller.signal,
          onProgress: (p: any) => {
            if (p.stage === 'loading') controller.abort();
          },
        });
      } catch (error) {
        cancelled = (error as Error).name;
      }
      // Reuse display paths already calculated for completed ink. This is an actual
      // cache reuse path, without computing outlines on the main thread in export.
      notebook.pages.forEach((p: any) => p.strokes.forEach(finalInkPath));
      const cached = await timed(() => background(notebook));
      const out = {
        points: 4 * 350 * 96,
        main: { ms: main.ms, frames: main.frames, maxFrameGapMs: main.maxFrameGapMs },
        worker: { ms: worker.ms, frames: worker.frames, maxFrameGapMs: worker.maxFrameGapMs },
        cached: { ms: cached.ms, frames: cached.frames, maxFrameGapMs: cached.maxFrameGapMs },
        same,
        cachedSame:
          cached.output.length === worker.output.length &&
          cached.output.every((v, i) => v === worker.output[i]),
        stages,
        cancelled,
        sourceAttached:
          notebook.source!.byteLength === bytes.length &&
          notebook.source!.every((v: number, i: number) => v === bytes[i]),
        pages: output.numPages,
        field: fields?.['group.field-0']?.some((v: any) => v.value === 'value-0'),
        text: text.items.map((i: any) => i.str).join(' '),
      };
      await pdf.destroy();
      await output.destroy();
      return out;
    },
    Array.from(await preservationFixture()),
  );
  expect(result.same).toBe(true);
  expect(result.cachedSame).toBe(true);
  expect(result.sourceAttached).toBe(true);
  expect(result.cancelled).toBe('AbortError');
  expect(result.pages).toBe(4);
  expect(result.field).toBe(true);
  expect(result.text).toContain('Original page 1');
  expect(result.stages).toEqual(
    expect.arrayContaining(['preparing', 'loading', 'structure', 'annotations', 'saving']),
  );
  expect(result.worker.frames).toBeGreaterThan(10);
  expect(result.worker.maxFrameGapMs).toBeLessThan(result.main.maxFrameGapMs * 0.65);
  await mkdir('docs/benchmarks', { recursive: true });
  await writeFile(
    'docs/benchmarks/pdf-export-worker-20261011.json',
    JSON.stringify(result, null, 2) + '\n',
  );
  await info.attach('pdf-export-worker.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  console.log(JSON.stringify({ pdfExportWorker: result }));
});
