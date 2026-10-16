import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument } = createRequire(import.meta.url)('pdf-lib');
async function notebook(page: Page) {
  return page.evaluate(async () => {
    const w = await import('/src/workspaceStore.ts' as string);
    return (await w.bootstrapWorkspace()).notebook;
  });
}
async function counts(page: Page) {
  const n = await notebook(page);
  return [
    n.pages.reduce((n, p) => n + p.strokes.length, 0),
    n.scratchPapers?.[0].page.strokes.length ?? 0,
  ];
}
async function redAt(page: Page, point: { x: number; y: number }) {
  return page.locator('.scratch-cross-ink').evaluate((c: HTMLCanvasElement, p) => {
    const b = c.getBoundingClientRect(),
      x = Math.floor(((p.x - b.x) * c.width) / b.width),
      y = Math.floor(((p.y - b.y) * c.height) / b.height);
    if (x < 3 || y < 3 || x + 3 > c.width || y + 3 > c.height) return false;
    const data = c.getContext('2d')!.getImageData(x - 3, y - 3, 6, 6).data;
    return [...data].some((v, i) => i % 4 === 0 && v > 180 && data[i + 1] < 150 && data[i + 3] > 0);
  }, point);
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 3; i++) pdf.addPage([360, 480]);
  await page.locator('input[type=file]').setInputFiles({
    name: 'Erase fixture.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
});
for (const [label, mode] of [
  ['单页标注', 'single'],
  ['连续页面预览', 'continuous'],
  ['双页预览', 'dual'],
] as const)
  test(`${mode}: cross-sheet erase previews, commits and undoes both directions; cancellation releases buffer`, async ({
    page,
  }) => {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('button', { name: '适合页面', exact: true }).click();
    await page.getByRole('button', { name: '草稿', exact: true }).click();
    await page
      .getByRole('dialog', { name: '草稿纸', exact: true })
      .getByRole('button', { name: '进入草稿模式', exact: true })
      .click();
    await page.keyboard.press('Escape');
    const papers = page.locator(mode === 'single' ? '.surface .paper' : '.reading-paper');
    const paper = mode === 'dual' ? papers.last() : papers.first();
    const r = (await paper.boundingBox())!,
      view = (await page.locator('.canvas-container').boundingBox())!;
    const edge = r.x + r.width,
      y = Math.max(r.y, view.y) + 130;
    expect(edge + 65).toBeLessThan(view.x + view.width);
    const left = { x: edge - 50, y },
      right = { x: edge + 60, y };
    await page.getByRole('button', { name: '圆珠笔', exact: true }).click();
    await page.mouse.move(left.x, left.y);
    await page.mouse.down();
    await page.mouse.move(right.x, right.y, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => counts(page)).toEqual([1, 1]);
    await page.getByRole('button', { name: '橡皮擦', exact: true }).click();
    for (const reverse of [false, true]) {
      const a = reverse ? right : left,
        b = reverse ? left : right;
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 12 });
      await expect.poll(() => redAt(page, { x: edge - 25, y })).toBe(true);
      await expect.poll(() => redAt(page, { x: edge + 25, y })).toBe(true);
      await expect.poll(() => counts(page)).toEqual([1, 1]);
      await page.mouse.up();
      await expect.poll(() => counts(page)).toEqual([0, 0]);
      await expect
        .poll(() =>
          page.locator('.scratch-cross-ink').evaluate((c: HTMLCanvasElement) => c.width * c.height),
        )
        .toBe(1);
      await page.keyboard.press('Control+z');
      await expect.poll(() => counts(page)).toEqual([1, 1]);
    }
    await page.mouse.move(left.x, left.y);
    await page.mouse.down();
    await page.mouse.move(right.x, right.y, { steps: 12 });
    await expect.poll(() => redAt(page, { x: edge + 25, y })).toBe(true);
    await paper
      .locator('.page-editor')
      .dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true });
    await page.mouse.up();
    await expect
      .poll(() =>
        page.locator('.scratch-cross-ink').evaluate((c: HTMLCanvasElement) => c.width * c.height),
      )
      .toBe(1);
    await expect.poll(() => counts(page)).toEqual([1, 1]);
    // Simulate the standard pen-tail signal; real pointer capture across the
    // sheets is exercised by the mouse drags above.
    await page.getByRole('button', { name: '钢笔', exact: true }).click();
    const scratch = page.locator('.scratch-paper .page-editor');
    await scratch.evaluate(
      (el, { left, right }) => {
        const root = el as HTMLElement,
          capture = root.setPointerCapture;
        root.setPointerCapture = () => {};
        try {
          for (const [type, point, pressure] of [
            ['pointerdown', right, 0.2],
            ['pointerrawupdate', left, 0.8],
            ['pointermove', left, 0.8],
          ] as const)
            root.dispatchEvent(
              new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                pointerType: 'pen',
                pointerId: 81,
                button: type === 'pointerdown' ? 5 : -1,
                buttons: 32,
                pressure,
                clientX: point.x,
                clientY: point.y,
              }),
            );
        } finally {
          root.setPointerCapture = capture;
        }
      },
      { left, right },
    );
    await expect.poll(() => redAt(page, { x: edge - 25, y })).toBe(true);
    await expect.poll(() => redAt(page, { x: edge + 25, y })).toBe(true);
    await expect(scratch).toHaveAttribute('data-pending-erase', '2');
    await scratch.dispatchEvent('pointerup', {
      pointerType: 'pen',
      pointerId: 81,
      button: 5,
      buttons: 0,
      pressure: 0,
      clientX: left.x,
      clientY: left.y,
    });
    await expect.poll(() => counts(page)).toEqual([0, 0]);
    await expect
      .poll(() =>
        page.locator('.scratch-cross-ink').evaluate((c: HTMLCanvasElement) => c.width * c.height),
      )
      .toBe(1);
    await page.keyboard.press('Control+z');
    await expect.poll(() => counts(page)).toEqual([1, 1]);
    await scratch.evaluate(
      (el, { left, right }) => {
        const root = el as HTMLElement,
          capture = root.setPointerCapture;
        root.setPointerCapture = () => {};
        try {
          for (const [type, point] of [
            ['pointerdown', right],
            ['pointermove', left],
          ] as const)
            root.dispatchEvent(
              new PointerEvent(type, {
                bubbles: true,
                pointerType: 'pen',
                pointerId: 82,
                button: 5,
                buttons: 32,
                pressure: 0.5,
                clientX: point.x,
                clientY: point.y,
              }),
            );
        } finally {
          root.setPointerCapture = capture;
        }
      },
      { left, right },
    );
    await expect.poll(() => redAt(page, { x: edge + 25, y })).toBe(true);
    await page.locator('.scratch-cross-ink').evaluate((c) => {
      (window as any).__erasedBuffer = c;
    });
    await page.getByRole('button', { name: '草稿', exact: true }).click();
    await page
      .getByRole('dialog', { name: '草稿纸', exact: true })
      .getByRole('button', { name: '退出草稿模式', exact: true })
      .click();
    await expect(page.locator('.scratch-cross-ink')).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const c = (window as any).__erasedBuffer as HTMLCanvasElement;
          return c.width * c.height;
        }),
      )
      .toBe(1);
    await expect.poll(() => counts(page)).toEqual([1, 1]);
  });
