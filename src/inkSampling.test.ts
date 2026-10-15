import { expect, it } from 'vitest';
import { InkSampleClock } from './inkSampling';
import { outline } from './ink';
import type { Stroke } from './model';

it('merges raw and coalesced events without duplicate/backward points or lost pressure changes', () => {
  const clock = new InkSampleClock();
  const points = [
    [1, 10, 10, 0.1],
    [2, 10, 11, 0.2],
    [3, 11, 12, 0.3],
  ];
  expect(points.map(([t, x, y, p]) => clock.accept(t, x, y, p))).toEqual([true, true, true]);
  expect(points.map(([t, x, y, p]) => clock.accept(t, x, y, p))).toEqual([false, false, false]);
  expect(clock.accept(3, 11, 12, 0.6)).toBe(true);
  expect(clock.accept(3, 11, 12, 0.6)).toBe(false);
  clock.reset();
  expect(clock.accept(1, 10, 10, 0.1)).toBe(true);
});

it('preserves the opening and bottom of a miniature U at different paper scales', () => {
  const inside = (polygon: number[][], x: number, y: number) => {
    let result = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i],
        b = polygon[j];
      if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0])
        result = !result;
    }
    return result;
  };
  for (const scale of [0.5, 1, 2, 10]) {
    const stroke: Stroke = {
      id: 'u',
      tool: 'pen',
      color: '#123456',
      size: 0.5 * scale,
      points: [
        [0, 0, 0.01],
        [0, 0.1, 0.01],
        [0.1, 0.1, 0.01],
        [0.2, 0.1, 0.01],
        [0.2, 0, 0.01],
      ].map(([x, y, p]) => [x * scale, y * scale, p]),
    };
    const polygon = outline(stroke);
    expect(inside(polygon, 0.1 * scale, 0.1 * scale)).toBe(true);
    expect(inside(polygon, 0.1 * scale, 0)).toBe(false);
  }
});
