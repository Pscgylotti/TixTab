import { test, expect, vi } from 'vitest';
vi.mock('pdfjs-dist', () => ({ Util: {} }));
import { normalizeOcr, tesseractLines, validOcr } from './ocrLayout';
import { findBitmapText } from './documentNavigation';
import { blankPage, newNotebook, validNotebook } from './model';
test('engine line geometry is normalized and invalid boxes cannot enter a project', () => {
  const lines = tesseractLines([
    {
      paragraphs: [
        { lines: [{ text: ' alpha ', confidence: 95, bbox: { x0: 10, y0: 20, x1: 90, y1: 40 } }] },
      ],
    },
  ]);
  const result = normalizeOcr('alpha', lines, 100, 100, 'Tesseract');
  expect(result.lines[0].polygon).toEqual([0.1, 0.2, 0.9, 0.2, 0.9, 0.4, 0.1, 0.4]);
  expect(validOcr(result)).toBe(true);
  expect(
    validOcr({ ...result, lines: [{ text: 'bad', polygon: [NaN, 0, 1, 0, 1, 1, 0, 1] }] }),
  ).toBe(false);
  const n = newNotebook();
  n.pages[0].bitmapOcr = [{ imageIndex: 0, polygon: [0, 100, 100, 100, 100, 0, 0, 0], result }];
  expect(validNotebook(n)).toBe(true);
  expect(findBitmapText(n.pages[0], 'alpha')[0].rects).toEqual([
    { x: 10, y: 20, width: 80, height: 20 },
  ]);
});
test('OCR highlights full measured lines, follows image transforms and nested groups', () => {
  const p = blankPage(),
    ocr = normalizeOcr(
      'ignored',
      [{ text: 'alpha beta', polygon: [10, 20, 90, 20, 90, 40, 10, 40] }],
      100,
      100,
      'test',
    );
  p.images = [
    {
      id: 'group',
      kind: 'image',
      data: 'data:image/png;base64,AA==',
      x: 100,
      y: 200,
      width: 400,
      height: 200,
      group: {
        width: 100,
        height: 100,
        objects: [
          {
            id: 'a',
            kind: 'image',
            data: 'data:image/png;base64,AA==',
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            ocr,
          },
          {
            id: 'b',
            kind: 'image',
            data: 'data:image/png;base64,AA==',
            x: 0,
            y: 0,
            width: 1,
            height: 1,
          },
        ],
      },
    },
  ];
  expect(findBitmapText(p, 'beta')[0].rects).toEqual([{ x: 140, y: 240, width: 320, height: 40 }]);
  p.images[0] = { ...p.images[0], x: 150, width: 200 };
  expect(findBitmapText(p, 'alpha')[0].rects).toEqual([{ x: 170, y: 240, width: 160, height: 40 }]);
  const pdf = blankPage();
  pdf.bitmapOcr = [
    { imageIndex: 1, polygon: [300, 100, 300, 300, 100, 300, 100, 100], result: ocr },
  ];
  expect(findBitmapText(pdf, 'alpha')[0].rects).toEqual([
    { x: 140, y: 120, width: 40, height: 160 },
  ]);
});
test('text-only engines search without fabricating precise coordinates', () => {
  const p = blankPage();
  p.bitmapOcr = [
    {
      imageIndex: 0,
      polygon: [10, 80, 110, 80, 110, 20, 10, 20],
      result: { text: 'two lines\nalpha', lines: [], engine: 'HTTP' },
    },
  ];
  expect(findBitmapText(p, 'alpha')[0].rects).toEqual([{ x: 10, y: 20, width: 100, height: 60 }]);
});

test('Tesseract word boxes survive normalization and project validation', () => {
  const lines = tesseractLines([
    {
      paragraphs: [
        {
          lines: [
            {
              text: 'alpha beta',
              bbox: { x0: 10, y0: 20, x1: 190, y1: 40 },
              words: [
                { text: 'alpha', bbox: { x0: 10, y0: 20, x1: 80, y1: 40 } },
                { text: 'beta', bbox: { x0: 100, y0: 20, x1: 190, y1: 40 } },
              ],
            },
          ],
        },
      ],
    },
  ]);
  const result = normalizeOcr('alpha beta', lines, 200, 100, 'Tesseract');
  expect(result.lines[0].words).toEqual([
    { text: 'alpha', polygon: [0.05, 0.2, 0.4, 0.2, 0.4, 0.4, 0.05, 0.4] },
    { text: 'beta', polygon: [0.5, 0.2, 0.95, 0.2, 0.95, 0.4, 0.5, 0.4] },
  ]);
  expect(validOcr(result)).toBe(true);
  expect(validOcr({ ...result, lines: [{ ...result.lines[0], words: [null] }] })).toBe(false);
  expect(
    validOcr({
      ...result,
      lines: [{ ...result.lines[0], words: [{ text: 'bad', polygon: [NaN] }] }],
    }),
  ).toBe(false);
});
