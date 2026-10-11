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
 * Prefer the side opposite the writing hand, then space above/below the text.
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
  const minimum = Math.min(expanded ? 220 : 54, fullHeight);
  const text = {
    left: clamp(anchor.left, left, right),
    top: clamp(anchor.top, top, bottom),
    width: Math.max(0, Math.min(anchor.left + anchor.width, right) - Math.max(anchor.left, left)),
    height: Math.max(0, Math.min(anchor.top + anchor.height, bottom) - Math.max(anchor.top, top)),
  };
  const tip = { left: point.x - 32, top: point.y - 32, width: 64, height: 64 };
  const preferred = hand === 'right' ? 'left' : 'right';
  const aligned = preferred === 'left' ? text.left : text.left + text.width - width;
  const candidates: FlyoutPosition[] = [];
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
  const side = (s: 'left' | 'right') =>
    add(s, s === 'left' ? text.left - width - gap : text.left + text.width + gap, text.top);
  side(preferred);
  side(preferred === 'left' ? 'right' : 'left');
  const above = text.top - gap - top,
    below = bottom - text.top - text.height - gap;
  add('above', aligned, text.top - gap - Math.min(fullHeight, above), above);
  add('below', aligned, text.top + text.height + gap, below);
  // For a selection spanning nearly the whole viewport, keep a scrollable panel
  // visible and choose the least overlapping edge; the text may be unavoidable.
  add('above', aligned, top);
  add('below', aligned, bottom - fullHeight);
  for (const obstacle of obstacles) {
    const aboveObstacle = obstacle.top - gap - top,
      belowObstacle = bottom - obstacle.top - obstacle.height - gap;
    add('above', aligned, obstacle.top - gap - Math.min(fullHeight, aboveObstacle), aboveObstacle);
    add('below', aligned, obstacle.top + obstacle.height + gap, belowObstacle);
    add('left', obstacle.left - width - gap, text.top);
    add('right', obstacle.left + obstacle.width + gap, text.top);
  }
  const score = (c: FlyoutPosition) =>
    overlap(c, text) * 4 +
    overlap(c, tip) * 2 +
    obstacles.reduce((area, obstacle) => area + overlap(c, obstacle) * 8, 0);
  return candidates.reduce((best, c) => (score(c) < score(best) ? c : best));
}
