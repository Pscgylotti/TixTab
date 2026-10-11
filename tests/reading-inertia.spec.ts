import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument } = createRequire(import.meta.url)('pdf-lib');
test('continuous touch flings coast, stop on retouch, and never coast a pinch', async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 16; i++) doc.addPage([600, 900]);
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.locator('input[type=file][accept=".pdf,.tixtab"]').setInputFiles({
    name: 'Long PDF.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
  const root = page.locator('.reading-view'),
    cdp = await page.context().newCDPSession(page),
    box = await root.boundingBox(),
    x = Math.round(box!.x + box!.width / 2),
    start = Math.round(box!.y + box!.height * 0.7);
  const touch = (type: string, ys: number[]) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: ys.map((y, id) => ({ x: x + id * 80, y, id })),
    });
  await page.waitForTimeout(200);
  const top = () => root.evaluate((el) => el.scrollTop);
  await touch('touchStart', [start]);
  for (let n = 1; n <= 6; n++) {
    await page.waitForTimeout(20);
    await touch('touchMove', [start - n * 35]);
  }
  await touch('touchEnd', []);
  const release = await top();
  await page.waitForTimeout(160);
  expect(await top()).toBeGreaterThan(release + 80);
  await touch('touchStart', [start]);
  const stopped = await top();
  await page.waitForTimeout(140);
  expect(await top()).toBeCloseTo(stopped, 0);
  await touch('touchEnd', []);
  await touch('touchStart', [start, start]);
  for (let n = 1; n <= 4; n++) {
    await page.waitForTimeout(20);
    await touch('touchMove', [start - n * 20, start - n * 20]);
  }
  await touch('touchEnd', []);
  const pinchEnd = await top();
  await page.waitForTimeout(140);
  expect(await top()).toBeCloseTo(pinchEnd, 0);
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.screenshot({ path: 'test-results/reading-transparent-controls.png' });
  expect(
    await root.evaluate((el) =>
      Math.abs(
        el.getBoundingClientRect().bottom - el.parentElement!.getBoundingClientRect().bottom,
      ),
    ),
  ).toBeLessThan(1);
  expect(await page.title()).toBe('TixTab · Thinking over Screen');
});
