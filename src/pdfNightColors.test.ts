import { expect, it } from 'vitest';
import { transformNightPixels } from './pdfNightColors';

it('preserves every grayscale coverage level and its alpha without spatial filtering', () => {
  const pixels = new Uint8ClampedArray(256 * 4);
  for (let v = 0; v < 256; v++) pixels.set([v, v, v, 200], v * 4);
  transformNightPixels(pixels);
  for (let v = 0; v < 256; v++) {
    const target = 230 - (v * 202) / 255;
    expect(Array.from(pixels.slice(v * 4, v * 4 + 4))).toEqual(
      Array.from(new Uint8ClampedArray([target, target + 4, target + 11, 200])),
    );
  }
});

it('removes low-chroma RGB fringes while preserving saturated vector hues', () => {
  const p = new Uint8ClampedArray([126, 132, 138, 255, 138, 132, 126, 255, 255, 0, 0, 255]);
  transformNightPixels(p);
  for (const i of [0, 4]) {
    expect(p[i + 1] - p[i]).toBe(4);
    expect(p[i + 2] - p[i]).toBe(11);
  }
  expect(p[8]).toBeGreaterThan(p[9]);
  expect(p[8]).toBeGreaterThan(p[10]);
});

it('leaves bitmap hue and low-chroma image detail on the image brightness path', () => {
  const original = new Uint8ClampedArray([126, 132, 138, 255, 255, 0, 0, 255]);
  const p = original.slice(),
    mask = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
  transformNightPixels(p, mask);
  expect(Array.from(p)).toEqual(
    Array.from(new Uint8ClampedArray([126 * 0.62, 132 * 0.62, 138 * 0.62, 255, 158.1, 0, 0, 255])),
  );
});
