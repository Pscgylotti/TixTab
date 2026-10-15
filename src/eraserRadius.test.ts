import { expect, it, vi, afterEach } from 'vitest';
import { eraserPaperRadius } from './eraserRadius';
import { savedInkSize, saveInkSize } from './inkPreferences';
afterEach(() => vi.unstubAllGlobals());
it('applies mapped pressure without a minimum radius and keeps mouse radius fixed', () => {
  expect(eraserPaperRadius(8, 0, true)).toBe(0);
  expect(eraserPaperRadius(0.1, 0.01, true)).toBe(0.001);
  expect(eraserPaperRadius(8, 0.25, true)).toBe(2);
  expect(eraserPaperRadius(8, 0, false)).toBe(8);
});
it('persists independent pen and eraser sizes with legacy migration', () => {
  const values = new Map([['tixtab.penSize', '4']]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
  });
  expect(savedInkSize('pen')).toBe(4);
  expect(savedInkSize('eraser')).toBe(8);
  for (const [tool, size] of [
    ['pen', 0.5],
    ['ballpoint', 2],
    ['pencil', 3],
    ['highlighter', 20],
    ['eraser', 0.1],
  ] as const)
    saveInkSize(tool, size);
  expect(
    ['pen', 'ballpoint', 'pencil', 'highlighter', 'eraser'].map((tool) =>
      savedInkSize(tool as 'pen'),
    ),
  ).toEqual([0.5, 2, 3, 20, 0.1]);
});
