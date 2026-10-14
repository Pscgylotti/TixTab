import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
test('minimal memory renders all views, clears unused ink buffers and preserves independent model and prerender preferences', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('surfacetab.modelIdleSeconds', '600');
  });
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 8; i++)
    doc.addPage([400, 600]).drawText(`Memory page ${i + 1}`, { x: 40, y: 500, size: 18, font });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'memory.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
  await expect(page.locator('.page-card').first()).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置与笔诊断' });
  await settings.getByRole('combobox', { name: '前后预渲染页数' }).selectOption('2');
  await settings.getByRole('combobox', { name: '内存占用' }).selectOption('minimal');
  await expect(settings.getByRole('combobox', { name: '前后预渲染页数' })).toHaveValue('0');
  await expect(settings.getByRole('combobox', { name: 'PDF 渲染清晰度' })).toBeDisabled();
  await settings.getByRole('button', { name: '关闭', exact: true }).click();
  for (const view of ['单页标注', '连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await expect
      .poll(() =>
        page
          .locator('.canvas-container canvas.pdf-layer,.canvas-container canvas.reading-pdf')
          .evaluateAll((els) => els.filter((el) => (el as HTMLCanvasElement).width > 1).length),
      )
      .toBeGreaterThan(0);
    expect(
      await page
        .locator('.canvas-container canvas.pdf-layer,.canvas-container canvas.reading-pdf')
        .evaluateAll((els) =>
          els.every(
            (el) => (el as HTMLCanvasElement).width * (el as HTMLCanvasElement).height < 1010000,
          ),
        ),
    ).toBe(true);
  }
  await page.getByRole('button', { name: '设置', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('surfacetab.modelIdleSeconds'))).toBe(
    '600',
  );
  await settings.getByRole('combobox', { name: '内存占用' }).selectOption('normal');
  await expect(settings.getByRole('combobox', { name: '前后预渲染页数' })).toHaveValue('2');
  await expect(settings.getByRole('combobox', { name: 'PDF 渲染清晰度' })).toBeEnabled();
});
