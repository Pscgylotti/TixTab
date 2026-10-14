import { expect, test } from 'vitest';
import { recognitionImageSize } from './recognitionImageSize';

test.each([
  [2001, 2000, 2.5], // Ceil at the 4 MP boundary used to exceed the backend limit.
  [3001, 2000, 1], // Round in bitmap OCR also exceeded it.
  [595.28, 841.89, 2.5],
  [40_000, 100, 1], // Long edge is bounded even below the area limit.
  [100, 40_000, 1],
  [20_000, 30_000, 1],
  [1, 100_000, 1],
])('recognition raster %s × %s at scale %s satisfies backend bounds', (w, h, maxScale) => {
  const size = recognitionImageSize(w, h, maxScale);
  expect(Number.isInteger(size.width) && Number.isInteger(size.height)).toBe(true);
  expect(size.width * size.height).toBeLessThanOrEqual(4_000_000);
  expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(8192);
  expect(size.scale).toBeLessThanOrEqual(maxScale);
  // Capture uses a uniform transform: keep the entire requested region visible.
  expect(w * size.scale).toBeLessThanOrEqual(size.width + 1e-8);
  expect(h * size.scale).toBeLessThanOrEqual(size.height + 1e-8);
});

test('small inputs keep their resolution and exact 4 MP images are accepted', () => {
  expect(recognitionImageSize(640, 480)).toEqual({ width: 640, height: 480, scale: 1 });
  expect(recognitionImageSize(2000, 2000)).toEqual({ width: 2000, height: 2000, scale: 1 });
});

test.each([0, -1, NaN, Infinity])('invalid dimension %s cannot allocate a canvas', (value) => {
  expect(() => recognitionImageSize(value, 100)).toThrow(RangeError);
  expect(() => recognitionImageSize(100, value)).toThrow(RangeError);
  expect(() => recognitionImageSize(100, 100, value)).toThrow(RangeError);
});
