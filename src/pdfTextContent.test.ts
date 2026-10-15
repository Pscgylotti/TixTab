import { it, expect, vi } from 'vitest';
import type { PDFDocumentProxy } from './pdfTypes';
import { readPdfTextContent, type TextContent } from './pdfTextContent';
function fixture(content = { items: [], styles: {} } as unknown as TextContent) {
  const getTextContent = vi.fn(async () => content);
  const pdf = { getPage: vi.fn(async () => ({ getTextContent })) } as unknown as PDFDocumentProxy;
  return { pdf, getTextContent };
}
it('shares pending and completed requests without mutating extracted content or mixing documents', async () => {
  const content = Object.freeze({
    items: Object.freeze([]),
    styles: Object.freeze({}),
    lang: 'en',
  }) as unknown as TextContent;
  const { pdf, getTextContent } = fixture(content),
    other = fixture(content);
  const a = readPdfTextContent(pdf, 0),
    b = readPdfTextContent(pdf, 0);
  expect(a).toBe(b);
  expect(await a).toBe(content);
  expect(await readPdfTextContent(pdf, 0)).toBe(content);
  await readPdfTextContent(other.pdf, 0);
  expect(getTextContent).toHaveBeenCalledTimes(1);
  expect(other.getTextContent).toHaveBeenCalledTimes(1);
});
it('evicts least recently used pages and oversized source data instead of retaining unbounded content', async () => {
  const { pdf, getTextContent } = fixture();
  for (let i = 0; i < 32; i++) await readPdfTextContent(pdf, i);
  await readPdfTextContent(pdf, 0);
  await readPdfTextContent(pdf, 32);
  await readPdfTextContent(pdf, 0);
  expect(getTextContent).toHaveBeenCalledTimes(33);
  await readPdfTextContent(pdf, 1);
  expect(getTextContent).toHaveBeenCalledTimes(34);
  const large = fixture({
    items: [{ str: 'x'.repeat(4_000_001) }],
    styles: {},
  } as unknown as TextContent);
  await readPdfTextContent(large.pdf, 0);
  await readPdfTextContent(large.pdf, 0);
  expect(large.getTextContent).toHaveBeenCalledTimes(2);
});
it('a rejected request can be retried and a new PDF identity gets independent text', async () => {
  const { pdf, getTextContent } = fixture();
  getTextContent.mockRejectedValueOnce(new Error('extraction failed'));
  await expect(readPdfTextContent(pdf, 0)).rejects.toThrow('extraction failed');
  await expect(readPdfTextContent(pdf, 0)).resolves.toHaveProperty('items');
  expect(getTextContent).toHaveBeenCalledTimes(2);
});
