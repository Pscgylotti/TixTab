import { describe, it, expect } from 'vitest';
import { imagePolygons, transformPolygon, polygonBox } from './pdfNightGeometry';
import { planPdfTiles } from './pdfTiles';
const names = {
  save: 10,
  restore: 11,
  transform: 12,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintImageXObjectRepeat: 88,
  paintInlineImageXObjectGroup: 87,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  beginGroup: 76,
  endGroup: 77,
  paintImageMaskXObject: 83,
  beginAnnotation: 80,
  endAnnotation: 81,
};
describe('night image geometry and low-power budgets', () => {
  it('annotation appearances reset the preceding content transform and restore their own state', () => {
    const p = imagePolygons(
      {
        fnArray: [12, 80, 12, 85, 81, 85],
        argsArray: [
          [100, 0, 0, 100, 900, 800],
          ['stamp', [10, 20, 110, 120], [1, 0, 0, 1, 10, 20], [0, 1, -1, 0, 100, 0], false],
          [20, 0, 0, 40, 0, 0],
          ['inside'],
          [],
          ['outside'],
        ],
      },
      names,
    );
    expect(p.map(polygonBox)).toEqual([
      { x: 70, y: 20, width: 40, height: 20 },
      { x: 900, y: 800, width: 100, height: 100 },
    ]);
  });
  it('tracks nested forms, restores transforms and excludes stencil masks', () => {
    const p = imagePolygons(
      {
        fnArray: [10, 12, 85, 74, 12, 86, 75, 83, 11, 85],
        argsArray: [
          [],
          [100, 0, 0, 50, 20, 30],
          ['image'],
          [[1, 0, 0, 1, 2, 3], null],
          [2, 0, 0, 2, 0, 0],
          [{}],
          [],
          ['mask'],
          [],
          ['last'],
        ],
      },
      names,
    );
    expect(p).toHaveLength(3);
    expect(polygonBox(p[0])).toEqual({ x: 20, y: 30, width: 100, height: 50 });
    expect(polygonBox(p[1])).toEqual({ x: 220, y: 180, width: 200, height: 100 });
    expect(polygonBox(p[2])).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
  it('rotation/crop and repeated-image transforms remain in the PDF viewport coordinates', () => {
    const p = imagePolygons(
      { fnArray: [88], argsArray: [['image', 20, 40, [10, 30, 50, 80]]] },
      names,
    );
    expect(p).toHaveLength(2);
    expect(polygonBox(transformPolygon(p[0], [0, 1, 1, 0, -5, -7]))).toEqual({
      x: 25,
      y: 3,
      width: 40,
      height: 20,
    });
  });
  it('eco tile plans honor their smaller pixel budget across large zooms', () => {
    for (const scale of [1, 2, 4, 8]) {
      const p = planPdfTiles(
        1200,
        1600,
        { x: 180, y: 330, width: 800, height: 600 },
        scale,
        2_000_000,
      );
      expect(p.pixels).toBeLessThanOrEqual(2_000_000);
      expect(p.tiles.length).toBeGreaterThan(0);
    }
  });
});
