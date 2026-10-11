import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
const { PDFDocument, StandardFonts, degrees, rgb } = createRequire(import.meta.url)('pdf-lib');

test('高清瓦片在各视图只绘制可见区域，旋转裁切像素与整页参考一致，空白页释放细节层', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const angle of [90, 0, 270]) {
    const p = pdf.addPage([900, 700]);
    p.setCropBox(20, 30, 820, 620);
    p.setRotation(degrees(angle));
    for (let i = 0; i < 4000; i++)
      p.drawRectangle({
        x: 20 + ((i * 17) % 820),
        y: 30 + ((i * 13) % 620),
        width: 0.6,
        height: 5,
        color: rgb(0.15, 0.35, 0.75),
      });
    p.drawText('Detail rendering competitive', { x: 180, y: 350, font, size: 12 });
  }
  const bytes = Buffer.from(await pdf.save());
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'tiles.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const timings: Record<string, number> = {};
  for (const mode of ['单页标注', '连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    const started = performance.now();
    await page.locator(mode === '单页标注' ? '.surface' : '.reading-view').evaluate((el) => {
      const r = el.getBoundingClientRect(),
        paper = el.querySelector<HTMLElement>('.paper,.reading-paper')!,
        logical = Number.parseFloat(
          paper.classList.contains('paper')
            ? paper.style.width
            : paper.querySelector<HTMLElement>('.reading-content')!.style.width,
        ),
        zoom = paper.getBoundingClientRect().width / logical;
      el.dispatchEvent(
        new WheelEvent('wheel', {
          ctrlKey: true,
          deltaY: -Math.log(4 / zoom) / 0.008,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(page.locator('.zoom-dock>span')).toHaveText('400%');
    await expect
      .poll(() => page.locator('.pdf-detail-tile[data-ready=true]').count())
      .toBeGreaterThan(0);
    await expect
      .poll(() => page.locator('.pdf-detail-tile:not([data-ready=true])').count())
      .toBe(0);
    timings[mode] = Math.round(performance.now() - started);
    const budgets = await page.locator('.pdf-detail-layer').evaluateAll((layers) =>
      layers.map((layer) => ({
        pixels: Number(layer.getAttribute('data-pixels')),
        count: layer.children.length,
        max: Math.max(
          0,
          ...Array.from(layer.querySelectorAll('canvas')).map((c) => c.width * c.height),
        ),
      })),
    );
    for (const b of budgets) {
      expect(b.pixels).toBeLessThanOrEqual(6_000_000);
      expect(b.count).toBeLessThanOrEqual(32);
      expect(b.max).toBeLessThanOrEqual(512 * 512);
    }
    if (mode === '单页标注') {
      const result = await page.evaluate(async (base64) => {
        const { loadPdf } = await import('/src/pdf.ts' as string),
          pdf = await loadPdf(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))),
          p = await pdf.getPage(1);
        const scale = Number(
            document.querySelector('.pdf-detail-tile')!.getAttribute('data-scale'),
          ),
          viewport = p.getViewport({ scale }),
          full = document.createElement('canvas');
        full.width = Math.ceil(viewport.width);
        full.height = Math.ceil(viewport.height);
        await p.render({ canvas: full, viewport }).promise;
        let sum = 0,
          mismatches = 0,
          samples = 0,
          dark = 0,
          maxPositionError = 0;
        const paper = document.querySelector('.paper')!.getBoundingClientRect();
        for (const tile of document.querySelectorAll<HTMLElement>(
          '.pdf-detail-tile[data-ready=true]',
        )) {
          const c = tile.querySelector('canvas')!,
            x = Number(tile.dataset.x),
            y = Number(tile.dataset.y),
            a = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data,
            b = full.getContext('2d')!.getImageData(x, y, c.width, c.height).data;
          const rect = tile.getBoundingClientRect();
          maxPositionError = Math.max(
            maxPositionError,
            Math.abs(rect.left - (paper.left + (x / scale) * 4)),
            Math.abs(rect.top - (paper.top + (y / scale) * 4)),
            Math.abs(rect.width - (c.width / scale) * 4),
          );
          for (let i = 0; i < a.length; i += 4) {
            const diff = Math.max(
              Math.abs(a[i] - b[i]),
              Math.abs(a[i + 1] - b[i + 1]),
              Math.abs(a[i + 2] - b[i + 2]),
            );
            sum += diff;
            samples++;
            if (diff > 16) mismatches++;
            if (a[i] < 220) dark++;
          }
        }
        await pdf.destroy();
        return {
          meanError: sum / samples,
          mismatchRatio: mismatches / samples,
          dark,
          maxPositionError,
          fullPixels: full.width * full.height,
        };
      }, bytes.toString('base64'));
      expect(result.dark).toBeGreaterThan(1000);
      expect(result.meanError).toBeLessThan(1);
      expect(result.mismatchRatio).toBeLessThan(0.01);
      expect(result.maxPositionError).toBeLessThan(0.1);
      console.log(JSON.stringify({ rotatedCropPixelComparison: result }));
    }
    const keys = () =>
      page.locator('.pdf-detail-tile').evaluateAll((tiles) =>
        tiles
          .map(
            (t) =>
              `${t.getAttribute('data-scale')}:${t.getAttribute('data-x')}:${t.getAttribute('data-y')}`,
          )
          .sort()
          .join('|'),
      );
    const before = await keys();
    await page.locator(mode === '单页标注' ? '.surface' : '.reading-view').evaluate((el) => {
      if (el.classList.contains('surface')) {
        const tile = el.querySelector<HTMLElement>('.pdf-detail-tile')!,
          step = Math.ceil(tile.getBoundingClientRect().width) + 32;
        el.dispatchEvent(
          new WheelEvent('wheel', { deltaX: step, deltaY: step, bubbles: true, cancelable: true }),
        );
      } else {
        const tile = el.querySelector<HTMLElement>('.pdf-detail-tile')!,
          step = Math.ceil(tile.getBoundingClientRect().width) + 32;
        el.scrollLeft += step;
        el.scrollTop += step;
      }
    });
    await expect.poll(keys).not.toBe(before);
    await expect
      .poll(() => page.locator('.pdf-detail-tile:not([data-ready=true])').count())
      .toBe(0);
    await expect(page.locator('.preview-toggle')).toHaveCount(0);
    await expect
      .poll(() => page.locator('.pdf-detail-tile[data-ready=true]').count())
      .toBeGreaterThan(0);
  }
  await page.getByRole('button', { name: '单页标注', exact: true }).click();
  await page.getByRole('button', { name: '插入空白页', exact: true }).click();
  await expect(page.locator('.pdf-detail-tile')).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ detailReadyMs: timings }));
});

