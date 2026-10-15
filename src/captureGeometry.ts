export interface CaptureBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
/** Both endpoints may lie outside the page. The preview and sampled region
 * must use the same clipped rectangle, including reverse drags. */
export function clippedCaptureBox(
  rect: CaptureBounds,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
) {
  const x0 = Math.max(rect.left, Math.min(rect.right, startX)),
    y0 = Math.max(rect.top, Math.min(rect.bottom, startY));
  const x1 = Math.max(rect.left, Math.min(rect.right, endX)),
    y1 = Math.max(rect.top, Math.min(rect.bottom, endY));
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}
