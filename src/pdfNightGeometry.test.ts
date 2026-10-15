import { describe, it, expect } from 'vitest';
import { transformPolygon, polygonBox } from './pdfNightGeometry';
import { planPdfTiles } from './pdfTiles';
describe('night image geometry and low-power budgets', () => {
  it('transforms and bounds image polygons', () => {
    expect(
      polygonBox(transformPolygon([10, 30, 30, 30, 30, 70, 10, 70], [0, 1, 1, 0, -5, -7])),
    ).toEqual({ x: 25, y: 3, width: 40, height: 20 });
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
