import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url),
  { PDFDocument } = require('pdf-lib'),
  sharp = require('sharp');
test.use({ hasTouch: true });
test('original image copy, touch and keyboard gallery keep native colors, skip blank pages and reset zoom', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const pdf = await PDFDocument.create();
  const colors = ['#e02040', '#20c040', '#2040e0'];
  const images = [];
  for (let i = 0; i < 3; i++) {
    const bytes = await sharp({
      create: { width: 32 + 8 * i, height: 24 + 6 * i, channels: 3, background: colors[i] },
    })
      .png()
      .toBuffer();
    images.push(await pdf.embedPng(bytes));
  }
  const first = pdf.addPage([400, 600]);
  first.drawImage(images[0], { x: 50, y: 300, width: 120, height: 90 });
  first.drawImage(images[1], { x: 220, y: 150, width: 100, height: 75 });
  pdf.addPage([400, 600]);
  pdf.addPage([400, 600]).drawImage(images[2], { x: 50, y: 300, width: 120, height: 90 });
  await page.locator('input[type=file]').setInputFiles({
    name: 'Gallery.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.getByRole('button', { name: '移动', exact: true }).click();
  const r = (await page.locator('.paper').boundingBox())!;
  await page.mouse.dblclick(r.x + (r.width * 100) / 400, r.y + (r.height * 255) / 600);
  const modal = page.getByRole('dialog', { name: '原图', exact: true });
  const dimensions = () =>
    modal.locator('canvas').evaluate((c: HTMLCanvasElement) => [c.width, c.height]);
  await expect.poll(dimensions).toEqual([32, 24]);
  const copy = modal.getByRole('button', { name: '复制图片', exact: true }),
    download = modal.getByRole('button', { name: '下载图片', exact: true });
  expect((await copy.boundingBox())!.x).toBeLessThan((await download.boundingBox())!.x);
  await copy.click();
  await expect(
    modal.getByText('图片已复制，可粘贴到聊天或其它应用。', { exact: true }),
  ).toBeVisible();
  const png = await page.evaluate(async () => {
    const item = (await navigator.clipboard.read()).find((i) => i.types.includes('image/png'))!;
    return [...new Uint8Array(await (await item.getType('image/png')).arrayBuffer())];
  });
  const meta = await sharp(Buffer.from(png)).metadata();
  expect([meta.width, meta.height]).toEqual([32, 24]);
  expect([...(await sharp(Buffer.from(png)).raw().toBuffer()).subarray(0, 3)]).toEqual([
    224, 32, 64,
  ]);
  await modal.getByRole('button', { name: '放大原图', exact: true }).click();
  await expect(modal.locator('output')).toHaveText('125%');
  await modal.getByRole('button', { name: '下一张图片', exact: true }).click();
  await expect.poll(dimensions).toEqual([40, 30]);
  await expect(modal.locator('output')).toHaveText('100%');
  await modal.getByLabel('原图缩放预览').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(dimensions).toEqual([48, 36]);
  await expect(modal.locator('.original-image-position')).toHaveText('第 3 页 · 图片 1');
  await expect(page.locator('.page-navigation')).toContainText('1 / 3');
  const pending = page.waitForEvent('download');
  await download.click();
  const file = await pending;
  expect(file.suggestedFilename()).toBe('TixTab-page-3-image-1.png');
  expect([
    ...(
      await sharp(await readFile((await file.path())!))
        .raw()
        .toBuffer()
    ).subarray(0, 3),
  ]).toEqual([32, 64, 224]);
  await modal.getByRole('button', { name: '下一张图片', exact: true }).click();
  await expect(modal.getByRole('button', { name: '下一张图片', exact: true })).toBeDisabled();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(dimensions).toEqual([40, 30]);
  const previous = (await modal
    .getByRole('button', { name: '上一张图片', exact: true })
    .boundingBox())!;
  await page.touchscreen.tap(previous.x + previous.width / 2, previous.y + previous.height / 2);
  await expect.poll(dimensions).toEqual([32, 24]);
  await modal.getByRole('button', { name: '上一张图片', exact: true }).click();
  await expect(modal.getByRole('button', { name: '上一张图片', exact: true })).toBeDisabled();
  await modal.locator('canvas').evaluate((c) => {
    (window as any).__galleryCanvas = c;
  });
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const c = (window as any).__galleryCanvas;
      return c.width * c.height;
    }),
  ).toBe(1);
});
