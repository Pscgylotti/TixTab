import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import type { Stroke } from '../src/model';

for (const cpu of [true, false])
  test(`增量/局部笔迹与完整回放逐像素相同 (${cpu ? 'CPU' : 'GPU'})`, async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async (cpu) => {
      const { CommittedInk } = await import('/src/committedInk.ts');
      const { drawStrokes } = await import('/src/ink.ts');
      const painter = new CommittedInk();
      // Pin the correctness oracle to one raster backend. Repeated readbacks can
      // otherwise move only one canvas from GPU to CPU halfway through the test.
      const fresh = () => {
        const c = document.createElement('canvas');
        c.getContext('2d', { willReadFrequently: cpu });
        return c;
      };
      let canvas = fresh();
      const reference = document.createElement('canvas');
      reference.getContext('2d', { willReadFrequently: cpu });
      let strokes: Stroke[] = [];
      let width = 197.3,
        height = 280.7,
        id = 'first';
      const checks: {
        name: string;
        different: number;
        drawn: number | undefined;
        scratch?: boolean;
      }[] = [];
      const check = (name: string) => {
        const paint = painter.paint(canvas, { id, width, height, strokes }),
          drawn = paint?.strokesDrawn;
        reference.width = canvas.width;
        reference.height = canvas.height;
        const ctx = reference.getContext('2d')!;
        ctx.setTransform(canvas.width / width, 0, 0, canvas.width / width, 0, 0);
        drawStrokes(ctx, strokes);
        // Read a copy: reading the live GPU canvas repeatedly can make Chromium
        // switch its raster backend, changing antialiasing in the test itself.
        const pixels = (source: HTMLCanvasElement) => {
          const copy = document.createElement('canvas');
          copy.width = source.width;
          copy.height = source.height;
          const read = copy.getContext('2d', { willReadFrequently: true })!;
          read.drawImage(source, 0, 0);
          return read.getImageData(0, 0, copy.width, copy.height).data;
        };
        const a = pixels(canvas),
          b = pixels(reference);
        let different = 0;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) different++;
        const diff = [];
        if (different)
          for (let i = 0; i < a.length && diff.length < 12; i++)
            if (a[i] !== b[i])
              diff.push({
                x: Math.floor(i / 4) % canvas.width,
                y: Math.floor(i / 4 / canvas.width),
                channel: i % 4,
                actual: a[i],
                expected: b[i],
              });
        checks.push({
          name,
          different,
          drawn,
          scratch: paint?.usedScratch,
          ...(different ? { diff } : {}),
        });
      };
      check('empty');
      const tools = ['pen', 'highlighter', 'pencil', 'ballpoint'] as const;
      for (let i = 0; i < 24; i++) {
        strokes = [
          ...strokes,
          {
            id: `s${i}`,
            tool: tools[i % 4],
            color: ['#e21936', '#136fed', '#f2bd34'][i % 3],
            size: 5 + (i % 8),
            points: Array.from({ length: (i % 6) + 1 }, (_, j) => [
              30 + j * 9 + (i % 3),
              40 + (i % 7) + Math.sin(j) * 15,
              0.1 + (j % 5) * 0.17,
            ]),
          },
        ];
        check(`append-${i}`);
      }
      check('same-array');
      strokes = [...strokes];
      check('same-references');
      const last = strokes.at(-1)!;
      strokes = strokes.slice(0, -1);
      check('undo');
      strokes = [...strokes, last];
      check('redo');
      strokes = strokes.filter((_, i) => i % 3);
      check('erase');
      strokes = [...strokes].reverse();
      check('reorder');
      strokes = strokes.map((s, i) => (i === 0 ? { ...s, color: '#04d6ab' } : s));
      check('edit-same-id');
      // A sparse scene forces dirty replay; the earlier dense transparent scene
      // intentionally exercises the full-replay fallback.
      strokes = Array.from({ length: 500 }, (_, i) => ({
        id: `sparse-${i}`,
        tool: tools[i % 4],
        color: ['#e21936', '#136fed'][i % 2],
        size: 1 + (i % 4),
        points: [
          [5 + (i % 20) * 9, 5 + Math.floor(i / 20) * 10, 0.3],
          [8 + (i % 20) * 9, 8 + Math.floor(i / 20) * 10, 0.85],
        ],
      }));
      check('sparse-load');
      const beforeErase = strokes;
      strokes = strokes.filter((_, i) => i !== 240);
      check('sparse-erase');
      strokes = beforeErase;
      check('sparse-undo');
      strokes = strokes.map((s, i) => (i === 242 ? { ...s, color: '#04d6ab' } : s));
      check('sparse-recolor');
      strokes = strokes.map((s, i) =>
        i === 241 ? { ...s, points: s.points.map(([x, y, p]) => [x + 5, y + 3, p]) } : s,
      );
      check('sparse-move');
      const unpainted = strokes.filter((_, i) => i !== 100);
      painter.candidates(unpainted, { minX: 0, minY: 0, maxX: width, maxY: height });
      strokes = unpainted.filter((_, i) => i !== 120);
      check('input-index-ahead-of-raster');
      let state = 813;
      const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
      strokes = Array.from({ length: 400 }, (_, i) => {
        const x = random() * width,
          y = random() * height;
        return {
          id: `random-${i}`,
          tool: tools[i % 4],
          color: ['#ed2878', '#238fee', '#cfba21'][i % 3],
          size: 1 + random() * 7,
          points: Array.from({ length: (i % 5) + 1 }, (_, j) => [
            x + j * 1.5,
            y + Math.sin(j) * 3,
            random(),
          ]),
        };
      });
      check('random-load');
      for (let i = 0; i < 24; i++) {
        const at = Math.floor(random() * strokes.length);
        strokes =
          i % 3 === 0
            ? strokes.filter((_, n) => n !== at)
            : strokes.map((s, n) =>
                n !== at
                  ? s
                  : {
                      ...s,
                      color: '#6941ff',
                      points: s.points.map(([x, y, p]) => [x + 3, y - 4, p]),
                    },
              );
        check(`random-edit-${i}`);
      }
      id = 'different-page';
      check('page-id');
      width = 201.13;
      check('width');
      height = 300.37;
      check('height');
      width = 1400;
      height = 2200;
      check('pixel-cap');
      canvas = fresh();
      check('remount');
      canvas.width = 10;
      check('external-resize');
      painter.reset();
      check('reset');
      strokes = [];
      check('clear');
      return checks;
    }, cpu);
    expect(
      result.every((r) => r.different === 0),
      JSON.stringify(result),
    ).toBe(true);
    expect(result.filter((r) => r.name.startsWith('append-')).map((r) => r.drawn)).toEqual(
      Array(24).fill(1),
    );
    expect(result.find((r) => r.name === 'same-array')?.drawn).toBe(0);
    expect(result.find((r) => r.name === 'same-references')?.drawn).toBe(0);
    expect(result.find((r) => r.name === 'undo')?.drawn).toBe(23);
    expect(result.find((r) => r.name === 'redo')?.drawn).toBe(1);
    expect(result.find((r) => r.name === 'sparse-erase')!.drawn!).toBeLessThan(50);
    expect(result.find((r) => r.name === 'sparse-recolor')!.drawn!).toBeLessThan(50);
    expect(result.some((r) => r.scratch)).toBe(true);
  });

