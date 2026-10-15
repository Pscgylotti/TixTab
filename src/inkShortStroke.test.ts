import { expect, it } from 'vitest';
import { outline, finalInkPath, cullingInkBounds, inkBounds } from './ink';
import type { Stroke } from './model';

it('short thin strokes and taps never create a cap wider than the brush pressure radius', () => {
  for (const size of [0.5, 0.75, 1, 2.5])
    for (const length of [0, 0.2, 0.5, 1, 2, 2.9, 3.1, 4])
      for (const pressure of [0.1, 0.5, 1])
        for (const tool of ['pen', 'ballpoint', 'pencil', 'highlighter'] as const) {
          const stroke: Stroke = {
            id: 'short',
            tool,
            size,
            color: '#112233',
            points:
              length === 0
                ? [[100, 100, pressure]]
                : [
                    [100, 100, pressure],
                    [100 + length, 100, pressure],
                  ],
          };
          const shape = outline(stroke);
          expect(shape.length).toBeGreaterThan(0);
          const thinning = tool === 'pen' ? 0.72 : tool === 'pencil' ? 0.65 : 0;
          const radius = size * (0.5 - thinning * (0.5 - pressure));
          for (const [x, y] of shape) {
            const dx = x < 100 ? 100 - x : x > 100 + length ? x - 100 - length : 0;
            expect(
              Math.hypot(dx, y - 100),
              JSON.stringify({ size, length, pressure, tool, x, y }),
            ).toBeLessThanOrEqual(radius + 0.001);
          }
          expect(finalInkPath(stroke)).not.toMatch(/NaN|Infinity/);
          const coarse = cullingInkBounds(stroke),
            exact = inkBounds(stroke);
          expect(coarse.minX).toBeLessThanOrEqual(exact.minX);
          expect(coarse.minY).toBeLessThanOrEqual(exact.minY);
          expect(coarse.maxX).toBeGreaterThanOrEqual(exact.maxX);
          expect(coarse.maxY).toBeGreaterThanOrEqual(exact.maxY);
        }
});

it('retains endpoints, turns and raw pressure while smoothing the display outline', () => {
  for (const size of [0.5, 2, 4, 12]) {
    const points: Stroke['points'] = [
      [10, 10, 0.2],
      [50, 20, 0.7],
      [50, 20, 0.8],
      [20, 10, 0.5],
      [150, 40, 0.4],
    ];
    const raw = JSON.stringify(points);
    const shape = outline({ id: 'normal', tool: 'pen', color: '#123456', size, points });
    expect(shape.every((p) => p.every(Number.isFinite))).toBe(true);
    expect(Math.max(...shape.map((p) => p[0]))).toBeGreaterThanOrEqual(150);
    expect(Math.min(...shape.map((p) => p[0]))).toBeLessThan(10);
    expect(JSON.stringify(points)).toBe(raw);
  }
});
