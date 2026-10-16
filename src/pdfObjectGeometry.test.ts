import { describe, expect, it } from 'vitest';
import { PdfViewport } from './pdfViewport';
import {
  alignOffsets,
  apply,
  containsPoint,
  distributeOffsets,
  invert,
  multiply,
  rotateAbout,
  scaleAbout,
  toPdfSpace,
  translate,
} from './pdfObjectGeometry';

const round = (values: number[]) => values.map((v) => Math.round(v * 1e6) / 1e6 + 0);

describe('affine helpers', () => {
  it('composes in application order and inverts', () => {
    const m = multiply(translate(10, 0), scaleAbout(2, 3, 0, 0));
    expect(apply(m, 1, 1)).toEqual([12, 3]);
    expect(round(multiply(invert(m), m))).toEqual([1, 0, 0, 1, 0, 0]);
  });
  it('rotates clockwise on screen about a point', () => {
    expect(round(apply(rotateAbout(Math.PI / 2, 10, 10), 20, 10))).toEqual([10, 20]);
  });
  it('tests points inside a rotated quad', () => {
    const diamond = [0, -10, 10, 0, 0, 10, -10, 0];
    expect(containsPoint(diamond, 0, 0)).toBe(true);
    expect(containsPoint(diamond, 8, 8)).toBe(false);
  });
});

describe('page to PDF space', () => {
  it.each([0, 90, 180, 270])(
    'a page move lands on the same page spot at rotation %i',
    (rotation) => {
      const view = new PdfViewport(
        { view: [10, 20, 410, 620], rotation, userUnit: 1, objectNumber: 1 },
        { scale: 1 },
      ).transform;
      const change = translate(15, -7),
        pdf = toPdfSpace(change, view),
        point = [100, 200];
      // Moving the PDF point by `pdf` equals moving its page position by `change`.
      const viaPdf = apply(view, ...(apply(pdf, point[0], point[1]) as [number, number])),
        viaPage = apply(change, ...(apply(view, point[0], point[1]) as [number, number]));
      expect(round(viaPdf)).toEqual(round(viaPage));
    },
  );
});

describe('arrange', () => {
  const boxes = [
    [0, 0, 10, 10],
    [30, 5, 50, 25],
    [100, 40, 110, 60],
  ];
  it('aligns to the union edges and centres', () => {
    expect(alignOffsets(boxes, 'left')).toEqual([
      [0, 0],
      [-30, 0],
      [-100, 0],
    ]);
    expect(alignOffsets(boxes, 'bottom')).toEqual([
      [0, 50],
      [0, 35],
      [0, 0],
    ]);
    expect(alignOffsets(boxes, 'center')).toEqual([
      [50, 0],
      [15, 0],
      [-50, 0],
    ]);
  });
  it('distributes equal gaps and keeps the outer boxes', () => {
    const offsets = distributeOffsets(boxes, 'x'),
      moved = boxes.map((b, i) => [b[0] + offsets[i][0], b[2] + offsets[i][0]]);
    expect(offsets[0]).toEqual([0, 0]);
    expect(offsets[2]).toEqual([0, 0]);
    expect(moved[1][0] - moved[0][1]).toBeCloseTo(moved[2][0] - moved[1][1], 6);
  });
});