test('2× DPI 高清细节不遮挡插图和笔迹，各模式图层正确，保持高清补绘', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  try {
    await page.goto('http://127.0.0.1:5173');
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    const image = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = c.height = 100;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, 100, 100);
      return c.toDataURL();
    });
    const pdf = await PDFDocument.create();
    const source = pdf.addPage([1000, 1000]);
    source.drawRectangle({ x: 0, y: 0, width: 1000, height: 1000, color: rgb(0, 0, 1) });
    pdf.addPage([1000, 1000]);
    const p = {
      id: 'dpi-page',
      sourceIndex: 0,
      width: 1000,
      height: 1000,
      paper: 'plain',
      images: [{ id: 'red', kind: 'sketch', data: image, x: 450, y: 450, width: 100, height: 100 }],
      strokes: [
        {
          id: 'black',
          tool: 'ballpoint',
          color: '#000000',
          size: 6,
          points: [
            [460, 500, 0.5],
            [540, 500, 0.5],
          ],
        },
      ],
    };
    const project = {
      version: 1,
      name: 'DPI layers',
      source: Buffer.from(await pdf.save()).toString('base64'),
      pages: [p, { ...p, id: 'dpi-page-2', sourceIndex: 1, images: [], strokes: [] }],
    };
    await page.locator('input[type=file]').setInputFiles({
      name: 'dpi.surfacetab',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(project)),
    });
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    const pixel = async (x: number, y: number) => {
      const png = await page.screenshot({
          clip: { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 },
        }),
        chunks = [];
      for (let offset = 8; offset < png.length;) {
        const length = png.readUInt32BE(offset),
          type = png.toString('ascii', offset + 4, offset + 8);
        if (type === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
        offset += length + 12;
      }
      return Array.from(inflateSync(Buffer.concat(chunks)).subarray(1, 4));
    };
    for (const mode of ['单页标注', '连续页面预览', '双页预览']) {
      await page.getByRole('button', { name: mode, exact: true }).click();
      const root = page.locator(mode === '单页标注' ? '.surface' : '.reading-view');
      await root.evaluate((el) => {
        const r = el.getBoundingClientRect(),
          paper = el.querySelector<HTMLElement>('.paper,.reading-paper')!,
          logical = Number.parseFloat(
            paper.classList.contains('paper')
              ? paper.style.width
              : paper.querySelector<HTMLElement>('.reading-content')!.style.width,
          ),
          zoom = paper.getBoundingClientRect().width / logical;
        el.dispatchEvent(
          new WheelEvent('wheel', {
            ctrlKey: true,
            deltaY: -Math.log(4 / zoom) / 0.008,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      const object = page
        .locator(mode === '单页标注' ? '.placed-object img' : '.reading-content>img')
        .first();
      await object.scrollIntoViewIfNeeded();
      await expect
        .poll(() => page.locator('.pdf-detail-tile[data-ready=true]').count())
        .toBeGreaterThan(0);
      await expect
        .poll(() => page.locator('.pdf-detail-tile:not([data-ready=true])').count())
        .toBe(0);
      const rect = (await object.boundingBox())!;
      expect(await pixel(rect.x + rect.width / 2, rect.y + rect.height * 0.2)).toEqual([255, 0, 0]);
      const black = await pixel(rect.x + rect.width / 2, rect.y + rect.height / 2);
      expect(Math.max(...black)).toBeLessThan(30);
      const budget = await page
        .locator('.pdf-detail-layer')
        .evaluateAll((layers) => layers.map((el) => Number(el.getAttribute('data-pixels'))));
      const limit = await page.evaluate(
        async () => (await import('/src/appearance.ts' as string)).renderPolicy().detailPixels,
      );
      for (const pixels of budget) expect(pixels).toBeLessThanOrEqual(limit);
      await expect(page.locator('.preview-toggle')).toHaveCount(0);
    }
    await page.screenshot({ path: 'test-results/detail-dpi-layers.png' });
  } finally {
    await context.close();
  }
});

test('两万个矢量元素：高清瓦片重复命中、平移只补缺块、共享缓存遵守内存上限', async ({ page }) => {
  test.setTimeout(120000);
  const doc = await PDFDocument.create(),
    p = doc.addPage([1200, 1600]);
  for (let i = 0; i < 20000; i++)
    p.drawRectangle({
      x: (i * 17) % 1200,
      y: (i * 13) % 1600,
      width: 2,
      height: 2,
      color: rgb(0.2, 0.3, 0.6),
    });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const result = await page.evaluate(
    async (base64) => {
      const { loadPdf } = await import('/src/pdf.ts' as string),
        { requestPdfBitmap, requestPdfTile, getPdfRenderStats } = await import(
          '/src/pdfRenderCache.ts' as string
        ),
        { planPdfTiles } = await import('/src/pdfTiles.ts' as string);
      const pdf = await loadPdf(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
      const start = performance.now();
      await requestPdfBitmap(pdf, 0, Math.sqrt(6_000_000 / (1200 * 1600)), 0).promise;
      const previewMs = performance.now() - start;
      const plan = planPdfTiles(1200, 1600, { x: 300, y: 550, width: 350, height: 225 }, 6);
      const draw = (p: typeof plan) =>
        Promise.all(p.tiles.map((tile) => requestPdfTile(pdf, 0, p.scale, tile, 0).promise));
      const detailStart = performance.now();
      await draw(plan);
      const detailMs = performance.now() - detailStart,
        first = getPdfRenderStats(pdf);
      const repeatStart = performance.now();
      await draw(plan);
      const repeatMs = performance.now() - repeatStart,
        repeat = getPdfRenderStats(pdf);
      const pan = planPdfTiles(1200, 1600, { x: 325, y: 570, width: 350, height: 225 }, 6),
        overlap = pan.tiles.filter((t) =>
          plan.tiles.some((u) => u.x === t.x && u.y === t.y),
        ).length;
      const panStart = performance.now();
      await draw(pan);
      const panMs = performance.now() - panStart,
        final = getPdfRenderStats(pdf);
      await pdf.destroy();
      return {
        previewMs,
        detailMs,
        repeatMs,
        panMs,
        planPixels: plan.pixels,
        detailTiles: plan.tiles.length,
        panTiles: pan.tiles.length,
        overlap,
        first,
        repeat,
        final,
        theoreticalFullAtScale6Pixels: 1200 * 1600 * 36,
      };
    },
    Buffer.from(await doc.save()).toString('base64'),
  );
  expect(result.planPixels).toBeLessThanOrEqual(6_000_000);
  expect(result.repeat.renders).toBe(result.first.renders);
  expect(result.repeat.hits - result.first.hits).toBe(result.detailTiles);
  expect(result.overlap).toBeGreaterThan(result.panTiles / 2);
  expect(result.final.renders - result.repeat.renders).toBe(result.panTiles - result.overlap);
  expect(result.final.hits - result.repeat.hits).toBe(result.overlap);
  expect(result.final.bytes).toBeLessThanOrEqual(48 * 1024 * 1024);
  expect(result.final.running + result.final.queued).toBe(0);
  console.log(JSON.stringify({ denseVectorBenchmark: result }));
});
