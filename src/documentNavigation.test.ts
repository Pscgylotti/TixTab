import { expect, it, vi } from 'vitest';
vi.mock('pdfjs-dist', () => ({ Util: { transform: (_: number[], matrix: number[]) => matrix } }));
import {
  detectedUrls,
  findText,
  readPageText,
  resolveDestination,
  safeDocumentUrl,
  findObjectText,
} from './documentNavigation';
import { blankPage } from './model';
import type { PDFDocumentProxy } from 'pdfjs-dist';
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
