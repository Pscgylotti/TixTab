import { expect, it } from 'vitest';
import { bitmapDimmingCurve, fullyCoveredByBitmap } from './nightGpuPolicy';
import { transformNightPixels } from './pdfNightColors';

it('accepts complete convex picture coverage in either winding and rotated coverage', () => {
  expect(fullyCoveredByBitmap(100, 80, [[0, 0, 100, 0, 100, 80, 0, 80]])).toBe(true);
  expect(fullyCoveredByBitmap(100, 80, [[0, 80, 100, 80, 100, 0, 0, 0]])).toBe(true);
  expect(fullyCoveredByBitmap(100, 80, [[50, -100, 200, 40, 50, 200, -100, 40]])).toBe(true);
});
it('rejects even a fractional uncovered border, partial unions, concave/degenerate and invalid shapes', () => {
  for (const polygons of [
    [],
    [[0, 0, 99.99, 0, 99.99, 80, 0, 80]],
    [
      [0, 0, 50, 0, 50, 80, 0, 80],
      [50, 0, 100, 0, 100, 80, 50, 80],
    ],
    [[0, 0, 100, 0, 20, 20, 0, 80]],
    [[0, 0, 100, 80, 0, 80, 100, 0]],
    [[0, 0, 0, 0, 0, 0, 0, 0]],
    [[NaN, 0, 100, 0, 100, 80, 0, 80]],
    [[0, 0, Infinity, 0, 100, 80, 0, 80]],
  ]) {
    expect(fullyCoveredByBitmap(100, 80, polygons)).toBe(false);
  }
  expect(fullyCoveredByBitmap(0, 80, [[0, 0, 100, 0, 100, 80, 0, 80]])).toBe(false);
});
it('matches the CPU bitmap transform for every channel value including half ties', () => {
  const expected = new Uint8ClampedArray(256 * 4),
    mask = new Uint8ClampedArray(256 * 4).fill(255);
  for (let i = 0; i < 256; i++) {
    expected[i * 4] = expected[i * 4 + 1] = expected[i * 4 + 2] = i;
    expected[i * 4 + 3] = 255;
  }
  transformNightPixels(expected, mask);
  expect(bitmapDimmingCurve()).toEqual(new Uint8Array(expected));
});

it('rejects large rotated coverage whose float32 vertices cut into the raster', () => {
  const p: [number, number, number, number, number, number, number, number] = [
    -1e8,
    -1e8 - 105,
    1e8,
    1e8 - 105,
    1e8,
    1e8 + 10000,
    -1e8,
    -1e8 + 10000,
  ];
  expect(fullyCoveredByBitmap(105, 80, [p])).toBe(false);
});
