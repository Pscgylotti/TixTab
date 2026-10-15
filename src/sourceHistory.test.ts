import { expect, it } from 'vitest';
import { newNotebook } from './model';
import { trimSourceHistory } from './sourceHistory';
import { newScratchPaper } from './scratchPaper';
it('charges shared source buffers only once and keeps a contiguous recent undo chain', () => {
  const a = { ...newNotebook(), source: new Uint8Array(10) },
    b = { ...newNotebook(), source: new Uint8Array(10) },
    c = { ...newNotebook(), source: new Uint8Array(10) };
  const pen = { ...b, pages: [...b.pages] };
  expect(trimSourceHistory([a, b, pen], c, 15)).toEqual([b, pen]);
  expect(trimSourceHistory([a, b, pen], c, 20)).toEqual([a, b, pen]);
  expect(trimSourceHistory([a, b, pen], b, 0)).toEqual([b, pen]);
  expect(trimSourceHistory([a, b], c, 0)).toEqual([b]);
});
it('bounds deleted scratch image heaps while shared pictures are charged once', () => {
  const n = newNotebook(),
    sheet = newScratchPaper([]);
  const picture = {
    id: 'p',
    kind: 'image' as const,
    data: 'A'.repeat(100),
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  };
  const a = { ...n, scratchPapers: [{ ...sheet, page: { ...sheet.page, images: [picture] } }] };
  const b = {
    ...n,
    scratchPapers: [
      { ...sheet, page: { ...sheet.page, images: [{ ...picture, data: 'B'.repeat(100) }] } },
    ],
  };
  expect(trimSourceHistory([a, b], n, 250)).toEqual([b]);
  expect(trimSourceHistory([a, { ...a, pages: [...a.pages] }], n, 200)).toHaveLength(2);
});
