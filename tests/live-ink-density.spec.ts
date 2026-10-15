import { test, expect } from '@playwright/test';
import type { Stroke } from '../src/model';

test.use({ deviceScaleFactor: 2 });

test('thin live ink matches display-density vector raster at 0.6x/4.5x/12x without a whole-page allocation', async ({
  page,
}) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const { paintLiveInk, releaseLiveInk } = await import('/src/liveInk.ts');
    const { drawStroke } = await import('/src/ink.ts');
    const rect = (left: number, top: number, width: number, height: number) => ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    });
    const results = [];
    for (const scale of [0.6, 4.5, 12]) {
      for (const tool of ['pen', 'ballpoint', 'pencil', 'highlighter'] as const) {
        const stroke: Stroke = {
          id: 'live',
          tool,
          color: '#b52e38',
          size: 0.5,
          points: [
            [100, 100, 0.3],
            [108, 103, 0.8],
            [116, 101, 0.5],
          ],
        };
        const paper = rect(200 - 100 * scale, 200 - 100 * scale, 600 * scale, 800 * scale);
        const view = rect(0, 0, 800, 600);
        const canvas = document.createElement('canvas');
        canvas.getContext('2d', { willReadFrequently: true });
        paintLiveInk(canvas, { width: 600, height: 800 }, [stroke], paper, view, 2);
        const density = canvas.width / parseFloat(canvas.style.width) / scale;
        const reference = document.createElement('canvas');
        reference.width = 1600;
        reference.height = 1200;
        const ctx = reference.getContext('2d', { willReadFrequently: true })!;
        ctx.setTransform(scale * 2, 0, 0, scale * 2, paper.left * 2, paper.top * 2);
        drawStroke(ctx, stroke);
        const expected = ctx.getImageData(0, 0, 1600, 1200).data;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, 1600, 1200);
        ctx.drawImage(
          canvas,
          Math.round((parseFloat(canvas.style.left) * scale + paper.left) * 2),
          Math.round((parseFloat(canvas.style.top) * scale + paper.top) * 2),
        );
        const actual = ctx.getImageData(0, 0, 1600, 1200).data;
        let error = 0,
          inkPixels = 0;
        for (let i = 3; i < expected.length; i += 4) {
          error += Math.abs(actual[i] - expected[i]);
          if (expected[i]) inkPixels++;
        }
        const pixels = canvas.width * canvas.height;
        releaseLiveInk(canvas);
        results.push({
          scale,
          tool,
          density,
          pixels,
          inkPixels,
          meanAlphaError: error / Math.max(1, inkPixels),
          released: canvas.width === 1 && canvas.height === 1,
        });
      }
    }
    // A full-page eraser highlight on an oversized page still allocates only
    // a screen-sized working raster, not 60000x80000 pixels.
    const canvas = document.createElement('canvas');
    paintLiveInk(
      canvas,
      { width: 6000, height: 8000 },
      [
        {
          id: 'large',
          tool: 'pen',
          color: '#123456',
          size: 12,
          points: [
            [0, 0, 0.5],
            [6000, 8000, 0.5],
          ],
        },
      ],
      rect(-100, -100, 60000, 80000),
      rect(0, 0, 800, 600),
      2,
    );
    return { results, largePixels: canvas.width * canvas.height };
  });
  for (const row of results.results) {
    expect(row.density, JSON.stringify(row)).toBeCloseTo(2, 3);
    expect(row.inkPixels).toBeGreaterThan(0);
    expect(row.meanAlphaError, JSON.stringify(row)).toBeLessThan(1);
    expect(row.pixels).toBeLessThan(300_000);
    expect(row.released).toBe(true);
  }
  expect(results.largePixels).toBeLessThan(2_200_000);
});

for (const memory of ['normal', 'minimal'])
  for (const view of ['单页标注', '连续页面预览', '双页预览'])
    test(`live ink uses current page scale from first contact and releases on pen-up: ${view}, ${memory}`, async ({
      page,
    }) => {
      await page.addInitScript(
        (memory) => localStorage.setItem('tixtab.memoryMode', memory),
        memory,
      );
      await page.goto('/');
      const project = await page.evaluate(async () => {
        const { newNotebook, blankPage } = await import('/src/model.ts');
        const n = newNotebook();
        n.pages = [0, 1].map(() => ({ ...blankPage(), width: 600, height: 800 }));
        return JSON.stringify(n);
      });
      await page.locator('input[type=file]').setInputFiles({
        name: 'density.tixtab',
        mimeType: 'application/json',
        buffer: Buffer.from(project),
      });
      await expect(page.locator('.busy-overlay')).toHaveCount(0);
      await page.getByRole('button', { name: view, exact: true }).click();
      await page.getByRole('button', { name: '圆珠笔', exact: true }).click();
      await page.getByRole('slider', { name: '笔触粗细', exact: true }).fill('0');
      for (let i = 0; i < 16; i++)
        await page.getByRole('button', { name: '放大', exact: true }).click();
      const editor = page.locator('.page-editor').first();
      await expect(editor).toBeVisible();
      const bounds = (await editor.boundingBox())!;
      const viewport = (await page.locator('.surface,.reading-view').first().boundingBox())!;
      const x = Math.max(bounds.x, viewport.x) + 90;
      const y = Math.max(bounds.y, viewport.y) + 100;
      const live = editor.locator('.live-layer');
      await page.mouse.move(x, y);
      await page.mouse.down();
      const density = async () =>
        live.evaluate((c: HTMLCanvasElement) => ({
          width: c.width,
          height: c.height,
          ratio:
            c.width /
            parseFloat(c.style.width) /
            (c.parentElement!.getBoundingClientRect().width / 600),
          ink: c
            .getContext('2d')!
            .getImageData(0, 0, c.width, c.height)
            .data.some((v, i) => i % 4 === 3 && v > 0),
        }));
      await expect.poll(async () => (await density()).ink).toBe(true);
      expect((await density()).ratio).toBeCloseTo(2, 3);
      await page.mouse.move(x + 140, y + 40, { steps: 8 });
      expect((await density()).ratio).toBeCloseTo(2, 3);
      expect((await density()).width * (await density()).height).toBeLessThan(500_000);
      await page.mouse.up();
      await expect(editor.locator('.reading-ink path')).toHaveCount(1);
      await expect.poll(async () => (await density()).width).toBe(1);
      await expect.poll(async () => (await density()).height).toBe(1);
      await expect(editor.locator('.ink-layer')).toHaveCount(0);
    });
