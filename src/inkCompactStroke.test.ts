import { expect, it } from 'vitest';
import { outline } from './ink';
import type { Stroke } from './model';
it('dense compact strokes retain their raw pressure samples without needle-like outline noise', () => {
  for (const scale of [0.25, 1, 10]) {
    const points: Stroke['points'] = Array.from({ length: 240 }, (_, i) => {
      const t = i / 239;
      return [
        (20 + t * 13) * scale,
        (20 + Math.sin(t * Math.PI) * 5 + Math.sin(i * 2.3) * 0.08) * scale,
        0.65 + Math.sin(i * 0.7) * 0.015,
      ];
    });
    const raw = JSON.stringify(points),
      size = 12 * scale;
    const shape = outline({ id: 'compact', tool: 'pen', color: '#9a7627', size, points });
    let needles = 0;
    for (let i = 0; i < shape.length; i++) {
      const p = shape[i],
        a = shape[(i + shape.length - 1) % shape.length],
        b = shape[(i + 1) % shape.length];
      const ax = a[0] - p[0],
        ay = a[1] - p[1],
        bx = b[0] - p[0],
        by = b[1] - p[1],
        la = Math.hypot(ax, ay),
        lb = Math.hypot(bx, by);
      if (la > scale && lb > scale && (ax * bx + ay * by) / (la * lb) > 0.98) needles++;
    }
    expect(needles).toBeLessThanOrEqual(1);
    expect(shape.every((p) => p.every(Number.isFinite))).toBe(true);
    expect(JSON.stringify(points)).toBe(raw);
  }
});
