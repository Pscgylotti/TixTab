import { describe, expect, it } from 'vitest';
import { itemAt, makeLayout, visibleRange } from './virtualLayout';
import { zoomReadingPoint } from './readingZoom';

describe('长文档视区与缩放锚点', () => {
  it('不同页高的前缀位置与滚动末端准确，空文档安全', () => {
    const layout = makeLayout([100, 200, 150], 8);
    expect(layout).toEqual({ offsets: [0, 108, 316, 474], total: 466 });
    expect([itemAt(layout, -1), itemAt(layout, 108), itemAt(layout, 999)]).toEqual([0, 1, 2]);
    expect(visibleRange(layout, 120, 60, 0)).toEqual({ start: 1, end: 2 });
    expect(visibleRange(makeLayout([]), 0, 100)).toEqual({ start: 0, end: 0 });
  });
  it('一万页的视区只包含附近页面，不依赖全量 DOM', () => {
    const layout = makeLayout(Array(10000).fill(842), 33),
      range = visibleRange(layout, 875 * 9990, 1000, 1000);
    expect(range.end - range.start).toBeLessThan(6);
    expect(range.start).toBeGreaterThan(9985);
    expect(layout.total).toBe(8_749_967);
  });
  it('连续模式第 600 页缩放保留纸面落点，不放大页间距和标题累计误差', () => {
    const pages = Array.from({ length: 1000 }, (_, i) => ({
      width: i % 2 ? 842 : 595,
      height: i % 2 ? 595 : 842,
    }));
    const old = makeLayout(
        pages.map((p) => p.height + 25),
        8,
      ),
      target = makeLayout(
        pages.map((p) => p.height * 2 + 25),
        8,
      );
    const point = { x: 700, y: 8 + old.offsets[599] + 25 + 123 };
    const next = zoomReadingPoint(pages, 'continuous', 0, 1200, 1, 2, point);
    expect(next.y).toBe(8 + target.offsets[599] + 25 + 246);
    const restored = zoomReadingPoint(pages, 'continuous', 0, 1200, 2, 1, next);
    expect(restored).toEqual(point);
  });
  it('双页模式保留右页落点，16px 页间距固定', () => {
    const pages = [
      { width: 600, height: 800 },
      { width: 600, height: 800 },
    ];
    const next = zoomReadingPoint(pages, 'dual', 0, 1000, 1, 2, {
      x: 8 + 600 + 16 + 100,
      y: 44 + 50,
    });
    expect(next).toEqual({ x: 8 + 1200 + 16 + 200, y: 44 + 100 });
  });
});
