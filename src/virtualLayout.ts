/** Prefix offsets keep mixed page sizes exact; viewport lookup is logarithmic. */
export interface VirtualLayout {
  offsets: number[];
  total: number;
}
export function makeLayout(heights: number[], gap = 0): VirtualLayout {
  const offsets = [0];
  let total = 0;
  for (const height of heights) {
    total += Math.max(0, height) + gap;
    offsets.push(total);
  }
  return { offsets, total: Math.max(0, total - (heights.length ? gap : 0)) };
}
export function itemAt(layout: VirtualLayout, position: number) {
  let low = 0,
    high = layout.offsets.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if (layout.offsets[mid] <= position) low = mid;
    else high = mid - 1;
  }
  return Math.max(0, Math.min(layout.offsets.length - 2, low));
}
export function visibleRange(layout: VirtualLayout, top: number, height: number, overscan = 500) {
  if (layout.offsets.length < 2) return { start: 0, end: 0 };
  const start = itemAt(layout, Math.max(0, top - overscan));
  const end = Math.min(layout.offsets.length - 1, itemAt(layout, top + height + overscan) + 1);
  return { start, end };
}
