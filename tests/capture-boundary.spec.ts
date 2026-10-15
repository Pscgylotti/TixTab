import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument } = createRequire(import.meta.url)('pdf-lib');
test('screenshots accept starts in outside whitespace and clip to the page in every view, including touch', async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 600]);
  doc.addPage([400, 600]);
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.locator('input[type=file]').setInputFiles({
    name: 'capture-boundary.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  for (const view of ['单页标注', '连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await page.getByRole('button', { name: '适合页面', exact: true }).click();
    const paper = page.locator(view === '单页标注' ? '.paper' : '.reading-paper').first(),
      r = (await paper.boundingBox())!;
    const area = (await page.locator('.canvas-container').boundingBox())!;
    expect(r.x - area.x).toBeGreaterThan(2);
    await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
    const x0 = Math.max(area.x + 1, r.x - 12),
      y0 = r.y + r.height * 0.2,
      x1 = r.x + r.width * 0.75,
      y1 = r.y + r.height * 0.6;
    if (view === '连续页面预览') {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: x0, y: y0 }],
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x1, y: y1 }],
      });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    } else {
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      await page.mouse.move(x1, y1, { steps: 5 });
      await page.mouse.up();
    }
    const dialog = page.getByRole('dialog', { name: '截图预览', exact: true });
    await expect(dialog).toBeVisible();
    const dimensions = await dialog.locator('img').evaluate((image: HTMLImageElement) => ({
      width: image.naturalWidth,
      height: image.naturalHeight,
    }));
    expect(dimensions.width).toBeGreaterThanOrEqual(749);
    expect(dimensions.width).toBeLessThanOrEqual(751);
    expect(dimensions.height).toBeGreaterThanOrEqual(599);
    expect(dimensions.height).toBeLessThanOrEqual(601);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  }
});
