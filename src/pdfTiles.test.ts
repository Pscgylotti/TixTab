import { describe, expect, it } from 'vitest';
import { MAX_TILE_PIXELS, TILE_SIZE, planPdfTiles } from './pdfTiles';

describe('按视区规划 PDF 高清瓦片', () => {
  it('只覆盖可见区域附近，整数像素网格没有缝隙，纸面位置不随缩放漂移', () => {
    const area = { x: 310, y: 450, width: 300, height: 200 },
      p = planPdfTiles(2000, 3000, area, 8);
    expect(p.scale).toBeGreaterThan(4);
    expect(p.pixels).toBeLessThanOrEqual(MAX_TILE_PIXELS);
    expect(p.tiles.length).toBeLessThan(32);
    for (let y = area.y; y < area.y + area.height; y += 10)
      for (let x = area.x; x < area.x + area.width; x += 10)
        expect(
          p.tiles.some(
            (t) =>
              x * p.scale >= t.x &&
              x * p.scale < t.x + t.width &&
              y * p.scale >= t.y &&
              y * p.scale < t.y + t.height,
          ),
        ).toBe(true);
    for (const t of p.tiles) {
      expect(t.x % TILE_SIZE).toBe(0);
      expect(t.y % TILE_SIZE).toBe(0);
      expect(t.width * t.height).toBeLessThanOrEqual(TILE_SIZE ** 2);
    }
  });
  it('短距离平移保留重复网格，裁切边界和横向页尺寸准确', () => {
    const a = planPdfTiles(842, 595, { x: 700, y: 500, width: 200, height: 150 }, 4),
      b = planPdfTiles(842, 595, { x: 710, y: 505, width: 200, height: 150 }, 4);
    expect(a.scale).toBe(b.scale);
    expect(
      a.tiles.filter((t) => b.tiles.some((u) => t.x === u.x && t.y === u.y)).length,
    ).toBeGreaterThan(0);
    for (const t of a.tiles) {
      expect(t.x + t.width).toBeLessThanOrEqual(Math.ceil(842 * a.scale));
      expect(t.y + t.height).toBeLessThanOrEqual(Math.ceil(595 * a.scale));
    }
    expect(a.tiles.some((t) => t.x + t.width === Math.ceil(842 * a.scale))).toBe(true);
  });
  it('高 DPI 大视区自动降采样，像素量和任务数量有界', () => {
    const plan = planPdfTiles(10000, 10000, { x: 200, y: 200, width: 2000, height: 1400 }, 8);
    expect(plan.scale).toBeLessThan(8);
    expect(plan.tiles.length).toBeGreaterThan(0);
    expect(plan.tiles.length).toBeLessThanOrEqual(32);
    expect(plan.pixels).toBeLessThanOrEqual(MAX_TILE_PIXELS);
    expect(planPdfTiles(1e12, 1e12, { x: 0, y: 0, width: 1e12, height: 1e12 }, 8).tiles).toEqual(
      [],
    );
  });
  it('接近像素预算时，平移跨越网格线不会使整层倍率变化', () => {
    const a = planPdfTiles(1200, 1600, { x: 300, y: 550, width: 350, height: 225 }, 6),
      b = planPdfTiles(1200, 1600, { x: 325, y: 570, width: 350, height: 225 }, 6);
    expect(a.scale).toBe(b.scale);
    expect(
      b.tiles.filter((t) => a.tiles.some((u) => t.x === u.x && t.y === u.y)).length,
    ).toBeGreaterThan(b.tiles.length / 2);
  });
  it('视区外或无效区域不分配画布，分数 DPI 稳定落在八分之一倍率', () => {
    expect(planPdfTiles(595, 842, { x: -200, y: -200, width: 100, height: 100 }, 4).tiles).toEqual(
      [],
    );
    expect(planPdfTiles(595, 842, { x: 0, y: 0, width: 0, height: 100 }, 4).tiles).toEqual([]);
    expect(planPdfTiles(595, 842, { x: 0, y: 0, width: 50, height: 50 }, 2.64).scale).toBe(2.625);
  });
});
