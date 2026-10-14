import type { Bounds } from './spatialIndex';
export type ForegroundClip = Bounds | false | undefined;
interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}
/** CSS overscan and outward buckets avoid remounting at every fractional scroll. */
export function foregroundClip(
  paper: Rect,
  viewport: Rect,
  width: number,
  height: number,
): ForegroundClip {
  if (!paper.width || !paper.height) return undefined;
  const sx = paper.width / width,
    sy = paper.height / height;
  const left = Math.max(paper.left, viewport.left - 160),
    top = Math.max(paper.top, viewport.top - 160);
  const right = Math.min(paper.right, viewport.right + 160),
    bottom = Math.min(paper.bottom, viewport.bottom + 160);
  if (right <= left || bottom <= top) return false;
  const floor = (v: number) => Math.floor(v / 64) * 64;
  const ceil = (v: number) => Math.ceil(v / 64) * 64;
  return {
    minX: Math.max(0, floor(left - paper.left) / sx),
    minY: Math.max(0, floor(top - paper.top) / sy),
    maxX: Math.min(width, ceil(right - paper.left) / sx),
    maxY: Math.min(height, ceil(bottom - paper.top) / sy),
  };
}
export function sameForegroundClip(a: ForegroundClip, b: ForegroundClip) {
  return (
    a === b ||
    !!(a && b && a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY)
  );
}
