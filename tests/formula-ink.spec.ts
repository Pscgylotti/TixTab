import { test, expect } from '@playwright/test';
import type { Stroke } from '../src/model';

for (const cpu of [true, false])
  test(`formula append raster preserves full white replay (${cpu ? 'CPU' : 'GPU'})`, async ({
    page,
  }) => {
    await page.goto('/');
    const result = await page.evaluate(async (cpu) => {
      const { FormulaInk } = await import('/src/formulaInk.ts');
      const { drawStrokes } = await import('/src/ink.ts');
      const painter = new FormulaInk();
      const fresh = () => {
        const c = document.createElement('canvas');
        c.getContext('2d', { willReadFrequently: cpu });
        return c;
      };
      let canvas = fresh(),
        strokes: Stroke[] = [],
        height = 320;
      const checks: { name: string; mode?: string; drawn?: number; different: number }[] = [];
      const check = (name: string) => {
        const paint = painter.paint(canvas, strokes, height);
        const reference = fresh();
        reference.width = 960;
        reference.height = height;
        const ctx = reference.getContext('2d')!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, 960, height);
        drawStrokes(ctx, strokes);
        const pixels = (c: HTMLCanvasElement) => {
          // Read a copy so correctness checks never switch only the live cache to CPU raster.
          const copy = document.createElement('canvas');
          copy.width = 960;
          copy.height = height;
          const read = copy.getContext('2d', { willReadFrequently: true })!;
          read.drawImage(c, 0, 0);
          return read.getImageData(0, 0, 960, height).data;
        };
        const a = pixels(canvas),
          b = pixels(reference);
        let different = 0;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) different++;
        checks.push({ name, mode: paint?.mode, drawn: paint?.strokesDrawn, different });
      };
      check('blank');
      for (let i = 0; i < 80; i++) {
        strokes = [
          ...strokes,
          {
            id: String(i),
            tool: i % 3 ? 'pen' : 'pencil',
            color: i % 2 ? '#204b85' : '#202a40',
            size: 5 + (i % 4),
            points: [
              [100 + i * 0.71, 90 + i * 0.4, 0.1],
              [130 + i * 0.8, 100 + i * 0.3, 0.8],
              [160 + i * 0.7, 120 + i * 0.3, 0.4],
            ],
          },
        ];
        if (i < 3 || i % 10 === 9) check('append-' + i);
        else painter.paint(canvas, strokes, height);
      }
      const beforeErase = strokes;
      strokes = strokes.filter((_, i) => i % 4 !== 0);
      check('erase');
      strokes = beforeErase;
      check('restore');
      strokes = strokes.map((s, i) =>
        i === 0
          ? {
              ...s,
              color: '#a81d35',
              points: [
                [600, 100, 0.5],
                [650, 180, 0.9],
              ],
            }
          : s,
      );
      check('same-id-edit');
      strokes = [...strokes].reverse();
      check('reorder');
      height = 640;
      check('multiline');
      strokes = [
        ...strokes,
        {
          id: 'low',
          tool: 'pen',
          color: '#202a40',
          size: 5,
          points: [
            [100, 450, 0.3],
            [200, 580, 0.8],
          ],
        },
      ];
      check('append-low');
      canvas = fresh();
      check('replaced-canvas');
      canvas.width = 17;
      check('external-size-reset');
      painter.reset();
      check('explicit-context-reset');
      strokes = [];
      check('clear');
      height = 320;
      check('single');
      return checks;
    }, cpu);
    expect(
      result.every((r) => r.different === 0),
      JSON.stringify(result),
    ).toBe(true);
    expect(
      result
        .filter((r) => r.name.startsWith('append-'))
        .every((r) => r.mode === 'append' && r.drawn === 1),
    ).toBe(true);
    for (const name of [
      'erase',
      'restore',
      'same-id-edit',
      'reorder',
      'multiline',
      'replaced-canvas',
      'external-size-reset',
      'explicit-context-reset',
      'clear',
      'single',
    ])
      expect(result.find((r) => r.name === name)?.mode, name).toBe('full');
  });
