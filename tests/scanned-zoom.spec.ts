import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument } = createRequire(import.meta.url)('pdf-lib');

test('night-mode scanned page 179 stays mounted and painted during continuous zoom', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('surfacetab.night', 'true'));
  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1800;
    c.height = 2400;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#18212c';
    ctx.font = '32px serif';
    for (let y = 80; y < 2350; y += 50)
      ctx.fillText('Scanned PDF page — keep the rendered image during zoom.', 70, y);
    return c.toDataURL();
  });
  const pdf = await PDFDocument.create(),
    image = await pdf.embedPng(png);
  for (let n = 0; n < 200; n++)
    pdf.addPage([600, 800]).drawImage(image, { x: 0, y: 0, width: 600, height: 800 });
  await page.locator('input[type=file]').setInputFiles({
    name: 'scanned-book.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await expect(page.getByRole('textbox', { name: '文档名称', exact: true })).toHaveValue(
    'scanned-book',
  );
  await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
  await page.locator('.reading-view').evaluate((el) => {
    const paper = el.querySelector('.reading-paper')!;
    const scale = paper.getBoundingClientRect().width / 600;
    el.scrollTop = 8 + 178 * (800 * scale + 33);
  });
  const card = page.locator('.reading-card[data-page-index="178"]');
  await expect(card.locator('canvas.reading-pdf[data-rendered-night=true]')).toBeVisible();
  await expect
    .poll(() => card.locator('canvas.reading-pdf').evaluate((c: HTMLCanvasElement) => c.width))
    .toBeGreaterThan(100);
  const result = await page.evaluate(async () => {
    const view = document.querySelector('.reading-view')!;
    const card = view.querySelector('.reading-card[data-page-index="178"]')!;
    const checks = [];
    for (let n = 0; n < 8; n++) {
      const rect = view.getBoundingClientRect();
      view.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -12,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      );
      await new Promise(requestAnimationFrame);
      const canvas = card.querySelector('canvas.reading-pdf') as HTMLCanvasElement;
      checks.push({
        connected: card.isConnected,
        width: canvas?.width ?? 0,
        visible: canvas ? getComputedStyle(canvas).visibility : 'missing',
      });
    }
    return checks;
  });
  expect(result, JSON.stringify(result)).toEqual(
    result.map((row) => ({ ...row, connected: true, visible: 'visible' })),
  );
  expect(
    result.every((row) => row.width > 100),
    JSON.stringify(result),
  ).toBe(true);
});
