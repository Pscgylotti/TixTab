import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts, rgb, degrees } = createRequire(import.meta.url)('pdf-lib');

async function fixture(page: Page, dense = false) {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 80;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#cc2233';
    ctx.fillRect(0, 0, 80, 80);
    return c.toDataURL();
  });
  const image = await doc.embedPng(png);
  for (let i = 0; i < 3; i++) {
    const p = doc.addPage([600, 800]);
    p.setCropBox(40, 60, 400, 600);
    if (i === 1) p.setRotation(degrees(90));
    p.drawRectangle({ x: 80, y: 100, width: 120, height: 100, color: rgb(0.1, 0.7, 0.3) });
    p.drawImage(image, { x: 260, y: 300, width: 100, height: 80 });
    p.drawText(`PDFium text selection page ${i + 1}`, { x: 60, y: 550, size: 16, font });
    if (dense)
      for (let n = 0; n < 6000; n++)
        p.drawText('Progressive render cancellation', {
          x: 50 + (n % 10),
          y: 80 + (n % 550),
          size: 7,
          font,
        });
  }
  return Buffer.from(await doc.save());
}

test('real PDFium renders cropped/rotated pages, consistent tiles and night colors, then releases documents while retaining the engine', async ({
  page,
}) => {
  await page.goto('/');
  const bytes = await fixture(page);
  const result = await page.evaluate(async (bytes) => {
    const { loadPdf } = await import('/src/pdf.ts');
    const { setPdfRenderBackend } = await import('/src/appearance.ts');
    const { requestPdfBitmap, requestPdfTile } = await import('/src/pdfRenderCache.ts');
    const { getPdfiumStats } = await import('/src/pdfiumRaster.ts');
    const pdf = await loadPdf(new Uint8Array(bytes));
    setPdfRenderBackend('pdfium');
    const checks = [];
    for (const index of [0, 1]) {
      const p = await pdf.getPage(index + 1),
        viewport = p.getViewport({ scale: 1.5 });
      const reference = document.createElement('canvas');
      reference.width = Math.ceil(viewport.width);
      reference.height = Math.ceil(viewport.height);
      await p.render({ canvas: reference, viewport }).promise;
      // The actual candidate must never silently fall back to PDF.js rendering.
      p.render = () => {
        throw new Error('unexpected PDF.js raster');
      };
      const full = await requestPdfBitmap(pdf, index, 1.5).promise;
      const ctx = full.getContext('2d')!;
      const expected = reference
        .getContext('2d')!
        .getImageData(0, 0, reference.width, reference.height).data;
      const actual = ctx.getImageData(0, 0, full.width, full.height).data;
      let colored = 0,
        correct = 0;
      for (let i = 0; i < expected.length; i += 4) {
        if (
          (expected[i] < 40 && expected[i + 1] > 150 && expected[i + 2] < 90) ||
          (expected[i] > 190 && expected[i + 1] < 45 && expected[i + 2] < 65)
        ) {
          colored++;
          if ([0, 1, 2].every((c) => Math.abs(expected[i + c] - actual[i + c]) <= 3)) correct++;
        }
      }
      const region = { x: 103, y: 127, width: 271, height: 319 };
      const tile = await requestPdfTile(pdf, index, 1.5, region, 0).promise;
      const crop = ctx.getImageData(region.x, region.y, region.width, region.height).data;
      const tilePixels = tile.getContext('2d')!.getImageData(0, 0, tile.width, tile.height).data;
      let different = 0;
      for (let i = 0; i < crop.length; i++) if (Math.abs(crop[i] - tilePixels[i]) > 3) different++;
      const night = await requestPdfBitmap(pdf, index, 1.5, 0, true).promise;
      const dark = night.getContext('2d')!.getImageData(0, 0, 1, 1).data;
      checks.push({
        backend: full.dataset.pdfBackend,
        width: full.width,
        height: full.height,
        colored,
        fidelity: correct / colored,
        tileDifference: different / crop.length,
        dark: Array.from(dark),
      });
      reference.width = reference.height = 1;
    }
    const before = getPdfiumStats();
    await pdf.destroy();
    for (let n = 0; n < 200 && getPdfiumStats().pending; n++)
      await new Promise((r) => setTimeout(r, 10));
    return { checks, before, after: getPdfiumStats() };
  }, Array.from(bytes));
  for (const row of result.checks) {
    expect(row.backend).toBe('pdfium');
    expect(row.colored).toBeGreaterThan(20000);
    expect(row.fidelity).toBeGreaterThan(0.99);
    expect(row.tileDifference).toBeLessThan(0.005);
    expect(Math.max(...row.dark.slice(0, 3))).toBeLessThan(70);
  }
  expect(result.before.renders).toBeGreaterThanOrEqual(4);
  expect(result.before.workers).toBe(1);
  expect(result.after).toMatchObject({
    workers: 1,
    pending: 0,
    documents: 0,
    sessions: 0,
    initializations: 1,
  });
});

