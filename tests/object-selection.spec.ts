import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
async function load(page: Page) {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 50;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, 50, 50);
    return c.toDataURL();
  });
  const images = [
    { id: 'a', x: 100, y: 100, width: 60, height: 50, kind: 'sketch', scene: { elements: [] } },
    { id: 'b', x: 220, y: 160, width: 60, height: 50, kind: 'formula', latex: 'x' },
    { id: 'c', x: 400, y: 400, width: 60, height: 50, kind: 'sketch' },
  ].map((i) => ({ ...i, data: png }));
  await page.locator('input[type=file]').setInputFiles({
    name: 'objects.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        name: '中文笔记 competitive',
        source: null,
        pages: [
          {
            id: 'p',
            sourceIndex: null,
            width: 595.28,
            height: 841.89,
            paper: 'plain',
            strokes: [],
            images,
          },
        ],
      }),
    ),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '对象', exact: true }).click();
}
async function point(page: Page, x: number, y: number) {
  const r = (await page.locator('.paper').boundingBox())!;
  return { x: r.x + (x / 595.28) * r.width, y: r.y + (y / 841.89) * r.height };
}
async function drag(page: Page, x: number, y: number, ex: number, ey: number) {
  const a = await point(page, x, y),
    b = await point(page, ex, ey);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
}
async function project(page: Page) {
  const pending = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  const download = await pending;
  return JSON.parse(await fs.readFile((await download.path())!, 'utf8'));
}
test('框选边框在缩放和平移后仍与鼠标拖拽的两端重合', async ({ page }) => {
  await load(page);
  for (let level = 0; level < 3; level++) {
    if (level) {
      await page.getByRole('button', { name: '放大', exact: true }).click();
      await page.getByRole('button', { name: '移动', exact: true }).click();
      const r = (await page.locator('.surface').boundingBox())!;
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
      await page.mouse.down();
      await page.mouse.move(r.x + r.width / 2 + 15, r.y + r.height / 2 + 12);
      await page.mouse.up();
      await page.getByRole('button', { name: '对象', exact: true }).click();
    }
    const a = await point(page, 50, 60),
      b = await point(page, 320, 270);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await expect
      .poll(async () => {
        const r = await page.locator('.object-marquee').boundingBox();
        return (
          !!r &&
          Math.abs(r.x - a.x) < 2 &&
          Math.abs(r.y - a.y) < 2 &&
          Math.abs(r.x + r.width - b.x) < 2 &&
          Math.abs(r.y + r.height - b.y) < 2
        );
      })
      .toBe(true);
    await page.mouse.up();
    await expect(page.locator('.object-selection')).toHaveAttribute('data-selected-count', '2');
    await page.keyboard.press('Escape');
  }
});
test('矩形多选整体移动缩放和 Del 删除均一次撤销，原始场景保留', async ({ page }) => {
  await load(page);
  await drag(page, 70, 70, 310, 250);
  await expect(page.locator('.object-selection')).toHaveAttribute('data-selected-count', '2');
  await expect(page.locator('.placed-object.chosen')).toHaveCount(2);
  await drag(page, 130, 125, 170, 155);
  let saved = await project(page);
  expect(saved.pages[0].images[0].x).toBeCloseTo(140);
  expect(saved.pages[0].images[1].x).toBeCloseTo(260);
  expect(saved.pages[0].images[2].x).toBe(400);
  expect(saved.pages[0].images[0].scene).toEqual({ elements: [] });
  await page.keyboard.press('Control+z');
  saved = await project(page);
  expect(saved.pages[0].images[0].x).toBe(100);
  expect(saved.pages[0].images[1].x).toBe(220);
  const handle = (await page.locator('.object-handle.se').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 30, handle.y + handle.height / 2 + 25, {
    steps: 6,
  });
  await page.mouse.up();
  saved = await project(page);
  const [a, b, c] = saved.pages[0].images;
  expect(a.width).toBeGreaterThan(60);
  expect(a.width / 60).toBeCloseTo(b.width / 60);
  expect((b.x - a.x) / 120).toBeCloseTo(a.width / 60);
  expect(c.width).toBe(60);
  await page.keyboard.press('Control+z');
  saved = await project(page);
  expect(saved.pages[0].images[0].width).toBe(60);
  await page.keyboard.press('Delete');
  saved = await project(page);
  expect(saved.pages[0].images.map((i: { id: string }) => i.id)).toEqual(['c']);
  await page.keyboard.press('Control+z');
  saved = await project(page);
  expect(saved.pages[0].images).toHaveLength(3);
  await expect(page.locator('.placed-object img')).toHaveCount(3);
});
test('Shift 加选与移除、笔框选、取消手势、Escape 不提交移动或删除', async ({ page }) => {
  await load(page);
  await drag(page, 70, 70, 310, 250);
  await page.keyboard.down('Shift');
  const third = await point(page, 430, 425);
  await page.mouse.click(third.x, third.y);
  await expect(page.locator('.object-selection')).toHaveAttribute('data-selected-count', '3');
  const first = await point(page, 130, 125);
  await page.mouse.click(first.x, first.y);
  await page.keyboard.up('Shift');
  await expect(page.locator('.object-selection')).toHaveAttribute('data-selected-count', '2');
  await page.keyboard.press('Escape');
  await expect(page.locator('.object-selection')).toHaveCount(0);
  await page.locator('.object-layer').evaluate((el) => {
    el.setPointerCapture = () => {};
    const r = el.getBoundingClientRect();
    const emit = (type: string, x: number, y: number) =>
      el.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 44,
          pointerType: 'pen',
          button: 0,
          buttons: 1,
          clientX: r.x + (x / 595.28) * r.width,
          clientY: r.y + (y / 841.89) * r.height,
          bubbles: true,
        }),
      );
    emit('pointerdown', 70, 70);
    emit('pointermove', 310, 250);
    emit('pointerup', 310, 250);
  });
  await expect(page.locator('.object-selection')).toHaveAttribute('data-selected-count', '2');
  const a = await point(page, 130, 125),
    b = await point(page, 180, 175);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.object-selection')).toHaveCount(0);
  const saved = await project(page);
  expect(saved.pages[0].images[0].x).toBe(100);
  expect(saved.pages[0].images).toHaveLength(3);
  const start = await point(page, 70, 70),
    end = await point(page, 310, 250);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.object-selection')).toHaveCount(0);
  await expect(page.locator('.object-marquee')).toHaveCount(0);
});
