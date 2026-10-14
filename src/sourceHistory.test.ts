import { expect, it } from 'vitest';
import { newNotebook } from './model';
import { trimSourceHistory } from './sourceHistory';
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
