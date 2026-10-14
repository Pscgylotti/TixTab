import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts, rgb, degrees } = createRequire(import.meta.url)('pdf-lib');
async function fixture(page: import('@playwright/test').Page) {
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 900;
    c.height = 600;
    const x = c.getContext('2d')!;
    ['#ff0000', '#00ff00', '#0000ff'].forEach((v, i) => {
      x.fillStyle = v;
      x.fillRect(i * 300, 0, 300, 600);
    });
    return c.toDataURL();
  });
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    img = await doc.embedPng(png);
  for (let i = 0; i < 3; i++) {
    const p = doc.addPage([600, 800]);
    p.drawText('competitive night mode', { x: 60, y: 700, size: 24, font });
    p.drawRectangle({ x: 60, y: 600, width: 100, height: 40, color: rgb(0, 0, 0) });
    p.drawRectangle({ x: 60, y: 520, width: 100, height: 40, color: rgb(1, 0, 0) });
    p.drawImage(img, { x: 200, y: 400, width: 180, height: 120 });
    if (i === 1) {
      p.setCropBox(20, 30, 560, 740);
      p.setRotation(degrees(90));
    }
  }
  return Buffer.from(await doc.save());
}

for (const mode of ['单页标注', '连续页面预览', '双页预览']) {
  test(`night switch hides stale daytime PDF pixels while conversion is pending: ${mode}`, async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    await page.locator('input[type=file]').setInputFiles({
      name: 'night-transition.pdf',
      mimeType: 'application/pdf',
      buffer: await fixture(page),
    });
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    await page.getByRole('button', { name: mode, exact: true }).click();
    if (mode === '单页标注') {
      for (let i = 0; i < 12; i++)
        await page.getByRole('button', { name: '放大', exact: true }).click();
      await expect(page.locator('.pdf-detail-tile[data-ready=true]').first()).toBeVisible();
    }
    const selector = mode === '单页标注' ? '.pdf-layer' : '.reading-pdf';
    await expect
      .poll(() =>
        page
          .locator(selector)
          .first()
          .evaluate((c: HTMLCanvasElement) => c.width),
      )
      .toBeGreaterThan(100);
    await expect
      .poll(() =>
        page
          .locator('.page-thumbnail canvas')
          .first()
          .evaluate((c: HTMLCanvasElement) => c.width),
      )
      .toBeGreaterThan(100);
    // Hold the actual worker startup, reproducing cold conversion or a busy render
    // queue. A painted daytime canvas must not remain white under the night UI.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/pdfNight.worker*', async (route) => {
      await gate;
      await route.continue();
    });
    try {
      await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-night', 'true');
      for (const canvas of await page
        .locator(`${selector},.page-thumbnail canvas,.pdf-detail-tile canvas`)
        .all()) {
        const wrongPixels = await canvas.evaluate(
          (c: HTMLCanvasElement) =>
            c.width > 1 && c.getContext('2d')!.getImageData(0, 0, 1, 1).data[0] === 255,
        );
        if (wrongPixels) await expect(canvas).toBeHidden();
      }
      await page.screenshot({
        path: `test-results/night-pending-${['单页标注', '连续页面预览', '双页预览'].indexOf(mode)}.png`,
      });
    } finally {
      release();
    }
    await expect
      .poll(() =>
        page
          .locator(selector)
          .first()
          .evaluate((c: HTMLCanvasElement) =>
            c.width > 1 ? c.getContext('2d')!.getImageData(0, 0, 1, 1).data[0] : 0,
          ),
      )
      .toBe(28);
    await expect(page.locator(selector).first()).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator('.page-thumbnail canvas')
          .first()
          .evaluate((c: HTMLCanvasElement) =>
            c.width > 1 ? c.getContext('2d')!.getImageData(0, 0, 1, 1).data[0] : 0,
          ),
      )
      .toBe(28);
    await expect(page.locator('.page-thumbnail canvas').first()).toBeVisible();
    await page.getByRole('button', { name: '查看原色', exact: true }).click();
    await expect
      .poll(() =>
        page
          .locator(selector)
          .first()
          .evaluate((c: HTMLCanvasElement) =>
            c.width > 1 ? c.getContext('2d')!.getImageData(0, 0, 1, 1).data[0] : 0,
          ),
      )
      .toBe(255);
    await expect(page.locator(selector).first()).toBeVisible();
  });
}
test('night colors preserve bitmap hue, rotated/cropped geometry, original previews and selection', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const bytes = await fixture(page);
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'night.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect
    .poll(() => page.locator('.pdf-layer').evaluate((c: HTMLCanvasElement) => c.width))
    .toBeGreaterThan(100);
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-night', 'true');
  await expect
    .poll(() =>
      page
        .locator('.pdf-layer')
        .evaluate((c: HTMLCanvasElement) =>
          Array.from(c.getContext('2d')!.getImageData(0, 0, 1, 1).data).slice(0, 3),
        ),
    )
    .toEqual([28, 32, 39]);
  const pixels = await page.locator('.pdf-layer').evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d')!,
      pixel = (x: number, y: number) =>
        Array.from(
          ctx.getImageData(Math.floor((x * c.width) / 600), Math.floor((y * c.height) / 800), 1, 1)
            .data,
        ).slice(0, 3);
    return {
      text: pixel(100, 180),
      vector: pixel(100, 260),
      red: pixel(230, 340),
      green: pixel(290, 340),
      blue: pixel(350, 340),
    };
  });
  expect(pixels.text).toEqual([230, 234, 241]);
  expect(pixels.red).toEqual([158, 0, 0]);
  expect(pixels.green).toEqual([0, 158, 0]);
  expect(pixels.blue).toEqual([0, 0, 158]);
  expect(pixels.vector[0]).toBeGreaterThan(pixels.vector[1]);
  await page.getByRole('button', { name: '移动', exact: true }).click();
  const imagePoint = await page.locator('.pdf-layer').evaluate((canvas) => {
    const b = canvas.getBoundingClientRect();
    return { x: b.left + (b.width * 290) / 600, y: b.top + (b.height * 340) / 800 };
  });
  await expect(page.locator('.pdf-original-image')).toHaveCount(0);
  await page.mouse.dblclick(imagePoint.x, imagePoint.y);
  const modal = page.getByRole('dialog', { name: '原图', exact: true });
  await expect(modal).toBeVisible();
  await expect
    .poll(() => modal.locator('canvas').evaluate((c: HTMLCanvasElement) => c.width))
    .toBeGreaterThan(100);
  expect(
    await modal.locator('canvas').evaluate((c: HTMLCanvasElement) => [c.width, c.height]),
  ).toEqual([900, 600]);
  expect((await modal.boundingBox())!.width).toBeGreaterThan(1000);
  expect(
    await modal
      .locator('canvas')
      .evaluate((c: HTMLCanvasElement) =>
        Array.from(c.getContext('2d')!.getImageData(c.width / 6, c.height / 2, 1, 1).data).slice(
          0,
          3,
        ),
      ),
  ).toEqual([255, 0, 0]);
  const preview = modal.locator('.original-image-content'),
    transform = modal.locator('.original-image-transform'),
    originalBounds = await preview.boundingBox(),
    pdfBounds = await page.locator('.pdf-layer').boundingBox();
  await modal.getByRole('button', { name: '放大原图', exact: true }).click();
  await expect(modal.locator('output')).toHaveText('125%');
  expect(await preview.boundingBox()).toEqual(originalBounds);
  const box = originalBounds!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20);
  await page.mouse.up();
  await expect(transform).not.toHaveCSS('transform', 'matrix(1.25, 0, 0, 1.25, 0, 0)');
  await page.mouse.wheel(0, -100);
  await expect
    .poll(async () => Number((await modal.locator('output').textContent())!.replace('%', '')))
    .toBeGreaterThan(125);
  await modal.getByRole('button', { name: '重置原图缩放' }).click();
  await expect(modal.locator('output')).toHaveText('100%');
  await expect(transform).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  const cdp = await page.context().newCDPSession(page),
    cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: cx - 20, y: cy, id: 1 },
      { x: cx + 20, y: cy, id: 2 },
    ],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { x: cx - 40, y: cy, id: 1 },
      { x: cx + 40, y: cy, id: 2 },
    ],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(modal.locator('output')).toHaveText('200%');
  await cdp.detach();
  expect(await page.locator('.pdf-layer').boundingBox()).toEqual(pdfBounds);
  await modal.getByRole('button', { name: '缩小原图' }).click();
  await expect(modal.locator('output')).toHaveText('160%');
  await preview.focus();
  await page.keyboard.press('Home');
  await expect(modal.locator('output')).toHaveText('100%');
  await expect(preview).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await page.getByRole('button', { name: '关闭原图' }).click();
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.mouse.dblclick(imagePoint.x, imagePoint.y);
  await expect(modal).toBeVisible();
  await expect
    .poll(() => modal.locator('canvas').evaluate((c: HTMLCanvasElement) => c.width))
    .toBe(900);
  await modal.screenshot({ path: '.cache/native-original-image-zoom.png' });
  await page.getByRole('button', { name: '关闭原图' }).click();
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.getByRole('button', { name: '查看原色', exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator('.pdf-layer')
        .evaluate((c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, 1, 1).data[0]),
    )
    .toBe(255);
  await page.getByRole('button', { name: '恢复夜间颜色', exact: true }).click();
  await page.getByRole('button', { name: '选文', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText('competitive');
  const glyph = await page
    .locator('.textLayer span')
    .first()
    .evaluate((el) => {
      const r = document.createRange();
      r.setStart(el.firstChild!, 0);
      r.setEnd(el.firstChild!, 1);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });
  await page.mouse.dblclick(glyph.x, glyph.y);
  await expect(page.locator('.selection-flyout')).toBeVisible();
  await page.getByRole('button', { name: '关闭划词工具' }).click();
  await page.getByRole('button', { name: '移动', exact: true }).click();
  for (const mode of ['连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    await expect
      .poll(() =>
        page
          .locator('.reading-pdf')
          .first()
          .evaluate((c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, 1, 1).data[0]),
      )
      .toBe(28);
    const point = await page
      .locator('.reading-pdf')
      .first()
      .evaluate((canvas) => {
        const b = canvas.getBoundingClientRect();
        return { x: b.left + (b.width * 290) / 600, y: b.top + (b.height * 340) / 800 };
      });
    await page.mouse.dblclick(point.x, point.y);
    await expect(modal).toBeVisible();
    await expect
      .poll(() => modal.locator('canvas').evaluate((c: HTMLCanvasElement) => c.width))
      .toBe(900);
    await expect(modal).toHaveCSS('background-color', 'rgb(30, 36, 47)');
    await page.getByRole('button', { name: '关闭原图' }).click();
  }
  // Independent real PDF render checks image geometry after crop+90° rotation, including tiles.
  const transformed = await page.evaluate(async (base64) => {
    const { loadPdf } = await import('/src/pdf.ts' as string),
      { requestPdfBitmap, requestPdfTile, getPdfRenderStats } = await import(
        '/src/pdfRenderCache.ts' as string
      ),
      pdf = await loadPdf(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))),
      p = await pdf.getPage(2),
      vp = p.getViewport({ scale: 1 }),
      point = vp.convertToViewportPoint(230, 460),
      normal = await requestPdfBitmap(pdf, 1, 1, 0, false).promise,
      before = getPdfRenderStats(pdf).renders,
      night = await requestPdfBitmap(pdf, 1, 1, 0, true).promise,
      after = getPdfRenderStats(pdf).renders,
      tile = await requestPdfTile(
        pdf,
        1,
        1,
        { x: Math.floor(point[0]) - 20, y: Math.floor(point[1]) - 20, width: 40, height: 40 },
        0,
        true,
      ).promise,
      pixel = (c: HTMLCanvasElement, x: number, y: number) =>
        Array.from(c.getContext('2d')!.getImageData(x, y, 1, 1).data).slice(0, 3);
    const result = {
      normal: pixel(normal, point[0], point[1]),
      night: pixel(night, point[0], point[1]),
      tile: pixel(tile, 20, 20),
      before,
      after,
    };
    await pdf.destroy();
    return result;
  }, bytes.toString('base64'));
  expect(transformed.normal).toEqual([255, 0, 0]);
  expect(transformed.night).toEqual([158, 0, 0]);
  expect(transformed.tile).toEqual([158, 0, 0]);
  expect(transformed.after).toBe(transformed.before);
  const originalCapture = await page.evaluate(async (base64) => {
    const { loadPdf } = await import('/src/pdf.ts' as string),
      { capturePage } = await import('/src/capturePage.ts' as string),
      pdf = await loadPdf(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))),
      png = await capturePage(
        {
          id: 'capture',
          sourceIndex: 0,
          width: 600,
          height: 800,
          paper: 'plain',
          images: [],
          strokes: [],
        },
        pdf,
        { x: 200, y: 280, width: 180, height: 120 },
      ),
      img = new Image();
    img.src = png;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d')!.drawImage(img, 0, 0);
    const pixel = Array.from(
      c.getContext('2d')!.getImageData(c.width / 6, c.height / 2, 1, 1).data,
    ).slice(0, 3);
    await pdf.destroy();
    return pixel;
  }, bytes.toString('base64'));
  expect(originalCapture).toEqual([255, 0, 0]);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 PDF', exact: true }).click();
  const output = await download,
    fs = await import('node:fs/promises'),
    exported = await fs.readFile((await output.path())!);
  const exportColor = await page.evaluate(async (base64) => {
    const { loadPdf } = await import('/src/pdf.ts' as string),
      pdf = await loadPdf(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))),
      p = await pdf.getPage(1),
      c = document.createElement('canvas');
    c.width = 600;
    c.height = 800;
    await p.render({ canvas: c, viewport: p.getViewport({ scale: 1 }) }).promise;
    const pixel = Array.from(c.getContext('2d')!.getImageData(230, 340, 1, 1).data).slice(0, 3);
    await pdf.destroy();
    return pixel;
  }, exported.toString('base64'));
  expect(exportColor).toEqual([255, 0, 0]);
  await page.screenshot({ path: 'test-results/night-mode.png' });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-night', 'true');
  expect(errors).toEqual([]);
});
test('dense PDF workload: eco profile bounds pixels and repeat work without stalling interaction', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
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
  const base64 = Buffer.from(await doc.save()).toString('base64');
  const result = await page.evaluate(async (base64) => {
    const { loadPdf } = await import('/src/pdf.ts' as string),
      { requestPdfBitmap, requestPdfTile, getPdfRenderStats } = await import(
        '/src/pdfRenderCache.ts' as string
      ),
      { setPowerMode, renderPolicy } = await import('/src/appearance.ts' as string),
      { planPdfTiles } = await import('/src/pdfTiles.ts' as string),
      results = [];
    for (const mode of ['quality', 'eco'] as const) {
      setPowerMode(mode);
      const policy = renderPolicy(),
        pdf = await loadPdf(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))),
        start = performance.now(),
        gaps: number[] = [];
      let active = true,
        last = performance.now();
      const frame = () => {
        if (!active) return;
        const now = performance.now();
        gaps.push(now - last);
        last = now;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      const base = await requestPdfBitmap(pdf, 0, policy.baseScale, 0, true).promise,
        plan = planPdfTiles(
          1200,
          1600,
          { x: 300, y: 550, width: 350, height: 225 },
          6,
          policy.detailPixels,
        ),
        draw = () =>
          Promise.all(
            plan.tiles.map((t) => requestPdfTile(pdf, 0, plan.scale, t, 0, true).promise),
          );
      await draw();
      const coldMs = performance.now() - start,
        first = getPdfRenderStats(pdf);
      await draw();
      const repeat = getPdfRenderStats(pdf);
      active = false;
      await pdf.destroy();
      results.push({
        mode,
        basePixels: base.width * base.height,
        detailPixels: plan.pixels,
        totalPixels: base.width * base.height + plan.pixels,
        tiles: plan.tiles.length,
        coldMs,
        frames: gaps.length,
        maxFrameGapMs: Math.max(0, ...gaps),
        repeatNewRenders: repeat.renders - first.renders,
        cacheBytes: repeat.bytes - repeat.pageBytes,
        pageCacheBytes: repeat.pageBytes,
        budgetBytes: policy.cacheBytes,
      });
    }
    setPowerMode('auto');
    return results;
  }, base64);
  expect(result[1].totalPixels).toBeLessThan(result[0].totalPixels * 0.65);
  for (const r of result) {
    expect(r.repeatNewRenders).toBe(0);
    expect(r.cacheBytes).toBeLessThanOrEqual(r.budgetBytes);
    expect(r.frames).toBeGreaterThan(0);
  }
  console.log(JSON.stringify({ nightDenseWorkload: result }));
  await info.attach('night-dense-workload.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
});
test('eco mode reduces budgets, pauses during input/hidden state, and stays usable at 560px', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('渲染与能耗', { exact: true }).selectOption('eco');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-eco', 'true');
  const result = await page.evaluate(async () => {
    const { renderPolicy } = await import('/src/appearance.ts' as string),
      { requestPdfBitmap, initializeRenderScheduler } = await import(
        '/src/pdfRenderCache.ts' as string
      );
    initializeRenderScheduler();
    let starts = 0;
    const pdf = {
      getPage: async () => ({
        getViewport: () => ({ width: 10, height: 10 }),
        render: () => {
          starts++;
          return { promise: Promise.resolve(), cancel: () => {} };
        },
      }),
    } as never;
    document.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 999 }));
    const a = requestPdfBitmap(pdf, 0, 1);
    await new Promise((r) => setTimeout(r, 50));
    const inputPaused = starts === 0;
    document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 999 }));
    await Promise.race([
      a.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('input not resumed')), 2000)),
    ]);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    const b = requestPdfBitmap(pdf, 1, 1);
    await new Promise((r) => setTimeout(r, 50));
    const hiddenPaused = starts === 1;
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.race([
      b.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('hidden not resumed')), 2000)),
    ]);
    delete (document as unknown as { hidden?: boolean }).hidden;
    document.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 998 }));
    const lost = requestPdfBitmap(pdf, 2, 1);
    document.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 998 }));
    await Promise.race([
      lost.promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('capture loss not resumed')), 2000),
      ),
    ]);
    return { policy: renderPolicy(), inputPaused, hiddenPaused, starts };
  });
  expect(result.policy).toMatchObject({
    concurrency: 1,
    detailPixels: 4_000_000,
    cacheBytes: 32 * 1024 * 1024,
  });
  expect(result.inputPaused).toBe(true);
  expect(result.hiddenPaused).toBe(true);
  expect(result.starts).toBe(3);
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.setViewportSize({ width: 560, height: 900 });
  for (const name of ['实验性夜间模式', '查看原色', '设置']) {
    const b = page.getByRole('button', { name, exact: true });
    await expect(b).toBeVisible();
    const r = (await b.boundingBox())!;
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(560);
  }
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('en');
  await expect(page.getByLabel('Rendering and energy use', { exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Power saving', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-eco', 'true');
});
test('dark formula preview exports readable original ink and Excalidraw follows night theme', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await page.getByLabel('LaTeX · 可直接修改', { exact: true }).fill('x^2');
  await expect(page.locator('.formula-preview .katex')).toBeVisible();
  expect(await page.locator('.formula-preview').evaluate((el) => getComputedStyle(el).color)).toBe(
    'rgb(193, 214, 251)',
  );
  await page.getByRole('button', { name: '插入当前页', exact: true }).click();
  await expect(page.locator('.placed-object img')).toHaveCount(1);
  const stored = await page.locator('.placed-object img').evaluate(async (el: HTMLImageElement) => {
    await el.decode();
    const c = document.createElement('canvas');
    c.width = el.naturalWidth;
    c.height = el.naturalHeight;
    c.getContext('2d')!.drawImage(el, 0, 0);
    const p = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let opaque = 0,
      dark = 0;
    for (let i = 0; i < p.length; i += 4)
      if (p[i + 3] > 230) {
        opaque++;
        if (p[i] < 100 && p[i + 1] < 100 && p[i + 2] < 120) dark++;
      }
    return { opaque, dark };
  });
  expect(stored.opaque).toBeGreaterThan(100);
  expect(stored.dark / stored.opaque).toBeGreaterThan(0.95);
  await page.getByRole('button', { name: '草图', exact: true }).click();
  await expect(page.locator('.excalidraw.theme--dark')).toBeVisible();
  await page.locator('.sketch-modal').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.getByRole('button', { name: '草图', exact: true }).click();
  await expect(page.locator('.excalidraw')).not.toHaveClass(/theme--dark/);
  await page.locator('.sketch-modal').getByRole('button', { name: '关闭', exact: true }).click();
});
