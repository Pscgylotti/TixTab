import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { waitForPerformanceSettled } from '../scripts/performance-settle.mjs';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
test.use({ deviceScaleFactor: 2.5 });

async function load(page: Page, count = 2) {
  await page.addInitScript(() => {
    localStorage.setItem('tixtab.performance.enabled', 'true');
    localStorage.setItem('surfacetab.powerMode', 'quality');
    localStorage.setItem('surfacetab.renderQuality', 'high');
  });
  await page.goto('/');
  await waitForPerformanceSettled(page);
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++) {
    const p = pdf.addPage([595, 842]);
    p.drawText(`Reading scale page ${i + 1}`, { x: 35, y: 730, size: 22, font });
    p.drawText('Same bitmap, current text and page identity.', { x: 35, y: 650, size: 13, font });
  }
  await page.locator('input[type=file]').setInputFiles({
    name: 'reading-scale.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await waitForPerformanceSettled(page);
}
async function zoom(page: Page, value: number) {
  await page.locator('.reading-view').evaluate((el, value) => {
    const paper = el.querySelector('.reading-paper')!.getBoundingClientRect();
    const r = el.getBoundingClientRect(),
      current = paper.width / 595;
    el.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -Math.log(value / current) / 0.008,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }),
    );
  }, value);
  await waitForPerformanceSettled(page);
}
const bitmaps = (page: Page) =>
  page.locator('.reading-paper').evaluateAll((els) =>
    els.map((el) => {
      const c = el.querySelector('canvas.reading-pdf') as HTMLCanvasElement;
      return {
        source: el.getAttribute('data-pdf-source'),
        width: c.width,
        height: c.height,
        night: c.dataset.renderedNight,
        png: c.toDataURL(),
      };
    }),
  );

test('same resolution bucket keeps current pixels; scale and night changes still refresh', async ({
  page,
}) => {
  await load(page);
  await page.getByRole('button', { name: '双页预览', exact: true }).click();
  await zoom(page, 1.05);
  const images = await bitmaps(page);
  expect(images).toHaveLength(2);
  expect(images.every((c) => c.width === 1785 && c.height === 2526)).toBe(true);
  const before = await page.evaluate(() => window.tixtabPerformance!.snapshot());
  await zoom(page, 1.08);
  const after = await page.evaluate(() => window.tixtabPerformance!.snapshot());
  expect(await bitmaps(page)).toEqual(images);
  // Keep the reuse experiment diagnostic separate from output correctness.
  // The candidate that removed these copies did not pass whole-flow resources.
  console.log(
    JSON.stringify({
      sameBucketDisplayTasks:
        after.stages['pdf-display'].completed - before.stages['pdf-display'].completed,
    }),
  );
  expect(after.counters.pdfPixels).toBe(before.counters.pdfPixels);
  await zoom(page, 0.68);
  const resized = await bitmaps(page);
  expect(resized.every((c) => c.width > 1 && c.width < 1785)).toBe(true);
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await waitForPerformanceSettled(page);
  const night = await bitmaps(page);
  expect(night.every((c) => c.night === 'true')).toBe(true);
  expect(night.map((c) => c.png)).not.toEqual(resized.map((c) => c.png));
  await page.getByRole('button', { name: '查看原色', exact: true }).click();
  await waitForPerformanceSettled(page);
  expect(await bitmaps(page)).toEqual(resized);
});

test('continuous page remount restores its bitmap and identity after leaving the virtual range', async ({
  page,
}) => {
  await load(page, 10);
  await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
  await zoom(page, 1.05);
  const first = (await bitmaps(page)).find((c) => c.source === '0');
  expect(first?.width).toBe(1785);
  await page.locator('.reading-view').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await waitForPerformanceSettled(page);
  await expect(page.locator('.reading-paper[data-pdf-source="0"]')).toHaveCount(0);
  await page.locator('.reading-view').evaluate((el) => {
    el.scrollTop = 0;
  });
  await waitForPerformanceSettled(page);
  expect((await bitmaps(page)).find((c) => c.source === '0')).toEqual(first);
});