test('PDFium UI works in all views with native text and image interactions, and can switch back', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('tixtab.pdfRenderBackend', 'pdfium'));
  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles({
    name: 'pdfium.pdf',
    mimeType: 'application/pdf',
    buffer: await fixture(page),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  for (const view of ['单页标注', '连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await expect(page.locator('canvas[data-pdf-backend=pdfium]').first()).toBeVisible();
    await page.getByRole('button', { name: '选文', exact: true }).click();
    await expect(
      page.locator('.textLayer span').filter({ hasText: 'PDFium text selection' }).first(),
    ).toBeVisible();
  }
  await page.getByRole('button', { name: '单页标注', exact: true }).click();
  await page.getByRole('button', { name: '移动', exact: true }).click();
  await page.getByRole('button', { name: '适合页面', exact: true }).click();
  const paper = (await page.locator('.paper').boundingBox())!;
  await page.mouse.dblclick(
    paper.x + (paper.width * 270) / 400,
    paper.y + (paper.height * 320) / 600,
  );
  const original = page.getByRole('dialog', { name: '原图', exact: true });
  await expect(original).toBeVisible();
  await expect
    .poll(() => original.locator('canvas').evaluate((c: HTMLCanvasElement) => c.width))
    .toBe(80);
  await original.getByRole('button', { name: '关闭原图', exact: true }).click();
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await expect(
    page.locator('.pdf-layer[data-pdf-backend=pdfium][data-rendered-night=true]'),
  ).toBeVisible();
  for (let i = 0; i < 12; i++)
    await page.getByRole('button', { name: '放大', exact: true }).click();
  await expect(
    page.locator('.pdf-detail-tile[data-ready=true] canvas[data-pdf-backend=pdfium]').first(),
  ).toBeVisible();
  // Switch via the actual settings control, not only the internal API.
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const setting = page.getByRole('combobox', { name: 'PDF 渲染引擎', exact: true });
  await expect(setting).toHaveValue('pdfium');
  await setting.selectOption('pdfjs');
  await expect(page.locator('.pdf-layer[data-pdf-backend=pdfjs]')).toBeAttached();
  await expect
    .poll(() =>
      page.evaluate(async () => (await import('/src/pdfiumRaster.ts')).getPdfiumStats().documents),
    )
    .toBe(0);
  expect(
    await page.evaluate(
      async () => (await import('/src/pdfiumRaster.ts')).getPdfiumStats().workers,
    ),
  ).toBe(1);
});

test('PDFium progressive work cancels while paused and repeated document close reuses one resident engine without retaining documents', async ({
  page,
}) => {
  await page.goto('/');
  const bytes = await fixture(page, true);
  const result = await page.evaluate(async (bytes) => {
    const { loadPdf } = await import('/src/pdf.ts');
    const { renderPdfium, getPdfiumStats } = await import('/src/pdfiumRaster.ts');
    const drained = async () => {
      for (let n = 0; n < 200 && getPdfiumStats().pending; n++)
        await new Promise((r) => setTimeout(r, 10));
      return getPdfiumStats();
    };
    const pdf = await loadPdf(new Uint8Array(bytes));
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 1200;
    const task = renderPdfium(pdf, 0, canvas, 800, 1200, { x: 0, y: 0, width: 800, height: 1200 });
    let yielded = false;
    const paused = new Promise<void>(
      (resolve) =>
        (task.onContinue = () => {
          yielded = true;
          resolve();
        }),
    );
    const rejected = task.promise.then(
      () => false,
      () => true,
    );
    await Promise.race([paused, task.promise]);
    task.cancel();
    const cancelled = await rejected;
    const next = renderPdfium(pdf, 1, canvas, 800, 1200, { x: 0, y: 0, width: 800, height: 1200 });
    await next.promise;
    await pdf.destroy();
    const snapshots = [await drained()];
    for (let n = 0; n < 2; n++) {
      const document = await loadPdf(new Uint8Array(bytes));
      await renderPdfium(document, 2, canvas, 80, 120, { x: 0, y: 0, width: 80, height: 120 })
        .promise;
      await document.destroy();
      snapshots.push(await drained());
    }
    canvas.width = canvas.height = 1;
    return { yielded, cancelled, snapshots };
  }, Array.from(bytes));
  expect(result.yielded).toBe(true);
  expect(result.cancelled).toBe(true);
  for (const snapshot of result.snapshots)
    expect(snapshot).toMatchObject({
      workers: 1,
      pending: 0,
      documents: 0,
      sessions: 0,
      initializations: 1,
    });
  expect(result.snapshots.at(-1)!.heapBytes).toBeLessThanOrEqual(result.snapshots[0].heapBytes);
});

test('simultaneous PDFium documents share the engine and closing one preserves the other', async ({
  page,
}) => {
  await page.goto('/');
  const bytes = await fixture(page);
  const result = await page.evaluate(async (bytes) => {
    const { loadPdf } = await import('/src/pdf.ts');
    const { renderPdfium, getPdfiumStats } = await import('/src/pdfiumRaster.ts');
    const a = await loadPdf(new Uint8Array(bytes)),
      b = await loadPdf(new Uint8Array(bytes));
    const render = async (pdf: typeof a, index: number) => {
      const c = document.createElement('canvas');
      c.width = 400;
      c.height = 600;
      await renderPdfium(pdf, index, c, 400, 600, { x: 0, y: 0, width: 400, height: 600 }).promise;
      const pixels = c.toDataURL();
      c.width = c.height = 1;
      return pixels;
    };
    const [first, second] = await Promise.all([render(a, 0), render(b, 1)]);
    const active = getPdfiumStats();
    await a.destroy();
    const again = await render(b, 1);
    await b.destroy();
    for (let n = 0; n < 200 && getPdfiumStats().pending; n++)
      await new Promise((r) => setTimeout(r, 10));
    return { active, same: again === second, distinct: first !== second, closed: getPdfiumStats() };
  }, Array.from(bytes));
  expect(result.active).toMatchObject({ workers: 1, documents: 2, initializations: 1 });
  expect(result.same).toBe(true);
  expect(result.distinct).toBe(true);
  expect(result.closed).toMatchObject({ workers: 1, documents: 0, pending: 0, sessions: 0 });
});
