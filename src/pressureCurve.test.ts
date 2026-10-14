import { afterEach, expect, it, vi } from 'vitest';
import { compilePressureCurve, normalizePressureCurve, LINEAR_PRESSURE } from './pressureCurve';
afterEach(() => vi.unstubAllGlobals());
it('defaults to linear and clamps invalid pressure', () => {
  const map = compilePressureCurve(LINEAR_PRESSURE);
  for (let i = 0; i <= 100; i++) expect(map(i / 100)).toBe(i / 100);
  expect(map(-1)).toBe(0);
  expect(map(2)).toBe(1);
  expect(map(NaN)).toBe(0);
});
it('interpolates multiple segments, preserves snapshots, validates endpoints and 16-point limit', () => {
  const map = compilePressureCurve([
    [0, 0],
    [0.25, 0.5],
    [0.75, 0.6],
    [1, 1],
  ]);
  expect(map(0.125)).toBeCloseTo(0.25);
  expect(map(0.5)).toBeCloseTo(0.55);
  expect(map(0.875)).toBeCloseTo(0.8);
  const valid = [
    [0, 0],
    ...Array.from({ length: 16 }, (_, i) => [(i + 1) / 17, (i + 1) / 17]),
    [1, 1],
  ];
  expect(normalizePressureCurve(valid)).toHaveLength(18);
  for (const invalid of [
    [...valid, [1, 1]],
    [
      [0, 1],
      [1, 1],
    ],
    [
      [0, 0],
      [0, 1],
      [1, 1],
    ],
    [
      [0, 0],
      [NaN, 0.4],
      [1, 1],
    ],
    null,
  ])
    expect(normalizePressureCurve(invalid)).toBe(LINEAR_PRESSURE);
});
it('persists preferences without changing a mapper already captured by a stroke', async () => {
  vi.resetModules();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
  });
  const module = await import('./pressureCurve');
  const original = module.getPressureMapper();
  module.savePressureCurve([
    [0, 0],
    [0.5, 0.8],
    [1, 1],
  ]);
  expect(original(0.5)).toBe(0.5);
  expect(module.getPressureMapper()(0.5)).toBe(0.8);
  vi.resetModules();
  expect((await import('./pressureCurve')).getPressureMapper()(0.5)).toBe(0.8);
});