test('实际编辑器追加只绘制新增笔迹，撤销/尾擦/切换视图后光栅与保存内容一致', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const strokes: Stroke[] = Array.from({ length: 300 }, (_, i) => ({
    id: `s${i}`,
    tool: i % 2 ? 'highlighter' : 'pencil',
    color: '#bc345a',
    size: 8,
    points: [
      [80 + (i % 15), 100 + (i % 20), 0.2],
      [110, 120 + (i % 20), 0.8],
      [150, 140, 0.4],
    ],
  }));
  await page.locator('input[accept=".pdf,.tixtab"]').setInputFiles({
    name: 'ink.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        name: 'ink',
        source: null,
        pages: [
          {
            id: 'p',
            width: 595.28,
            height: 841.89,
            sourceIndex: null,
            paper: 'plain',
            strokes,
            images: [],
          },
        ],
      }),
    ),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '钢笔', exact: true }).click();
  await page.evaluate(() => {
    const original = CanvasRenderingContext2D.prototype.fill;
    (window as any).inkFills = 0;
    CanvasRenderingContext2D.prototype.fill = function (...args: any[]) {
      if (this.canvas instanceof HTMLCanvasElement && this.canvas.classList.contains('ink-layer'))
        (window as any).inkFills++;
      return original.apply(this, args as any);
    };
  });
  const gesture = (eraser = false) =>
    page.locator('.page-editor').evaluate(async (el, eraser) => {
      el.setPointerCapture = () => {};
      const r = el.getBoundingClientRect();
      for (const [type, x] of [
        ['pointerdown', 90],
        ['pointermove', 120],
        ['pointerup', 150],
      ] as const) {
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerType: 'pen',
            pointerId: 71,
            button: eraser ? 5 : 0,
            buttons: eraser ? 32 : 1,
            pressure: 0.65,
            clientX: r.x + (x / 595.28) * r.width,
            clientY: r.y + (120 / 841.89) * r.height,
          }),
        );
      }
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    }, eraser);
  const verifyRaster = async () => {
    const pending = page.waitForEvent('download');
    await page.keyboard.press('Control+s');
    const saved = JSON.parse(await fs.readFile((await (await pending).path())!, 'utf8'));
    const difference = await page.locator('.ink-layer').evaluate(async (c, p) => {
      const canvas = c as HTMLCanvasElement,
        reference = document.createElement('canvas');
      reference.width = canvas.width;
      reference.height = canvas.height;
      const ctx = reference.getContext('2d')!;
      ctx.setTransform(canvas.width / p.width, 0, 0, canvas.width / p.width, 0, 0);
      const { drawStrokes } = await import('/src/ink.ts');
      drawStrokes(ctx, p.strokes);
      // Avoid readbacks on the editor canvas, which would change its backend.
      const pixels = (source: HTMLCanvasElement) => {
        const copy = document.createElement('canvas');
        copy.width = source.width;
        copy.height = source.height;
        const read = copy.getContext('2d', { willReadFrequently: true })!;
        read.drawImage(source, 0, 0);
        return read.getImageData(0, 0, copy.width, copy.height).data;
      };
      const a = pixels(canvas),
        b = pixels(reference);
      let different = 0,
        maxComposited = 0;
      for (let i = 0; i < a.length; i += 4) {
        for (let c = 0; c < 4; c++) if (a[i + c] !== b[i + c]) different++;
        for (const background of [0, 255])
          for (let c = 0; c < 3; c++) {
            const av = (a[i + c] * a[i + 3] + background * (255 - a[i + 3])) / 255,
              bv = (b[i + c] * b[i + 3] + background * (255 - b[i + 3])) / 255;
            maxComposited = Math.max(maxComposited, Math.abs(av - bv));
          }
      }
      return { different, maxComposited };
    }, saved.pages[0]);
    expect(difference.different, JSON.stringify(difference)).toBe(0);
    return saved.pages[0].strokes.length;
  };
  await gesture();
  expect(await page.evaluate(() => (window as any).inkFills)).toBe(1);
  expect(await verifyRaster()).toBe(301);
  await page.keyboard.press('Control+z');
  expect(await verifyRaster()).toBe(300);
  await page.keyboard.press('Control+y');
  expect(await verifyRaster()).toBe(301);
  await gesture(true);
  expect(await verifyRaster()).toBeLessThan(301);
  for (const view of ['连续页面预览', '双页预览', '单页标注'])
    await page.getByRole('button', { name: view, exact: true }).click();
  await verifyRaster();
  await gesture();
  await verifyRaster();
  await page.locator('.ink-layer').evaluate((el) => {
    const c = el as HTMLCanvasElement,
      ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    c.dispatchEvent(new Event('contextlost'));
    c.dispatchEvent(new Event('contextrestored'));
  });
  await verifyRaster();
});
