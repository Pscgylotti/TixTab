import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, degrees } = createRequire(import.meta.url)('pdf-lib');
test('Fit page uses rotated CropBox edges, fills available space and keeps mixed spreads visible', async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  const a = doc.addPage([400, 600]);
  a.setCropBox(50, 60, 120, 180);
  a.setRotation(degrees(90));
  doc.addPage([180, 500]);
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.locator('input[type=file]').setInputFiles({
    name: 'Cropped.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '收起底部工具', exact: true }).click();
  for (const size of [
    { width: 1440, height: 960 },
    { width: 560, height: 900 },
  ]) {
    await page.setViewportSize(size);
    for (const mode of ['单页标注', '连续页面预览', '双页预览']) {
      await page.getByRole('button', { name: mode, exact: true }).click();
      await page.getByRole('button', { name: '适合页面', exact: true }).click();
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const root = document.querySelector('.surface,.reading-view')!,
              v = root.getBoundingClientRect(),
              papers = Array.from(root.querySelectorAll('.paper,.reading-paper'))
                .slice(0, root.classList.contains('reading-dual') ? 2 : 1)
                .map((el) => el.getBoundingClientRect());
            const left = Math.min(...papers.map((r) => r.left)) - v.left,
              right = v.right - Math.max(...papers.map((r) => r.right)),
              top = Math.min(...papers.map((r) => r.top)) - v.top,
              bottom = v.bottom - Math.max(...papers.map((r) => r.bottom));
            return (
              left >= -1 &&
              right >= -1 &&
              top >= -1 &&
              bottom >= -1 &&
              Math.min(left + right, bottom + (root.classList.contains('surface') ? top : 0)) < 20
            );
          }),
        )
        .toBe(true);
      const r = await page.locator('.paper,.reading-paper').first().boundingBox();
      expect(r!.width / r!.height).toBeCloseTo(1.5, 2);
    }
  }
});
test('Fit page adapts to chrome and resizing, leaves expanded controls clear, manual zoom stays manual', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '适合页面', exact: true }).click();
  const height = () => page.locator('.paper').evaluate((el) => el.getBoundingClientRect().height);
  const before = await height();
  await page.getByRole('button', { name: '收起底部工具', exact: true }).click();
  await expect.poll(height).toBeGreaterThan(before + 10);
  await page.getByRole('button', { name: '展开底部工具', exact: true }).click();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const p = document.querySelector('.paper')!.getBoundingClientRect();
        return Array.from(
          document.querySelectorAll(
            '.canvas-container > .insert-dock,.canvas-container > .zoom-dock,.canvas-container > .page-navigation',
          ),
        ).every((el) => {
          const c = el.getBoundingClientRect();
          return p.right <= c.left || p.left >= c.right || p.bottom <= c.top || p.top >= c.bottom;
        });
      }),
    )
    .toBe(true);
  await page.getByRole('button', { name: '收起底部工具', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1200 });
  await expect.poll(height).toBeGreaterThan(before + 100);
  await page.getByRole('button', { name: '放大', exact: true }).click();
  const manual = await height();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(height).toBeCloseTo(manual, 1);
});
