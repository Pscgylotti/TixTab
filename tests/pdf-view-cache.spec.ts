import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument } = createRequire(import.meta.url)('pdf-lib');
test('width fitting works in all views and folded controls; pre-render range persists', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('tixtab.performance.enabled', 'true'));
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const settings = async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    return page.getByRole('dialog', { name: '设置与笔诊断' });
  };
  let dialog = await settings();
  await expect(dialog.getByLabel('前后预渲染页数', { exact: true })).toHaveValue('1');
  await dialog.getByLabel('前后预渲染页数', { exact: true }).selectOption('0');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 5; i++) pdf.addPage([600, 1200]);
  await page.locator('input[type=file]').setInputFiles({
    name: 'tall.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect
    .poll(() => page.locator('.pdf-layer').evaluate((c: HTMLCanvasElement) => c.width))
    .toBeGreaterThan(100);
  expect(
    await page.evaluate(
      () => window.tixtabPerformance!.snapshot().stages['pdf-prefetch'].completed,
    ),
  ).toBe(0);
  for (const mode of ['单页标注', '连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    await page.getByRole('button', { name: '适合宽度', exact: true }).click();
    await expect
      .poll(async () => {
        const width = await page.locator('.canvas-container').evaluate((el) => el.clientWidth),
          paper = (await page.locator('.paper,.reading-paper').first().boundingBox())!,
          total = mode === '双页预览' ? paper.width * 2 + 16 : paper.width;
        return Math.abs(width - 16 - total);
      })
      .toBeLessThan(2);
  }
  await page.getByRole('button', { name: '单页标注', exact: true }).click();
  await page.getByRole('button', { name: '适合宽度', exact: true }).click();
  const before = (await page.locator('.paper').boundingBox())!.width;
  await page.getByRole('button', { name: '适合页面', exact: true }).click();
  await expect
    .poll(async () => (await page.locator('.paper').boundingBox())!.width)
    .toBeLessThan(before);
  dialog = await settings();
  await dialog.getByLabel('前后预渲染页数', { exact: true }).selectOption('0.5');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.tixtabPerformance!.snapshot().stages['pdf-prefetch'].completed),
    )
    .toBeGreaterThan(0);
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  dialog = await settings();
  await expect(dialog.getByLabel('前后预渲染页数', { exact: true })).toHaveValue('0.5');
  expect(
    await dialog
      .getByLabel('前后预渲染页数', { exact: true })
      .locator('option')
      .evaluateAll((options) => options.map((el) => (el as HTMLOptionElement).value)),
  ).toEqual(['0', '0.5', '1', '2', '3', '4']);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '收起底部工具', exact: true }).click();
  await page.getByRole('button', { name: '适合宽度', exact: true }).click();
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect
    .poll(async () => {
      const width = await page.locator('.canvas-container').evaluate((el) => el.clientWidth),
        paper = (await page.locator('.paper').boundingBox())!;
      return Math.abs(width - 16 - paper.width);
    })
    .toBeLessThan(2);
});
