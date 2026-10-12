export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export type WritingHand = 'right' | 'left';
export interface FlyoutPosition extends ViewRect {
  side: 'left' | 'right' | 'above' | 'below';
  maxHeight: number;
}
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, max));
function overlap(a: ViewRect, b: ViewRect) {
  return (
    Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top))
  );
}
/** Fixed-position CSS coordinates, including the visual viewport when zoomed.
 * Evaluate a bounded set of placements; no measurements, timers or polling here.
 * Prefer the roomier vertical region, aligned away from the writing hand.
 * A tall panel scrolls in the available space rather than covering the selection.
 */
export function placeSelectionFlyout(
  viewport: ViewRect,
  size: { width: number; height: number },
  anchor: ViewRect,
  point: { x: number; y: number },
  hand: WritingHand,
  expanded: boolean,
  obstacles: ViewRect[] = [],
): FlyoutPosition {
  const margin = Math.min(12, viewport.width / 4, viewport.height / 4),
    gap = 36;
  const left = viewport.left + margin,
    top = viewport.top + margin;
  const right = viewport.left + viewport.width - margin,
    bottom = viewport.top + viewport.height - margin;
  const width = Math.min(size.width, right - left),
    fullHeight = Math.min(size.height, bottom - top);
  // A short page viewport must still offer a scrollable vertical placement.
  const minimum = Math.min(54, fullHeight);
  const text = {
    left: clamp(anchor.left, left, right),
    top: clamp(anchor.top, top, bottom),
    width: Math.max(0, Math.min(anchor.left + anchor.width, right) - Math.max(anchor.left, left)),
    height: Math.max(0, Math.min(anchor.top + anchor.height, bottom) - Math.max(anchor.top, top)),
  };
  const tip = { left: point.x - 32, top: point.y - 32, width: 64, height: 64 };
  const preferred = hand === 'right' ? 'left' : 'right';
  const aligned = clamp(
    preferred === 'left' ? text.left + text.width - width : text.left,
    left,
    right - width,
  );
  const candidates: FlyoutPosition[] = [];
  const fallback = new Set<FlyoutPosition>();
  const add = (side: FlyoutPosition['side'], x: number, y: number, maxHeight = bottom - top) => {
    if (maxHeight < minimum) return;
    const height = Math.min(fullHeight, maxHeight);
    candidates.push({
      side,
      left: clamp(x, left, right - width),
      top: clamp(y, top, bottom - height),
      width,
      height,
      maxHeight,
    });
  };
  const vertical = (side: 'above' | 'below', start: number, end: number) => {
    let slots = [[start, end]];
    for (const obstacle of obstacles) {
      if (obstacle.left >= aligned + width || obstacle.left + obstacle.width <= aligned) continue;
      const a = obstacle.top - 12,
        b = obstacle.top + obstacle.height + 12;
      slots = slots.flatMap(([lo, hi]) =>
        b <= lo || a >= hi
          ? [[lo, hi]]
          : [
              [lo, Math.min(hi, a)],
              [Math.max(lo, b), hi],
            ],
      );
    }
    for (const [lo, hi] of slots)
      add(side, aligned, side === 'above' ? hi - Math.min(fullHeight, hi - lo) : lo, hi - lo);
  };
  vertical('above', top, text.top - gap);
  vertical('below', text.top + text.height + gap, bottom);
  const side = (s: 'left' | 'right') =>
    add(s, s === 'left' ? text.left - width - gap : text.left + text.width + gap, text.top);
  side(preferred);
  side(preferred === 'left' ? 'right' : 'left');
  // For a selection spanning nearly the whole viewport, keep a scrollable panel
  // visible and choose the least overlapping edge; the text may be unavoidable.
  add('above', aligned, top);
  fallback.add(candidates.at(-1)!);
  add('below', aligned, bottom - fullHeight);
  fallback.add(candidates.at(-1)!);
  const score = (c: FlyoutPosition) =>
    overlap(c, text) * 4 +
    overlap(c, tip) * 2 +
    obstacles.reduce((area, obstacle) => area + overlap(c, obstacle) * 8, 0);
  const rank = (c: FlyoutPosition) =>
    fallback.has(c)
      ? 3
      : c.side === 'above' || c.side === 'below'
        ? expanded && c.height < 100
          ? 2
          : 0
        : 1;
  return candidates.reduce((best, c) => {
    const difference =
      score(c) - score(best) ||
      rank(c) - rank(best) ||
      best.height - c.height ||
      best.maxHeight - c.maxHeight;
    return difference < 0 ? c : best;
  });
}
