import { expect, test, vi } from 'vitest';
import { bitmapSelectionWords, bitmapTextLines, projectOcrPolygon } from './bitmapText';
import { blankPage } from './model';

test('PDF word coordinates follow the image vertical flip and rotation', () => {
  expect(
    projectOcrPolygon([0, 0, 1, 0, 1, 1, 0, 1], [10, 100, 210, 100, 210, 20, 10, 20], true),
  ).toEqual([10, 20, 210, 20, 210, 100, 10, 100]);
  expect(
    projectOcrPolygon([0, 0, 1, 0, 1, 1, 0, 1], [100, 20, 100, 220, 20, 220, 20, 20], true),
  ).toEqual([20, 20, 20, 220, 100, 220, 100, 20]);
});

test('OCR words follow nested group movement and scaling without including text-only guesses', () => {
  const page = blankPage(),
    polygon = [0, 0, 1, 0, 1, 1, 0, 1];
  page.images = [
    {
      id: 'group',
      kind: 'image',
      data: '',
      x: 100,
      y: 200,
      width: 400,
      height: 200,
      group: {
        width: 100,
        height: 100,
        objects: [
          {
            id: 'child',
            kind: 'image',
            data: '',
            x: 10,
            y: 20,
            width: 50,
            height: 40,
            ocr: {
              text: 'alpha',
              engine: 'Tesseract',
              lines: [{ text: 'alpha', polygon, words: [{ text: 'alpha', polygon }] }],
            },
          },
        ],
      },
    },
  ];
  const line = bitmapTextLines(page)[0];
  expect(line.polygon).toEqual([140, 240, 340, 240, 340, 320, 140, 320]);
  expect(line.words?.[0].polygon).toEqual(line.polygon);
  page.bitmapOcr = [
    { imageIndex: 0, polygon, result: { text: 'no coordinates', lines: [], engine: 'HTTP' } },
  ];
  expect(bitmapTextLines(page)).toHaveLength(1);
});

test('selectable OCR keeps the exact line spacing and safely falls back for mismatched words', () => {
  const polygon = [0, 0, 1, 0, 1, 1, 0, 1];
  for (const text of ['中文', '中 文', 'alpha   beta']) {
    const parts = text.startsWith('中') ? ['中', '文'] : ['alpha', 'beta'];
    const words = bitmapSelectionWords({
      key: 'line',
      text,
      polygon,
      words: parts.map((text) => ({ text, polygon })),
    });
    expect(words.map((w) => w.before + w.text + (w.after ?? '')).join('')).toBe(text);
  }
  expect(
    bitmapSelectionWords({
      key: 'line',
      text: 'original',
      polygon,
      words: [{ text: 'different', polygon }],
    }),
  ).toEqual([
    { key: 'line', text: 'original', polygon, words: [{ text: 'different', polygon }], before: '' },
  ]);
});
