import { afterEach, expect, it, vi } from 'vitest';
import { originalPdfText } from './chatFile';
const mocks = vi.hoisted(() => ({ loadPdf: vi.fn() }));
vi.mock('./pdf', () => ({ loadPdf: mocks.loadPdf }));
afterEach(() => vi.resetAllMocks());
it('bounds PDF text and explicitly marks partial coverage without altering source bytes', async () => {
  const cleanup = vi.fn(),
    destroy = vi.fn();
  mocks.loadPdf.mockResolvedValue({
    numPages: 5,
    getPage: async () => ({
      getTextContent: async () => ({ items: [{ str: 'a'.repeat(60000), hasEOL: true }] }),
      cleanup,
    }),
    destroy,
  });
  const source = new Uint8Array([1, 2, 3]);
  const text = await originalPdfText(source, new AbortController().signal);
  expect(text).toContain('2 of 5 pages; truncated at 100000 characters');
  expect(text).toContain('do not claim to summarize unseen content');
  expect(text.length).toBeLessThan(100400);
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(destroy).toHaveBeenCalledOnce();
  expect(mocks.loadPdf.mock.calls[0][0]).not.toBe(source);
  expect(source).toEqual(new Uint8Array([1, 2, 3]));
});
it('rejects scanned PDFs with an actionable error and destroys its private document', async () => {
  const destroy = vi.fn();
  mocks.loadPdf.mockResolvedValue({
    numPages: 1,
    getPage: async () => ({ getTextContent: async () => ({ items: [] }), cleanup: vi.fn() }),
    destroy,
  });
  await expect(originalPdfText(new Uint8Array([1]), new AbortController().signal)).rejects.toThrow(
    'OCR',
  );
  expect(destroy).toHaveBeenCalledOnce();
});
it('cancels extraction between pages and still releases the PDF worker', async () => {
  const controller = new AbortController(),
    destroy = vi.fn();
  mocks.loadPdf.mockResolvedValue({
    numPages: 2,
    getPage: async () => ({
      getTextContent: async () => {
        controller.abort();
        return { items: [] };
      },
      cleanup: vi.fn(),
    }),
    destroy,
  });
  await expect(originalPdfText(new Uint8Array([1]), controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(destroy).toHaveBeenCalledOnce();
});
