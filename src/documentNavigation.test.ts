import { expect, it, vi } from 'vitest';
import {
  detectedUrls,
  findText,
  readPageText,
  resolveDestination,
  safeDocumentUrl,
  findObjectText,
} from './documentNavigation';
import { blankPage } from './model';
import type { PDFDocumentProxy } from './pdfTypes';
import { PdfViewport } from './pdfViewport';
it.each([0, 90, 180, 270])(
  'keeps rotated arXiv substring bounds and search aligned at page rotation %s',
  async (rotation) => {
    const str = 'arXiv:2212.05032v3 [cs.CV] 28 Feb',
      viewport = new PdfViewport(
        { view: [20, 30, 620, 830], rotation, userUnit: 2, objectNumber: 1 },
        { scale: 1 },
      );
    const pdf = {
      getPage: async () => ({
        getViewport: () => viewport,
        getTextContent: async () => ({
          items: [
            {
              str,
              transform: [0, 12, -12, 0, 60, 100],
              width: str.length * 6,
              height: 12,
              fontName: 'f',
            },
          ],
          styles: { f: { ascent: 0.8 } },
        }),
      }),
    } as unknown as PDFDocumentProxy;
    const content = await readPageText(pdf, 0),
      link = detectedUrls(content)[0],
      rect = link.rects[0],
      expected = viewport.convertToViewportRectangle([50.4, 100, 62.4, 208]),
      x = Math.min(expected[0], expected[2]),
      y = Math.min(expected[1], expected[3]);
    expect(link.url).toBe('https://arxiv.org/abs/2212.05032v3');
    expect(rect.x).toBeCloseTo(x);
    expect(rect.y).toBeCloseTo(y);
    expect(rect.width).toBeCloseTo(Math.abs(expected[2] - expected[0]));
    expect(rect.height).toBeCloseTo(Math.abs(expected[3] - expected[1]));
    expect(findText(content, 'arXiv:2212.05032v3', 'page')[0].rects).toEqual(link.rects);
  },
);

it('joins adjacent rotated fragments along their baseline without adding spaces inside identifiers', async () => {
  const pdf = {
    getPage: async () => ({
      getViewport: () => ({ transform: [1, 0, 0, -1, 0, 800], scale: 1, userUnit: 1 }),
      getTextContent: async () => ({
        items: [
          { str: 'arXiv:', transform: [0, 12, -12, 0, 60, 100], width: 36, fontName: 'f' },
          { str: '2212.05032v3', transform: [0, 12, -12, 0, 60, 136], width: 66, fontName: 'f' },
          { str: '[cs.CV]', transform: [0, 12, -12, 0, 60, 208], width: 42, fontName: 'f' },
        ],
        styles: { f: { ascent: 0.8 } },
      }),
    }),
  } as unknown as PDFDocumentProxy;
  const content = await readPageText(pdf, 0);
  expect(content.text).toBe('arXiv:2212.05032v3 [cs.CV]');
  expect(detectedUrls(content)[0].rects).toHaveLength(2);
  expect(detectedUrls(content)[0].rects.every((r) => r.width < r.height)).toBe(true);
});
it('searches literal punctuation and phrases across line breaks without changing Unicode offsets', () => {
  const text = 'İ prefix a+b\nNEXT end a+b';
  const content = {
    text,
    parts: [{ start: 0, end: text.length, rect: { x: 20, y: 30, width: 260, height: 10 } }],
  };
  const hits = findText(content, 'a+b next', 'page');
  expect(hits).toHaveLength(1);
  expect(hits[0].key).toBe('page:pdf:9');
  expect(hits[0].rects[0].x).toBe(20 + (260 * 9) / text.length);
  expect(findText(content, 'a+b', 'page')).toHaveLength(2);
});
it('recognizes plain web URLs, drops sentence punctuation and rejects unsafe protocols/credentials', () => {
  const text = 'See https://example.org/a?q=1, and www.example.com. javascript:bad';
  const links = detectedUrls({
    text,
    parts: [{ start: 0, end: text.length, rect: { x: 0, y: 0, width: 500, height: 12 } }],
  });
  expect(links.map((l) => l.url)).toEqual([
    'https://example.org/a?q=1',
    'https://www.example.com/',
  ]);
  for (const url of [
    'javascript:alert(1)',
    'file:///c:/x',
    'https://u:p@example.com',
    'data:text/plain,x',
  ])
    expect(safeDocumentUrl(url)).toBeNull();
});
it('recognizes explicit arXiv identifiers and email addresses without duplicate URL hits', () => {
  const text =
    'arXiv:2607.12358, arXiv: 0704.0001v2; arXiv:hep-th/9901001. Contact author+pdf@example.ac.uk or mailto:team@example.org. https://example.org/a@b.com arXiv:2613.12345 2607.12358';
  const content = {
    text,
    parts: [{ start: 0, end: text.length, rect: { x: 0, y: 0, width: 1000, height: 12 } }],
  };
  expect(detectedUrls(content).map((l) => l.url)).toEqual([
    'https://arxiv.org/abs/2607.12358',
    'https://arxiv.org/abs/0704.0001v2',
    'https://arxiv.org/abs/hep-th/9901001',
    'mailto:author+pdf@example.ac.uk',
    'mailto:team@example.org',
    'https://example.org/a@b.com',
  ]);
});
it('shares one extraction across simultaneous requests and resolves named reference destinations', async () => {
  const getTextContent = vi.fn(async () => ({
    items: [
      { str: 'first', transform: [1, 0, 0, 12, 30, 40], width: 30, fontName: 'f', hasEOL: false },
    ],
    styles: { f: { ascent: 0.8 } },
  }));
  const getPage = vi.fn(async () => ({
    getTextContent,
    view: [0, 0, 595, 842],
    getViewport: () => ({
      transform: [1, 0, 0, 1, 0, 0],
      scale: 1,
      convertToViewportPoint: (x: number, y: number) => [x, 842 - y],
    }),
  }));
  const pdf = {
    getPage,
    numPages: 2,
    getDestination: vi.fn(async () => [{ num: 8, gen: 0 }, { name: 'XYZ' }, 30, 700, null]),
    getPageIndex: vi.fn(async () => 1),
  } as unknown as PDFDocumentProxy;
  const [a, b] = await Promise.all([readPageText(pdf, 0), readPageText(pdf, 0)]);
  expect(a).toBe(b);
  expect(getTextContent).toHaveBeenCalledTimes(1);
  expect(await resolveDestination(pdf, 'ref')).toEqual({
    sourceIndex: 1,
    rect: { x: 30, y: 142, width: 1, height: 20 },
  });
  await resolveDestination(pdf, 'ref');
  expect(pdf.getPageIndex).toHaveBeenCalledTimes(1);
});
it('finds editable text in nested foreground objects without requiring OCR', () => {
  const page = blankPage();
  page.images = [
    {
      id: 'g',
      kind: 'image',
      data: '',
      x: 5,
      y: 6,
      width: 100,
      height: 50,
      group: {
        width: 100,
        height: 50,
        objects: [
          {
            id: 't',
            kind: 'text',
            data: '',
            x: 0,
            y: 0,
            width: 50,
            height: 20,
            textBox: { content: 'Alpha beta', fontSize: 12, color: '#000000', bold: false },
          },
        ],
      },
    },
  ];
  expect(findObjectText(page, 'beta')).toHaveLength(1);
});
