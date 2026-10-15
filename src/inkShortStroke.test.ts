import { expect, it } from 'vitest';
import { getStroke } from 'perfect-freehand';
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

it('retains normal-stroke geometry including sharp turns and repeated samples', () => {
  for (const size of [0.5, 2, 4, 12]) {
    const points: Stroke['points'] = [
      [10, 10, 0.2],
      [50, 20, 0.7],
      [50, 20, 0.8],
      [20, 10, 0.5],
      [150, 40, 0.4],
    ];
    const stroke: Stroke = { id: 'normal', tool: 'pen', color: '#123456', size, points };
    expect(outline(stroke)).toEqual(
      getStroke(points, {
        size,
        thinning: 0.72,
        smoothing: 0.5,
        streamline: 0.25,
        simulatePressure: false,
        last: true,
      }),
    );
  }
});
