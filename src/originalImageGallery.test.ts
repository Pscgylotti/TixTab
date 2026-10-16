import { describe, expect, it } from 'vitest';
import { adjacentOriginalImage, type OriginalImageSelection } from './originalImageGallery';
import type { PDFDocumentProxy } from './pdfTypes';
const polygon = [0, 0, 10, 0, 10, 20, 0, 20];
function fixture() {
  const calls: number[] = [];
  const pdf = {
    getImages: async (i: number) => {
      calls.push(i);
      return i === 1 ? [] : i === 0 ? [polygon, polygon] : [polygon];
    },
    getPage: async () => ({ getViewport: () => ({ transform: [1, 0, 0, 1, 0, 0] }) }),
  } as unknown as PDFDocumentProxy;
  const pages = [
    { id: 'a', sourceIndex: 0 },
    { id: 'blank', sourceIndex: null },
    { id: 'empty', sourceIndex: 1 },
    { id: 'c', sourceIndex: 2 },
  ];
  const selected: OriginalImageSelection = { pageId: 'a', sourceIndex: 0, imageIndex: 0, polygon };
  return { pdf, calls, pages, selected };
}
describe('original image gallery', () => {
  it('walks current page images, skips empty/inserted blank pages and reverses across pages', async () => {
    const f = fixture(),
      signal = new AbortController().signal;
    const second = (await adjacentOriginalImage(f.pdf, f.pages, f.selected, 1, signal))!;
    expect([second.pageId, second.imageIndex]).toEqual(['a', 1]);
    expect(f.calls).toEqual([0]);
    const next = (await adjacentOriginalImage(f.pdf, f.pages, second, 1, signal))!;
    expect([next.pageId, next.sourceIndex, next.imageIndex]).toEqual(['c', 2, 0]);
    expect((await adjacentOriginalImage(f.pdf, f.pages, next, -1, signal))?.imageIndex).toBe(1);
    expect(await adjacentOriginalImage(f.pdf, f.pages, next, 1, signal)).toBeNull();
    expect(await adjacentOriginalImage(f.pdf, f.pages, f.selected, -1, signal)).toBeNull();
  });
  it('uses edited document order and identifies duplicate source pages by page ID', async () => {
    const f = fixture(),
      signal = new AbortController().signal;
    const pages = [f.pages[3], f.pages[0], { id: 'copy', sourceIndex: 0 }];
    const last = { ...f.selected, imageIndex: 1 };
    expect((await adjacentOriginalImage(f.pdf, pages, last, 1, signal))?.pageId).toBe('copy');
    expect((await adjacentOriginalImage(f.pdf, pages, f.selected, -1, signal))?.pageId).toBe('c');
  });
  it('stops metadata traversal after cancellation without decoding images', async () => {
    const f = fixture(),
      owner = new AbortController();
    f.pdf.getImages = async (i) => {
      f.calls.push(i);
      owner.abort();
      return [];
    };
    await expect(
      adjacentOriginalImage(f.pdf, f.pages, f.selected, 1, owner.signal),
    ).rejects.toThrow();
    expect(f.calls).toEqual([0]);
  });
});
