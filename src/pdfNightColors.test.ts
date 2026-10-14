import { expect, it } from 'vitest';
import { transformNightPixels } from './pdfNightColors';

// Frozen pre-fast-path arithmetic, including its Float32 lookup-table rounding.
function referenceNightPixels(p: Uint8ClampedArray, mask?: Uint8ClampedArray) {
  const lut = Float32Array.from({ length: 256 }, (_, chroma) => {
    const t = Math.min(1, Math.max(0, (chroma - 16) / 32));
    return 0.7 * t * t * (3 - 2 * t);
  });
  for (let i = 0; i < p.length; i += 4) {
    const r = p[i],
      g = p[i + 1],
      b = p[i + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const target = 230 - (l * 202) / 255;
    const saturation = lut[Math.max(r, g, b) - Math.min(r, g, b)];
    const photo = (mask?.[i + 3] ?? 0) / 255;
    p[i] = (target + (r - l) * saturation) * (1 - photo) + r * 0.62 * photo;
    p[i + 1] = (target + 4 + (g - l) * saturation) * (1 - photo) + g * 0.62 * photo;
    p[i + 2] = (target + 11 + (b - l) * saturation) * (1 - photo) + b * 0.62 * photo;
  }
}

function identical(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i]) throw Error(`Night channel ${i}: ${a[i]} !== ${b[i]}`);
}

it('matches the old arithmetic for all 16,777,216 fully masked RGB colors, preserving alpha', () => {
  const mask = new Uint8ClampedArray(256 * 256 * 4).fill(255);
  for (let r = 0; r < 256; r++) {
    const p = new Uint8ClampedArray(mask.length);
    for (let g = 0; g < 256; g++)
      for (let b = 0; b < 256; b++) p.set([r, g, b, (r + g + b) % 256], (g * 256 + b) * 4);
    const expected = p.slice();
    referenceNightPixels(expected, mask);
    transformNightPixels(p, mask);
    identical(p, expected);
  }
}, 15000);

it('keeps vector, partial coverage, mixed masks and absent mask arithmetic byte-identical', () => {
  let seed = 813;
  const randomByte = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 24;
  const source = Uint8ClampedArray.from({ length: 65536 }, randomByte);
  for (const alpha of [undefined, 0, 1, 127, 254, 255, 'mixed'] as const) {
    const mask = alpha === undefined ? undefined : new Uint8ClampedArray(source.length);
    if (mask)
      for (let i = 3; i < mask.length; i += 4) mask[i] = alpha === 'mixed' ? randomByte() : alpha!;
    const p = source.slice(),
      expected = source.slice();
    referenceNightPixels(expected, mask);
    transformNightPixels(p, mask);
    identical(p, expected);
  }
});

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
