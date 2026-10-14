import { expect, it } from 'vitest';
import { finalInkPath, inkPath, inkBounds, outline, rememberInkPath } from './ink';
import type { Stroke } from './model';

it('keeps exact path strings and legacy rounded/raw bounds across pressures and decimal edges', () => {
  let seed = 813;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 2000; i++) {
    const stroke: Stroke = {
      id: `format-${i}`,
      tool: ['pen', 'ballpoint', 'pencil', 'highlighter'][i % 4] as Stroke['tool'],
      color: '#335577',
      size: 0.1 + random() * 24,
      points: Array.from({ length: 1 + (i % 18) }, (_, j) => [
        (i % 2 ? -1 : 1) * (random() * 600 + (j % 3) * 0.005),
        (i % 3 ? 1 : -1) * (random() * 800 + (j % 4) * 0.005),
        random() * 1.5 - 0.2,
      ]),
    };
    const original = inkPath(stroke);
    expect(finalInkPath(stroke)).toBe(original);
    const points = [
      ...outline(stroke).map((p) => [Number(p[0].toFixed(2)), Number(p[1].toFixed(2)), 0]),
      ...stroke.points.map((p) => [p[0], p[1], stroke.size / 2]),
    ];
    const expected = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const [x, y, radius] of points) {
      expected.minX = Math.min(expected.minX, x - radius);
      expected.minY = Math.min(expected.minY, y - radius);
      expected.maxX = Math.max(expected.maxX, x + radius);
      expected.maxY = Math.max(expected.maxY, y + radius);
    }
    expect(inkBounds(stroke)).toEqual(expected);
    expect(finalInkPath(stroke)).toBe(original);
  }
});

it('preserves empty and worker-seeded geometry fallbacks', () => {
  const empty: Stroke = { id: 'empty', tool: 'pen', color: '#335577', size: 2, points: [] };
  expect(finalInkPath(empty)).toBe('');
  expect(inkBounds(empty)).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  const seeded = { ...empty, id: 'seeded' };
  rememberInkPath(seeded, 'M -10.255,20.005 L 30.001,40.009 Z');
  expect(finalInkPath(seeded)).toBe('M -10.255,20.005 L 30.001,40.009 Z');
  expect(inkBounds(seeded)).toEqual({
    minX: Number((-10.255).toFixed(2)),
    minY: Number((20.005).toFixed(2)),
    maxX: 30,
    maxY: 40.01,
  });
});

it('preserves seeded decimal extrema, rounding ties and signed-zero hit bounds', () => {
  for (const coordinates of [
    [
      [-0.001, -0.004],
      [-0.002, -0.003],
    ],
    [
      [-0, 0],
      [0, -0],
    ],
    [
      [-0.005, 0.005],
      [1.005, -1.005],
      [-10.255, 20.005],
    ],
    [
      [-1e21, 1e21],
      [1e21, -1e21],
    ],
  ]) {
    const stroke: Stroke = {
      id: 'seed-extrema',
      tool: 'pen',
      color: '#335577',
      size: 2,
      points: [],
    };
    rememberInkPath(stroke, `M ${coordinates.map(([x, y]) => `${x},${y}`).join(' L ')} Z`);
    const expected = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    // The legacy fallback parses coordinate pairs without exponent notation.
    const pairs = [...finalInkPath(stroke).matchAll(/(-?[\d.]+),(-?[\d.]+)/g)];
    for (const pair of pairs) {
      const x = Number(Number(pair[1]).toFixed(2)),
        y = Number(Number(pair[2]).toFixed(2));
      expected.minX = Math.min(expected.minX, x - 0);
      expected.minY = Math.min(expected.minY, y - 0);
      expected.maxX = Math.max(expected.maxX, x + 0);
      expected.maxY = Math.max(expected.maxY, y + 0);
    }
    expect(inkBounds(stroke)).toEqual(
      expected.minX === Infinity ? { minX: 0, minY: 0, maxX: 0, maxY: 0 } : expected,
    );
  }
});
