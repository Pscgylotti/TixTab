import { describe, it, expect } from 'vitest';
import { blankPage, type Notebook, type Stroke } from './model';
import { ScratchEraseSession } from './scratchErase';

const rect = (x: number, y: number, width: number, height: number) =>
  ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height }) as DOMRect;
const stroke = (id: string, x: number, y: number): Stroke => ({
  id,
  tool: 'pen',
  color: '#123456',
  size: 1,
  points: [
    [x, y, 0.5],
    [x + 5, y, 0.5],
  ],
});
function fixture() {
  const pdf = blankPage(100, 100),
    scratch = blankPage(400, 400),
    other = blankPage();
  pdf.strokes = [stroke('pdf', 80, 50), stroke('untouched', 20, 20)];
  scratch.strokes = [
    stroke('scratch', 250, 100),
    stroke('covered', 100, 100),
    stroke('far', 360, 100),
  ];
  const n: Notebook = {
    version: 1,
    name: 'test',
    source: null,
    pages: [pdf, other],
    scratchPapers: [
      { id: 'scratch', name: 'Scratch', page: scratch, view: { x: 200, y: 200, zoom: 0.5 } },
    ],
  };
  const pdfRect = rect(0, 0, 100, 100),
    scratchRect = rect(0, 0, 200, 200);
  const hits = [
    { page: pdf, rect: pdfRect },
    { page: scratch, rect: scratchRect },
  ];
  return { n, pdf, scratch, other, pdfRect, scratchRect, hits };
}
describe('cross-sheet erasing', () => {
  for (const reverse of [false, true])
    it(`routes ${reverse ? 'scratch to PDF' : 'PDF to scratch'} as one immutable transaction`, () => {
      const f = fixture(),
        session = new ScratchEraseSession(f.hits);
      if (reverse) session.sample(f.scratch, f.scratchRect, [280, 100, 0.5], [150, 100, 0.5], 4);
      else session.sample(f.pdf, f.pdfRect, [75, 50, 0.5], [140, 50, 0.5], 2);
      expect(
        session
          .preview()
          .flatMap((p) => p.strokes.map((s) => s.id))
          .sort(),
      ).toEqual(['pdf', 'scratch']);
      expect(f.pdf.strokes).toHaveLength(2);
      expect(f.scratch.strokes).toHaveLength(3);
      const next = session.apply(f.n);
      expect(next.pages[0].strokes.map((s) => s.id)).toEqual(['untouched']);
      expect(next.scratchPapers![0].page.strokes.map((s) => s.id)).toEqual(['covered', 'far']);
      expect(next.pages[1]).toBe(f.other);
      // The old notebook itself is the undo snapshot for both sheets.
      expect(f.n.pages[0].strokes).toHaveLength(2);
      expect(f.n.scratchPapers![0].page.strokes).toHaveLength(3);
    });

  it('converts pressure-derived radius to each independently zoomed paper', () => {
    const f = fixture();
    f.scratch.strokes = [stroke('near', 250, 103), stroke('outside', 250, 110)];
    const session = new ScratchEraseSession(f.hits);
    session.sample(f.pdf, f.pdfRect, [110, 50, 0.5], [140, 50, 0.5], 2);
    expect(session.preview()[0].strokes.map((s) => s.id)).toEqual(['near']);
    const zero = new ScratchEraseSession(f.hits);
    zero.sample(f.pdf, f.pdfRect, [75, 50, 0], [140, 50, 0], 0);
    expect(zero.apply(f.n)).toBe(f.n);
  });

  it('respects foreground PDF, hidden sheets and viewport bounds', () => {
    const f = fixture(),
      session = new ScratchEraseSession(f.hits, rect(0, 0, 140, 200));
    session.sample(f.pdf, f.pdfRect, [20, 50, 0.5], [190, 50, 0.5], 1);
    expect(
      session
        .preview()
        .flatMap((p) => p.strokes.map((s) => s.id))
        .sort(),
    ).toEqual(['pdf', 'scratch']);
    const onlyScratch = new ScratchEraseSession([f.hits[1]]);
    onlyScratch.sample(f.scratch, f.scratchRect, [90, 100, 0.5], [120, 100, 0.5], 1);
    expect(onlyScratch.preview()[0].strokes[0].id).toBe('covered');
  });

  it('keeps object erasing and ink layer ordering consistent across both sheets', () => {
    const f = fixture();
    f.pdf.images = [{ id: 'a', kind: 'text', data: '', x: 80, y: 45, width: 5, height: 10 }];
    f.pdf.inkLayer = 1;
    f.scratch.images = [{ id: 'b', kind: 'sketch', data: '', x: 250, y: 95, width: 5, height: 10 }];
    const session = new ScratchEraseSession(f.hits);
    session.sample(f.pdf, f.pdfRect, [75, 50, 0.5], [140, 50, 0.5], 2);
    const next = session.apply(f.n);
    expect(next.pages[0].images).toEqual([]);
    expect(next.pages[0].inkLayer).toBe(0);
    expect(next.scratchPapers![0].page.images).toEqual([]);
  });

  it('discards stale marks after undo or concurrent changes instead of partially applying', () => {
    const f = fixture(),
      session = new ScratchEraseSession(f.hits);
    session.sample(f.pdf, f.pdfRect, [75, 50, 0.5], [140, 50, 0.5], 2);
    const changed = { ...f.n, pages: [{ ...f.pdf, strokes: [] }, f.other] };
    expect(session.apply(changed)).toBe(changed);
  });
});
