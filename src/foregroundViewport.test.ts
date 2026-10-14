import { expect, test } from 'vitest';
import { foregroundClip, sameForegroundClip } from './foregroundViewport';
import { cullingInkBounds, inkBounds, cachedInkPath, rememberInkPath } from './ink';
import type { Stroke } from './model';

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

test('seeded geometry and legacy pressure use exact bounds for conservative culling', () => {
  const seeded: Stroke = { id: 'seeded', tool: 'pen', size: 4, color: '#111', points: [] };
  rememberInkPath(seeded, 'M -20,-30 L 200,300 Z');
  expect(cullingInkBounds(seeded)).toEqual({ minX: -20, minY: -30, maxX: 200, maxY: 300 });
  for (const pressure of [-2, 3, 100]) {
    const stroke: Stroke = { ...seeded, id: String(pressure), points: [[10, 20, pressure]] };
    expect(cullingInkBounds(stroke)).toEqual(inkBounds(stroke));
  }
});
test('inverse viewport bounds include CSS overscan under translation, non-uniform scale and fractional sizes', () => {
  const paper = rect(-500.4, -900.2, 1800, 2400),
    view = rect(50, 20, 600, 800);
  const clip = foregroundClip(paper, view, 600, 1000);
  expect(clip).toBeTruthy();
  if (!clip) throw Error('clip');
  expect(clip.minX).toBeLessThanOrEqual((view.left - paper.left - 160) / 3);
  expect(clip.minY).toBeLessThanOrEqual((view.top - paper.top - 160) / 2.4);
  expect(clip.maxX).toBeGreaterThanOrEqual((view.right - paper.left + 160) / 3);
  expect(clip.maxY).toBeGreaterThanOrEqual((view.bottom - paper.top + 160) / 2.4);
  expect(foregroundClip(rect(0, 2000, 600, 1000), view, 600, 1000)).toBe(false);
  expect(foregroundClip(rect(0, 0, 0, 0), view, 600, 1000)).toBeUndefined();
  expect(sameForegroundClip(clip, { ...clip })).toBe(true);
  expect(sameForegroundClip(clip, false)).toBe(false);
  expect(sameForegroundClip(clip, { ...clip, minX: clip.minX + 1 })).toBe(false);
});
test('cheap cold ink bounds contain actual pressure outlines without preparing invisible paths', () => {
  let seed = 813;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let n = 0; n < 500; n++) {
    const stroke: Stroke = {
      id: String(n),
      tool: (['pen', 'ballpoint', 'pencil', 'highlighter'] as const)[n % 4],
      size: 0.1 + random() * 64,
      color: '#111111',
      points: Array.from({ length: (n % 50) + 1 }, () => [
        random() * 600,
        random() * 1000,
        random(),
      ]),
    };
    const cold = cullingInkBounds(stroke);
    expect(cachedInkPath(stroke)).toBeUndefined();
    const exact = inkBounds(stroke);
    expect(cold.minX).toBeLessThanOrEqual(exact.minX);
    expect(cold.minY).toBeLessThanOrEqual(exact.minY);
    expect(cold.maxX).toBeGreaterThanOrEqual(exact.maxX);
    expect(cold.maxY).toBeGreaterThanOrEqual(exact.maxY);
    expect(cullingInkBounds(stroke)).toBe(exact);
  }
});
